import { record } from "./generation-data.js";
import { t } from "./i18n.js";

export const INTERNAL_CLIPBOARD_TYPE = "application/x-open-slidestudio-elements";
const HTML_MARKER = "data-open-slidestudio-clipboard";

/** @param {unknown} value */
export function decodeClipboardContent(value) {
  const source = record(value);
  if (
    source !== value ||
    (source.token !== undefined && typeof source.token !== "string") ||
    (source.plain !== undefined && typeof source.plain !== "string")
  )
    throw new TypeError(t("剪贴板格式无效"));
  return {
    token: typeof source.token === "string" ? source.token : "",
    plain: typeof source.plain === "string" ? source.plain : "",
  };
}

/** @param {EventTarget | null} [target] */
export function nativeClipboardTarget(target = document.activeElement) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable) ||
    (target instanceof Element && Boolean(target.closest('[contenteditable="true"]')))
  );
}

/** @param {Pick<DataTransfer, "getData"> | null | undefined} data */
export function clipboardPlainText(data) {
  const plain = data?.getData("text/plain") || "";
  if (plain) return plain;
  const html = data?.getData("text/html") || "";
  if (!html) return "";
  return new DOMParser().parseFromString(html, "text/html").body.textContent || "";
}

/** @param {{token: string, plain: string}} payload */
export function clipboardHtml(payload) {
  const node = document.createElement("span");
  node.setAttribute(HTML_MARKER, payload.token);
  node.textContent = payload.plain;
  return node.outerHTML;
}

/** @param {string} html */
export function clipboardTokenFromHtml(html) {
  if (!html) return "";
  return (
    new DOMParser().parseFromString(html, "text/html").querySelector(`[${HTML_MARKER}]`)?.getAttribute(HTML_MARKER) ||
    ""
  );
}
