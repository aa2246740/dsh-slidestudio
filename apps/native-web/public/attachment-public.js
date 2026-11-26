import { INVALID_REPLY, record, text } from "./generation-data.js";
import { assertStyleProfileContext, parsePublicStyleProfile } from "./attachment-style-profile.js";
import { parseImageMaterials } from "./attachment-image-pack.js";
import { parseEmbeddedImages } from "./attachment-embedded.js";
import { parseImageMetadata } from "./attachment-image-metadata.js";
import { parsePdfRender } from "./attachment-pdf-render.js";
/** @import { StyleProfile } from "./attachment-style-profile.js" */
/** @import { ImageMetadata } from "./attachment-image-metadata.js" */
/** @import { EmbeddedImage } from "./attachment-embedded.js" */
/** @import { PdfRenderStatus } from "./attachment-pdf-render.js" */

/** Public attachment record served by POST /api/attachments/upload, GET /api/attachments/:id and the demo route.
 * @typedef {{
 *  id: string, name: string, size: number, kind: "text"|"table"|"document"|"deck-template"|"image"|null, status: "parsed"|"unsupported"|"failed", parser: string|null, summary: {zh: string}|null,
 *  styleProfile?: StyleProfile, styleHintLine?: string, imageMetadata?: ImageMetadata, warnings: {code: string, message: string}[], needsVision: boolean,
 *  imageMaterials?: PublicAttachment[], embeddedImages?: EmbeddedImage[], pdfRender?: PdfRenderStatus, duplicateOf?: string, errorCode?: string, message?: string, }} PublicAttachment
 */

const KINDS = ["text", "table", "document", "deck-template", "image"];
const STATUSES = ["parsed", "unsupported", "failed"];
export { INVALID_REPLY };

/** @param {unknown} value */
const optionalString = (value) => value === undefined || typeof value === "string";

/** @param {unknown} value */
const validSize = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** @param {unknown} value */
function validWarnings(value) {
  return (
    Array.isArray(value) &&
    value.every((warning) => {
      const entry = record(warning);
      return typeof entry.code === "string" && typeof entry.message === "string";
    })
  );
}

/** Identity, status and kind of the record.
 * @param {Record<string, unknown>} data @param {string} status @param {string|null} kind */
function validHead(data, status, kind) {
  return (
    Boolean(text(data.id).trim()) &&
    Boolean(text(data.name).trim()) &&
    STATUSES.includes(status) &&
    (kind === null || KINDS.includes(kind)) &&
    validSize(data.size)
  );
}

/** Optional scalar fields of the record.
 * @param {Record<string, unknown>} data @param {Record<string, unknown>|null} summary */
function validFields(data, summary) {
  return (
    (data.parser === null || optionalString(data.parser)) &&
    !(summary && typeof summary.zh !== "string") &&
    validWarnings(data.warnings) &&
    typeof data.needsVision === "boolean" &&
    optionalString(data.duplicateOf) &&
    optionalString(data.errorCode) &&
    optionalString(data.message) &&
    (data.styleHintLine === undefined || (typeof data.styleHintLine === "string" && data.styleHintLine.length <= 240))
  );
}

/** @param {unknown} value @returns {{code: string, message: string}[]} */
function warningsOf(value) {
  return (Array.isArray(value) ? value : []).map((warning) => {
    const entry = record(warning);
    return { code: text(entry.code), message: text(entry.message) };
  });
}

/** Optional string fields copied only when present.
 * @param {Record<string, unknown>} data */
function optionalStrings(data) {
  return {
    ...(typeof data.styleHintLine === "string" && data.styleHintLine ? { styleHintLine: data.styleHintLine } : {}),
    ...(typeof data.duplicateOf === "string" ? { duplicateOf: data.duplicateOf } : {}),
    ...(typeof data.errorCode === "string" ? { errorCode: data.errorCode } : {}),
    ...(typeof data.message === "string" ? { message: data.message } : {}),
  };
}

/** Strictly decode the public attachment record; never paint fabricated data.
 * @param {unknown} value @returns {PublicAttachment} */
export function parseAttachmentPublic(value) {
  const data = record(value);
  const status = text(data.status);
  const kind = data.kind === null ? null : text(data.kind);
  const summary = data.summary == null ? null : record(data.summary);
  const styleProfile = parsePublicStyleProfile(data.styleProfile);
  const imageMetadata = parseImageMetadata(data.imageMetadata);
  const pdfRender = parsePdfRender(data.pdfRender);
  if (!validHead(data, status, kind) || !validFields(data, summary)) {
    throw new Error(INVALID_REPLY);
  }
  assertStyleProfileContext(styleProfile, kind, data.parser, imageMetadata);
  const imageMaterials = parseImageMaterials(data.imageMaterials, data.parser, kind, status, parseAttachmentPublic);
  const embeddedImages = parseEmbeddedImages(data.embeddedImages, data.parser, kind, status);
  return {
    id: text(data.id),
    name: text(data.name),
    size: /** @type {number} */ (data.size),
    kind: /** @type {PublicAttachment["kind"]} */ (kind),
    status: /** @type {PublicAttachment["status"]} */ (status),
    parser: typeof data.parser === "string" ? data.parser : null,
    summary: summary ? { zh: text(summary.zh) } : null,
    ...(styleProfile ? { styleProfile } : {}),
    ...(imageMetadata ? { imageMetadata } : {}),
    warnings: warningsOf(data.warnings),
    needsVision: data.needsVision === true,
    ...(imageMaterials ? { imageMaterials } : {}),
    ...(embeddedImages ? { embeddedImages } : {}),
    ...(pdfRender ? { pdfRender } : {}),
    ...optionalStrings(data),
  };
}
