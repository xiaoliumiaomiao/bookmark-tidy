import { flattenTree, findScopeRoots, fingerprint } from './tree.js';
import { classifyBookmark, suggestTitle, matchesDomain, matchesCategoryFolder, categoryCatalog } from './naming.js';
import { DEFAULT_SETTINGS, validateSettings } from './settings.js';

function pathLocked(path, lockedPaths) {
  return lockedPaths.some((locked) => locked.length <= path.length && locked.every((segment, index) => segment === path[index]));
}

function insideScope(node, scopeId, byId) {
  let parentId = node.parentId;
  const visited = new Set();
  while (parentId !== undefined && !visited.has(parentId)) {
    if (parentId === scopeId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

function ruleCategory(node, rules) {
  let hostname = '';
  try { hostname = new URL(node.url).hostname; } catch { /* Invalid URLs still remain in place. */ }
  const title = node.title.toLowerCase();
  for (const rule of rules) {
    if (rule.type === 'domain' ? matchesDomain(hostname, rule.pattern) : title.includes(rule.pattern.toLowerCase())) {
      return rule.category;
    }
  }
  return null;
}

export function buildPlan(tree, options = {}) {
  const settings = validateSettings(options.settings ?? DEFAULT_SETTINGS);
  const { scopeId, mode = 'full', granularity = settings.granularity } = options;
  if (!['full', 'incremental'].includes(mode)) throw new TypeError('整理模式 mode 无效');
  if (!['few', 'balanced', 'many'].includes(granularity)) throw new TypeError('分类粒度 granularity 无效');
  const flat = flattenTree(tree);
  const byId = new Map(flat.map((node) => [node.id, node]));
  if (byId.size !== flat.length) throw new TypeError('书签树包含重复 id，不能确定安全范围');
  const scope = byId.get(scopeId);
  const roots = findScopeRoots(tree);
  const allowed = scope && roots.some((root) => root.id === scopeId || insideScope(scope, root.id, byId));
  if (!allowed || scope.url !== undefined || scope.unmodifiable || pathLocked(scope.path, settings.lockedFolderPaths)) {
    throw new TypeError('scope 必须是未锁定且可编辑的书签文件夹范围');
  }
  if (mode === 'incremental' && !roots.some((root) => root.id === scopeId &&
      (root.folderType === undefined || ['bookmarks-bar', 'bookmark-bar'].includes(root.folderType)))) {
    throw new TypeError('增量整理 scope 只能选择永久书签栏范围');
  }
  const lockedUrls = new Set(settings.lockedBookmarkUrls);
  const protectedNode = (node) => Boolean(node.unmodifiable || pathLocked(node.path, settings.lockedFolderPaths));
  const candidates = flat.filter((node) => node.url !== undefined && (mode === 'incremental' ? node.parentId === scopeId : insideScope(node, scopeId, byId)));
  const destinationFolders = flat.filter((node) => node.id !== scopeId && node.url === undefined && !protectedNode(node) &&
    (mode === 'incremental' ? node.parentId === scopeId : insideScope(node, scopeId, byId)));
  const overrideByUrl = new Map(settings.overrides.map((override) => [override.url, override]));
  const foldersByCategory = new Map();
  const folderDefinitions = new Map(destinationFolders.map((folder) => [`existing:${folder.id}`, {
    key: `existing:${folder.id}`, title: folder.title, parentId: folder.parentId, existingId: folder.id,
  }]));
  const items = [];
  let locked = 0;

  function folderFor(category) {
    if (foldersByCategory.has(category)) return foldersByCategory.get(category);
    const exact = destinationFolders.find((folder) => folder.title.trim().toLowerCase() === category.toLowerCase());
    // Full reorganization honors the requested density; incremental additions
    // prefer stable existing groups even when their labels are broader aliases.
    const existing = exact ?? (mode === 'incremental' ? destinationFolders.find((folder) => matchesCategoryFolder(folder.title, category)) : undefined);
    const folder = existing
      ? { key: `existing:${existing.id}`, title: existing.title, parentId: existing.parentId, existingId: existing.id }
      : { key: `new:${encodeURIComponent(category)}`, title: category, parentId: scopeId };
    foldersByCategory.set(category, folder);
    folderDefinitions.set(folder.key, folder);
    return folder;
  }

  // Catalog entries are options for manual/AI review. The engine creates only
  // new folders actually referenced by selected items, so empty categories stay virtual.
  for (const category of categoryCatalog(granularity)) folderFor(category);

  for (const node of candidates) {
    if (protectedNode(node) || lockedUrls.has(node.url)) { locked += 1; continue; }
    const override = overrideByUrl.get(node.url);
    const automatic = classifyBookmark(node, granularity);
    const fromRule = ruleCategory(node, settings.rules);
    const category = override?.category ?? fromRule ?? automatic.category;
    const newTitle = override?.title ?? suggestTitle(node);
    const folder = category ? folderFor(category) : null;
    const moving = folder !== null && folder.existingId !== node.parentId;
    items.push({
      id: node.id,
      url: node.url,
      oldTitle: node.title,
      newTitle,
      oldParentId: node.parentId,
      oldIndex: node.index,
      targetFolderKey: folder?.key ?? null,
      selected: moving || newTitle !== node.title,
      confidence: override?.category || fromRule ? 'high' : automatic.confidence,
      reason: override?.category ? '已保存的人工分类' : fromRule ? '匹配本地分类规则' : automatic.reason,
    });
  }

  const folders = [...folderDefinitions.values()];
  const stats = {
    scanned: candidates.length,
    locked,
    rename: items.filter((item) => item.selected && item.oldTitle !== item.newTitle).length,
    move: items.filter((item) => item.selected && item.targetFolderKey && folderDefinitions.get(item.targetFolderKey).existingId !== item.oldParentId).length,
    review: items.filter((item) => item.confidence === 'review').length,
    total: items.length,
  };
  const id = globalThis.crypto?.randomUUID?.() ?? `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { version: 1, id, createdAt: new Date().toISOString(), scopeId, mode, granularity, sourceFingerprint: fingerprint(tree), folders, items, stats };
}
