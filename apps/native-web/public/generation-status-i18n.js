/**
 * English copy for the unified generation status/recovery card and blockers.
 * Chinese is the key; feature-i18n.js merges this slice into i18n.js.
 * @type {Record<string, string>}
 */
export const GENERATION_STATUS_I18N = {
  "{n} 秒后自动重试": "Auto-retrying in {n}s",
  "正在重试…": "Retrying…",
  查看技术详情: "View technical details",
  切换模型: "Switch model",
  停止等待: "Stop waiting",
  用新模型继续: "Continue with new model",
  "模型单轮输出达到长度上限，任务已自动暂停。":
    "The model reached its single-turn output limit and the task paused automatically.",
  页面规划尚未完成: "Page plan is not complete yet",
  页面规划需要补全: "Page plan needs completion",
  整稿结构检查尚未通过: "Deck structure check has not passed yet",
  必需参考资料尚未读完: "Required reference materials have not been fully read",
  页面截图或排版检查尚未通过: "Page screenshots or layout checks have not passed yet",
};
