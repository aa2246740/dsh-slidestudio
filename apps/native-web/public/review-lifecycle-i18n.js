/** English copy for the comment-batch / AI edit lease lifecycle (public/ai-lock-lifecycle.js).
 * Chinese is the key; i18n.js merges this slice into its dictionary. */
export const REVIEW_LIFECYCLE_I18N = {
  "版本保护已失效 · 修改前版本在历史版本中": "Version protection lapsed · the pre-edit version is in version history",
  "AI 修改没有完成，服务端已恢复修改前版本，批注可重试":
    "The AI edit did not finish; the server restored the pre-edit version. The comments can be retried.",
  "这批批注没有被 AI 接收，服务端已取消，批注可重试":
    "The AI never picked up these comments; the server cancelled the batch. The comments can be retried.",
  "AI 版本保护状态不确定，请检查生成历程；本标签继续禁止写入。":
    "AI version protection is uncertain; check the generation history. This tab stays write-locked.",
  "服务端没有返回可验证的批注发送记录，未提交": "The server returned no verifiable comment receipt; nothing was sent.",
};
