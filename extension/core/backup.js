const escapeHTML = value => String(value).replace(/[&<>"']/gu,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const dateAttribute = (name,value) => Number.isFinite(value) && value>0 ? ` ${name}="${Math.floor(value/1000)}"` : '';

/** Netscape HTML imports add bookmarks; they do not recreate original browser IDs. */
export function exportBookmarkHTML(backup) {
  if(backup?.version!==1 || !Array.isArray(backup.tree)) throw new Error('书签备份格式无效');
  const lines=['<!DOCTYPE NETSCAPE-Bookmark-file-1>','<!-- 本地导出；导入会追加书签，请避免重复导入。 -->','<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">','<TITLE>书签归位备份</TITLE>','<H1>书签备份</H1>','<DL><p>'];
  function visit(nodes,depth) {
    for(const node of nodes) {
      const indent='    '.repeat(depth);
      if(typeof node.url==='string') {
        lines.push(`${indent}<DT><A HREF="${escapeHTML(node.url)}"${dateAttribute('ADD_DATE',node.dateAdded)}>${escapeHTML(node.title)}</A>`);
      } else if(node.parentId===undefined && !node.folderType && !node.title) {
        visit(node.children || [],depth);
      } else {
        lines.push(`${indent}<DT><H3${node.folderType==='bookmarks-bar' ? ' PERSONAL_TOOLBAR="true"' : ''}${dateAttribute('ADD_DATE',node.dateAdded)}>${escapeHTML(node.title)}</H3>`);
        lines.push(`${indent}<DL><p>`);visit(node.children || [],depth+1);lines.push(`${indent}</DL><p>`);
      }
    }
  }
  visit(backup.tree,1);lines.push('</DL><p>');return lines.join('\n');
}
