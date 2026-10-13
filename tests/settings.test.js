import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings, exportSettings, importSettings } from '../extension/core/settings.js';

const defaults = () => structuredClone(DEFAULT_SETTINGS);

test('defaults are local, versioned, immutable and use path arrays', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { version: 1, granularity: 'balanced', lockedBookmarkUrls: [], lockedFolderPaths: [], rules: [], overrides: [] });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.rules));
});

test('import and export preserve literal URLs and folder segments', () => {
  const value = defaults();
  value.lockedBookmarkUrls = ['https://example.com/a?x=1&y=%2F#中文'];
  value.lockedFolderPaths = [['书签栏', '工作/资料']];
  value.rules = [{ type: 'domain', pattern: 'GitHub.COM', category: '编程' }, { type: 'keyword', pattern: '考试', category: '报考' }];
  value.overrides = [{ url: 'https://example.com/a?x=1&y=%2F#中文', title: '具体主题', category: '个人资料' }];
  const validated = validateSettings(value);
  assert.equal(validated.rules[0].pattern, 'github.com');
  assert.deepEqual(importSettings(exportSettings(value)), validated);
  assert.equal(validated.lockedBookmarkUrls[0], value.lockedBookmarkUrls[0]);
  assert.notEqual(validated, value);
  assert.notEqual(validated.lockedFolderPaths[0], value.lockedFolderPaths[0]);
});

test('rejects keys outside the public schema rather than saving secrets', () => {
  assert.throws(() => validateSettings({ ...defaults(), apiKey: 'never-store-this' }), /字段|schema|设置/);
  assert.throws(() => exportSettings({ ...defaults(), endpoint: 'https://example.com' }), /字段|schema|设置/);
  const value = defaults();
  value.rules = [{ type: 'domain', pattern: 'example.com', category: '资料', token: 'never-store-this' }];
  assert.throws(() => validateSettings(value), /字段|schema|规则/);
});

test('rejects unsupported versions, missing fields and invalid granularity', () => {
  assert.throws(() => validateSettings({ ...defaults(), version: 2 }), /版本|version/);
  assert.throws(() => validateSettings({ version: 1 }), /字段|schema|设置/);
  assert.throws(() => validateSettings({ ...defaults(), granularity: 'tiny' }), /粒度|granularity/);
});

test('domain rules reject schemes, paths, wildcard patterns and fake host text', () => {
  for (const pattern of ['https://github.com', '*.github.com', 'github.com/path', 'github.com@evil.test', 'github.com:443', '.github.com']) {
    const value = defaults();
    value.rules = [{ type: 'domain', pattern, category: '开发' }];
    assert.throws(() => validateSettings(value), /域名|domain/);
  }
});

test('folder locks use nonempty arrays and never split slashes in titles', () => {
  for (const lockedFolderPaths of ['书签栏/开发', ['书签栏/开发'], [[]], [['书签栏', '']]]) {
    assert.throws(() => validateSettings({ ...defaults(), lockedFolderPaths }), /路径|数组|array/);
  }
  assert.deepEqual(validateSettings({ ...defaults(), lockedFolderPaths: [['书签栏', '工作/资料']] }).lockedFolderPaths, [['书签栏', '工作/资料']]);
});

test('overrides require a literal URL and at least one editable field', () => {
  for (const override of [{ url: 'https://example.com' }, { url: 'not a URL', title: '标题' }, { url: 'https://example.com', category: '' }, { url: 'https://example.com', selected: true }]) {
    assert.throws(() => validateSettings({ ...defaults(), overrides: [override] }), /网址|标题|分类|字段|override|选择/);
  }
  assert.throws(() => validateSettings({ ...defaults(), overrides: [{ url: 'https://example.com', title: '' }] }), /标题/);
});

test('rejects credential-bearing URLs and control characters', () => {
  assert.throws(() => validateSettings({ ...defaults(), lockedBookmarkUrls: ['https://user:pass@example.com/'] }), /凭据|网址/);
  assert.throws(() => validateSettings({ ...defaults(), rules: [{ type: 'keyword', pattern: 'test\u0000', category: '资料' }] }), /字符|规则/);
});

test('imports reject invalid JSON and non-object shapes without echoing input', () => {
  assert.throws(() => importSettings('{bad secret-value'), /JSON/);
  assert.throws(() => importSettings('[]'), /设置|object|对象/);
  assert.throws(() => importSettings('{"version":1,"__proto__":{"apiKey":"secret"}}'), /字段|设置|schema/);
});

test('duplicate overrides are rejected because a URL can have only one human choice', () => {
  assert.throws(() => validateSettings({ ...defaults(), overrides: [{ url: 'https://example.com', title: 'A' }, { url: 'https://example.com', category: 'B' }] }), /重复/);
});

test('manual title overrides are limited to 200 characters without truncation', () => {
  assert.throws(() => validateSettings({ ...defaults(), overrides: [{ url: 'https://example.com', title: '题'.repeat(201) }] }), /标题/);
  assert.equal(validateSettings({ ...defaults(), overrides: [{ url: 'https://example.com', title: '题'.repeat(200) }] }).overrides[0].title.length, 200);
});
