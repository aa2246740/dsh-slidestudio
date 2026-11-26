import { INVALID_REPLY, record } from "./generation-data.js";
import { t } from "./i18n.js";

/** PDF page-image status shown on a parsed PDF chip. Text parsing never waits
 *  for it; this module only decodes it, words the chip note and re-reads a render that is still queued or running.
 * @import { PublicAttachment } from "./attachment-public.js"
 * @import { LocalAttachment } from "./attachment-chips.js"
 * @typedef {{
 *  available: boolean, state: string, pageCount: number, renderedPages: number, maxPages: number, message: string, }} PdfRenderStatus
 * @typedef {Pick<LocalAttachment, "id"|"status"|"parser"|"pdfRender"|"summaryZh"|"warnings"|"styleProfile"|"renderTimer"|"renderPolls"|"renderGaveUp">} PdfRenderChip */

/** A queued or running PDF render is re-read this often, for at most
 * RENDER_POLL_LIMIT rounds (about ten minutes). */
export const RENDER_POLL_MS = 1500;
export const RENDER_POLL_LIMIT = 400;
const PDF_RENDER_PENDING = new Set(["queued", "running"]);

/** Strict decode of the optional PDF page-image status (server projection).
 * @param {unknown} value @returns {PdfRenderStatus|undefined} */
export function parsePdfRender(value) {
  if (value == null) return undefined;
  const data = record(value);
  if (
    typeof data.available !== "boolean" ||
    typeof data.state !== "string" ||
    typeof data.message !== "string" ||
    !Number.isSafeInteger(data.pageCount) ||
    !Number.isSafeInteger(data.renderedPages) ||
    !Number.isSafeInteger(data.maxPages)
  ) {
    throw new Error(INVALID_REPLY);
  }
  return {
    available: data.available,
    state: data.state,
    pageCount: /** @type {number} */ (data.pageCount),
    renderedPages: /** @type {number} */ (data.renderedPages),
    maxPages: /** @type {number} */ (data.maxPages),
    message: data.message,
  };
}

/** @param {unknown} parser */
export function isPdfParser(parser) {
  return typeof parser === "string" && parser.startsWith("pdf-unpdf-");
}

/** Chip line for a PDF's page images, or null when there is nothing to show.
 * Failure names the consequence for vision models; the text stays readable.
 * @param {Pick<PdfRenderChip, "status"|"parser"|"pdfRender">} item
 * @returns {{text: string, failed: boolean}|null} */
export function pdfRenderNote(item) {
  const render = item.pdfRender;
  if (item.status !== "parsed" || !render || !isPdfParser(item.parser)) return null;
  if (render.state === "ready") {
    return {
      text: t("页面图片已生成 {n} 页，看图模型可按页查看", { n: render.renderedPages }),
      failed: false,
    };
  }
  if (PDF_RENDER_PENDING.has(render.state)) {
    return { text: t("页面图片生成中，文字已可使用"), failed: false };
  }
  return { text: t("页面图片没有生成，看图模型无法查看页面"), failed: true };
}

/** DOM form of pdfRenderNote for the chip header; null when there is no line.
 * @param {Pick<PdfRenderChip, "status"|"parser"|"pdfRender">} item
 * @returns {HTMLElement|null} */
export function pdfRenderNoteElement(item) {
  const line = pdfRenderNote(item);
  if (!line) return null;
  const note = document.createElement("small");
  note.className = line.failed ? "chip-render-note is-failed" : "chip-render-note";
  note.textContent = line.text;
  return note;
}

/**
 *  A parsed PDF whose page images are still queued or running, and that the poller has not given up on. Only these hold a vision model's send.
 * @param {Partial<Pick<PdfRenderChip, "status"|"parser"|"pdfRender"|"renderGaveUp">>} item
 */
export function pdfRenderPending(item) {
  return (
    item.status === "parsed" &&
    isPdfParser(item.parser) &&
    item.pdfRender?.available === true &&
    PDF_RENDER_PENDING.has(item.pdfRender.state) &&
    item.renderGaveUp !== true
  );
}

/**
 *  Bounded re-read of PDFs whose page images are still pending. Each read refreshes the page-image status and the summary, warnings and style profile the chip shows.
 *  Removing a chip stops its loop; a failed read keeps the last note and retries. A deleted record (404) or an exhausted budget gives up: the chip keeps its data and no longer holds the send gate.
 * @param {{
 *  apiPath: (path: string) => string, items: PdfRenderChip[], onUpdate: () => void, parse: (value: unknown) => Partial<Pick<PublicAttachment, "pdfRender"|"summary"|"warnings"|"styleProfile">>, }} options
 */
export function createPdfRenderPoller({ apiPath, items, parse, onUpdate }) {
  /** @param {PdfRenderChip} item */
  function watch(item) {
    if (!item.id || item.status !== "parsed" || !isPdfParser(item.parser)) return;
    if (!item.pdfRender || !PDF_RENDER_PENDING.has(item.pdfRender.state) || item.renderTimer) return;
    item.renderPolls = 0;
    item.renderGaveUp = false;
    item.renderTimer = setTimeout(() => void poll(item), RENDER_POLL_MS);
  }
  /** @param {PdfRenderChip} item */
  function stop(item) {
    clearTimeout(item.renderTimer || undefined);
    item.renderTimer = 0;
  }
  /** Stop counting the render as pending and repaint once, so the gate releases.
   * @param {PdfRenderChip} item */
  function giveUp(item) {
    item.renderGaveUp = true;
    onUpdate();
  }
  /**
   * @param {PdfRenderChip} item
   * @param {ReturnType<typeof parse>} fresh
   */
  function applyFresh(item, fresh) {
    if (fresh.pdfRender) item.pdfRender = fresh.pdfRender;
    item.summaryZh = fresh.summary?.zh || "";
    item.warnings = fresh.warnings;
    item.styleProfile = fresh.styleProfile;
  }
  /** One GET of the record; resolves true when the record is gone (404).
   * @param {PdfRenderChip} item @param {string} id */
  async function readOnce(item, id) {
    try {
      const response = await fetch(apiPath(`/api/attachments/${encodeURIComponent(id)}`), {
        headers: { Accept: "application/json" },
      });
      if (!items.includes(item)) return false;
      if (response.status === 404) return true;
      if (response.ok) {
        const fresh = parse(await response.json());
        if (!items.includes(item)) return false;
        applyFresh(item, fresh);
        onUpdate();
      }
    } catch {
      // Network or malformed reply: keep the last note and try again below.
    }
    return false;
  }
  /** @param {PdfRenderChip} item */
  async function poll(item) {
    item.renderTimer = 0;
    if (!items.includes(item) || !item.id) return;
    item.renderPolls = (item.renderPolls || 0) + 1;
    const deleted = await readOnce(item, item.id);
    if (!items.includes(item)) return;
    if (deleted) {
      giveUp(item);
      return;
    }
    if (!item.pdfRender || !PDF_RENDER_PENDING.has(item.pdfRender.state)) return;
    if ((item.renderPolls || 0) >= RENDER_POLL_LIMIT) {
      giveUp(item);
      return;
    }
    item.renderTimer = setTimeout(() => void poll(item), RENDER_POLL_MS);
  }
  return { watch, stop };
}
