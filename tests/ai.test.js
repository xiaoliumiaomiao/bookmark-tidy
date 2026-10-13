import test from 'node:test';
import assert from 'node:assert/strict';
const ai = await import('../extension/core/ai.js').catch(()=>({}));
const plan = {granularity:'balanced',items:[{id:'a',oldTitle:'教程',url:'https://example.com/private/path?opaque=value#part',newTitle:'教程',targetFolderKey:null}],folders:[{key:'dev',title:'开发工具'}]};
test('AI 待发送数据仅有 id、原始标题、域名，不含完整网址',()=>{
  assert.equal(typeof ai.buildAIPayload,'function','AI 边界尚未实现');
  assert.deepEqual(ai.buildAIPayload(plan),[{id:'a',title:'教程',hostname:'example.com'}]);
});
test('拒绝远程 HTTP、含密码地址和跳转风险，允许 HTTPS 或回环本机',()=>{
  assert.equal(typeof ai.validateEndpoint,'function','地址校验尚未实现');
  assert.throws(()=>ai.validateEndpoint('http://example.com/v1/chat/completions'));
  assert.throws(()=>ai.validateEndpoint('https://user:password@example.com/v1/chat/completions'));
  assert.throws(()=>ai.validateEndpoint('https://example.com/path?api_key=value'));
  assert.equal(ai.validateEndpoint('http://127.0.0.1:1234/v1/chat/completions').origin,'http://127.0.0.1:1234');
});
test('未经明确确认不发送；确认后禁止携带cookie且不允许重定向',async()=>{
  assert.equal(typeof ai.requestSuggestions,'function','请求边界尚未实现');
  let calls=0;
  const fetchImpl = async (url,options)=>{calls++; assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');
    assert.ok(!options.body.includes('private/path')); return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'[{"id":"a","title":"开发教程","category":"开发工具"}]'}}]})};};
  await assert.rejects(ai.requestSuggestions(plan,{endpoint:'https://example.com/v1/chat/completions',model:'test',confirmed:false},fetchImpl));
  assert.equal(calls,0);
  const result=await ai.requestSuggestions(plan,{endpoint:'https://example.com/v1/chat/completions',model:'test',confirmed:true},fetchImpl);
  assert.equal(result.items[0].newTitle,'开发教程'); assert.equal(result.items[0].url,plan.items[0].url);
});
test('AI 请求不外发用户私人目录名，只有固定内置分类和已预览书签字段',async()=>{
  const privatePlan=structuredClone(plan);privatePlan.folders.push({key:'private',title:'私人项目目录名称'});
  await ai.requestSuggestions(privatePlan,{endpoint:'https://example.com/chat',model:'test',confirmed:true},async(url,options)=>{
    assert.ok(!options.body.includes('私人项目目录名称'));
    const messages=JSON.parse(options.body).messages;
    assert.deepEqual(JSON.parse(messages[1].content),ai.buildAIPayload(privatePlan));
    return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'[]'}}]})};
  });
});
test('服务成功响应回显本次密钥时拒绝建议，密钥不进入预览',async()=>{
  const synthetic='synthetic-'+'credential-for-review';
  await assert.rejects(ai.requestSuggestions(plan,{endpoint:'https://example.com/chat',model:'test',confirmed:true,apiKey:synthetic},async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:JSON.stringify([{id:'a',title:synthetic}])}}]})})),/敏感|凭据/u);
  assert.equal(plan.items[0].newTitle,'教程');
});
test('AI不能返回网址、未知ID或任意目录，异常响应不会部分修改预览',()=>{
  assert.equal(typeof ai.mergeSuggestions,'function','建议校验尚未实现');
  for(const suggestions of [[{id:'x',title:'改名'}],[{id:'a',url:'https://evil.example'}],[{id:'a',category:'未授权文件夹'}],[{id:'a',title:'a'},{id:'a',title:'b'}]]) {
    assert.throws(()=>ai.mergeSuggestions(plan,suggestions));
  }
  assert.equal(plan.items[0].newTitle,'教程');
});
