/**
 * The `utf8-full-v1` text receipt. A plain UTF-8 txt/md/csv/tsv/json upload
 * within the inline budget carries this receipt in its store metadata next to
 * the `material-derivative/v1` derivative, so the DSH host's inline
 * attachment path (`verifiedAttachment`) and the materials path
 * (`verifySessionMaterials`) both accept the same record. The receipt is
 * re-verified by re-reading the original on every read; it never carries an
 * owner.
 */
import crypto from "node:crypto";
import path from "node:path";

export const ATTACHMENT_TEXT_LIMIT = 48_000;
export const TEXT_RECEIPT_PARSER = "utf8-full-v1";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".tsv", ".json"]);

/** @param {import("node:crypto").BinaryLike} value */
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * @typedef {{parsed: true, complete: true, parser: "utf8-full-v1", text: string, chars: number,
 *   originalSha256: string, textSha256: string}} TextReceipt
 * @typedef {{parsed: false, note: string}} TextRefusal
 * @typedef {{id: string, name: string, bytes: number, storeId: string} & TextReceipt} TextReceiptRecord
 */

/**
 * Full UTF-8 read of a text upload, or the Chinese reason it cannot be inlined.
 * Nothing is ever replaced, dropped or truncated.
 * @param {string} name @param {Uint8Array} bytes
 * @returns {TextReceipt|TextRefusal}
 */
export function parseAttachmentBuffer(name, bytes) {
  if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    return { parsed: false, note: "当前仅能完整读取 UTF-8 的 txt、md、csv、tsv、json 文件，请转换后重传" };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { parsed: false, note: "资料不是有效的 UTF-8 文本，未替换或丢弃任何字符" };
  }
  if (!text.trim()) return { parsed: false, note: "资料正文为空" };
  if (text.length > ATTACHMENT_TEXT_LIMIT) {
    return { parsed: false, note: `资料超过 ${ATTACHMENT_TEXT_LIMIT} 字符，请明确拆分后重传；内容未被截断` };
  }
  return {
    parsed: true,
    complete: true,
    parser: TEXT_RECEIPT_PARSER,
    text,
    chars: text.length,
    originalSha256: digest(bytes),
    textSha256: digest(text),
  };
}

/**
 * Metadata fields that pin a text receipt (everything but the text itself).
 * @param {TextReceipt} receipt @param {number} size
 */
export function textReceiptMeta(receipt, size) {
  return {
    bytes: size,
    parsed: true,
    complete: true,
    parser: TEXT_RECEIPT_PARSER,
    chars: receipt.chars,
    textSha256: receipt.textSha256,
  };
}

/** @param {Record<string, unknown>} meta */
export function carriesTextReceipt(meta) {
  return meta.parser === TEXT_RECEIPT_PARSER || meta.parsed !== undefined || meta.complete !== undefined;
}

/**
 * Re-parse the original and compare it with the stored receipt. Any drift
 * (bytes, parser, char count, text hash, completeness) fails closed.
 * @param {Record<string, unknown>} meta @param {Buffer} bytes
 * @returns {TextReceiptRecord}
 */
export function verifyTextReceipt(meta, bytes) {
  const parsed = parseAttachmentBuffer(String(meta.name), bytes);
  if (
    !parsed.parsed ||
    meta.parsed !== true ||
    meta.complete !== true ||
    meta.chars !== parsed.chars ||
    meta.parser !== parsed.parser ||
    meta.textSha256 !== parsed.textSha256
  ) {
    throw new Error("资料完整解析凭据无效，请重新上传");
  }
  return {
    id: String(meta.id),
    name: String(meta.name),
    bytes: bytes.length,
    storeId: String(meta.storeId),
    ...parsed,
  };
}

/**
 * Wire shape the DSH host's `verifiedAttachment` accepts: exactly the
 * pre-materials receipt, no derivative and no owner.
 * @param {TextReceiptRecord} record
 */
export function textReceiptView(record) {
  return {
    id: record.id,
    name: record.name,
    bytes: record.bytes,
    storeId: record.storeId,
    parsed: record.parsed,
    complete: record.complete,
    parser: record.parser,
    text: record.text,
    chars: record.chars,
    originalSha256: record.originalSha256,
    textSha256: record.textSha256,
  };
}
