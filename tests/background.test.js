import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeEnvironment} from './helpers/bookmarks.js';
const mod=await import('../extension/background.js').catch(()=>({}));
test('后台只接受扩展自己的工作区页面，不接受外部页面或未知命令',async()=>{
  assert.equal(typeof mod.senderAllowed,'function','后台授权边界尚未实现');
  const api={runtime:{id:'demo',getURL:p=>`chrome-extension://demo/${p}`}};
  assert.equal(mod.senderAllowed({id:'other',url:'https://example.com'},api),false);
  assert.equal(mod.senderAllowed({id:'demo',url:'https://example.com'},api),false);
  assert.equal(mod.senderAllowed({id:'demo',url:'chrome-extension://demo/app.html'},api),true);
});
test('预览和 inspect 不写入书签；伪造 planId 拒绝',async()=>{
  assert.equal(typeof mod.createController,'function','后台控制器尚未实现');
  const env=fakeEnvironment();
  const dispatch=mod.createController({...env,permissions:{contains:async()=>false}});
  await dispatch({command:'inspect'});
  const plan=await dispatch({command:'preview',options:{scopeId:'1',mode:'incremental',granularity:'balanced'}});
  assert.ok(plan.items.length>0);assert.equal(env.calls.length,0);
  await assert.rejects(dispatch({command:'apply',planId:'forged',edits:[]}),/预览/);
  assert.equal(env.calls.length,0);
});
test('AI成功响应回显密钥被后台拒绝，任何持久化状态均不含该密钥',async()=>{
  const env=fakeEnvironment();const dispatch=mod.createController({...env,permissions:{contains:async()=>true}});
  const plan=await dispatch({command:'preview',options:{scopeId:'1',mode:'incremental',granularity:'balanced'}});
  const synthetic='synthetic-'+'integration-credential';const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:JSON.stringify([{id:plan.items[0].id,title:synthetic}])}}]})});
  try {
    await assert.rejects(dispatch({command:'aiSuggestions',planId:plan.id,endpoint:'https://example.com/chat',model:'test',apiKey:synthetic,confirmed:true}),/敏感|凭据/u);
    assert.ok(!JSON.stringify(env.values).includes(synthetic));assert.equal(env.calls.length,0);
  } finally {globalThis.fetch=originalFetch;}
});
