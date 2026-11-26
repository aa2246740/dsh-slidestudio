/**
 * Upload size limits. The HTTP body cap is the largest limit any type may
 * have (50 MiB); the per-type limit is applied after the content is detected,
 * so a renamed file gets the limit of what it really is. Anything not listed
 * as a large document — images, spreadsheets, Word files, text and the legacy
 * Office formats — keeps 20 MiB.
 */
import { detectType } from "./detect.mjs";

const MIB = 1024 * 1024;

export const DEFAULT_FILE_BYTES = 20 * MIB;
export const LARGE_DOCUMENT_BYTES = 50 * MIB;
/** Hard cap on the request body, read before anything is known about the type. */
export const MAX_UPLOAD_BYTES = LARGE_DOCUMENT_BYTES;

export const UPLOAD_CAP_MESSAGE = "文件超过 50MB 上限，请压缩或拆分后再上传";
export const TOO_LARGE_FOR_TYPE_MESSAGE = "图片等文件不能超过 20MB；PPT 和 PDF 不能超过 50MB";

const LARGE_DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
]);

/**
 * Whether an upload may be accepted at its size. Files up to the default limit
 * are never inspected; larger ones must be detected as a PPTX, POTX or PDF.
 * @param {string} name @param {Uint8Array} bytes
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function uploadSizeVerdict(name, bytes) {
  if (bytes.length > LARGE_DOCUMENT_BYTES) return { ok: false, message: UPLOAD_CAP_MESSAGE };
  if (bytes.length <= DEFAULT_FILE_BYTES) return { ok: true };
  const detected = detectType({ name, bytes });
  if (detected.ok && LARGE_DOCUMENT_MIMES.has(detected.detectedMime)) return { ok: true };
  return { ok: false, message: TOO_LARGE_FOR_TYPE_MESSAGE };
}
