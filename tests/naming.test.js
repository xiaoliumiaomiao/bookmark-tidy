import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestTitle, classifyBookmark } from '../extension/core/naming.js';

test('cleans whitespace without dropping an unknown page topic', () => {
  assert.equal(suggestTitle({ title: '  山城\n  资料 / 2026 年第二季度  ', url: 'https://unknown.example/topic?a=1' }), '山城 资料 / 2026 年第二季度');
});

test('recognizable homepages receive short names', () => {
  assert.equal(suggestTitle({ title: 'GitHub · Build and ship software', url: 'https://github.com/' }), 'GitHub');
  assert.equal(suggestTitle({ title: '腾讯云 - 产业智变 云启未来', url: 'https://cloud.tencent.com/' }), '腾讯云');
});

test('short names retain the specific page topic', () => {
  assert.equal(suggestTitle({ title: 'React useEffect reference | React', url: 'https://react.dev/reference/react/useEffect' }), 'React useEffect reference');
  assert.equal(suggestTitle({ title: '年度纪录片 - YouTube', url: 'https://www.youtube.com/watch?v=abc' }), '年度纪录片');
});

test('unknown and malformed URLs do not invent website names or categories', () => {
  for (const url of ['https://unknown.example/plain', 'javascript:alert(1)', 'not a URL']) {
    assert.equal(suggestTitle({ title: '特殊页面', url }), '特殊页面');
    assert.deepEqual(classifyBookmark({ title: '特殊页面', url }).category, null);
    assert.equal(classifyBookmark({ title: '特殊页面', url }).confidence, 'review');
  }
});

test('known hosts are matched by domain boundary', () => {
  assert.equal(classifyBookmark({ title: '主页', url: 'https://github.com.evil.example/' }).category, null);
  assert.equal(classifyBookmark({ title: '主页', url: 'https://evilgithub.com/' }).category, null);
  assert.equal(classifyBookmark({ title: '项目', url: 'https://gist.github.com/user/id' }).category, '开发工具');
});

test('Chinese and English purpose keywords classify unfamiliar websites', () => {
  assert.equal(classifyBookmark({ title: '重庆事业单位考试公告', url: 'https://unknown.example/2026' }).category, '生活服务');
  assert.equal(classifyBookmark({ title: 'JavaScript API reference', url: 'https://unknown.example/page' }).category, '开发工具');
  assert.equal(classifyBookmark({ title: 'AI 图像生成工具', url: 'https://unknown.example/page' }).category, 'AI 工具');
});

test('URL purpose clues classify otherwise unnamed documentation', () => {
  assert.equal(classifyBookmark({ title: '页面', url: 'https://unknown.example/docs/reference/start' }, 'many').category, '开发文档');
});

test('few, balanced and many change grouping at distinct levels', () => {
  const bookmarks = [
    { title: '项目', url: 'https://github.com/acme/project' },
    { title: '文档', url: 'https://developer.mozilla.org/en-US/docs/Web' },
    { title: '云', url: 'https://cloud.tencent.com/product' },
  ];
  const counts = ['few', 'balanced', 'many'].map((g) => new Set(bookmarks.map((b) => classifyBookmark(b, g).category)).size);
  assert.deepEqual(counts, [1, 2, 3]);
});

test('rejects unsupported granularity', () => {
  assert.throws(() => classifyBookmark({ title: '文档', url: 'https://github.com/' }, 'extreme'), /granularity|粒度/);
});

test('ordinary words containing ai do not trigger AI classification', () => {
  assert.equal(classifyBookmark({ title: 'Mail archive and daily notes', url: 'https://unknown.example/' }).category, null);
});

test('a known site query or hash retains the specific homepage topic', () => {
  assert.equal(suggestTitle({ title: '专题检索 | GitHub', url: 'https://github.com/?q=专题' }), '专题检索');
  assert.equal(suggestTitle({ title: '具体片段 - YouTube', url: 'https://youtube.com/#clip' }), '具体片段');
});

test('product subdomain homepages retain their specific topic', () => {
  assert.equal(suggestTitle({ title: 'GitHub Education', url: 'https://education.github.com/' }), 'GitHub Education');
  assert.equal(suggestTitle({ title: 'GitLab System Status', url: 'https://status.gitlab.com/' }), 'GitLab System Status');
  assert.equal(suggestTitle({ title: 'RAM 控制台 - 阿里云', url: 'https://ram.console.aliyun.com/' }), 'RAM 控制台');
  assert.equal(suggestTitle({ title: 'React useEffect reference', url: 'https://react.dev/' }), 'React useEffect reference');
});

test('automatic names preserve long topics instead of suggesting an invalid or truncated title', () => {
  const title = `${'具体页面主题'.repeat(40)} - GitHub`;
  assert.equal(suggestTitle({ title, url: 'https://github.com/acme/project' }), title);
  const unknownTitle = `  ${'具体页面主题'.repeat(40)}  `;
  assert.equal(suggestTitle({ title: unknownTitle, url: 'https://unknown.example/topic' }), unknownTitle);
  assert.equal(suggestTitle({ title: '  ', url: 'https://unknown.example/topic' }), '  ');
});
