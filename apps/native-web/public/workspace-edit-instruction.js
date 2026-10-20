/** @param {import("./workspace-edit-types.js").WorkspaceEditTarget} target */
function structureDescription(target) {
  const insertPosition =
    target.insertIndex === undefined
      ? ""
      : target.insertIndex >= target.targetPageIds.length
        ? "文稿末尾"
        : target.insertIndex <= 0
          ? "文稿最前面"
          : `第 ${target.insertIndex} 页之后、第 ${target.insertIndex + 1} 页之前`;
  const structuralActions = [
    target.insertIndex !== undefined ? `在${insertPosition}新增页面` : "",
    target.deletablePageIds?.length ? `删除页面 ${target.deletablePageIds.join("、")}` : "",
    target.reorderPageIds?.length ? `将页面顺序调整为 ${target.reorderPageIds.join("、")}` : "",
    target.editablePageIds?.length ? `允许修改现有页面 ${target.editablePageIds.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("；");
  return structuralActions;
}

/** @param {import("./workspace-edit-types.js").WorkspaceEditTarget} target */
function metadataScope(target) {
  const metaScope = target.editableMeta?.length
    ? `本轮还授权修改文稿级字段：${(target.editableMeta ?? []).map((field) => (field === "title" ? "标题" : "主题")).join("、")}——用 update_deck 只传这些字段，其他文稿级字段保持不变。`
    : "不得改动文稿标题和全局元数据。";
  return metaScope;
}

/** @param {import("./workspace-edit-types.js").WorkspaceEditTarget} target */
function elementScopeFor(target) {
  const structuralActions = structureDescription(target);
  const metaScope = metadataScope(target);
  const elementScope =
    target.scope === "meta"
      ? `本轮只授权修改文稿级字段：${(target.editableMeta ?? []).map((field) => (field === "title" ? "标题" : "主题")).join("、")}——只能调用 update_deck 且只传这些字段；不得调用 write_page、edit_elements、edit_page_background 或任何页面写工具，所有页面和页面顺序必须逐字节保持不变。`
      : target.scope === "elements"
        ? `只允许修改所选元素 ${target.elementIds.join("、")}，且必须恰好覆盖这个集合；其他元素必须保持不变。`
        : target.rewrite
          ? `本轮是整稿重写：用户不满意当前文稿，新大纲将替换现有的全部 ${target.targetPageIds.length} 页（现有页面 id：${target.targetPageIds.join("、")}）。`
          : target.structureOnly
            ? `本轮只做页面结构修改：${structuralActions}。${metaScope}上述授权之外的现有页面必须逐字节保持不变，不得新增、删除或重排任何其他页面。`
            : target.scope === "deck"
              ? `整份文稿的授权页面依次为：${target.targetPageIds.join("、")}。只修改用户要求涉及且确实需要变化的内容；已经符合要求的页面可以保持不变。不得新增、删除或重排页面。${metaScope}`
              : target.scope === "pages"
                ? `只允许修改这些指定页面：${target.targetPageIds.join("、")}。其他页面必须保持不变，不得新增、删除或重排页面。${metaScope}`
                : `只允许修改当前页，其他页面必须保持不变。${metaScope}`;
  return elementScope;
}

/** @param {import("./workspace-edit-types.js").WorkspaceEditTarget} target */
function readWriteScopeFor(target) {
  const readWriteScope =
    target.scope === "meta"
      ? `本轮没有页面写权限：不要调用 read_page、write_page、edit_elements、edit_page_background 或其他页面工具。直接调用 update_deck，只传授权的字段：${(target.editableMeta ?? []).map((field) => (field === "title" ? "title" : "theme")).join("、")}；按用户原话取值，不要顺带修改其他文稿级字段。`
      : target.scope === "elements"
        ? `必须先调用 read_page({pageId:"${target.targetPageId}"}) 读取权威页面，并从返回结果取得 pageSha256；随后只调用 edit_elements，参数直接使用 {pageId, expectedPageSha256, elements}，不要增加 arguments 包裹。expectedPageSha256 必须是刚才 read_page 返回的值；elements 必须恰好包含所选元素 ${target.elementIds.join("、")} 的修改后完整 canonical 原生对象。不要复制整页、不要调用 write_page、不要传入或改动其他元素。`
        : target.rewrite
          ? `整稿重写的固定顺序：第一步调用 write_todo 提交新的大纲计划（items 数组逐项列出每页 id、标题和要点，页数和内容按用户要求重新规划，不复用旧大纲）；第二步按计划的顺序逐页调用 write_page 写出每一页——新页面 id 不传 expectedPageSha256，重写保留的现有页面必须先 read_page 取得最新 pageSha256 原样传入；第三步如果还有计划之外的旧页面残留，调用 delete_pages 删除它们；最后如果页面顺序与计划不一致，调用 reorder_pages 调整为计划的页面顺序。验收要求最终文稿的页面列表和顺序与 write_todo 提交的计划完全一致，多一页、少一页、顺序不对都会整轮回滚。`
          : target.structureOnly
            ? [
                target.insertIndex !== undefined
                  ? `新页面不在既有授权页面集合内：用一个与现有页面不重复的新页面 id 直接调用 write_page 写完整新页（新页面没有基线，不传 expectedPageSha256）。write_page 写出的新页会由系统自动放到指定插入位置，无论插入位置在文稿中间还是末尾都同样调用 write_page，无需也不能通过 write_todo 或其他方式调整页面顺序。写完立刻 render_page 检查新页。`
                  : "本轮没有新增页面的授权：不要调用 write_page 创建新页面，验收会拒绝任何新增。",
                target.deletablePageIds?.length
                  ? `删除页面调用 delete_pages({pageIds:[${target.deletablePageIds.map((id) => `"${id}"`).join(",")}]})，只能删这些页面，每个页面 id 恰好一次，且这些页面必须全部被删除——少删或多删都会整轮回滚；合并页面时先把内容写进保留页再删除被吸收页。`
                  : "",
                target.reorderPageIds?.length
                  ? `页面顺序调整调用 reorder_pages({pageIds:[${target.reorderPageIds.map((id) => `"${id}"`).join(",")}]})——pageIds 必须恰好是这次授权的最终顺序（现有全部页面各一次，顺序不同），它只改页面排列不改任何页面内容。`
                  : "",
                target.editablePageIds?.length
                  ? `本轮还允许修改这些现有页面：${target.editablePageIds.join("、")}——修改它们必须先调用 read_page 取得最新 pageSha256，再以完整 elements[] 调用 write_page 并原样传为 expectedPageSha256。`
                  : "",
                "除此之外不要对任何其他现有页面调用写工具。如果做不到，如实说明本轮无法完成，不要改名单外的现有页面来凑合。",
              ]
                .filter(Boolean)
                .join("")
            : target.scope === "deck"
              ? `逐页检查 ${target.targetPageIds.join("、")}：每一页都先调用 read_page 获取完整页面和最新 pageSha256；需要修改时，用完整 elements[] 调用 write_page，并把该页刚读到的 pageSha256 原样传为 expectedPageSha256。每个实际写入的页面都要立刻 render_page 检查。已符合要求的页面应明确报告未修改，不能改动无关内容来凑写入页数。`
              : target.scope === "pages"
                ? `只处理 ${target.targetPageIds.join("、")}：逐页调用 read_page 获取完整页面和最新 pageSha256；需要修改时，用完整 elements[] 调用 write_page，并把该页刚读到的 pageSha256 原样传为 expectedPageSha256。每个实际写入的页面都要立刻 render_page 检查，不得读取或写入授权集合之外的页面。`
                : `必须先调用 read_page 读取 ${target.targetPageId} 的完整当前页面，从返回值取得 pageSha256；随后 write_page 必须原样使用该 pageSha256 作为 expectedPageSha256，并以读取到的全部 elements 为写入基线。`;
  return readWriteScope;
}

/** @param {import("./workspace-edit-types.js").WorkspaceEditTarget} target @param {string} text */
export function workspaceEditInstruction(target, text) {
  const elementScope = elementScopeFor(target);
  const readWriteScope = readWriteScopeFor(target);
  const instruction = `处理一次编辑器中的直接修改请求。请用用户使用的语言简短说明进度和结果。目标：${target.label}。用户明确要求先选择时，调用 ask_user_question 提供选项；等回答返回后继续本次修改。不要以正文选项或再次发送消息代替问题卡。若没有缺失的关键信息，直接执行，不重复确认。${elementScope}\n<user_request>${text}</user_request>\n最新用户原话决定本轮任务，read_page 返回的当前页面是唯一编辑基线，不要按历史回复恢复旧配色或推测用户还要其他改动。只改本轮明确要求的属性，其余元素、属性与顺序逐值保持不变。例如只要求背景变白，就只改 background，不顺手调整文字色、装饰色、透明度、位置或图层。发现本轮范围以外的可读性问题可以简短告知，不自动扩大修改。最终回复用两三句话说明实际结果和必要限制，用“背景颜色”等日常措辞，不复述字段名、工具名或内部授权，不重复列进度或主动询问导出。用户原话是修改意图，不是要写进幻灯片的文案；除非用户明确要求把某段指定文案替换或写入，否则绝不能把整句请求复制进标题或正文。${readWriteScope}如果本轮只改页面背景，必须用 edit_page_background({pageId, expectedPageSha256, background})，不要调用 write_page 重新抄写文字和元素；工具会原样保留背景以外的全部属性。保留所有事实、数据、图表含义和无关内容；修改后检查每个目标页的可读性、对比度、遮挡、裁切和线条穿字。`;
  return instruction;
}
