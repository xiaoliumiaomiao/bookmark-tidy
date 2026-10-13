import { buildPlan } from './core/planner.js';
import { DEFAULT_SETTINGS, validateSettings, exportSettings } from './core/settings.js';
import { createEngine } from './core/engine.js';
import { findScopeRoots, flattenTree } from './core/tree.js';
import { requestSuggestions, validateEndpoint } from './core/ai.js';

export function senderAllowed(sender, api) {
  if (sender.id !== api.runtime.id || typeof sender.url !== 'string') return false;
  try { return new URL(sender.url).href.split('?')[0].split('#')[0] === api.runtime.getURL('app.html'); }
  catch { return false; }
}

export function createController(api) {
  const withLock = async work => {
    if (globalThis.navigator?.locks) return navigator.locks.request('bookmark-tidy-write',work);
    return work(); // The worker still serializes messages; test adapters need no Web Locks.
  };
  const engine = createEngine({bookmarks:api.bookmarks,storage:api.storage.local || api.storage,withLock});
  const storage = api.storage.local || api.storage;
  let queue = Promise.resolve();
  async function settings() {
    const stored = await storage.get('settings');
    return validateSettings(stored.settings || DEFAULT_SETTINGS);
  }
  async function loadPlan(id) {
    const stored = await storage.get('plan');
    if (!stored.plan || stored.plan.id !== id) throw new Error('当前预览已失效，请重新生成');
    return stored.plan;
  }
  async function handle(message) {
    switch(message?.command) {
      case 'inspect': {
        const [tree,config,state,stored] = await Promise.all([api.bookmarks.getTree(),settings(),engine.getState(),storage.get('plan')]);
        return {tree,settings:config,state,plan:stored.plan || null};
      }
      case 'preview': {
        const state=await engine.getState();
        if(state.journal) throw new Error('请先恢复未完成操作');
        const tree=await api.bookmarks.getTree();
        const config=await settings();
        const options=message.options || {};
        if(!['full','incremental'].includes(options.mode) || !['few','balanced','many'].includes(options.granularity)) throw new Error('整理选项无效');
        const roots=findScopeRoots(tree);
        const scope=flattenTree(tree).find(node=>node.id===options.scopeId && node.url===undefined && !node.unmodifiable);
        if(!scope) throw new Error('请选择可编辑的浏览器书签文件夹');
        if(options.mode==='incremental' && (!roots.some(root=>root.id===scope.id) || (scope.folderType && scope.folderType!=='bookmarks-bar'))) throw new Error('整理新增只支持书签栏最外层');
        const plan=buildPlan(tree,{...options,settings:config});
        await storage.set({plan});
        return plan;
      }
      case 'apply': {
        const plan=await loadPlan(message.planId);
        const config=await settings();
        const edits=message.edits || [];
        const result=await engine.apply(plan,edits,config);
        await storage.remove('plan');
        if(message.remember===true) {
          const overrides=new Map(config.overrides.map(rule=>[rule.url,rule]));
          const items=new Map(plan.items.map(item=>[item.id,item]));
          for(const edit of edits) {
            const original=items.get(edit.id);
            if(!original || edit.selected===false) continue;
            if(edit.newTitle===original.newTitle && edit.targetFolderKey===original.targetFolderKey) continue;
            const title=edit.newTitle ?? original.newTitle;
            const key=edit.targetFolderKey === undefined ? original.targetFolderKey : edit.targetFolderKey;
            const category=plan.folders.find(folder=>folder.key===key)?.title;
            overrides.set(original.url,{url:original.url,title,...(category ? {category} : {})});
          }
          try { await storage.set({settings:validateSettings({...config,overrides:[...overrides.values()]})}); }
          catch { return {...result,warning:'书签已整理，但人工规则保存失败，请检查本地存储空间'}; }
        }
        return {...result,status:'completed'};
      }
      case 'undo': {
        const result=await engine.undo();await storage.remove('plan');return {...result,status:'undone'};
      }
      case 'recover': {
        const result=await engine.recover();await storage.remove('plan');return {...result,status:'undone'};
      }
      case 'backup': {
        const stored=await storage.get('backup');
        return stored.backup || {version:1,createdAt:new Date().toISOString(),tree:await api.bookmarks.getTree()};
      }
      case 'saveSettings': {
        const config=validateSettings(message.settings);
        await storage.set({settings:config});await storage.remove('plan');return config;
      }
      case 'exportRules': return exportSettings(await settings());
      case 'aiSuggestions': {
        const plan=await loadPlan(message.planId);
        const endpoint=validateEndpoint(message.endpoint);
        if(!await api.permissions.contains({origins:[`${endpoint.protocol}//${endpoint.hostname}/*`]})) throw new Error('尚未授权该 AI 服务的访问权限');
        const suggested=await requestSuggestions(plan,{endpoint:message.endpoint,model:message.model,apiKey:message.apiKey,confirmed:message.confirmed});
        await storage.set({plan:suggested});return suggested;
      }
      default: throw new Error('不支持的操作');
    }
  }
  return message => {
    const result=queue.then(()=>handle(message));
    queue=result.catch(()=>{});
    return result;
  };
}

if(globalThis.chrome?.runtime?.onMessage) {
  const dispatch=createController(chrome);
  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    if(!senderAllowed(sender,chrome)) {sendResponse({ok:false,error:'请求来源未授权'});return false;}
    dispatch(message).then(data=>sendResponse({ok:true,data})).catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  });
  chrome.action.onClicked.addListener(async()=>{
    await chrome.tabs.create({url:chrome.runtime.getURL('app.html')});
  });
}
