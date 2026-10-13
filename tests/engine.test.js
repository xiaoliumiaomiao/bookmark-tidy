import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnvironment } from './helpers/bookmarks.js';
const engineModule = await import('../extension/core/engine.js').catch(() => ({}));
const settings = {version:1,granularity:'balanced',lockedBookmarkUrls:[],lockedFolderPaths:[],rules:[],overrides:[]};
async function setup() {
  assert.equal(typeof engineModule.createEngine, 'function', '事务引擎尚未实现');
  const env = fakeEnvironment();
  const { fingerprint } = await import('../extension/core/tree.js');
  const before = await env.bookmarks.getTree();
  const plan = {version:1,id:'test-plan',scopeId:'1',mode:'full',sourceFingerprint:fingerprint(before),
    folders:[{key:'dev',title:'开发',parentId:'1'}], items:['a','b'].map(id => {
      const n = env.find(id); return {id,url:n.url,oldTitle:n.title,newTitle:id==='a'?'GitHub·项目':'MDN·教程',oldParentId:n.parentId,oldIndex:n.index,targetFolderKey:'dev',selected:true};
    })};
  return {env,plan,before,engine:engineModule.createEngine(env),fingerprint};
}
test('应用仅改标题和位置，保留每个完整网址和重复书签', async () => {
  const {env,engine,plan,before} = await setup(); await engine.apply(plan, [], settings);
  assert.equal(env.find('a').url, before[0].children[0].children[0].children[0].url);
  assert.equal(env.find('d').url, env.find('e').url);
  assert.equal(env.find('a').title,'GitHub·项目');
  assert.equal(env.find('a').parentId,env.find('b').parentId);
  assert.ok(env.calls.every(call => call.method !== 'update' || !('url' in call.data)));
  assert.equal((await engine.getState()).history.length,1);
});
test('撤销恢复名称、父文件夹、原始顺序，清理自己新建的空文件夹', async () => {
  const {engine,plan,before,env,fingerprint} = await setup(); await engine.apply(plan,[],settings); await engine.undo();
  assert.equal(fingerprint(await env.bookmarks.getTree()),fingerprint(before));
});
test('预览后书签发生变动时拒绝应用且不写入', async () => {
  const {env,engine,plan} = await setup(); env.find('d').title='用户新标题';
  await assert.rejects(engine.apply(plan,[],settings),/变|过期|重新/);
  assert.equal(env.calls.length,0);
});
test('取消条目不修改；非法目标和重复编辑拒绝', async () => {
  const {env,engine,plan} = await setup();
  await assert.rejects(engine.apply(plan,[{id:'a',selected:true,newTitle:'改名',targetFolderKey:'missing'}],settings));
  assert.equal(env.calls.length,0);
  await engine.apply(plan,[{id:'b',selected:false}],settings);
  assert.equal(env.find('b').title,'MDN Web Docs - 教程'); assert.equal(env.find('b').parentId,'10');
});
test('移动响应丢失后保留日志，重新建立引擎可恢复撤销', async () => {
  const {env,engine,plan,before,fingerprint} = await setup(); env.failNext('move',true);
  await assert.rejects(engine.apply(plan,[],settings),/中断|丢失/);
  assert.ok((await engine.getState()).journal);
  await engineModule.createEngine(env).recover();
  assert.equal(fingerprint(await env.bookmarks.getTree()),fingerprint(before));
});
test('创建文件夹响应丢失可用唯一标记恢复，重试不产生副本', async () => {
  const {env,engine,plan,before,fingerprint} = await setup(); env.failNext('create',true);
  await assert.rejects(engine.apply(plan,[],settings)); await engine.recover();
  assert.equal(fingerprint(await env.bookmarks.getTree()),fingerprint(before));
  await engine.apply(plan,[],settings); await engine.undo();
  assert.equal(fingerprint(await env.bookmarks.getTree()),fingerprint(before));
});
test('撤销前用户修改过受影响书签则停止并保持用户修改', async () => {
  const {env,engine,plan} = await setup(); await engine.apply(plan,[],settings);
  env.find('a').title='用户后来的决定'; const snapshot = structuredClone(await env.bookmarks.getTree());
  await assert.rejects(engine.undo(),/冲突|修改/);
  assert.deepEqual(await env.bookmarks.getTree(),snapshot);
});
test('撤销保留之后新增的无关书签，以及新分类中的用户新增项', async () => {
  const {env,engine,plan} = await setup(); await engine.apply(plan,[],settings);
  const createdParent = env.find('a').parentId;
  await env.bookmarks.create({parentId:createdParent,title:'用户新增',url:'https://example.com/new'});
  await engine.undo();
  assert.equal(env.find('a').parentId,'10');
  assert.ok((await env.bookmarks.getChildren(createdParent)).some(node=>node.title==='用户新增'));
});
test('存在待恢复日志时禁止另一次整理', async () => {
  const {env,engine,plan} = await setup(); env.failNext('move'); await assert.rejects(engine.apply(plan,[],settings));
  await assert.rejects(engine.apply(plan,[],settings),/恢复|未完成/);
});
test('复用既有深层长名称文件夹，不修改该文件夹名称', async()=>{
  const {env,engine,plan,fingerprint}=await setup();
  env.find('10').title='专题'.repeat(110);
  plan.sourceFingerprint=fingerprint(await env.bookmarks.getTree());
  plan.folders=[{key:'dev',existingId:'10',parentId:'1',title:env.find('10').title}];
  await engine.apply(plan,[],settings);
  assert.equal(env.find('10').title,'专题'.repeat(110));
  assert.ok(env.calls.every(call=>call.method!=='create'));
});
test('移动尚未执行就中断，之后用户排序时恢复应停止而不是覆盖顺序',async()=>{
  const {env,engine,plan}=await setup();env.failNext('move');
  await assert.rejects(engine.apply(plan,[],settings));
  await env.bookmarks.move('a',{parentId:'10',index:2});
  const snapshot=await env.bookmarks.getTree();
  await assert.rejects(engineModule.createEngine(env).recover(),/顺序|冲突/u);
  assert.deepEqual(await env.bookmarks.getTree(),snapshot);
});
test('撤销移动响应丢失后用户排序，恢复不能重新覆盖用户排序',async()=>{
  const {env,engine,plan}=await setup();await engine.apply(plan,[],settings);
  env.failNext('move',true);await assert.rejects(engine.undo());
  await env.bookmarks.move('a',{parentId:'10',index:1});
  const snapshot=await env.bookmarks.getTree();
  await assert.rejects(engineModule.createEngine(env).recover(),/顺序|冲突/u);
  assert.deepEqual(await env.bookmarks.getTree(),snapshot);
});
test('应用开始后目的分类移出范围，不得把书签移到范围外',async()=>{
  const {env,engine,plan,fingerprint}=await setup();
  const node=env.find('d');plan.items=[{id:'d',url:node.url,oldTitle:node.title,newTitle:node.title,oldParentId:node.parentId,oldIndex:node.index,targetFolderKey:'dev',selected:true}];
  plan.folders=[{key:'dev',title:'旧开发',parentId:'1',existingId:'10'}];
  plan.sourceFingerprint=fingerprint(await env.bookmarks.getTree());
  const save=env.storage.set;let once=true;
  env.storage.set=async data=>{await save(data);if(data.backup && once){once=false;await env.bookmarks.move('10',{parentId:'2'});}};
  await assert.rejects(engine.apply(plan,[],settings),/范围|冲突|顺序/u);
  assert.equal(env.find('d').parentId,'1');
});
test('整理新增允许保留当前位置而只改名称',async()=>{
  const {env,engine,plan}=await setup();const n=env.find('d');
  plan.mode='incremental';plan.folders=[];
  plan.items=[{id:n.id,url:n.url,oldTitle:n.title,newTitle:'ChatGPT',oldParentId:n.parentId,oldIndex:n.index,targetFolderKey:null,selected:true}];
  await engine.apply(plan,[],settings);
  assert.equal(env.find('d').title,'ChatGPT');assert.equal(env.find('d').parentId,'1');
  await engine.undo();assert.equal(env.find('d').title,n.title);
});
test('记录移动准备阶段时嵌套目的地漂移，最终写前检查应拒绝',async()=>{
  const {env,engine,plan,fingerprint}=await setup();
  const destination=await env.bookmarks.create({parentId:'10',title:'开发工具'});
  const n=env.find('d');plan.items=[{id:n.id,url:n.url,oldTitle:n.title,newTitle:n.title,oldParentId:n.parentId,oldIndex:n.index,targetFolderKey:'dev',selected:true}];
  plan.folders=[{key:'dev',title:destination.title,parentId:'10',existingId:destination.id}];plan.sourceFingerprint=fingerprint(await env.bookmarks.getTree());
  const save=env.storage.set;let once=true;
  env.storage.set=async data=>{await save(data);if(once && data.journal?.orderProof && data.journal.changes[0].move==='pending'){once=false;await env.bookmarks.move(destination.id,{parentId:'2'});}};
  await assert.rejects(engine.apply(plan,[],settings),/范围|冲突/u);assert.equal(env.find('d').parentId,'1');
});
test('记录改名准备阶段时用户改名，不能覆盖后来的名称',async()=>{
  const {env,engine,plan}=await setup();const save=env.storage.set;let once=true;
  env.storage.set=async data=>{await save(data);if(once && data.journal?.changes[0].rename==='pending'){once=false;env.find('a').title='后来的人工名称';}};
  await assert.rejects(engine.apply(plan,[],settings),/冲突|名称|变化/u);assert.equal(env.find('a').title,'后来的人工名称');
});
test('清理新建空目录准备阶段用户改名，不删除用户后来保留的目录',async()=>{
  const {env,engine,plan}=await setup();await engine.apply(plan,[],settings);
  const folderId=env.find('a').parentId;const save=env.storage.set;let once=true;
  env.storage.set=async data=>{await save(data);if(once && data.journal?.createdFolders.some(folder=>folder.removing)){once=false;env.find(folderId).title='用户后来保留的目录';}};
  await assert.rejects(engine.undo(),/冲突|分类|变化/u);
  assert.equal(env.find(folderId).title,'用户后来保留的目录');
});
