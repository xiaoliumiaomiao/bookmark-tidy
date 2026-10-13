import test from 'node:test';
import assert from 'node:assert/strict';
const backup=await import('../extension/core/backup.js').catch(()=>({}));
test('HTML备份保留文件夹、完整网址和重复条目，浏览器可识别格式',()=>{
  assert.equal(typeof backup.exportBookmarkHTML,'function','可导入备份尚未实现');
  const result=backup.exportBookmarkHTML({version:1,tree:[{id:'0',title:'',children:[{id:'1',title:'书签栏',folderType:'bookmarks-bar',children:[{id:'a',title:'教程',url:'https://example.com/path?a=1&b=2#section'},{id:'b',title:'副本',url:'https://example.com/path?a=1&b=2#section'}]}]}]});
  assert.match(result,/NETSCAPE-Bookmark-file-1/u);assert.match(result,/PERSONAL_TOOLBAR="true"/u);
  assert.equal((result.match(/<A HREF=/gu)||[]).length,2);
  assert.match(result,/https:\/\/example.com\/path\?a=1&amp;b=2#section/u);
});
test('不可信标题和网址被转义，导出文档不能注入脚本或属性',()=>{
  assert.equal(typeof backup.exportBookmarkHTML,'function','可导入备份尚未实现');
  const html=backup.exportBookmarkHTML({version:1,tree:[{id:'a',title:'</A><script>alert(1)</script>',url:'https://example.com/" onmouseover="bad'}]});
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&quot; onmouseover=&quot;bad'));
});
