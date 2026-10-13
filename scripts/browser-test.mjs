import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {fingerprint,flattenTree} from '../extension/core/tree.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
let playwright;
for(const location of [process.env.PLAYWRIGHT_MODULE_PATH,'playwright',join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
  try {playwright=require(location);break;} catch {}
}
if(!playwright) throw new Error('请通过 PLAYWRIGHT_MODULE_PATH 指定已有 Playwright，或在开发环境安装 Playwright');
const targets=[
  {name:'Chrome',path:'C:/Program Files/Google/Chrome/Application/chrome.exe'},
  {name:'Edge',path:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}
].filter(target=>existsSync(target.path));
if(!targets.length) targets.push({name:'Chromium',path:process.env.BROWSER_EXECUTABLE || undefined});
const artifacts=join(root,'artifacts');
const profileBase=join(root,'.test-profiles');
await mkdir(artifacts,{recursive:true});await mkdir(profileBase,{recursive:true});
const report={createdAt:new Date().toISOString(),profileIsolation:true,browsers:[]};
for(const target of targets) {
  const profile=await mkdtemp(join(profileBase,`${target.name.toLowerCase()}-`));
  let context,passed=false;
  const result={name:target.name,tests:[],externalRequests:[],pageErrors:[]};
  try {
    context=await playwright.chromium.launchPersistentContext(profile,{
      headless:true,...(target.path ? {executablePath:target.path} : {channel:'chromium'}),
      ignoreDefaultArgs:['--disable-extensions'],
      args:['--enable-unsafe-extension-debugging','--disable-background-networking'],
      viewport:{width:1440,height:1000}
    });
    result.version=context.browser().version();
    const cdp=await context.browser().newBrowserCDPSession();
    const loaded=await cdp.send('Extensions.loadUnpacked',{path:join(root,'extension')});
    const page=await context.newPage();
    page.on('pageerror',error=>result.pageErrors.push(error.message));
    page.on('request',request=>{if(/^https?:/u.test(request.url())) result.externalRequests.push(request.url());});
    await page.goto(`chrome-extension://${loaded.id}/app.html`);
    const send=message=>page.evaluate(async message=>{
      const result=await chrome.runtime.sendMessage(message);
      if(!result.ok) throw new Error(result.error);
      return result.data;
    },message);
    await page.waitForFunction(()=>!document.getElementById('scope').disabled);
    const fixture=await page.evaluate(async()=>{
      const tree=await chrome.bookmarks.getTree();
      const flat=nodes=>nodes.flatMap(node=>[node,...flat(node.children || [])]);
      const scope=flat(tree).find(node=>node.folderType==='bookmarks-bar' && !node.unmodifiable);
      if(!scope) throw new Error('没有可编辑书签栏');
      const old=await chrome.bookmarks.create({parentId:scope.id,title:'原有开发'});
      const locked=await chrome.bookmarks.create({parentId:scope.id,title:'保留专题'});
      const nested=await chrome.bookmarks.create({parentId:old.id,title:'MDN Web Docs - JavaScript 教程',url:'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript?lang=zh#scope'});
      const lockedChild=await chrome.bookmarks.create({parentId:locked.id,title:'GitHub Education',url:'https://education.github.com/'});
      const cancel=await chrome.bookmarks.create({parentId:scope.id,title:'GitHub - 项目主页',url:'https://github.com/example/bookmark-tidy?view=readme#start'});
      await chrome.bookmarks.create({parentId:scope.id,title:'GitHub 重复保留项',url:cancel.url});
      await chrome.bookmarks.create({parentId:scope.id,title:'ChatGPT - AI 对话',url:'https://chatgpt.com/'});
      await chrome.bookmarks.create({parentId:scope.id,title:'Notion - 工作空间',url:'https://www.notion.so/'});
      const lockedUrl=await chrome.bookmarks.create({parentId:scope.id,title:'Gmail - 常用入口',url:'https://mail.google.com/mail/u/0/#inbox'});
      await chrome.bookmarks.create({parentId:scope.id,title:'我的页面',url:'https://example.com/private/path?opaque=kept#fragment'});
      return {scopeId:scope.id,scopeTitle:scope.title,oldId:old.id,lockedId:locked.id,nestedId:nested.id,lockedChildId:lockedChild.id,cancelId:cancel.id,lockedUrlId:lockedUrl.id,lockedUrl:lockedUrl.url};
    });
    const config=(await send({command:'inspect'})).settings;
    config.lockedBookmarkUrls=[fixture.lockedUrl];config.lockedFolderPaths=[[fixture.scopeTitle,'保留专题']];
    await send({command:'saveSettings',settings:config});
    await page.reload();await page.waitForFunction(()=>!document.getElementById('scope').disabled);
    await page.selectOption('#scope',fixture.scopeId);
    const before=(await send({command:'inspect'})).tree;
    const beforeNodes=new Map(flattenTree(before).map(node=>[node.id,node]));
    await page.click('#preview-button');
    await page.waitForFunction(()=>document.getElementById('plan-state').textContent==='等待你确认');
    let plan=(await send({command:'inspect'})).plan;
    assert.equal(fingerprint((await send({command:'inspect'})).tree),fingerprint(before));
    assert.ok(!plan.items.some(item=>[fixture.lockedChildId,fixture.lockedUrlId].includes(item.id)));
    result.tests.push('预览只读、文件夹与网址锁定');
    await page.locator(`tr[data-item-id="${fixture.cancelId}"] .item-selected`).uncheck();
    await page.screenshot({path:join(artifacts,`${target.name.toLowerCase()}-preview.png`),fullPage:true});
    await page.click('#apply-button');
    await page.waitForFunction(()=>document.getElementById('notice').dataset.kind==='success');
    const after=(await send({command:'inspect'})).tree;
    const afterNodes=new Map(flattenTree(after).map(node=>[node.id,node]));
    for(const node of beforeNodes.values()) {
      if(node.url!==undefined) assert.equal(afterNodes.get(node.id)?.url,node.url);
    }
    assert.equal(flattenTree(after).filter(node=>node.url!==undefined).length,flattenTree(before).filter(node=>node.url!==undefined).length);
    for(const id of [fixture.cancelId,fixture.lockedChildId,fixture.lockedUrlId]) {
      assert.equal(afterNodes.get(id).title,beforeNodes.get(id).title);assert.equal(afterNodes.get(id).parentId,beforeNodes.get(id).parentId);
    }
    assert.ok(afterNodes.has(fixture.oldId),'保留原文件夹');
    result.tests.push('实际界面应用：完整网址逐字保留、重复保留、取消项与锁定项不变');
    await page.click('#undo-button');
    await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('已撤销'));
    assert.equal(fingerprint((await send({command:'inspect'})).tree),fingerprint(before));
    result.tests.push('实际界面撤销：名称、父位置、顺序完全恢复');
    await page.evaluate(async({scopeId,oldId})=>{
      await chrome.bookmarks.create({parentId:scopeId,title:'Canva - 设计与创作',url:'https://www.canva.com/'});
      await chrome.bookmarks.create({parentId:oldId,title:'GitHub 新增嵌套条目',url:'https://github.com/example/nested'});
    },fixture);
    const incrementalBefore=(await send({command:'inspect'})).tree;
    const nestedBefore=flattenTree(incrementalBefore).filter(node=>node.url!==undefined && node.parentId!==fixture.scopeId);
    plan=await send({command:'preview',options:{scopeId:fixture.scopeId,mode:'incremental',granularity:'many'}});
    assert.ok(plan.items.every(item=>item.oldParentId===fixture.scopeId));
    await send({command:'apply',planId:plan.id,edits:[]});
    const incNodes=new Map(flattenTree((await send({command:'inspect'})).tree).map(node=>[node.id,node]));
    for(const node of nestedBefore) assert.deepEqual(incNodes.get(node.id),node);
    await send({command:'undo'});
    assert.equal(fingerprint((await send({command:'inspect'})).tree),fingerprint(incrementalBefore));
    result.tests.push('整理新增只处理外层；已有文件夹内条目完全不变');
    plan=await send({command:'preview',options:{scopeId:fixture.scopeId,mode:'full',granularity:'balanced'}});
    await page.evaluate(async id=>chrome.bookmarks.update(id,{title:'预览后用户修改'}),fixture.cancelId);
    await assert.rejects(send({command:'apply',planId:plan.id,edits:[]}),/过期|变化/u);
    result.tests.push('实际 API 变化使旧预览失效');
    const exported=JSON.parse(await send({command:'exportRules'}));
    assert.ok(!('apiKey' in exported));
    assert.equal(result.externalRequests.length,0);assert.deepEqual(result.pageErrors,[]);
    result.tests.push('默认本地界面零外联、无页面错误、规则导出无密钥');
    passed=true;result.passed=true;
    console.log(`${target.name} ${result.version}: ${result.tests.length} checks passed`);
  } catch(error) {
    result.passed=false;result.error=error.message;result.profile=profile;process.exitCode=1;
    console.error(`${target.name}: ${error.message}`);
  } finally {
    if(context) await context.close();
    if(passed) {
      const resolved=resolve(profile);
      if(resolved.startsWith(resolve(profileBase)+ '\\') || resolved.startsWith(resolve(profileBase)+'/')) await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:300});
    }
    report.browsers.push(result);
    await writeFile(join(artifacts,'browser-report.json'),JSON.stringify(report,null,2));
  }
}
