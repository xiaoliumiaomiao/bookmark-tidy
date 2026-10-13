import { flattenTree, fingerprint } from './tree.js';

const clone = value => structuredClone(value);
const titleValid = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f]/u.test(value);
const conflict = message => new Error(`检测到修改冲突：${message}。已停止，请保留备份并检查书签。`);

/** The worker is the only writer. A journal is persisted before every side effect. */
export function createEngine({ bookmarks, storage, withLock = work => work() }) {
  const read = async () => {
    const data = await storage.get(['journal', 'history']);
    return { journal: data.journal || null, history: data.history || [] };
  };
  const persist = journal => storage.set({ journal: clone(journal) });
  const current = async () => {
    const tree = await bookmarks.getTree();
    return { tree, nodes: new Map(flattenTree(tree).map(node => [node.id, node])) };
  };
  function isWithin(id, rootId, nodes) {
    let node = nodes.get(id);
    const seen = new Set();
    while (node && !seen.has(node.id)) {
      if (node.id === rootId) return true;
      seen.add(node.id); node = nodes.get(node.parentId);
    }
    return false;
  }
  function protectedNode(node, nodes, settings) {
    if (settings.lockedBookmarkUrls?.includes(node.url)) return true;
    if (settings.lockedFolderPaths?.some(path => path.every((part, i) => node.path?.[i] === part))) return true;
    let cursor = node;
    while (cursor) {
      if (cursor.unmodifiable) return true;
      cursor = nodes.get(cursor.parentId);
    }
    return false;
  }
  function captureOrders(nodes, parents) {
    return Object.fromEntries([...new Set(parents)].map(parent=>[parent,[...nodes.values()].filter(node=>node.parentId===parent).sort((a,b)=>a.index-b.index).map(node=>node.id)]));
  }
  function orderMatches(expected, nodes) {
    if(!expected) return true;
    const known=new Set(Object.values(expected).flat());
    return Object.entries(expected).every(([parent,ids])=>{
      const actual=[...nodes.values()].filter(node=>node.parentId===parent && known.has(node.id)).sort((a,b)=>a.index-b.index).map(node=>node.id);
      return JSON.stringify(actual)===JSON.stringify(ids.filter(id=>nodes.has(id)));
    });
  }
  function checkPhaseOrder(journal,nodes) {
    const allowed=journal.orderProof ? [journal.orderProof.before,journal.orderProof.after] : [journal.expectedOrders];
    if(!allowed.some(order=>orderMatches(order,nodes))) throw conflict('相关文件夹的书签顺序已被修改');
  }
  async function prepareMove(journal,change,parentId,index) {
    const live=await current();checkPhaseOrder(journal,live.nodes);
    const source=live.nodes.get(change.id);
    const parents=[...Object.keys(journal.expectedOrders || {}),source.parentId,parentId];
    const before=captureOrders(live.nodes,parents);const after=clone(before);
    after[source.parentId]=after[source.parentId].filter(id=>id!==change.id);
    const destination=after[parentId];
    destination.splice(Math.min(index ?? destination.length,destination.length),0,change.id);
    journal.orderProof={before,after};await persist(journal);
  }
  async function finishMove(journal) {
    const live=await current();
    if(!orderMatches(journal.orderProof.after,live.nodes)) throw conflict('移动后的顺序发生变化');
    journal.expectedOrders=journal.orderProof.after;journal.orderProof=null;await persist(journal);
  }
  function checkApplyLocation(change,plan,settings,nodes) {
    const node=nodes.get(change.id);const destination=nodes.get(change.after.parentId);
    if(!node || !destination || destination.url!==undefined || !isWithin(node.id,plan.scopeId,nodes) || !isWithin(destination.id,plan.scopeId,nodes) || protectedNode(node,nodes,settings) || protectedNode(destination,nodes,settings)) throw conflict('源书签或目标分类已移出范围或受到保护');
    if(plan.mode==='incremental' && (node.parentId!==plan.scopeId || (destination.id!==plan.scopeId && destination.parentId!==plan.scopeId))) throw conflict('新增整理的范围已变化');
  }
  function selectItems(plan, edits, nodes, settings) {
    if (!Array.isArray(edits) || edits.length > plan.items.length) throw new Error('预览编辑格式无效');
    const sourceIds = new Set(plan.items.map(item => item.id));
    const editMap = new Map();
    for (const edit of edits) {
      if (!sourceIds.has(edit.id) || editMap.has(edit.id)) throw new Error('包含未知或重复书签编辑');
      if (edit.selected !== undefined && typeof edit.selected !== 'boolean') throw new Error('选择状态无效');
      editMap.set(edit.id, edit);
    }
    const folders = new Map(plan.folders.map(folder => [folder.key, folder]));
    const selected = [];
    for (const item of plan.items) {
      const edit = editMap.get(item.id) || {};
      if (!(edit.selected ?? item.selected)) continue;
      const node = nodes.get(item.id);
      if (!node || node.url !== item.url || node.title !== item.oldTitle || node.parentId !== item.oldParentId) throw conflict('书签已变化');
      if (!isWithin(node.id, plan.scopeId, nodes) || node.id === plan.scopeId || protectedNode(node, nodes, settings)) throw new Error('条目超出范围或已锁定');
      if (plan.mode === 'incremental' && node.parentId !== plan.scopeId) throw new Error('整理新增只能修改书签栏最外层的书签');
      const newTitle = edit.newTitle ?? item.newTitle;
      if (newTitle !== item.oldTitle && !titleValid(newTitle)) throw new Error('新书签名称须为 1–200 个字符，且不能包含控制字符');
      const targetKey = edit.targetFolderKey === undefined ? item.targetFolderKey : edit.targetFolderKey;
      if (targetKey !== null && !folders.has(targetKey)) throw new Error('目标分类不在当前预览中');
      const folder = folders.get(targetKey);
      if (folder) {
        if (!folder.existingId && (!titleValid(folder.title) || folder.parentId !== plan.scopeId)) throw new Error('目标分类文件夹无效');
        if (folder.existingId) {
          const destination = nodes.get(folder.existingId);
          if (!destination || destination.url || !isWithin(destination.id, plan.scopeId, nodes) || protectedNode(destination, nodes, settings)) throw conflict('目标分类不可用');
          if (plan.mode === 'incremental' && destination.parentId !== plan.scopeId) throw new Error('新增整理不能进入深层分类');
        }
      }
      selected.push({ ...item, newTitle, targetFolderKey: targetKey, selected: true });
    }
    return selected;
  }
  async function applyUnlocked(plan, edits = [], settings = {}) {
    const state = await read();
    if (state.journal) throw new Error('存在未完成操作，请先恢复撤销');
    const live = await current();
    if (fingerprint(live.tree) !== plan.sourceFingerprint) throw new Error('预览已过期，书签发生变化，请重新生成预览');
    const scope = live.nodes.get(plan.scopeId);
    if (!scope || scope.url || scope.unmodifiable) throw new Error('整理范围不可用');
    const selected = selectItems(plan, edits, live.nodes, settings);
    const neededKeys = new Set(selected.map(item => item.targetFolderKey).filter(Boolean));
    const destinations = new Map(plan.folders.filter(folder => neededKeys.has(folder.key)).map(folder => [folder.key, folder.existingId || null]));
    const txId = crypto.randomUUID();
    const journal = {
      version: 1, id: txId, status: 'applying', createdAt: new Date().toISOString(),
      planId: plan.id, scopeId: plan.scopeId, beforeTree: clone(live.tree),
      createdFolders: plan.folders.filter(folder => neededKeys.has(folder.key) && !folder.existingId).map(folder => ({
        key: folder.key, title: folder.title, parentId: folder.parentId,
        marker: `${folder.title} ⟦${txId}⟧`, id: null, renamed: false, removing: false, removed: false
      })),
      changes: selected.map(item => ({ id: item.id, url: item.url,
        before: {title:item.oldTitle,parentId:item.oldParentId,index:item.oldIndex},
        after: {title:item.newTitle,parentId:destinations.get(item.targetFolderKey) || item.oldParentId},
        targetKey:item.targetFolderKey,
        rename:item.newTitle === item.oldTitle ? 'none' : 'not_started', move:'not_started', restoreTitle:'not_started', restoreMove:'not_started'
      }))
    };
    journal.expectedOrders=captureOrders(live.nodes,[plan.scopeId,...journal.changes.map(change=>change.before.parentId),...plan.folders.filter(folder=>neededKeys.has(folder.key) && folder.existingId).map(folder=>folder.existingId)]);
    // This snapshot is also available for export after interruption.
    await storage.set({ journal: clone(journal), backup: {version:1,createdAt:journal.createdAt,tree:clone(live.tree)} });
    try {
      for (const folder of journal.createdFolders) {
        await persist(journal);
        const created = await bookmarks.create({parentId:folder.parentId,title:folder.marker});
        folder.id = created.id; destinations.set(folder.key, created.id);
        await persist(journal);
        folder.renamePending = true; await persist(journal);
        const folderLive=(await current()).nodes;const temporary=folderLive.get(folder.id);
        if(!temporary || temporary.title!==folder.marker || temporary.parentId!==folder.parentId || protectedNode(temporary,folderLive,settings) || !isWithin(temporary.id,plan.scopeId,folderLive)) throw conflict('新建分类已变化');
        await bookmarks.update(folder.id, {title:folder.title});
        folder.renamed = true; folder.renamePending = false; await persist(journal);
      }
      for (const change of journal.changes) {
        change.after.parentId = change.targetKey ? destinations.get(change.targetKey) : change.before.parentId;
        change.move = change.after.parentId === change.before.parentId ? 'none' : 'not_started';
      }
      const ready=await current();checkPhaseOrder(journal,ready.nodes);
      journal.expectedOrders=captureOrders(ready.nodes,[...Object.keys(journal.expectedOrders),...journal.changes.map(change=>change.after.parentId)]);
      await persist(journal);
      for (const change of journal.changes) {
        const live=await current();checkPhaseOrder(journal,live.nodes);checkApplyLocation(change,plan,settings,live.nodes);
        const [node] = await bookmarks.get(change.id);
        if (node.url !== change.url || node.title !== change.before.title || node.parentId !== change.before.parentId) throw conflict('应用时书签变化');
        if (change.rename !== 'none') {
          change.rename = 'pending'; await persist(journal);
          const live=await current();checkPhaseOrder(journal,live.nodes);checkApplyLocation(change,plan,settings,live.nodes);
          const source=live.nodes.get(change.id);
          if(source.url!==change.url || source.title!==change.before.title || source.parentId!==change.before.parentId) throw conflict('改名前书签已变化');
          await bookmarks.update(change.id, {title:change.after.title});
          change.rename = 'done'; await persist(journal);
        }
        if (change.move !== 'none') {
          const live=await current();checkPhaseOrder(journal,live.nodes);checkApplyLocation(change,plan,settings,live.nodes);
          const [renamed] = await bookmarks.get(change.id);
          if (renamed.url !== change.url || renamed.title !== change.after.title || renamed.parentId !== change.before.parentId) throw conflict('移动前书签变化');
          change.move = 'pending'; await persist(journal);
          await prepareMove(journal,change,change.after.parentId);
          const fresh=await current();checkPhaseOrder(journal,fresh.nodes);checkApplyLocation(change,plan,settings,fresh.nodes);
          const source=fresh.nodes.get(change.id);
          if(source.url!==change.url || source.title!==change.after.title || source.parentId!==change.before.parentId) throw conflict('移动准备后书签已变化');
          await bookmarks.move(change.id, {parentId:change.after.parentId});
          change.move = 'done'; await finishMove(journal);
        }
      }
      const after = await current();
      for (const node of flattenTree(journal.beforeTree).filter(node => node.url !== undefined)) {
        if (after.nodes.get(node.id)?.url !== node.url) throw conflict('完整网址或书签数量变化');
      }
      for (const change of journal.changes) {
        const node = after.nodes.get(change.id);
        if (node.title !== change.after.title || node.parentId !== change.after.parentId) throw conflict('结果与预览不一致');
      }
      journal.status = 'applied'; journal.afterTree = after.tree; journal.completedAt = new Date().toISOString();
      await storage.set({journal:null,history:[clone(journal), ...state.history].slice(0,3)});
      return {id:journal.id,changed:journal.changes.filter(c => c.rename !== 'none' || c.move !== 'none').length};
    } catch (error) {
      journal.status = 'interrupted';
      // Do not persist arbitrary browser/AI error strings or any credential material.
      await persist(journal).catch(() => {});
      throw new Error(`整理中断：${error.message}。操作记录已保留，请点击恢复撤销。`);
    }
  }
  async function reconcileFolders(journal, nodes) {
    for (const folder of journal.createdFolders) {
      if (!folder.id && !folder.removed) {
        const matches = [...nodes.values()].filter(node => node.parentId === folder.parentId && node.title === folder.marker && node.url === undefined);
        if (matches.length > 1) throw conflict('临时文件夹不唯一');
        if (matches.length === 1) { folder.id = matches[0].id; await persist(journal); }
      }
      const node = folder.id && nodes.get(folder.id);
      if (!node && folder.id && !folder.removing && !folder.removed) throw conflict('新建分类已被删除');
      if (node && (node.parentId !== folder.parentId || ![folder.title,folder.marker].includes(node.title))) throw conflict('新建分类已被改名或移动');
    }
  }
  function allowedValue(stage, before, after, restore) {
    if (restore === 'done') return [before];
    if (restore === 'pending') return [before,after];
    return stage === 'done' ? [after] : stage === 'pending' ? [before,after] : [before];
  }
  function validateUndo(journal, nodes, checkOrder) {
    for (const change of journal.changes) {
      const node = nodes.get(change.id);
      if (!node || node.url !== change.url || node.unmodifiable) throw conflict('书签被删除、网址被修改或不可编辑');
      if (!allowedValue(change.rename,change.before.title,change.after.title,change.restoreTitle).includes(node.title)) throw conflict('书签名称已被修改');
      if (!allowedValue(change.move,change.before.parentId,change.after.parentId,change.restoreMove).includes(node.parentId)) throw conflict('书签位置已被修改');
      const parent = nodes.get(change.before.parentId);
      if (!parent || parent.url || parent.unmodifiable) throw conflict('原文件夹已不存在或不可编辑');
    }
    if (checkOrder && journal.afterTree) {
      const after = flattenTree(journal.afterTree);
      const touched = new Set(journal.changes.flatMap(change=>[change.before.parentId,change.after.parentId]));
      for (const parentId of touched) {
        const expected = after.filter(node=>node.parentId===parentId).map(node=>node.id).filter(id=>nodes.has(id));
        const known = new Set(expected);
        const actual = [...nodes.values()].filter(node=>node.parentId===parentId && known.has(node.id)).sort((a,b)=>a.index-b.index).map(node=>node.id);
        if (JSON.stringify(expected)!==JSON.stringify(actual)) throw conflict('相关文件夹的书签顺序已被修改');
      }
    }
  }
  async function restore(journal, history, fromHistory) {
    let live = await current();
    // Preflight the entire rollback before writing any bookmark.
    await reconcileFolders(journal, live.nodes);
    checkPhaseOrder(journal,live.nodes);
    validateUndo(journal, live.nodes, fromHistory);
    journal.expectedOrders=captureOrders(live.nodes,[...Object.keys(journal.expectedOrders || {}),...journal.changes.flatMap(change=>[change.before.parentId,change.after.parentId])]);journal.orderProof=null;
    journal.status = 'undoing'; await persist(journal);
    try {
      for (const change of journal.changes) {
        checkPhaseOrder(journal,(await current()).nodes);
        const [node] = await bookmarks.get(change.id);
        if (!allowedValue(change.rename,change.before.title,change.after.title,change.restoreTitle).includes(node.title) || node.url !== change.url || !allowedValue(change.move,change.before.parentId,change.after.parentId,change.restoreMove).includes(node.parentId)) throw conflict('恢复时名称或位置变化');
        if (node.title !== change.before.title) {
          change.restoreTitle = 'pending'; await persist(journal);
          const live=await current();checkPhaseOrder(journal,live.nodes);
          const fresh=live.nodes.get(change.id);
          if(!fresh || fresh.unmodifiable || fresh.url!==change.url || !allowedValue(change.rename,change.before.title,change.after.title,change.restoreTitle).includes(fresh.title) || !allowedValue(change.move,change.before.parentId,change.after.parentId,change.restoreMove).includes(fresh.parentId)) throw conflict('恢复改名前书签变化');
          await bookmarks.update(change.id,{title:change.before.title});
        }
        change.restoreTitle = 'done'; await persist(journal);
      }
      // Ascending original indices restore order even when several bookmarks left one parent.
      const moved = journal.changes.filter(change => change.move !== 'none' && change.move !== 'not_started');
      moved.sort((a,b)=>a.before.parentId.localeCompare(b.before.parentId) || a.before.index-b.before.index);
      for (const change of moved) {
        checkPhaseOrder(journal,(await current()).nodes);
        const [node] = await bookmarks.get(change.id);
        if (node.url !== change.url || node.title !== change.before.title || !allowedValue(change.move,change.before.parentId,change.after.parentId,change.restoreMove).includes(node.parentId)) throw conflict('恢复时位置变化');
        if (node.parentId !== change.before.parentId || node.index !== change.before.index) {
          change.restoreMove = 'pending'; await persist(journal);
          await prepareMove(journal,change,change.before.parentId,change.before.index);
          const live=await current();checkPhaseOrder(journal,live.nodes);
          const fresh=live.nodes.get(change.id);const destination=live.nodes.get(change.before.parentId);
          if(!fresh || fresh.unmodifiable || !destination || destination.unmodifiable || fresh.url!==change.url || fresh.title!==change.before.title || !allowedValue(change.move,change.before.parentId,change.after.parentId,change.restoreMove).includes(fresh.parentId)) throw conflict('恢复移动前书签变化');
          await bookmarks.move(change.id,{parentId:change.before.parentId,index:change.before.index});
          await finishMove(journal);
        }
        change.restoreMove = 'done'; await persist(journal);
      }
      let keptFolders = 0;
      for (const folder of journal.createdFolders.toReversed()) {
        if (!folder.id || folder.removed) continue;
        const nodes = (await current()).nodes;
        const node = nodes.get(folder.id);
        if (!node) { folder.removed = true; await persist(journal); continue; }
        if (node.parentId !== folder.parentId || ![folder.title,folder.marker].includes(node.title)) throw conflict('分类文件夹变化');
        const children = await bookmarks.getChildren(folder.id);
        if (children.length) { keptFolders++; continue; }
        folder.removing = true; await persist(journal);
        const live=await current();checkPhaseOrder(journal,live.nodes);
        const fresh=live.nodes.get(folder.id);
        if(!fresh || fresh.unmodifiable || fresh.parentId!==folder.parentId || ![folder.title,folder.marker].includes(fresh.title)) throw conflict('清理前分类文件夹变化');
        if((await bookmarks.getChildren(folder.id)).length) {folder.removing=false;keptFolders++;await persist(journal);continue;}
        await bookmarks.remove(folder.id);
        journal.expectedOrders=Object.fromEntries(Object.entries(journal.expectedOrders).map(([id,children])=>[id,children.filter(child=>child!==folder.id)]));
        folder.removed = true; await persist(journal);
      }
      live = await current();
      for (const change of journal.changes) {
        const node = live.nodes.get(change.id);
        if (!node || node.url !== change.url || node.title !== change.before.title || node.parentId !== change.before.parentId) throw conflict('恢复结果不一致');
      }
      const remaining = history.filter(entry=>entry.id!==journal.id);
      await storage.set({journal:null,history:remaining});
      return {restored:journal.changes.length,keptFolders};
    } catch (error) {
      await persist(journal).catch(()=>{});
      throw new Error(`恢复未完成：${error.message}。可检查后再次恢复。`);
    }
  }
  return {
    getState:read,
    apply:(plan,edits,settings)=>withLock(()=>applyUnlocked(plan,edits,settings)),
    undo:()=>withLock(async()=>{
      const state = await read(); if (state.journal) throw new Error('请先恢复未完成操作');
      if (!state.history.length) throw new Error('没有可撤销的整理');
      return restore(clone(state.history[0]),state.history,true);
    }),
    recover:()=>withLock(async()=>{
      const state = await read(); if (!state.journal) throw new Error('没有待恢复的操作');
      return restore(state.journal,state.history,false);
    })
  };
}
