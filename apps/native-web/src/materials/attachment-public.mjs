/**
 * Browser and host views of a stored attachment record. Neither view carries
 * an owner (the editor is single-user local) and the public view never
 * carries file contents.
 */
import crypto from "node:crypto";
import { publicImageChildren, publicStyleProfile } from "./public-style-profile.mjs";
import { tableTextRendering } from "./table-text.mjs";

/** @param {import("node:crypto").BinaryLike} value */
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** @typedef {import("../attachments.mjs").StoredRecord} StoredRecord */
/** @typedef {{code: string, message: string}} Warning */

/**
 * Receipt fields the pre-materials upload response carried; kept for the
 * Hub chip (`parsed`, `chars`, `bytes`) on records with a text receipt.
 * @param {import("../attachments.mjs").AttachmentMeta} meta
 */
function textReceiptPublic(meta) {
  if (meta.parsed !== true || meta.complete !== true) return {};
  return {
    bytes: meta.size,
    storeId: meta.storeId,
    parsed: true,
    complete: true,
    chars: meta.chars,
    originalSha256: meta.originalSha256,
    textSha256: meta.textSha256,
  };
}

/**
 * Public record shown to the browser: recognition result or the Chinese
 * reason it was rejected. A dedupe response may pass `warnings` — the current
 * upload's own detection warnings — instead of the stored record's.
 * @param {StoredRecord} record
 * @param {{duplicateOf?: string, warnings?: Warning[]}} [options]
 */
export function materialPublic(record, { duplicateOf, warnings } = {}) {
  const { meta, derivative } = record;
  const chain = duplicateOf ?? meta.duplicateOf;
  return {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    kind: derivative.kind,
    status: derivative.status === "ok" || derivative.status === "partial" ? "parsed" : derivative.status,
    parser: derivative.parser?.id ?? null,
    summary: derivative.summary ? { zh: derivative.summary.zh } : null,
    ...publicStyleProfile(derivative),
    warnings: warnings ?? derivative.warnings ?? [],
    needsVision: Boolean(meta.needsVision),
    ...publicImageChildren(derivative),
    ...(chain ? { duplicateOf: chain } : {}),
    ...(derivative.errorCode ? { errorCode: derivative.errorCode } : {}),
    ...(derivative.message ? { message: derivative.message } : {}),
    ...textReceiptPublic(meta),
  };
}

/**
 * Inline fields of a parsed text or table material.
 * @param {StoredRecord} record @param {boolean} includeText @param {boolean} inlineTableText
 */
function inlineFields(record, includeText, inlineTableText) {
  const { derivative } = record;
  const textPayload = derivative.text;
  if (derivative.kind === "text" && derivative.status === "ok" && textPayload) {
    return {
      parsed: true,
      complete: true,
      chars: textPayload.chars,
      ...(includeText ? { text: textPayload.text, textSha256: digest(textPayload.text) } : {}),
    };
  }
  const tablePayload = derivative.table;
  if (!(derivative.kind === "table" && derivative.status === "ok" && tablePayload)) return {};
  const tableRender = inlineTableText ? tableTextRendering(derivative) : undefined;
  if (!tableRender) return { parsed: true, complete: true, chars: tablePayload.chars ?? 0 };
  return {
    parsed: true,
    complete: !tableRender.truncated,
    chars: tableRender.chars,
    ...(includeText
      ? {
          text: tableRender.text,
          textSha256: digest(tableRender.text),
          ...(tableRender.truncated ? { truncated: true } : {}),
        }
      : {}),
  };
}

/**
 * Full read for the editor/host: the public record plus the text fields that
 * let small text materials stay inline. Upload responses use
 * `includeText: false`. `inlineTableText` (host reads only) adds the table's
 * deterministic text rendering; browser reads keep the summary-only shape.
 * @param {StoredRecord} record
 * @param {{includeText?: boolean, inlineTableText?: boolean}} [options]
 */
export function attachmentContent(record, { includeText = true, inlineTableText = false } = {}) {
  const { meta } = record;
  return {
    ...materialPublic(record),
    bytes: meta.size,
    storeId: meta.storeId,
    originalSha256: meta.originalSha256,
    derivativeSha256: meta.derivativeSha256,
    ...inlineFields(record, includeText, inlineTableText),
  };
}
