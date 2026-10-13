import { flattenTree, findScopeRoots } from './core/tree.js';
import { exportBookmarkHTML } from './core/backup.js';

const $ = (id) => document.getElementById(id);
const state = {
  tree: [], nodes: [], roots: [], settings: null, draft: null, journal: null, history: [],
  plan: null, edits: new Map(), busy: false, initialized: false, dirty: false, category: '*'
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notice(text, kind = 'info') {
  $('notice').textContent = text;
  $('notice').dataset.kind = kind;
}

async function request(command, payload = {}) {
  try {
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('请先在浏览器扩展管理页面加载插件，再点击插件图标打开。');
    const response = await chrome.runtime.sendMessage({ command, ...payload });
    if (!response?.ok) throw new Error(response?.error || '操作没有完成。请重新读取书签后再试。');
    return response.data;
  } catch (error) { error.command = command; throw error; }
}

// Copy only the documented settings fields. Credentials never enter this object.
function safeSettings(value) {
  return {
    version: value?.version ?? 1,
    granularity: value?.granularity ?? 'balanced',
    lockedBookmarkUrls: [...(value?.lockedBookmarkUrls || [])],
    lockedFolderPaths: (value?.lockedFolderPaths || []).map((path) => [...path]),
    rules: (value?.rules || []).map(({ type, pattern, category }) => ({ type, pattern, category })),
    overrides: (value?.overrides || []).map(({ url, title, category }) => ({ url, ...(title !== undefined ? { title } : {}), ...(category !== undefined ? { category } : {}) }))
  };
}

function samePath(a, b) { return a.length === b.length && a.every((part, i) => part === b[i]); }
function pathStartsWith(path, prefix) { return prefix.length <= path.length && prefix.every((part, i) => part === path[i]); }
function pathText(node) { return (node?.path || []).join('/') || '浏览器书签'; }
function hostname(url) { try { return new URL(url).hostname; } catch { return ''; } }

function setBusy(value) {
  state.busy = value;
  document.body.setAttribute('aria-busy', String(value));
  updateControls();
}

async function run(action) {
  if (state.busy) return;
  setBusy(true);
  try { await action(); }
  catch (error) {
    if (['apply', 'undo', 'recover'].includes(error.command) && state.initialized) {
      // A failed response can follow partial writes. Read the journal before enabling actions.
      try { hydrate(await request('inspect')); }
      catch {
        state.journal ||= { status: 'unverified' };
        invalidate();
      }
    }
    notice(error.message || '操作未完成，请重新尝试。', 'error');
  }
  finally { setBusy(false); }
}

function updateControls() {
  const unavailable = !state.initialized || state.busy;
  const pending = Boolean(state.journal);
  const scopeRoot = state.roots.find((root) => root.id === $('scope').value);
  const supportsIncremental = scopeRoot && (scopeRoot.folderType === 'bookmarks-bar' || (!scopeRoot.folderType && scopeRoot.id === '1'));
  for (const node of document.querySelectorAll('#scope, #granularity, [name="mode"], #tree-search, #item-search, #add-rule, #import-rules, #export-rules, #rules-list input, #rules-list select, #rules-list button, .lock-button, .lock-summary-row button, #remember, #select-all, .item-selected, .title-input, .folder-select, .category-chip')) node.disabled = unavailable || pending || node.dataset.noneditable === 'true';
  const incremental = document.querySelector('[name="mode"][value="incremental"]');
  incremental.disabled = unavailable || pending || !supportsIncremental;
  if (state.initialized && !supportsIncremental) document.querySelector('[name="mode"][value="full"]').checked = true;
  $('preview-button').disabled = unavailable || pending || state.dirty || !$('scope').value;
  $('backup-button').disabled = unavailable;
  $('backup-html-button').disabled = unavailable;
  $('undo-button').disabled = unavailable || pending || !state.history.length;
  $('recover-button').disabled = unavailable || !pending;
  $('save-settings').disabled = unavailable || pending || !state.dirty;
  $('apply-button').disabled = unavailable || pending || state.dirty || !state.plan || ![...state.edits.values()].some((item) => item.selected);
  const aiReady = state.plan && state.plan.items.length && !pending && !state.dirty;
  for (const id of ['ai-endpoint', 'ai-model', 'ai-key', 'ai-confirm']) $(id).disabled = unavailable || !aiReady;
  $('ai-request').disabled = unavailable || !aiReady || !$('ai-confirm').checked || !$('ai-endpoint').value.trim() || !$('ai-model').value.trim();
  $('recovery-banner').hidden = !pending;
  $('settings-dirty').hidden = !state.dirty;
}

function invalidate(message = '选项已改变，请重新生成预览。') {
  state.plan = null;
  state.edits.clear();
  state.category = '*';
  $('ai-key').value = '';
  $('ai-confirm').checked = false;
  renderPlan();
  if (state.initialized) notice(message);
  updateControls();
}

function settingsChanged() {
  state.dirty = JSON.stringify(state.draft) !== JSON.stringify(state.settings);
  invalidate('锁定或规则已修改。请先保存设置，再生成新的预览。');
  renderLocks();
  renderTree();
  updateControls();
}

function hydrate(data, { restorePlan = false } = {}) {
  state.tree = data.tree || [];
  state.nodes = flattenTree(state.tree);
  state.roots = findScopeRoots(state.tree);
  state.settings = safeSettings(data.settings);
  state.draft = safeSettings(data.settings);
  state.dirty = false;
  state.journal = data.state?.journal || null;
  state.history = Array.isArray(data.state?.history) ? data.state.history : [];
  const currentScope = $('scope').value;
  $('scope').replaceChildren(...state.roots.map((root) => {
    const option = element('option', null, root.title || '书签目录');
    option.value = root.id;
    return option;
  }));
  const scopeId = !state.initialized && data.plan?.scopeId ? data.plan.scopeId : currentScope;
  if (state.roots.some((root) => root.id === scopeId)) $('scope').value = scopeId;
  if (!state.initialized) {
    $('granularity').value = data.plan?.granularity || state.settings.granularity;
    const mode = data.plan?.mode || 'full';
    document.querySelector(`[name="mode"][value="${mode === 'incremental' ? 'incremental' : 'full'}"]`).checked = true;
  }
  state.initialized = true;
  if (restorePlan && data.plan && !state.journal && data.plan.scopeId === $('scope').value) acceptPlan(data.plan);
  else if (!restorePlan) invalidate();
  renderTree();
  renderLocks();
  renderRules();
  updateControls();
}

function nodeLock(node) {
  if (node.unmodifiable) return '管理员管理';
  if (node.url && state.draft.lockedBookmarkUrls.includes(node.url)) return '网址已锁定';
  if (state.draft.lockedFolderPaths.some((path) => pathStartsWith(node.path || [], path))) return '目录已锁定';
  return null;
}

function ownLock(node) {
  return node.url ? state.draft.lockedBookmarkUrls.includes(node.url) : state.draft.lockedFolderPaths.some((path) => samePath(path, node.path || []));
}

function toggleLock(node) {
  if (!state.draft || node.unmodifiable || state.busy || state.journal) return;
  if (node.url) {
    const index = state.draft.lockedBookmarkUrls.indexOf(node.url);
    if (index >= 0) state.draft.lockedBookmarkUrls.splice(index, 1);
    else state.draft.lockedBookmarkUrls.push(node.url);
  } else {
    const index = state.draft.lockedFolderPaths.findIndex((path) => samePath(path, node.path || []));
    if (index >= 0) state.draft.lockedFolderPaths.splice(index, 1);
    else state.draft.lockedFolderPaths.push([...(node.path || [])]);
  }
  settingsChanged();
}

function renderTree() {
  if (!state.draft) return;
  const query = $('tree-search').value.trim().toLocaleLowerCase();
  const all = state.nodes.filter((node) => node.id !== '0' && (node.url || (node.path || []).length));
  const matches = all.filter((node) => !query || `${node.title} ${node.url || ''} ${pathText(node)}`.toLocaleLowerCase().includes(query));
  const shown = matches.slice(0, 100);
  $('tree-list').replaceChildren(...shown.map((node) => {
    const row = element('div', 'tree-entry');
    const depth = query ? 0 : Math.min(Math.max((node.path || []).length - 1, 0), 4);
    row.style.paddingLeft = `${depth * 10}px`;
    row.append(element('span', 'tree-symbol', node.url ? '·' : '▸'));
    const content = element('div', 'tree-entry-content');
    const title = element('span', 'tree-entry-title', node.title || '未命名');
    title.title = node.title || '未命名';
    const path = element('span', 'tree-entry-path', node.url ? hostname(node.url) || node.url : pathText(node));
    path.title = node.url || pathText(node);
    content.append(title, path);
    row.append(content);
    const lock = nodeLock(node);
    const button = element('button', 'lock-button', node.unmodifiable ? '受管理' : ownLock(node) ? '解锁' : lock ? '已保护' : '锁定');
    button.type = 'button';
    button.dataset.lockId = node.id;
    button.setAttribute('aria-label', `${ownLock(node) ? '解锁' : '锁定'}${node.url ? '书签网址' : '目录'} ${node.title || '未命名'}`);
    button.setAttribute('aria-pressed', String(Boolean(lock)));
    button.dataset.noneditable = String(Boolean(node.unmodifiable) || Boolean(lock && !ownLock(node)));
    button.title = lock || (node.url ? '锁定完整网址相同的所有书签' : `锁定目录及子树：${pathText(node)}`);
    button.disabled = state.busy || Boolean(state.journal) || Boolean(node.unmodifiable) || Boolean(lock && !ownLock(node));
    button.addEventListener('click', () => toggleLock(node));
    row.append(button);
    return row;
  }));
  if (!shown.length) $('tree-list').append(element('p', 'hint', '没有匹配的书签或目录。'));
  $('tree-count').textContent = matches.length > shown.length ? `显示前 ${shown.length} 项，共 ${matches.length} 项。搜索可定位其他书签。` : `显示 ${shown.length} 项`;
}

function renderLocks() {
  if (!state.draft) return;
  $('lock-count').textContent = `${state.draft.lockedBookmarkUrls.length + state.draft.lockedFolderPaths.length} 项锁定`;
  const locked = [
    ...state.draft.lockedBookmarkUrls.map((url) => ({ text: `网址：${url}`, remove: () => { state.draft.lockedBookmarkUrls = state.draft.lockedBookmarkUrls.filter((value) => value !== url); } })),
    ...state.draft.lockedFolderPaths.map((path) => ({ text: `目录：${path.join('/')}`, remove: () => { state.draft.lockedFolderPaths = state.draft.lockedFolderPaths.filter((value) => !samePath(value, path)); } }))
  ];
  $('locks-summary').replaceChildren(...locked.map(({ text, remove }) => {
    const row = element('div', 'lock-summary-row');
    const label = element('span', null, text);
    label.title = text;
    const button = element('button', null, '移除');
    button.type = 'button';
    button.setAttribute('aria-label', `移除锁定 ${text}`);
    button.addEventListener('click', () => { remove(); settingsChanged(); });
    row.append(label, button);
    return row;
  }));
}

function renderRules() {
  if (!state.draft) return;
  $('rules-list').replaceChildren(...state.draft.rules.map((rule, index) => {
    const row = element('div', 'rule-row');
    const type = element('select');
    type.setAttribute('aria-label', `规则 ${index + 1} 匹配方式`);
    for (const [value, label] of [['domain', '按域名'], ['keyword', '按关键词']]) { const option = element('option', null, label); option.value = value; type.append(option); }
    type.value = rule.type;
    type.addEventListener('change', () => { rule.type = type.value; settingsChanged(); });
    const pattern = element('input');
    pattern.value = rule.pattern;
    pattern.placeholder = '域名或关键词';
    pattern.setAttribute('aria-label', `规则 ${index + 1} 匹配内容`);
    pattern.addEventListener('input', () => { rule.pattern = pattern.value; settingsChanged(); });
    const category = element('input');
    category.value = rule.category;
    category.placeholder = '分类名称';
    category.setAttribute('aria-label', `规则 ${index + 1} 分类名称`);
    category.addEventListener('input', () => { rule.category = category.value; settingsChanged(); });
    const remove = element('button', null, '删除');
    remove.type = 'button';
    remove.setAttribute('aria-label', `删除规则 ${index + 1}`);
    remove.addEventListener('click', () => { state.draft.rules.splice(index, 1); settingsChanged(); renderRules(); });
    row.append(type, pattern, category, remove);
    return row;
  }));
  if (!state.draft.rules.length) $('rules-list').append(element('p', 'hint', '尚未添加规则，默认使用本地分类建议。'));
}

function acceptPlan(plan) {
  if (!plan || !Array.isArray(plan.items) || !Array.isArray(plan.folders)) throw new Error('预览内容不完整。请重新生成。');
  state.plan = plan;
  state.edits = new Map(plan.items.map((item) => [item.id, { id: item.id, selected: Boolean(item.selected), newTitle: item.newTitle, targetFolderKey: item.targetFolderKey ?? null }]));
  state.category = '*';
  $('item-search').value = '';
  $('ai-confirm').checked = false;
  renderPlan();
  updateControls();
}

function visibleItems() {
  const query = $('item-search').value.trim().toLocaleLowerCase();
  return (state.plan?.items || []).filter((item) => {
    const edit = state.edits.get(item.id);
    return (state.category === '*' || (edit.targetFolderKey ?? '__keep') === state.category) && (!query || `${item.oldTitle} ${edit.newTitle} ${item.url}`.toLocaleLowerCase().includes(query));
  });
}

function folderTitle(key) {
  if (key === null) return '保留当前位置';
  return state.plan.folders.find((folder) => folder.key === key)?.title || '目录待确认';
}

function updateSelection() {
  if (!state.plan) return;
  const selected = [...state.edits.values()].filter((edit) => edit.selected);
  $('selection-count').textContent = `已选 ${selected.length} / ${state.plan.items.length} 项`;
  const visible = visibleItems();
  const selectedVisible = visible.filter((item) => state.edits.get(item.id).selected).length;
  $('select-all').checked = Boolean(visible.length && selectedVisible === visible.length);
  $('select-all').indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $('select-all').disabled = state.busy || Boolean(state.journal) || !visible.length;
  const review = state.plan.items.filter((item) => item.confidence === 'review' && state.edits.get(item.id).selected).length;
  $('review-hint').hidden = !review;
  $('apply-button').textContent = selected.length ? `应用 ${selected.length} 个选中项` : '应用选中项';
  updateControls();
}

function renderCategories() {
  const counts = new Map();
  for (const item of state.plan?.items || []) {
    const edit = state.edits.get(item.id);
    if (!edit.selected) continue;
    const key = edit.targetFolderKey;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const buttons = [['*', `全部 ${state.plan?.items.length || 0}`], ...[...counts].map(([key, count]) => [key ?? '__keep', `${folderTitle(key)} ${count}`])].map(([key, text]) => {
    const button = element('button', 'category-chip', text);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.category === key));
    button.addEventListener('click', () => { state.category = key; renderCategories(); renderRows(); });
    return button;
  });
  $('category-overview').replaceChildren(...buttons);
}

function renderRows() {
  const items = visibleItems();
  $('preview-rows').replaceChildren(...items.map((item) => {
    const edit = state.edits.get(item.id);
    const row = element('tr', edit.selected ? '' : 'is-unselected');
    row.dataset.itemId = item.id;
    const selectedCell = element('td');
    const selected = element('input', 'item-selected');
    selected.type = 'checkbox';
    selected.checked = edit.selected;
    selected.setAttribute('aria-label', `选择 ${item.oldTitle}`);
    selected.addEventListener('change', () => { edit.selected = selected.checked; row.classList.toggle('is-unselected', !edit.selected); renderCategories(); updateSelection(); });
    selectedCell.append(selected);
    const original = element('td');
    original.append(element('div', 'original-title', item.oldTitle || '未命名书签'), element('span', 'original-url', item.url));
    original.append(element('span', 'original-path', `当前位置：${pathText(state.nodes.find((node) => node.id === item.oldParentId))}`));
    const titleCell = element('td');
    const title = element('input', 'title-input');
    title.type = 'text';
    title.value = edit.newTitle;
    title.setAttribute('aria-label', `${item.oldTitle} 整理后名称`);
    title.addEventListener('input', () => { edit.newTitle = title.value; });
    titleCell.append(title);
    const folderCell = element('td');
    const folder = element('select', 'folder-select');
    folder.setAttribute('aria-label', `${item.oldTitle} 目标目录`);
    const keep = element('option', null, '保留当前位置'); keep.value = ''; folder.append(keep);
    for (const destination of state.plan.folders) {
      const option = element('option', null, `${destination.title}${destination.existingId ? ' · 已有目录' : ' · 新建分类'}`);
      option.value = destination.key; folder.append(option);
    }
    folder.value = edit.targetFolderKey ?? '';
    folder.addEventListener('change', () => { edit.targetFolderKey = folder.value || null; renderCategories(); updateSelection(); });
    folderCell.append(folder);
    const reason = element('td');
    reason.append(element('span', item.confidence === 'review' ? 'review-label' : 'high-label', item.confidence === 'review' ? '待确认' : '本地建议'), element('div', 'reason-text', item.reason || '请检查建议'));
    row.append(selectedCell, original, titleCell, folderCell, reason);
    return row;
  }));
  if (!items.length) {
    const row = element('tr'); const cell = element('td', 'hint', '没有匹配的预览条目。可以更换分类或清空筛选。'); cell.colSpan = 5; row.append(cell); $('preview-rows').append(row);
  }
  updateSelection();
}

function payloadRecords() {
  return (state.plan?.items || []).map((item) => ({ id: item.id, title: item.oldTitle, hostname: hostname(item.url) }));
}

function renderPlan() {
  const plan = state.plan;
  const hasItems = Boolean(plan?.items.length);
  $('preview-workspace').hidden = !hasItems;
  $('empty-state').hidden = hasItems;
  $('plan-summary').hidden = !plan;
  $('category-overview').hidden = !hasItems;
  $('ai-payload').textContent = JSON.stringify(payloadRecords(), null, 2);
  if (!plan) {
    $('plan-state').textContent = '尚未生成';
    $('plan-caption').textContent = '选择范围，生成预览后逐项确认';
    $('preview-rows').replaceChildren();
    $('plan-summary').replaceChildren();
    $('category-overview').replaceChildren();
    $('empty-state').querySelector('h3').textContent = '先看建议，再决定如何整理';
    $('empty-state').querySelector('p').textContent = '左侧选择整理范围，点击「生成整理预览」。预览里可以修改名称、选择目录，或取消任意条目。';
    return;
  }
  const scopeName = state.roots.find((root) => root.id === plan.scopeId)?.title || '选定目录';
  let time = '';
  try { time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(plan.createdAt)); } catch {}
  $('plan-caption').textContent = `${scopeName} · ${plan.mode === 'incremental' ? '整理新增' : '整理整体'}${time ? ` · 生成于 ${time}` : ''}`;
  $('plan-state').textContent = '等待你确认';
  const stats = [['scanned', '扫描'], ['locked', '已保护'], ['rename', '名称建议'], ['move', '目录建议'], ['review', '待确认']];
  $('plan-summary').replaceChildren(...stats.map(([key, label]) => {
    const stat = element('div', 'summary-stat'); stat.append(element('strong', null, String(plan.stats?.[key] ?? 0)), element('span', null, label)); return stat;
  }));
  if (!hasItems) {
    $('empty-state').querySelector('h3').textContent = '这个范围目前没有可整理的条目';
    $('empty-state').querySelector('p').textContent = '内容可能已整理或受到锁定保护。可以检查左侧范围、整理方式和锁定设置。';
  }
  renderCategories();
  renderRows();
}

function download(content, filename, type = 'application/json;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = element('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

$('preview-button').addEventListener('click', () => run(async () => {
  if (state.journal || state.dirty) return;
  const options = { scopeId: $('scope').value, mode: document.querySelector('[name="mode"]:checked').value, granularity: $('granularity').value };
  const plan = await request('preview', { options });
  acceptPlan(plan);
  notice(`预览已生成，浏览器书签尚未修改。请检查 ${plan.items.length} 项建议。`);
}));

for (const control of document.querySelectorAll('#scope, #granularity, [name="mode"]')) control.addEventListener('change', () => invalidate());
$('tree-search').addEventListener('input', renderTree);
$('item-search').addEventListener('input', renderRows);
$('select-all').addEventListener('change', () => {
  for (const item of visibleItems()) state.edits.get(item.id).selected = $('select-all').checked;
  renderCategories();
  renderRows();
});

$('apply-button').addEventListener('click', () => run(async () => {
  if (!state.plan || state.journal || state.dirty) return;
  const result = await request('apply', { planId: state.plan.id, edits: [...state.edits.values()].map((edit) => ({ ...edit })), remember: $('remember').checked });
  const data = await request('inspect');
  hydrate(data);
  if (result?.status === 'completed') notice(result.warning || '选中项已整理。完整网址保留，可以撤销上次整理。', result.warning ? 'info' : 'success');
  else notice('操作已返回，请检查当前状态。未完成操作需要先恢复撤回。');
}));

$('undo-button').addEventListener('click', () => run(async () => {
  const result = await request('undo');
  hydrate(await request('inspect'));
  notice(result?.status === 'undone' || result?.status === 'rolled-back' ? '上次整理已撤销。可以重新生成预览。' : '撤销请求已返回，请检查当前状态。', 'success');
}));

$('recover-button').addEventListener('click', () => run(async () => {
  await request('recover');
  hydrate(await request('inspect'));
  notice(state.journal ? '仍有未完成操作。请检查提示中的冲突后再恢复。' : '未完成操作已撤回。可以重新生成预览。', state.journal ? 'error' : 'success');
}));

$('backup-button').addEventListener('click', () => run(async () => {
  const backup = await request('backup');
  download(JSON.stringify(backup, null, 2), `书签完整备份-${stamp()}.json`);
  notice('完整 JSON 备份已导出：优先使用最近一次整理前的备份，没有整理备份时使用当前书签。文件包含完整网址，请保存在可信位置。', 'success');
}));

$('backup-html-button').addEventListener('click', () => run(async () => {
  const backup = await request('backup');
  download(exportBookmarkHTML(backup), `书签备份-${stamp()}.html`, 'text/html;charset=utf-8');
  notice('HTML 备份已导出：优先使用最近一次整理前的备份，没有整理备份时使用当前书签。浏览器导入会新增条目，恢复名称和目录结构，不替换现有书签，也不保留原 ID 和日期。', 'success');
}));

$('save-settings').addEventListener('click', () => run(async () => {
  await request('saveSettings', { settings: safeSettings(state.draft) });
  hydrate(await request('inspect'));
  notice('锁定与规则已保存。请重新生成预览。', 'success');
}));

$('add-rule').addEventListener('click', () => {
  state.draft.rules.push({ type: 'domain', pattern: '', category: '' });
  settingsChanged(); renderRules(); updateControls();
  $('rules-list').querySelector('.rule-row:last-child input')?.focus();
});

$('export-rules').addEventListener('click', () => run(async () => {
  const exported = await request('exportRules');
  const value = typeof exported === 'string' ? JSON.parse(exported) : exported;
  download(JSON.stringify(safeSettings(value), null, 2), `书签锁定与规则-${stamp()}.json`);
  notice(state.dirty ? '已导出已保存的锁定与规则。当前未保存的修改没有写入导出文件。' : '已导出锁定与规则，不包含 AI 密钥。', 'success');
}));

$('import-rules').addEventListener('click', () => $('rules-file').click());
$('rules-file').addEventListener('change', () => run(async () => {
  const file = $('rules-file').files[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('规则文件过大，请选择 2 MB 以内的 JSON 文件。');
    const value = JSON.parse(await file.text());
    if (value.version !== 1 || !['few', 'balanced', 'many'].includes(value.granularity) || !Array.isArray(value.rules) || !Array.isArray(value.lockedBookmarkUrls) || !Array.isArray(value.lockedFolderPaths) || !Array.isArray(value.overrides)) throw new Error('规则文件格式不匹配，请导入本插件导出的 JSON。');
    if (!value.lockedBookmarkUrls.every((url) => typeof url === 'string') || !value.lockedFolderPaths.every((path) => Array.isArray(path) && path.length && path.every((part) => typeof part === 'string')) || !value.rules.every((rule) => ['domain', 'keyword'].includes(rule.type) && typeof rule.pattern === 'string' && typeof rule.category === 'string') || !value.overrides.every((override) => typeof override.url === 'string' && (override.title === undefined || typeof override.title === 'string') && (override.category === undefined || typeof override.category === 'string'))) throw new Error('规则文件包含无效的锁定或规则项。');
    state.draft = safeSettings(value);
    $('granularity').value = state.draft.granularity;
    settingsChanged(); renderRules();
    notice('规则已载入待检查。确认后点击「保存锁定与规则」；浏览器书签没有改变。');
  } finally { $('rules-file').value = ''; }
}));

for (const id of ['ai-endpoint', 'ai-model', 'ai-key']) $(id).addEventListener('input', () => { $('ai-confirm').checked = false; updateControls(); });
$('ai-confirm').addEventListener('change', updateControls);

$('ai-request').addEventListener('click', () => run(async () => {
  try {
    if (!state.plan || state.journal || state.dirty || !$('ai-confirm').checked) throw new Error('请生成预览并确认发送数据后再请求 AI。');
    const endpoint = $('ai-endpoint').value.trim();
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('请填写完整的 Chat Completions 地址。'); }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) throw new Error('服务地址需要使用 HTTPS，或本机 localhost / 127.0.0.1 的 HTTP 地址，不应包含账号密码、查询参数或片段。');
    if (!url.pathname || url.pathname === '/') throw new Error('请填写完整接口路径，例如 /v1/chat/completions。');
    const apiKey = $('ai-key').value;
    const model = $('ai-model').value.trim();
    const originPattern = `${url.protocol}//${url.hostname}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) { notice('已取消网络权限申请，没有发送 AI 请求。'); return; }
    const plan = await request('aiSuggestions', { planId: state.plan.id, endpoint, model, apiKey, confirmed: true });
    acceptPlan(plan);
    notice('AI 建议已加入预览。请重新检查名称和目录，确认后再应用。');
  } finally { $('ai-key').value = ''; $('ai-confirm').checked = false; }
}));

run(async () => {
  hydrate(await request('inspect'), { restorePlan: true });
  notice(state.journal ? '检测到未完成操作。先恢复撤回，再进行新的整理。' : state.plan ? '已恢复上次预览。应用前请重新检查建议。' : '已读取本浏览器书签。先生成预览，确认后再应用。');
});
