/**
 * English copy for layout mode (母版/版式): layout-mode.js, layout-edit-turn.js and the layout
 * markup in index.html. i18n.js spreads this slice into its EN dictionary; the Chinese source text
 * is the key, so a missing entry simply falls back to Chinese.
 */
export const LAYOUT_I18N = {
  // ---- layout-mode.js ----
  母版: "Master",
  "{count} 页使用": "Used on {count} pages",
  "正在编辑版式『{name}』· {count} 页使用": "Editing layout “{name}” · used on {count} pages",
  "正在编辑母版『{name}』": "Editing master “{name}”",
  "版式里不能放图表/表格": "Layouts can't contain charts or tables",
  "这份文稿还没有版式。新建一个版式后，页面可以套用它。":
    "This deck has no layouts yet. Create one, then pages can use it.",
  "这一页没有版式。选择一个版式后，可以编辑它。": "This page has no layout. Choose a layout to edit it.",
  "{kind}：{name}，{meta}": "{kind}: {name}, {meta}",
  母版与版式: "Master & layouts",
  新建版式: "New layout",
  重命名: "Rename",
  删除版式: "Delete layout",
  重命名版式: "Rename layout",
  版式名称: "Layout name",
  删除版式确认: "Confirm layout deletion",
  "删除后，{count} 页会失去版式『{name}』的内容；页面自有内容保留。":
    "After deletion, {count} pages lose the content of layout “{name}”; their own content stays.",
  无版式: "No layout",
  "{name}（{count} 页）": "{name} ({count} pages)",
  版式名称不能为空: "Layout name can't be empty",
  "已撤销母版『{name}』的修改": "Undid the change to master “{name}”",
  "已撤销版式『{name}』的修改": "Undid the change to layout “{name}”",
  // ---- layout-edit-turn.js ----
  "母版暂不支持 AI 修改。请先选择一个版式，或在「编辑版式」里手动编辑母版。":
    "AI can't edit the master yet. Choose a layout first, or edit the master by hand in Edit layout.",
  "版式的当前内容没有取回，未发送修改请求":
    "The layout's current content was not retrieved; the change request was not sent",
  "修改范围：版式『{name}』": "Scope: layout “{name}”",
  // ---- index.html layout markup (data-i18n / data-i18n-title / data-i18n-aria-label) ----
  完成: "Done",
  编辑版式: "Edit layout",
  插入页码: "Insert page number",
  页码: "Page number",
  页面版式: "Page layout",
};
