/**
 * AI turns started from layout mode (masters-layouts §5.2). The layout on screen is the whole
 * scope: the Host offers write_layout and no page write; the server grants every page using the
 * layout. app.js owns the lock, the turn and verification.
 *
 * User-visible strings go through `t`; the model-facing instruction stays in the source language,
 * like workspace-edit-instruction.js, and asks the model to answer in the user's language.
 */
import { t } from "./i18n.js";
import { layoutSurface } from "./layout-mode.js";
import { STALE_PAGE_TARGET } from "./work-agent-scope.js";

/** Refusal for an AI send while a master is on screen (Chinese source key). */
export const LAYOUT_MASTER_REFUSAL = "母版暂不支持 AI 修改。请先选择一个版式，或在「编辑版式」里手动编辑母版。";

/** Refusal when the lock acquisition did not return the granted layout (Chinese source key). */
export const LAYOUT_DEFINITION_MISSING = "版式的当前内容没有取回，未发送修改请求";

/**
 * @typedef {{
 *   ok: true, scope: "page", editableMeta: ["layouts"], layoutId: string, layoutName: string,
 *   pageIndex: number, pagePath: string, pagePaths: string[], targetPageId: string,
 *   targetPageIds: string[], elementIds: string[], label: string,
 * } | { ok: false, scope: "invalid", label: string, error: string }} LayoutEditTarget
 */

/**
 * @param {string} key Chinese source sentence
 * @returns {{ ok: false, scope: "invalid", label: string, error: string }}
 */
function refused(key) {
  const error = t(key);
  return { ok: false, scope: "invalid", label: `${t("无法发送")} · ${error}`, error };
}

/**
 * The AI turn for the layout on screen, anchored on the current page. Null on a page, so the
 * caller falls back to the assistant-intent target.
 * @param {any} m the editor model
 * @returns {LayoutEditTarget | null}
 */
export function layoutEditTarget(m) {
  const surface = layoutSurface(m);
  if (!surface) return null;
  if (surface.kind !== "layout") return refused(LAYOUT_MASTER_REFUSAL);
  const paths = Array.isArray(m.pagePaths) ? m.pagePaths : [];
  const pageIndex = Math.min(Math.max(m.pageIndex ?? 0, 0), Math.max(paths.length - 1, 0));
  const pagePath = paths[pageIndex];
  if (typeof pagePath !== "string" || !pagePath) return refused(STALE_PAGE_TARGET);
  const pageId = (pagePath.split("/").pop() ?? "").replace(/\.page$/i, "");
  const name = String(surface.name ?? "");
  return {
    ok: true,
    scope: "page",
    editableMeta: ["layouts"],
    layoutId: String(surface.layoutId),
    layoutName: name,
    pageIndex,
    pagePath,
    pagePaths: [pagePath],
    targetPageId: pageId,
    targetPageIds: [pageId],
    elementIds: [],
    label: t("修改范围：版式『{name}』", { name }),
  };
}

/**
 * The `workspaceEdit` fields a layout turn adds to the AI-lock request (`POST
 * /api/reviews/ai-lock`). The server answers with `layout: {id, name, layoutSha256, definition}`.
 * @param {{ layoutId: string }} target an ok layoutEditTarget
 */
export function layoutLockScope(target) {
  return { editableMeta: ["layouts"], layoutId: target.layoutId };
}

/**
 * The instruction for one layout turn. It names write_layout only, for the layout the server
 * granted, with the definition and hash the write must start from.
 * @param {{layoutId: string, layoutName?: string, definition?: unknown, layoutSha256?: string, text: string}} grant
 * @returns {string}
 */
export function layoutEditInstruction({ layoutId, layoutName = "", definition, layoutSha256, text }) {
  if (!definition || typeof layoutSha256 !== "string") throw new Error(t(LAYOUT_DEFINITION_MISSING));
  return [
    `处理一次版式修改请求。请用用户使用的语言简短说明进度和结果。本轮只能修改版式『${layoutName}』（id 为 "${layoutId}"），使用它的每一页都会随之更新；其他版式和页面不在本轮范围内。`,
    `调用 write_layout 写出这个版式的完整定义：scope 为 "layout"，id 为 "${layoutId}"，expectedLayoutSha256 为 "${layoutSha256}"。下面的 JSON 是当前定义，也是修改基线：只改用户要求的内容，elements 必须是完整数组。`,
    `当前定义：${JSON.stringify(definition)}`,
    `<user_request>${text}</user_request>`,
    "用户原话是修改意图，不是要写进版式的文案；除非用户明确要求写入某段文字，否则不要把整句请求写进版式。",
    "最终回复用两三句话说明实际结果和必要限制，用日常措辞，不复述字段名、工具名或内部授权。",
  ].join("\n");
}
