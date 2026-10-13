/** Browser metadata is deliberately excluded from the user-state fingerprint. */
export function flattenTree(tree) {
  if (!Array.isArray(tree)) throw new TypeError('书签树必须是数组');
  const result = [];
  function visit(nodes, parentId, ancestorPath, inheritedProtection) {
    nodes.forEach((node, index) => {
      if (!node || typeof node.id !== 'string' || typeof node.title !== 'string') {
        throw new TypeError('书签节点缺少有效 id 或标题');
      }
      const isBookmark = typeof node.url === 'string';
      const isVirtualRoot = parentId === undefined && node.parentId === undefined && !node.folderType;
      const path = isBookmark || isVirtualRoot ? [...ancestorPath] : [...ancestorPath, node.title];
      const protection = inheritedProtection || node.unmodifiable || (node.folderType === 'managed' ? 'managed' : undefined);
      const flat = {
        id: node.id,
        title: node.title,
        parentId: parentId ?? node.parentId,
        index,
        path,
      };
      if (isBookmark) flat.url = node.url;
      if (protection) flat.unmodifiable = protection;
      if (node.folderType !== undefined) flat.folderType = node.folderType;
      if (node.syncing !== undefined) flat.syncing = node.syncing;
      result.push(flat);
      if (!isBookmark && node.children !== undefined) {
        if (!Array.isArray(node.children)) throw new TypeError('书签文件夹 children 必须是数组');
        visit(node.children, node.id, path, protection);
      }
    });
  }
  visit(tree, undefined, [], undefined);
  return result;
}

export function findScopeRoots(tree) {
  const nodes = flattenTree(tree);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const folderTypes = new Set(['bookmarks-bar', 'bookmark-bar', 'other', 'mobile']);
  const editable = (node) => node.url === undefined && !node.unmodifiable;
  const typed = nodes.filter((node) => editable(node) && folderTypes.has(node.folderType));
  if (typed.length) return typed;
  // Legacy browsers expose permanent folders as children of the virtual root.
  return nodes.filter((node) => {
    if (!editable(node) || node.parentId === undefined) return false;
    const parent = byId.get(node.parentId);
    return !parent || (parent.parentId === undefined && !parent.folderType && parent.url === undefined);
  });
}

export function fingerprint(tree) {
  // The traversal position, rather than optional API index fields, records order.
  return JSON.stringify(flattenTree(tree).map((node) => [
    node.id, node.parentId ?? null, node.title, node.url ?? null, node.index,
  ]));
}

export function folderPath(node) {
  return Array.isArray(node?.path) ? node.path.join('/') : '';
}
