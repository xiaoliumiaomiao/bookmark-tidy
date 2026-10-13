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
