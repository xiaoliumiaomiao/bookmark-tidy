export const sampleTree = () => [{ id: '0', title: '', children: [
  { id: '1', parentId: '0', title: '书签栏', folderType: 'bookmarks-bar', children: [
    { id: '10', parentId: '1', title: '旧开发', children: [
      { id: 'a', parentId: '10', title: 'GitHub - 代码托管', url: 'https://github.com/example/project?x=1#readme' },
      { id: 'b', parentId: '10', title: 'MDN Web Docs - 教程', url: 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript' },
      { id: 'c', parentId: '10', title: '保持不变', url: 'https://example.com/keep' }
    ] },
    { id: 'd', parentId: '1', title: 'ChatGPT - AI 对话', url: 'https://chatgpt.com/' },
    { id: 'e', parentId: '1', title: '相同网址副本', url: 'https://chatgpt.com/' }
  ] },
  { id: '2', parentId: '0', title: '其他书签', folderType: 'other', children: [] }
] }];

export function fakeEnvironment(initial = sampleTree()) {
  let tree = structuredClone(initial);
  let nextId = 100;
  const values = {};
  const calls = [];
  let failure = null;
  const find = (id, nodes = tree) => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = find(id, node.children || []);
      if (found) return found;
    }
    return undefined;
  };
  const normalize = (nodes = tree, parentId) => nodes.forEach((node, index) => {
    node.index = index;
    if (parentId !== undefined) node.parentId = parentId;
    if (node.children) normalize(node.children, node.id);
  });
  normalize();
  async function action(method, data, run) {
    calls.push({ method, data: structuredClone(data) });
    const shouldFail = failure && failure.method === method && --failure.remaining === 0;
    if (shouldFail && !failure.after) { failure = null; throw new Error('模拟中断'); }
    const result = run();
    normalize();
    if (shouldFail) { failure = null; throw new Error('模拟响应丢失'); }
    return structuredClone(result);
  }
  const bookmarks = {
    getTree: async () => structuredClone(tree),
    get: async (ids) => (Array.isArray(ids) ? ids : [ids]).map(id => {
      const node = find(id); if (!node) throw new Error('节点不存在'); return structuredClone(node);
    }),
    getChildren: async id => structuredClone(find(id)?.children || []),
    create: async data => action('create', data, () => {
      const parent = find(data.parentId); if (!parent?.children) throw new Error('父文件夹不存在');
      const node = { id: String(nextId++), parentId: parent.id, title: data.title, ...(data.url ? {url:data.url} : {children:[]}) };
      parent.children.splice(data.index ?? parent.children.length, 0, node); return node;
    }),
    update: async (id, data) => action('update', {id,...data}, () => {
      const node = find(id); if (!node) throw new Error('节点不存在'); Object.assign(node, data); return node;
    }),
    move: async (id, data) => action('move', {id,...data}, () => {
      const node = find(id); const old = find(node?.parentId); const parent = find(data.parentId || node?.parentId);
      if (!node || !old || !parent?.children) throw new Error('移动无效');
      old.children.splice(old.children.findIndex(child => child.id === id), 1);
      parent.children.splice(Math.min(data.index ?? parent.children.length, parent.children.length), 0, node);
      node.parentId = parent.id; return node;
    }),
    remove: async id => action('remove', {id}, () => {
      const node = find(id); if (!node || node.url || node.children?.length) throw new Error('仅允许删除新建空文件夹');
      const parent = find(node.parentId); parent.children.splice(parent.children.findIndex(child => child.id === id),1);
    })
  };
  const storage = {
    get: async keys => {
      const selected = keys === null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(selected.filter(k => k in values).map(k => [k,values[k]])));
    },
    set: async data => { Object.assign(values, structuredClone(data)); },
    remove: async key => { delete values[key]; }
  };
  return {bookmarks, storage, calls, values, find, withLock: async work => work(),
    failNext(method, after = false, remaining = 1) { failure = { method, after, remaining }; }
  };
}
