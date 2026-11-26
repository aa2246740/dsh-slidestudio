import crypto from "node:crypto";
import fs from "node:fs";
import { MATERIAL_MAX_ORIGINAL_BYTES } from "@open-slidestudio/presentation-run";
import { mergePdfPixelStyle, PDF_RENDER_CONFIG, runPdfRenderChild } from "./pdf-render.mjs";
import { readPdfPage, removePdfPages, writePdfPage } from "./pdf-page-store.mjs";
import { mergePdfPageImages, pdfWording } from "./pdf-wording.mjs";

const PDF_MIME = "application/pdf";
const CANVAS_UNAVAILABLE = "页面图片没有生成，看图模型无法查看页面；PDF 文字仍可读取";
const INVALID_PAGES = "PDF 页面图片校验失败，文字内容仍可读取";
const UNSAFE_SAVE = "PDF 页面图片无法安全保存，文字内容仍可读取";

/**
 * @typedef {import("./pdf-page-store.mjs").PdfAttachmentStore} PdfAttachmentStore
 * @typedef {import("./pdf-page-store.mjs").PdfStoredRecord} PdfStoredRecord
 * @typedef {import("./pdf-page-store.mjs").PdfStoredDerivative} PdfStoredDerivative
 * @typedef {import("./pdf-page-store.mjs").PdfPageDescriptor} PdfPageDescriptor
 * @typedef {{code?: string, message?: string, peakRssMb?: number}} PdfRenderFailure
 */

/**
 * Queue one successfully parsed PDF without awaiting any rendering work.
 * `overrides` is a test-only injection; no route or caller in the product passes it.
 * @param {{store: PdfAttachmentStore, queue: import("./pdf-render.mjs").PdfRenderQueue,
 *   record: PdfStoredRecord, overrides?: import("./pdf-render.mjs").PdfRenderOverrides}} input
 */
export function enqueuePdfRender({ store, queue, record, overrides }) {
  if (!isPdf(record.derivative)) return false;
  const id = record.meta.id;
  const pageCount = Number(record.derivative.document?.pageCount) || 0;
  /** @type {import("./pdf-render.mjs").PdfRenderMetrics} */
  let metrics = { peakRssMb: 0, durationMs: 0 };
  const accepted = queue.enqueue({
    id,
    start: () => updatePdfRenderState(store, id, "running"),
    run: async () => {
      const current = readOwnedRecord(store, id);
      if (!current || !isPdf(current.derivative)) {
        throw renderFailure("render-failed", "PDF 原文件已变化，页面图片未生成；文字内容仍可读取");
      }
      const filePath = store.paths(id).original;
      store.regularFile(filePath);
      const result = await runPdfRenderChild({
        filePath,
        pageCount,
        overrides,
        onMetrics: (value) => {
          metrics = {
            peakRssMb: Number(value.peakRssMb) || 0,
            durationMs: Number(value.durationMs) || 0,
          };
        },
      });
      return { ...result, metrics };
    },
    complete: (result) => storePdfRenderResult(store, id, result),
    fail: (error) => storePdfRenderFailure(store, id, error),
  });
  if (!accepted) {
    storePdfRenderFailure(store, id, {
      code: "render-queue-full",
      message: "PDF 页面图片队列已满，文字内容仍可读取；请稍后重新上传",
    });
  }
  return accepted;
}

/** @param {string} state @param {number} rendered @param {boolean|null} available */
function defaultRenderMessage(state, rendered, available) {
  if (state === "ready") return `已生成前 ${rendered} 页图片，可供支持看图的模型按页查看`;
  if (available === false) return CANVAS_UNAVAILABLE;
  if (available === null) return "正在检查 PDF 页面图片能力，文字解析不受影响";
  return "PDF 页面图片正在后台生成，文字解析不受影响";
}

/**
 * Safe, content-free public projection for chips and attachment polling.
 * @param {PdfStoredRecord} record
 * @param {boolean|null} available
 */
export function publicPdfRenderStatus(record, available) {
  if (!isPdf(record.derivative)) return undefined;
  const document = record.derivative.document ?? {};
  /** @type {PdfPageDescriptor[]} */
  const renderedPages = Array.isArray(document.renderedPages) ? document.renderedPages : [];
  const state = typeof document.renderState === "string" ? document.renderState : "queued";
  const message =
    typeof document.renderMessage === "string"
      ? document.renderMessage
      : defaultRenderMessage(state, renderedPages.length, available);
  return {
    available: available === true,
    state,
    pageCount: Number(document.pageCount) || 0,
    renderedPages: renderedPages.length,
    pages: renderedPages.map((page) => ({
      page: page.index,
      sha256: page.sha256,
      px: page.px,
      url: `/api/attachments/${encodeURIComponent(record.meta.id)}/pages/${page.index}`,
    })),
    maxPages: PDF_RENDER_CONFIG.maxPages,
    message,
  };
}

export { readPdfPage };

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Current record of a PDF attachment. The name is kept for callers written for
 * owner-scoped stores; this local single-user store has no owner to check.
 * @param {PdfAttachmentStore} store @param {string} id
 * @returns {PdfStoredRecord|undefined}
 */
export function readOwnedRecord(store, id) {
  return store.read(id);
}

/** @param {PdfStoredDerivative} derivative */
function isPdf(derivative) {
  return (
    derivative.kind === "document" &&
    (derivative.source?.detectedMime === PDF_MIME || derivative.parser?.id?.startsWith("pdf-unpdf-") === true)
  );
}

/** @param {PdfAttachmentStore} store @param {string} id @param {string} state */
function updatePdfRenderState(store, id, state) {
  const derivative = updateRecord(store, id, (current) => ({
    ...current,
    document: {
      ...current.document,
      renderState: state,
      renderMessage:
        state === "running" ? "PDF 页面图片正在后台生成，文字解析不受影响" : current.document?.renderMessage,
    },
  }));
  if (derivative) persistDerivative(store, id, serialize(derivative));
}

/** @param {unknown} page @param {number} expectedIndex @returns {page is PdfPageDescriptor & {data: string}} */
function validRenderedPage(page, expectedIndex) {
  if (!isRecord(page) || page.index !== expectedIndex || !Number.isSafeInteger(page.index)) {
    return false;
  }
  const px = page.px;
  return (
    page.file === `page-${page.index}.jpg` &&
    isHash(page.sha256) &&
    isRecord(px) &&
    Number.isSafeInteger(px.width) &&
    Number.isSafeInteger(px.height) &&
    px.width >= 1 &&
    px.width <= PDF_RENDER_CONFIG.width &&
    px.height >= 1 &&
    px.height <= 50_000 &&
    typeof page.data === "string"
  );
}

/**
 * Verify and write every rendered page JPEG, or name the failure to record.
 * @param {PdfAttachmentStore} store @param {string} id @param {unknown} pages
 * @returns {{normalized: PdfPageDescriptor[], keepPages: number[]}|{failure: string}}
 */
function savePdfPages(store, id, pages) {
  if (!Array.isArray(pages) || pages.length > PDF_RENDER_CONFIG.maxPages) {
    return { failure: "PDF 页面图片结果无效，文字内容仍可读取" };
  }
  /** @type {PdfPageDescriptor[]} */
  const normalized = [];
  for (const page of pages) {
    if (!validRenderedPage(page, normalized.length + 1)) return { failure: INVALID_PAGES };
    const bytes = Buffer.from(page.data, "base64");
    if (!bytes.length || digest(bytes) !== page.sha256) return { failure: INVALID_PAGES };
    try {
      writePdfPage(store, id, page.index, bytes, page.sha256);
    } catch {
      return { failure: UNSAFE_SAVE };
    }
    const { index, file, sha256, px } = page;
    normalized.push({ index, file, sha256, px: { width: px.width, height: px.height } });
  }
  return { normalized, keepPages: normalized.map((page) => page.index) };
}

/**
 * The derivative after a successful render: measured image coverage upgrades the
 * low-text wording, page descriptors and metrics are recorded, pixel style merged.
 * @param {PdfStoredDerivative} current
 * @param {import("./pdf-render.mjs").PdfRenderOutcome} result
 * @param {PdfPageDescriptor[]} normalized
 */
function renderedDerivative(current, result, normalized) {
  const document = current.document ?? {};
  const pages = mergePdfPageImages(Array.isArray(document.pages) ? document.pages : [], result.pageImages);
  const wording = pdfWording({
    parserId: current.parser?.id ?? "",
    pageCount: Number(document.pageCount) || pages.length,
    chars: Number(document.chars) || 0,
    pages,
    extractedPages: pages.length,
    tables: Array.isArray(document.tables) ? document.tables.length : 0,
  });
  const metrics = result.metrics;
  return {
    ...current,
    summary: wording.summary,
    warnings: [
      ...(Array.isArray(current.warnings) ? current.warnings : []).filter(
        (warning) => warning.code !== "scanned-pages",
      ),
      ...wording.warnings,
    ],
    document: {
      ...document,
      pages,
      renderedPages: normalized,
      renderState: "ready",
      renderMessage: `已生成前 ${normalized.length} 页图片，可供支持看图的模型按页查看`,
      renderMetrics: isRecord(metrics)
        ? { peakRssMb: Number(metrics.peakRssMb) || 0, durationMs: Number(metrics.durationMs) || 0 }
        : undefined,
      ...(result.pixelStyleProfile
        ? { styleProfile: mergePdfPixelStyle(document.styleProfile, result.pixelStyleProfile) }
        : {}),
    },
  };
}

/**
 * @param {PdfAttachmentStore} store
 * @param {string} id
 * @param {import("./pdf-render.mjs").PdfRenderOutcome} result
 */
function storePdfRenderResult(store, id, result) {
  // A PDF deleted while its render ran keeps no page image: the record is
  // confirmed before the first JPEG is written.
  if (!pdfExists(store, id)) {
    removePdfPages(store, id);
    return;
  }
  const saved = savePdfPages(store, id, result.renderedPages);
  if ("failure" in saved) {
    storePdfRenderFailure(store, id, { code: "render-failed", message: saved.failure });
    return;
  }
  const derivative = updateRecord(store, id, (current) => renderedDerivative(current, result, saved.normalized));
  if (!derivative) {
    removePdfPages(store, id);
    return;
  }
  const bytes = serialize(derivative);
  if (bytes.length > MATERIAL_MAX_ORIGINAL_BYTES) {
    removePdfPages(store, id);
    storePdfRenderFailure(store, id, {
      code: "render-limit",
      message: "PDF 页面图片超出资料存储上限，未保存页面图；文字内容仍可读取",
    });
    return;
  }
  // Re-checked after the rename: a delete can land between the read and the
  // rename. A vanished record or an unwritable derivative keeps no page.
  if (!persistDerivative(store, id, bytes) || !pdfExists(store, id)) {
    removePdfPages(store, id);
    storePdfRenderFailure(store, id, { code: "render-failed", message: UNSAFE_SAVE });
    return;
  }
  removePdfPages(store, id, saved.keepPages);
}

/**
 * @param {PdfAttachmentStore} store @param {string} id @param {PdfRenderFailure} error
 */
function storePdfRenderFailure(store, id, error) {
  const code = typeof error.code === "string" ? error.code : "render-failed";
  const unavailable = code === "canvas-unavailable";
  const message = unavailable
    ? CANVAS_UNAVAILABLE
    : typeof error.message === "string"
      ? error.message
      : "PDF 页面图片生成失败，文字内容仍可读取";
  const peakRssMb = Number(error.peakRssMb);
  const saved = updateRecord(store, id, (current) => ({
    ...current,
    document: {
      ...current.document,
      renderedPages: [],
      renderState: unavailable ? "unavailable" : "failed",
      renderMessage: message,
      ...(Number.isFinite(peakRssMb) ? { renderMetrics: { peakRssMb, durationMs: 0 } } : {}),
    },
  }));
  // A failed or vanished record keeps no page JPEG from this render.
  removePdfPages(store, id);
  if (!saved) return;
  saved.warnings = [
    ...saved.warnings.filter(
      (warning) => !warning.code.startsWith("render-") && warning.code !== "page-render-unavailable",
    ),
    { code, message },
  ];
  persistDerivative(store, id, serialize(saved));
}

/**
 * @param {PdfAttachmentStore} store @param {string} id
 * @param {(derivative: PdfStoredDerivative) => PdfStoredDerivative} update
 * @returns {PdfStoredDerivative|undefined}
 */
function updateRecord(store, id, update) {
  const record = readOwnedRecord(store, id);
  if (!record || !isPdf(record.derivative)) return undefined;
  if (!isRecord(record.derivative.document)) return undefined;
  return update(record.derivative);
}

/** True while the record still exists and is a PDF. @param {PdfAttachmentStore} store @param {string} id */
function pdfExists(store, id) {
  const record = readOwnedRecord(store, id);
  return Boolean(record && isPdf(record.derivative));
}

/** @param {unknown} derivative */
const serialize = (derivative) => Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");

/** @param {string[]} files */
function unlinkQuietly(files) {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // A failed temp file has no authority and is safe to leave absent.
    }
  }
}

/**
 * Replace the derivative and its hash receipt synchronously. JS cannot
 * interleave a GET between these two renames, and temp files are private to
 * the attachment store directory.
 * @param {PdfAttachmentStore} store @param {string} id @param {Buffer} bytes
 * @returns {boolean} false when the record is gone or the files could not be written
 */
function persistDerivative(store, id, bytes) {
  const record = readOwnedRecord(store, id);
  if (!record) return false;
  const paths = store.paths(id);
  const metadata = JSON.parse(store.regularFile(paths.metadata).toString("utf8"));
  const tempDerivative = `${paths.derivative}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const tempMetadata = `${paths.metadata}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempDerivative, bytes, { flag: "wx", mode: 0o600 });
    metadata.derivativeSha256 = digest(bytes);
    fs.writeFileSync(tempMetadata, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(tempDerivative, paths.derivative);
    fs.renameSync(tempMetadata, paths.metadata);
    return true;
  } catch {
    unlinkQuietly([tempDerivative, tempMetadata]);
    return false;
  }
}

/** @param {unknown} value */
function isHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** @param {Uint8Array} bytes */
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** @param {string} code @param {string} message */
function renderFailure(code, message) {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}
