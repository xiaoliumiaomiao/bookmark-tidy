import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenTree, findScopeRoots, fingerprint, folderPath } from '../extension/core/tree.js';
import { buildPlan } from '../extension/core/planner.js';
import { DEFAULT_SETTINGS } from '../extension/core/settings.js';

function fixture() {
  return [{ id: 'virtual', title: '', children: [
    { id: 'bar-a', title: '书签栏', folderType: 'bookmarks-bar', children: [
      { id: 'github', title: ' Acme project - GitHub ', url: 'https://github.com/acme/project?tab=readme#中文' },
      { id: 'duplicate', title: '另一个项目', url: 'https://github.com/acme/project?tab=readme#中文' },
      { id: 'unknown', title: '  独特主题  ', url: 'https://unknown.example/topic?token=local-only' },
      { id: 'dev', title: '开发', children: [
        { id: 'mdn', title: 'Array API reference | MDN', url: 'https://developer.mozilla.org/docs/Web/JavaScript/Array' },
      ] },
      { id: 'locked', title: '旧资料', children: [
        { id: 'lock-nested', title: '深层', children: [
          { id: 'locked-bookmark', title: 'ChatGPT', url: 'https://chatgpt.com/' },
        ] },
      ] },
      { id: 'managed', title: '组织资料', unmodifiable: 'managed', children: [
        { id: 'managed-bookmark', title: '腾讯云', url: 'https://cloud.tencent.com/' },
      ] },
    ] },
    { id: 'bar-b', title: '另一个书签栏', folderType: 'bookmarks-bar', children: [
      { id: 'outside', title: '视频', url: 'https://youtube.com/watch?v=outside' },
    ] },
    { id: 'other', title: '其他书签', folderType: 'other', children: [] },
    { id: 'managed-root', title: '管理员', folderType: 'managed', unmodifiable: 'managed', children: [] },
  ] }];
}

const settings = (extra = {}) => ({ ...structuredClone(DEFAULT_SETTINGS), ...extra });
const plan = (tree, options = {}) => buildPlan(tree, { scopeId: 'bar-a', mode: 'full', granularity: 'balanced', settings: settings(), ...options });

test('flattened paths preserve ancestor segments and authoritative sibling order', () => {
  const flat = flattenTree(fixture());
  assert.deepEqual(flat.find((n) => n.id === 'mdn').path, ['书签栏', '开发']);
  assert.deepEqual(flat.find((n) => n.id === 'dev').path, ['书签栏', '开发']);
  assert.equal(folderPath(flat.find((n) => n.id === 'mdn')), '书签栏/开发');
  assert.equal(flat.find((n) => n.id === 'github').parentId, 'bar-a');
  assert.equal(flat.find((n) => n.id === 'duplicate').index, 1);
  assert.equal(flat.find((n) => n.id === 'managed-bookmark').unmodifiable, 'managed');
});

test('scope discovery supports multiple bars and fallbacks without fixed IDs', () => {
  assert.deepEqual(findScopeRoots(fixture()).map((n) => n.id), ['bar-a', 'bar-b', 'other']);
  const legacy = fixture();
  for (const node of legacy[0].children) delete node.folderType;
  assert.deepEqual(findScopeRoots(legacy).map((n) => n.id), ['bar-a', 'bar-b', 'other']);
});

test('fingerprint ignores browser timestamps, omitted indexes and sync metadata', () => {
  const original = fixture();
  const freshBrowser = structuredClone(original);
  const visit = (nodes, parentId) => nodes.forEach((n, index) => {
    n.index = index;
    if (parentId) n.parentId = parentId;
    n.dateAdded = Date.now(); n.dateGroupModified = Date.now(); n.syncing = true;
    if (n.children) visit(n.children, n.id);
  });
  visit(freshBrowser);
  assert.equal(fingerprint(original), fingerprint(freshBrowser));
});

test('fingerprint detects user title, URL, parent and sibling-order changes', () => {
  for (const mutate of [
    (t) => { t[0].children[0].children[0].title = '手动标题'; },
    (t) => { t[0].children[0].children[0].url += '&changed=1'; },
    (t) => { t[0].children[1].children.push(t[0].children[0].children.shift()); },
    (t) => { t[0].children[0].children.reverse(); },
  ]) {
    const modified = fixture(); mutate(modified);
    assert.notEqual(fingerprint(fixture()), fingerprint(modified));
  }
});

test('planning preserves literal URLs, duplicate nodes and immutable input', () => {
  const tree = fixture(); const before = structuredClone(tree);
  const result = plan(tree);
  const original = new Map(flattenTree(tree).filter((n) => n.url).map((n) => [n.id, n.url]));
  assert.ok(result.items.some((i) => i.id === 'github'));
  assert.ok(result.items.some((i) => i.id === 'duplicate'));
  for (const item of result.items) assert.equal(item.url, original.get(item.id));
  assert.deepEqual(tree, before);
  assert.equal(result.sourceFingerprint, fingerprint(tree));
  assert.equal(result.version, 1);
  assert.equal(typeof result.id, 'string');
  assert.ok(Number.isFinite(Date.parse(result.createdAt)));
});

test('incremental mode scans only direct bookmarks and reuses unlocked direct folders', () => {
  const result = plan(fixture(), { mode: 'incremental' });
  assert.deepEqual(result.items.map((i) => i.id), ['github', 'duplicate', 'unknown']);
  const github = result.items.find((i) => i.id === 'github');
  assert.equal(result.folders.find((f) => f.key === github.targetFolderKey).existingId, 'dev');
  assert.equal(result.stats.scanned, 3);
});

test('full mode permits nested bookmarks but excludes outside and managed nodes', () => {
  const result = plan(fixture());
  assert.ok(result.items.some((i) => i.id === 'mdn'));
  assert.ok(result.items.some((i) => i.id === 'locked-bookmark'));
  assert.ok(!result.items.some((i) => ['outside', 'managed-bookmark'].includes(i.id)));
  assert.equal(result.stats.locked, 1);
});

test('URL locks protect every duplicate and folder locks protect whole nested subtrees', () => {
  const result = plan(fixture(), { settings: settings({
    lockedBookmarkUrls: ['https://github.com/acme/project?tab=readme#中文'],
    lockedFolderPaths: [['书签栏', '旧资料']],
  }) });
  assert.deepEqual(result.items.map((i) => i.id), ['unknown', 'mdn']);
  assert.equal(result.stats.locked, 4);
});

test('folder locks do not confuse slashes inside a title with path separators', () => {
  const tree = fixture();
  tree[0].children[0].children.push({ id: 'slash', title: '旧资料/深层', children: [{ id: 'slash-book', title: 'GitHub', url: 'https://github.com/' }] });
  const result = plan(tree, { settings: settings({ lockedFolderPaths: [['书签栏', '旧资料', '深层']] }) });
  assert.ok(result.items.some((i) => i.id === 'slash-book'));
  assert.ok(!result.items.some((i) => i.id === 'locked-bookmark'));
});

test('locked folders cannot become classification destinations', () => {
  const result = plan(fixture(), { mode: 'incremental', settings: settings({ lockedFolderPaths: [['书签栏', '开发']] }) });
  assert.ok(!result.folders.some((f) => f.existingId === 'dev'));
  assert.ok(result.folders.some((f) => f.title === '开发工具' && !f.existingId));
});

test('unknown bookmarks stay in place while harmless title cleanup is allowed', () => {
  const result = plan(fixture());
  const unknown = result.items.find((i) => i.id === 'unknown');
  assert.equal(unknown.targetFolderKey, null);
  assert.equal(unknown.confidence, 'review');
  assert.equal(unknown.newTitle, '独特主题');
  assert.equal(unknown.selected, true);
});

test('manual URL overrides retain exact page titles and take precedence over rules', () => {
  const url = 'https://github.com/acme/project?tab=readme#中文';
  const result = plan(fixture(), { settings: settings({
    rules: [{ type: 'domain', pattern: 'github.com', category: '自动规则' }],
    overrides: [{ url, title: 'Acme 精确主题', category: '我的项目' }],
  }) });
  const overridden = result.items.filter((i) => i.url === url);
  assert.equal(overridden.length, 2);
  for (const item of overridden) {
    assert.equal(item.newTitle, 'Acme 精确主题');
    assert.equal(result.folders.find((f) => f.key === item.targetFolderKey).title, '我的项目');
  }
});

test('domain rules cannot match attacker-controlled hostname suffixes', () => {
  const tree = fixture();
  tree[0].children[0].children.push({ id: 'fake', title: '页面', url: 'https://github.com.attacker.example/' });
  const result = plan(tree, { settings: settings({ rules: [{ type: 'domain', pattern: 'github.com', category: '自定义' }] }) });
  const fake = result.items.find((i) => i.id === 'fake');
  assert.equal(fake.targetFolderKey, null);
  assert.equal(result.folders.find((f) => f.key === result.items.find((i) => i.id === 'github').targetFolderKey).title, '自定义');
});

test('no-op suggestions retain valid existing category options without intended writes', () => {
  const tree = [{ id: 'root', title: '', children: [{ id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: 'category', title: '开发工具', children: [{ id: 'same', title: '项目', url: 'https://github.com/acme/p' }] },
  ] }] }];
  const result = plan(tree, { scopeId: 'bar' });
  assert.equal(result.items[0].selected, false);
  assert.equal(result.folders.find((f) => f.key === result.items[0].targetFolderKey).existingId, 'category');
  assert.equal(result.stats.rename, 0);
  assert.equal(result.stats.move, 0);
});

test('scope and mode validation refuse virtual roots, bookmarks and managed folders', () => {
  for (const scopeId of ['virtual', 'github', 'managed-root', 'managed', 'missing']) assert.throws(() => plan(fixture(), { scopeId }), /范围|scope|文件夹/);
  assert.throws(() => plan(fixture(), { mode: 'delete' }), /模式|mode/);
  assert.throws(() => plan(fixture(), { granularity: 'extreme' }), /粒度|granularity/);
});

test('full planning preserves existing folders and can reuse nested destinations', () => {
  const tree = fixture();
  tree[0].children[0].children.push({ id: 'holder', title: '分类容器', children: [{ id: 'ai-folder', title: 'AI 工具', children: [] }] });
  const result = plan(tree);
  const chat = result.items.find((i) => i.id === 'locked-bookmark');
  assert.equal(result.folders.find((f) => f.key === chat.targetFolderKey).existingId, 'ai-folder');
  assert.ok(flattenTree(tree).some((n) => n.id === 'holder'));
  const incremental = plan(tree, { mode: 'incremental', settings: settings({ overrides: [{ url: 'https://github.com/acme/project?tab=readme#中文', category: 'AI 工具' }] }) });
  assert.ok(!incremental.folders.some((f) => f.existingId === 'ai-folder'));
});

test('granularity changes actually referenced categories when there are no existing categories', () => {
  const tree = [{ id: 'root', title: '', children: [{ id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: 'repo', title: '项目', url: 'https://github.com/acme/p' },
    { id: 'docs', title: '文档', url: 'https://developer.mozilla.org/docs/Web' },
    { id: 'cloud', title: '服务', url: 'https://cloud.tencent.com/product' },
  ] }] }];
  assert.deepEqual(['few', 'balanced', 'many'].map((granularity) => new Set(plan(tree, { scopeId: 'bar', granularity }).items.filter((i) => i.selected).map((i) => i.targetFolderKey)).size), [1, 2, 3]);
});

test('deeply frozen tree and settings remain untouched during planning', () => {
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const tree = freeze(fixture());
  const originalSettings = freeze(settings({ lockedFolderPaths: [['书签栏', '旧资料']] }));
  assert.doesNotThrow(() => plan(tree, { settings: originalSettings }));
  assert.equal(originalSettings.granularity, 'balanced');
});

test('scope rejects duplicate IDs rather than proposing an ambiguous write', () => {
  const tree = fixture();
  tree[0].children[0].children.push({ id: 'github', title: '复制 id', url: 'https://unknown.example/' });
  assert.throws(() => plan(tree), /重复 id/);
});

test('incremental mode refuses existing child folders and typed non-bar roots', () => {
  for (const scopeId of ['dev', 'other']) assert.throws(() => plan(fixture(), { scopeId, mode: 'incremental' }), /书签栏|范围|scope/);
  assert.doesNotThrow(() => plan(fixture(), { scopeId: 'dev', mode: 'full' }));
  const legacy = fixture();
  for (const node of legacy[0].children) delete node.folderType;
  assert.doesNotThrow(() => plan(legacy, { scopeId: 'bar-b', mode: 'incremental' }));
});

test('unknown-only previews expose legal existing and built-in destinations without selecting them', () => {
  const tree = [{ id: 'root', title: '', children: [{ id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: 'unknown', title: '主题', url: 'https://unknown.example/topic' },
    { id: 'empty', title: '我的资料', children: [] },
    { id: 'locked', title: '私人', children: [], unmodifiable: 'managed' },
  ] }] }];
  const result = plan(tree, { scopeId: 'bar', mode: 'incremental' });
  assert.ok(result.folders.some((f) => f.existingId === 'empty'));
  assert.ok(result.folders.some((f) => f.title === 'AI 工具'));
  assert.ok(!result.folders.some((f) => f.existingId === 'locked'));
  assert.equal(result.items[0].targetFolderKey, null);
  assert.equal(result.items[0].selected, false);
  assert.equal(result.stats.move, 0);
});

test('full many separates AI uses even when bookmarks already occupy a broad AI folder', () => {
  const tree = [{ id: 'root', title: '', children: [{ id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: 'ai', title: 'AI 工具', children: [
      { id: 'chat', title: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'music', title: 'Suno', url: 'https://suno.com/' },
    ] },
  ] }] }];
  const before = structuredClone(tree);
  const result = plan(tree, { scopeId: 'bar', granularity: 'many' });
  const referenced = result.items.filter((item) => item.selected).map((item) => result.folders.find((folder) => folder.key === item.targetFolderKey));
  assert.deepEqual(referenced.map((folder) => folder.title), ['AI 对话', 'AI 创作']);
  assert.ok(referenced.every((folder) => !folder.existingId));
  assert.equal(result.stats.move, 2);
  assert.ok(result.folders.some((folder) => folder.existingId === 'ai'));
  assert.deepEqual(tree, before);
});

test('full many reuses exact fine categories instead of broad development aliases', () => {
  const tree = [{ id: 'root', title: '', children: [{ id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: 'dev', title: '开发工具', children: [
      { id: 'repo', title: '项目', url: 'https://github.com/acme/p' },
      { id: 'docs', title: '文档', url: 'https://developer.mozilla.org/docs/Web' },
    ] },
    { id: 'exact-docs', title: '开发文档', children: [] },
  ] }] }];
  const result = plan(tree, { scopeId: 'bar', granularity: 'many' });
  const repoTarget = result.folders.find((folder) => folder.key === result.items.find((item) => item.id === 'repo').targetFolderKey);
  const docsTarget = result.folders.find((folder) => folder.key === result.items.find((item) => item.id === 'docs').targetFolderKey);
  assert.equal(repoTarget.title, '代码托管');
  assert.ok(!repoTarget.existingId);
  assert.equal(docsTarget.existingId, 'exact-docs');
});

test('incremental many retains broad existing categories for direct newly added bookmarks', () => {
  const tree = [{ id: 'root', title: '', children: [{ id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: 'ai', title: 'AI 工具', children: [{ id: 'older', title: '原始条目', url: 'https://unknown.example/old' }] },
    { id: 'chat', title: 'ChatGPT', url: 'https://chatgpt.com/' },
    { id: 'music', title: 'Suno', url: 'https://suno.com/' },
  ] }] }];
  const result = plan(tree, { scopeId: 'bar', mode: 'incremental', granularity: 'many' });
  assert.deepEqual(result.items.map((item) => item.id), ['chat', 'music']);
  assert.ok(result.items.every((item) => result.folders.find((folder) => folder.key === item.targetFolderKey).existingId === 'ai'));
  assert.equal(new Set(result.items.map((item) => item.targetFolderKey)).size, 1);
});

test('representative browser titles produce four concrete rename suggestions', () => {
  const tree = [{ id: 'root', title: '', children: [{ id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: 'docs', title: 'MDN Web Docs - JavaScript 教程', url: 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript' },
    { id: 'repo', title: 'GitHub - 项目主页', url: 'https://github.com/openai/codex' },
    { id: 'chat', title: 'ChatGPT - AI 对话', url: 'https://chatgpt.com/' },
    { id: 'office', title: 'Notion - 工作空间', url: 'https://notion.so/' },
  ] }] }];
  const result = plan(tree, { scopeId: 'bar' });
  assert.equal(result.stats.rename, 4);
  assert.deepEqual(result.items.map((item) => item.newTitle), ['MDN·JavaScript 教程', 'GitHub·项目主页', 'ChatGPT', 'Notion']);
  for (const item of result.items) assert.equal(item.url, tree[0].children[0].children.find((node) => node.id === item.id).url);
});
