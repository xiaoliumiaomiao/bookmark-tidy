import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tree = [{ id: '0', title: '', children: [
  { id: '1', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: '10', title: 'GitHub - 项目首页', url: 'https://github.com/example/repo?x=1#readme' },
    { id: '11', title: '待确认资料', url: 'https://example.org/long/path?token=preserved' },
    { id: '12', title: '已有资料', children: [
      { id: '13', title: 'MDN Web Docs', url: 'https://developer.mozilla.org/zh-CN/' }
    ] }
  ] },
  { id: '2', title: '其他书签', folderType: 'other', children: [] }
] }];
const settings = { version: 1, granularity: 'balanced', lockedBookmarkUrls: [], lockedFolderPaths: [], rules: [], overrides: [] };
const plan = {
  version: 1, id: 'plan-1', createdAt: '2026-10-13T08:00:00.000Z', scopeId: '1', mode: 'full', granularity: 'balanced', sourceFingerprint: 'sample',
  folders: [{ key: 'development', title: '开发工具', parentId: '1' }, { key: 'existing-12', title: '已有资料', parentId: '1', existingId: '12' }],
  items: [
    { id: '10', url: tree[0].children[0].children[0].url, oldTitle: 'GitHub - 项目首页', newTitle: 'GitHub', oldParentId: '1', oldIndex: 0, targetFolderKey: 'development', selected: true, confidence: 'high', reason: '域名匹配' },
    { id: '11', url: tree[0].children[0].children[1].url, oldTitle: '待确认资料', newTitle: '资料', oldParentId: '1', oldIndex: 1, targetFolderKey: null, selected: true, confidence: 'review', reason: '归类待确认' }
  ], stats: { scanned: 3, locked: 0, rename: 2, move: 1, review: 1, total: 2 }
};

test('manifest limits installation permissions and keeps scripts local', async () => {
  const path = join(root, 'extension', 'manifest.json');
  assert.ok(existsSync(path), '缺少可加载的 MV3 manifest');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['bookmarks', 'storage']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']);
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.host_permissions, undefined);
  for (const icon of Object.values(manifest.icons)) assert.ok(existsSync(join(root, 'extension', icon)));
});

test('Chinese workspace implements preview, selection, settings and explicit AI consent', async (t) => {
  assert.ok(existsSync(join(root, 'extension', 'app.html')), '缺少中文整理工作区');
  let playwright;
  const modulePaths = [process.env.PLAYWRIGHT_MODULE_PATH, 'playwright', join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean);
  for (const path of modulePaths) { try { playwright = require(path); break; } catch {} }
  assert.ok(playwright, '设置 PLAYWRIGHT_MODULE_PATH 指向已有 Playwright；无需安装依赖');
  const executable = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(existsSync);
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, 'extension', `.${pathname}`);
    if (!path.startsWith(join(root, 'extension') + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) { res.writeHead(403).end(); return; }
    try {
      const content = await readFile(path);
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  let browser;
  t.after(async () => { try { if (browser) await browser.close(); } finally { await new Promise((done) => server.close(done)); } });
  browser = await playwright.chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
  const url = `http://127.0.0.1:${server.address().port}/app.html`;
  const pages = [];
  async function open({ journal = null, denied = false, failApply = false, managed = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pages.push(page);
    await page.addInitScript(({ tree, settings, plan, journal, denied, failApply, managed }) => {
      if (managed) tree[0].children[0].children[2].children[0].unmodifiable = 'managed';
      let currentPlan = null;
      let currentSettings = settings;
      let currentJournal = journal;
      let history = [];
      window.__messages = [];
      window.__permissionRequests = [];
      window.__downloadTypes = [];
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__downloadTypes.push(blob.type); return createObjectURL(blob); };
      window.chrome = {
        runtime: { sendMessage: async (message) => {
          const recorded = structuredClone(message);
          if ('apiKey' in recorded) recorded.apiKey = '[redacted]';
          window.__messages.push(recorded);
          switch (message.command) {
            case 'inspect': return { ok: true, data: { tree, settings: currentSettings, state: { journal: currentJournal, history }, plan: currentPlan } };
            case 'preview': currentPlan = { ...structuredClone(plan), ...message.options }; return { ok: true, data: currentPlan };
            case 'apply':
              if (failApply) { currentJournal = { id: 'partial-1', status: 'interrupted' }; return { ok: false, error: '模拟书签冲突，操作已暂停' }; }
              history = [{ id: 'operation-1', status: 'completed' }]; currentPlan = null; return { ok: true, data: { status: 'completed' } };
            case 'saveSettings': currentSettings = message.settings; currentPlan = null; return { ok: true, data: currentSettings };
            case 'recover': currentJournal = null; currentPlan = null; return { ok: true, data: { status: 'rolled-back' } };
            case 'undo': history = []; currentPlan = null; return { ok: true, data: { status: 'undone' } };
            case 'backup': return { ok: true, data: { version: 1, createdAt: plan.createdAt, tree } };
            case 'exportRules': return { ok: true, data: JSON.stringify(currentSettings) };
            case 'aiSuggestions': currentPlan = { ...plan, id: 'plan-ai', items: plan.items.map((item) => ({ ...item, newTitle: item.id === '10' ? '代码仓库' : item.newTitle })) }; return { ok: true, data: currentPlan };
            default: return { ok: false, error: '未知命令' };
          }
        } },
        permissions: { request: async (request) => { window.__permissionRequests.push(request); return !denied; } }
      };
    }, { tree, settings, plan, journal, denied, failApply, managed });
    await page.goto(url);
    await page.locator('#scope').waitFor();
    await page.waitForFunction(() => window.__messages.some((message) => message.command === 'inspect'));
    await page.locator('#preview-button').waitFor({ state: 'visible' });
    return page;
  }

  await t.test('preview reads only; cancelled rows are sent as unselected and edits are explicit', async () => {
    const page = await open();
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    assert.deepEqual(await page.locator('#scope option').evaluateAll((options) => options.map((option) => option.value)), ['1', '2']);
    assert.equal(await page.locator('#apply-button').isDisabled(), false);
    assert.deepEqual(await page.evaluate(() => window.__messages.filter((message) => ['apply', 'undo', 'recover', 'saveSettings'].includes(message.command))), []);
    await page.locator('[data-item-id="10"] .title-input').fill('我的代码仓库');
    await page.locator('[data-item-id="11"] .item-selected').uncheck();
    await page.locator('#remember').check();
    await page.locator('#apply-button').click();
    await page.waitForFunction(() => window.__messages.some((message) => message.command === 'apply'));
    const applied = await page.evaluate(() => window.__messages.find((message) => message.command === 'apply'));
    assert.equal(applied.planId, 'plan-1');
    assert.equal(applied.remember, true);
    assert.equal(applied.edits.find((edit) => edit.id === '10').newTitle, '我的代码仓库');
    assert.equal(applied.edits.find((edit) => edit.id === '11').selected, false);
    assert.equal('url' in applied.edits[0], false);
    await page.close();
  });

  await t.test('importable backup downloads one HTML file through the read-only backup API', async () => {
    const page = await open();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 2500 }),
      page.locator('#backup-html-button').click({ timeout: 2000 })
    ]);
    assert.match(download.suggestedFilename(), /^书签备份-.*\.html$/);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const html = Buffer.concat(chunks).toString('utf8');
    assert.match(html, /NETSCAPE-Bookmark-file-1/i);
    assert.match(html, /GitHub - 项目首页/);
    assert.match(html, /https:\/\/github\.com\/example\/repo\?x=1#readme/);
    assert.deepEqual(await page.evaluate(() => window.__downloadTypes), ['text/html;charset=utf-8']);
    assert.deepEqual(await page.evaluate(() => window.__messages.filter((message) => ['apply', 'undo', 'recover', 'saveSettings'].includes(message.command))), []);
    await page.close();
  });

  await t.test('changing scope invalidates a previous plan', async () => {
    const page = await open();
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    await page.locator('#scope').selectOption('2');
    assert.equal(await page.locator('#apply-button').isDisabled(), true);
    assert.equal(await page.locator('[data-item-id]').count(), 0);
    await page.close();
  });

  await t.test('incremental mode is available only for the bookmark bar', async () => {
    const page = await open();
    await page.locator('[name="mode"][value="incremental"]').check();
    await page.locator('#scope').selectOption('2');
    assert.equal(await page.locator('[name="mode"][value="incremental"]').isDisabled(), true);
    assert.equal(await page.locator('[name="mode"][value="full"]').isChecked(), true);
    await page.close();
  });

  await t.test('category overview counts only selected destinations', async () => {
    const page = await open();
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    await page.locator('[data-item-id="10"] .item-selected').uncheck();
    assert.equal(await page.locator('#category-overview').getByText('开发工具 1', { exact: true }).count(), 0);
    assert.equal(await page.locator('#category-overview').getByText('保留当前位置 1', { exact: true }).count(), 1);
    await page.close();
  });

  await t.test('apply errors refresh authoritative pending state before permitting another action', async () => {
    const page = await open({ failApply: true });
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    await page.locator('#apply-button').click();
    await page.locator('#recovery-banner').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await page.locator('#apply-button').isDisabled(), true);
    assert.equal(await page.locator('#preview-button').isDisabled(), true);
    assert.match(await page.locator('#notice').textContent(), /冲突/);
    await page.close();
  });

  await t.test('managed and inherited folder protection cannot be unlocked through a child control', async () => {
    const page = await open({ managed: true });
    assert.equal(await page.locator('[data-lock-id="13"]').isDisabled(), true);
    await page.locator('[data-lock-id="12"]').click();
    assert.equal(await page.locator('[data-lock-id="13"]').isDisabled(), true);
    await page.close();
    const inherited = await open();
    await inherited.locator('[data-lock-id="12"]').click();
    assert.equal(await inherited.locator('[data-lock-id="13"]').isDisabled(), true);
    await inherited.close();
  });

  await t.test('importing rules stages the change and drops credential fields before saving', async () => {
    const page = await open();
    const imported = { ...settings, rules: [{ type: 'keyword', pattern: '课程', category: '学习' }], apiKey: 'dummy-must-be-discarded' };
    await page.locator('#rules-file').setInputFiles({ name: 'rules.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await page.locator('#save-settings').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#save-settings').disabled);
    assert.deepEqual(await page.evaluate(() => window.__messages.filter((message) => message.command === 'saveSettings')), []);
    await page.locator('#save-settings').click();
    await page.waitForFunction(() => window.__messages.some((message) => message.command === 'saveSettings'));
    const saved = await page.evaluate(() => window.__messages.find((message) => message.command === 'saveSettings').settings);
    assert.deepEqual(saved.rules, imported.rules);
    assert.equal('apiKey' in saved, false);
    await page.close();
  });

  await t.test('unfinished journal blocks apply and offers explicit recovery', async () => {
    const page = await open({ journal: { id: 'pending-1', status: 'interrupted' } });
    await page.locator('#recovery-banner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#apply-button').isDisabled(), true);
    assert.equal(await page.locator('#preview-button').isDisabled(), true);
    await page.locator('#recover-button').click();
    await page.waitForFunction(() => window.__messages.some((message) => message.command === 'recover'));
    await page.locator('#recovery-banner').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#preview-button').isDisabled(), false);
    await page.close();
  });

  await t.test('global tree search locks bookmarks and folder subtrees through settings', async () => {
    const page = await open();
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    await page.locator('#tree-search').fill('MDN');
    await page.locator('[data-lock-id="13"]').click();
    assert.equal(await page.locator('#apply-button').isDisabled(), true);
    await page.locator('#tree-search').fill('已有资料');
    await page.locator('[data-lock-id="12"]').click();
    await page.locator('#save-settings').click();
    await page.waitForFunction(() => window.__messages.some((message) => message.command === 'saveSettings'));
    const saved = await page.evaluate(() => window.__messages.find((message) => message.command === 'saveSettings').settings);
    assert.deepEqual(saved.lockedBookmarkUrls, [tree[0].children[0].children[2].children[0].url]);
    assert.deepEqual(saved.lockedFolderPaths, [['书签栏', '已有资料']]);
    assert.equal('apiKey' in saved, false);
    await page.close();
  });

  await t.test('AI sends only confirmed title/domain records with an origin permission and clears key', async () => {
    const page = await open();
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    await page.locator('#ai-panel summary').click();
    await page.locator('#ai-endpoint').fill('https://api.example.org/v1/chat/completions');
    await page.locator('#ai-model').fill('example-model');
    await page.locator('#ai-key').fill('dummy-for-ui-test');
    assert.equal(await page.locator('#ai-request').isDisabled(), true);
    const payload = JSON.parse(await page.locator('#ai-payload').textContent());
    assert.deepEqual(payload, plan.items.map((item) => ({ id: item.id, title: item.oldTitle, hostname: new URL(item.url).hostname })));
    assert.equal((await page.locator('#ai-payload').textContent()).includes('?token='), false);
    await page.locator('#ai-confirm').check();
    await page.locator('#ai-request').click();
    await page.waitForFunction(() => window.__messages.some((message) => message.command === 'aiSuggestions'));
    await page.waitForFunction(() => document.querySelector('#ai-key').value === '');
    assert.deepEqual(await page.evaluate(() => window.__permissionRequests), [{ origins: ['https://api.example.org/*'] }]);
    assert.equal(await page.locator('[data-item-id="10"] .title-input').inputValue(), '代码仓库');
    assert.deepEqual(await page.evaluate(() => window.__messages.filter((message) => message.command === 'apply')), []);
    await page.close();
  });

  await t.test('denied optional permission skips the AI request and clears key', async () => {
    const page = await open({ denied: true });
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    await page.locator('#ai-panel summary').click();
    await page.locator('#ai-endpoint').fill('https://api.example.org/v1/chat/completions');
    await page.locator('#ai-model').fill('example-model');
    await page.locator('#ai-key').fill('dummy-for-ui-test');
    await page.locator('#ai-confirm').check();
    await page.locator('#ai-request').click();
    await page.waitForFunction(() => window.__permissionRequests.length === 1);
    await page.waitForFunction(() => document.querySelector('#ai-key').value === '');
    assert.deepEqual(await page.evaluate(() => window.__messages.filter((message) => message.command === 'aiSuggestions')), []);
    await page.close();
  });

  await t.test('loopback AI services can be requested without an API key', async () => {
    const page = await open();
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    await page.locator('#ai-panel summary').click();
    await page.locator('#ai-endpoint').fill('http://127.0.0.1:8000/v1/chat/completions');
    await page.locator('#ai-model').fill('local-model');
    await page.locator('#ai-confirm').check();
    assert.equal(await page.locator('#ai-request').isDisabled(), false);
    await page.locator('#ai-request').click();
    await page.waitForFunction(() => window.__messages.some((message) => message.command === 'aiSuggestions'));
    assert.deepEqual(await page.evaluate(() => window.__permissionRequests), [{ origins: ['http://127.0.0.1/*'] }]);
    await page.close();
  });

  await t.test('desktop and narrow layouts keep actions reachable and visible keyboard focus', async () => {
    const page = await open();
    await page.locator('#preview-button').click();
    await page.locator('[data-item-id="10"]').waitFor();
    await page.locator('#preview-button').focus();
    const outline = await page.locator('#preview-button').evaluate((el) => getComputedStyle(el).outlineStyle);
    assert.notEqual(outline, 'none');
    if (process.env.UI_SCREENSHOT_DIR) {
      await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_SCREENSHOT_DIR, 'ui-desktop.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.locator('#apply-button').isVisible(), true);
    if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.UI_SCREENSHOT_DIR, 'ui-narrow.png'), fullPage: true });
    await page.close();
  });
});
