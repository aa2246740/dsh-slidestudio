import { t } from "./i18n.js";

/** @type {Record<string, string>} */
export const PROCESS_STATUS_LABEL = Object.freeze({
  running: t("运行中"),
  success: t("成功"),
  failed: t("失败"),
  recovered: t("已恢复"),
  canceled: t("已取消"),
  returned: t("结果已返回"),
  info: t("已记录"),
});

/** Translate a status key for display; the frozen map stays as source keys. */
/** @param {string} status */
export function processStatusLabel(status) {
  return t(PROCESS_STATUS_LABEL[status] || status || "");
}

export const TOOL_VERBS = {
  open_project: "Read",
  inspect_capabilities: "Inspect",
  list_references: "Search",
  read_reference: "Read",
  view_design_reference: "Read",
  commit_design: "Write",
  write_todo: "Write",
  read_page: "Read",
  write_page: "Write",
  edit_elements: "Edit",
  render_page: "Read",
  review_page: "Read",
  search_image: "Search",
  generate_image: "Write",
  web_search: "Search",
  review_pages: "Read",
  render_deck: "Read",
  review_deck: "Read",
  compose_deck: "Write",
  export_deck: "Write",
  finish: "Write",
  finalize_deck: "Write",
};

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{pageId?: string}} row
 * @returns {string}
 */
export function toolTarget(name, args, row) {
  if (args.sourceId) {
    const source = String(args.sourceId).replace(/^openkimi:/, "");
    return Number.isInteger(Number(args.chunkIndex)) ? `${source} #${args.chunkIndex}` : source;
  }
  if (args.pageId || (name === "write_page" && args.id)) return String(args.pageId || args.id);
  if (args.query) return String(args.query);
  if (args.designSystemId) return String(args.designSystemId);
  if (name === "inspect_capabilities") return "capabilities";
  if (name === "list_references") return "references";
  if (name === "write_todo") return "todo";
  if (name === "compose_deck") return "deck";
  if (name === "export_deck") return "export";
  if (row.pageId) return String(row.pageId);
  return name;
}

export const TOOL_TITLES = {
  open_project: t("准备演示文稿"),
  inspect_capabilities: t("检查可用能力"),
  list_references: t("查找参考资料"),
  read_reference: t("阅读参考资料"),
  view_design_reference: t("查看设计参考"),
  commit_design: t("确定设计与页面安排"),
  write_todo: t("安排页面制作任务"),
  read_page: t("读取页面"),
  write_page: t("撰写页面"),
  edit_elements: t("修改所选对象"),
  render_page: t("生成页面预览"),
  review_page: t("检查页面效果"),
  search_image: t("寻找配图"),
  generate_image: t("生成配图"),
  web_search: t("检索资料"),
  review_pages: t("检查页面结构"),
  render_deck: t("生成整稿预览"),
  review_deck: t("检查整份演示文稿"),
  compose_deck: t("确认最终稿"),
  export_deck: t("导出演示文稿"),
  finish: t("完成制作"),
  finalize_deck: t("完成制作"),
};

/** @type {Record<string, string>} */
const FIELD_NAMES = {
  items: t("任务列表"),
  slidePlan: t("页面安排"),
  id: t("页面或图片编号"),
  pageId: t("页面编号"),
  prompt: t("图片描述"),
  sourceId: t("资料来源"),
  chunkIndex: t("资料分段"),
  elements: t("页面内容"),
  query: t("搜索词"),
};

/** @param {unknown} value */
export function objectFrom(value) {
  const raw = typeof value === "string" ? value.trim() : value;
  const candidates = typeof raw === "string" ? [raw, raw.replace(/\s*\[image content omitted\]\s*$/i, "")] : [raw];
  for (const candidate of candidates) {
    try {
      const parsed = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

/** @param {unknown} value @param {number} [limit] */
export function brief(value, limit = 160) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, limit) : "";
}

/** @param {unknown} output @param {string} name */
export function failureExplanation(output, name) {
  const value = objectFrom(output);
  const payload = value.payload && typeof value.payload === "object" ? value.payload : {};
  const raw = [value.summary, value.detail, payload.error, output].filter((x) => typeof x === "string").join("\n");
  const missing = [...raw.matchAll(/missing required property ["']([^"']+)["']/g)].map(
    (x) =>
      (x[1] === "id" && name === "write_page"
        ? t("页面编号")
        : x[1] === "id" && name === "generate_image"
          ? t("图片编号")
          : FIELD_NAMES[x[1]]) || x[1],
  );
  if (missing.length) return t(`这次调用未执行：缺少{p0}。`, { p0: [...new Set(missing)].join("、") });
  if (/taste execution gate is not enabled/.test(raw)) return t("本次任务未启用设计参考预览，无法打开这张参考图。");
  if (/unknown OpenKimi source id/.test(raw)) return t("没有找到指定的参考资料。");
  if (/deck overview was not emitted/i.test(raw)) return t("整稿检查尚未执行：缺少整稿预览。");
  const unread = raw.match(/compose gate failed:\s*(\d+) required source chunks unread/i);
  if (unread) return t(`最终合稿尚未完成：仍有 {p0} 个参考资料分段未读取。`, { p0: unread[1] });
  if (/page image was not emitted/i.test(raw)) return t("页面检查尚未执行：缺少该页预览。");
  if (/footer_zone|\boverlap\b/i.test(raw)) return t("页面内容未写入：检测到布局冲突。");
  if (/tool call aborted before dispatch/i.test(raw)) return t("工具调用在派发前中止。");
  if (/unauthorized|authentication|invalid.api.key|\b401\b/i.test(raw)) return t("服务未通过身份验证，这次调用失败。");
  if (/rate.limit|\b429\b/i.test(raw)) return t("服务请求过于频繁，这次调用未完成。");
  if (/timeout|timed out/i.test(raw)) return t("等待服务响应超时，这次调用未完成。");
  const chinese = [value.summary, value.detail].find((x) => typeof x === "string" && /[\u4e00-\u9fff]/.test(x));
  return chinese ? brief(chinese) : t("这次操作没有完成，具体错误保留在技术详情中。");
}
