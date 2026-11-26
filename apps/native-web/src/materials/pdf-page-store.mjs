import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Structural view of the attachment store the PDF modules use. The editor is
 * single-user and local: records carry no owner and reads take no scope.
 * @typedef {{index: number, file: string, sha256: string,
 *   px: {width: number, height: number}}} PdfPageDescriptor
 * @typedef {{kind: string|null, source?: {detectedMime?: string|null},
 *   parser?: {id?: string|null}, summary?: unknown,
 *   warnings: {code: string, message: string}[], document?: Record<string, any>,
 *   [key: string]: unknown}} PdfStoredDerivative
 * @typedef {{meta: {id: string, [key: string]: unknown},
 *   derivative: PdfStoredDerivative}} PdfStoredRecord
 * @typedef {{root: string,
 *   paths: (id: string) => {original: string, metadata: string, derivative: string},
 *   regularFile: (file: string) => Buffer,
 *   read: (id: string) => PdfStoredRecord|undefined}} PdfAttachmentStore
 */

/** @param {Uint8Array} bytes */
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** @param {PdfAttachmentStore} store @param {string} id @param {number} page */
function pagePath(store, id, page) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 40) {
    throw new Error("PDF 页面编号无效");
  }
  return `${store.paths(id).original}.page-${page}.jpg`;
}

/**
 * Atomically persist a page image next to its attachment's files.
 * @param {PdfAttachmentStore} store
 * @param {string} id @param {number} page @param {Buffer} bytes @param {string} sha256
 */
export function writePdfPage(store, id, page, bytes, sha256) {
  if (!bytes.length || digest(bytes) !== sha256) throw new Error("PDF 页面图片校验失败");
  const destination = pagePath(store, id, page);
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
    const saved = store.regularFile(destination);
    if (digest(saved) !== sha256) throw new Error("PDF 页面图片落盘校验失败");
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temp is private and may already have been renamed.
    }
    throw error;
  }
}

/**
 * Remove only renderer-owned page JPEGs matching this exact attachment id.
 * @param {PdfAttachmentStore} store @param {string} id
 * @param {number[]} [keepPages]
 */
export function removePdfPages(store, id, keepPages = []) {
  const original = store.paths(id).original;
  const prefix = `${path.basename(original)}.page-`;
  const keep = new Set(keepPages);
  for (const entry of fs.readdirSync(store.root)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".jpg")) continue;
    const page = Number(entry.slice(prefix.length, -4));
    if (!Number.isSafeInteger(page) || keep.has(page)) continue;
    const candidate = path.join(store.root, entry);
    try {
      store.regularFile(candidate);
      fs.unlinkSync(candidate);
    } catch {
      // Do not follow or remove a non-regular/symlink entry.
    }
  }
}

/**
 * Return a hash-verified JPEG or undefined when it was never rendered. The
 * derivative descriptor, not a caller-provided path, is the only authority
 * for page access.
 * @param {PdfAttachmentStore} store @param {string} id @param {number} page
 * @returns {{bytes: Buffer, descriptor: PdfPageDescriptor}|undefined}
 */
export function readPdfPage(store, id, page) {
  const record = store.read(id);
  if (!record || record.derivative.parser?.id?.startsWith("pdf-unpdf-") !== true) {
    return undefined;
  }
  const document = record.derivative.document;
  const descriptor = Array.isArray(document?.renderedPages)
    ? /** @type {(PdfPageDescriptor|undefined)[]} */ (document.renderedPages).find((entry) => entry?.index === page)
    : undefined;
  if (
    document?.renderState !== "ready" ||
    !descriptor ||
    descriptor.file !== `page-${page}.jpg` ||
    typeof descriptor.sha256 !== "string"
  ) {
    return undefined;
  }
  const bytes = store.regularFile(pagePath(store, id, page));
  if (digest(bytes) !== descriptor.sha256) throw new Error("PDF 页面图片校验失败");
  return { bytes, descriptor };
}
