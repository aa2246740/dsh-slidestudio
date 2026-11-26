/**
 * Attachment store for reference materials. Each record keeps the original
 * bytes, a `material-derivative/v1` derivative and a receipt that pins both
 * hashes — reads verify the receipt instead of re-parsing. Plain UTF-8 text
 * uploads within the inline budget additionally carry the `utf8-full-v1`
 * text receipt the DSH host's inline attachment path verifies. The editor is
 * single-user local: records never carry an owner, and identical bytes dedupe
 * to the existing record when it satisfies the current intake contract.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MATERIAL_MAX_ORIGINAL_BYTES } from "@open-slidestudio/presentation-run/material-limits";
import { DERIVATIVE_SCHEMA, buildDerivative } from "./materials/derivative.mjs";
import { ensureCorruptLogoNote, ensureOversizedLogoNote, logoBytesOf } from "./materials/logo-bytes.mjs";
import {
  writeExclusive,
  templateDetailBytes,
  templateKitBytes,
  verifyTemplateDetail,
  verifyTemplateKit,
} from "./materials/attachment-files.mjs";
import { attachmentContent, materialPublic } from "./materials/attachment-public.mjs";
import { textParser } from "./materials/parsers/text.mjs";
import { detectType } from "./materials/detect.mjs";
import { recordReusable } from "./materials/store-reuse.mjs";
import {
  ATTACHMENT_TEXT_LIMIT,
  TEXT_RECEIPT_PARSER,
  carriesTextReceipt,
  parseAttachmentBuffer,
  textReceiptMeta,
  verifyTextReceipt,
} from "./materials/text-receipt.mjs";
import { tableTextRendering } from "./materials/table-text.mjs";

export { ATTACHMENT_TEXT_LIMIT, TEXT_RECEIPT_PARSER, attachmentContent, parseAttachmentBuffer, tableTextRendering };

/** @param {import("node:crypto").BinaryLike} value */
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** @param {string} message */
function refuse(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Base64 upload decode for the JSON route: raw base64 or a `data:` URL; a
 * non-canonical encoding is refused so a stored record is always byte-exact.
 * @param {unknown} data
 */
export function decodeAttachmentUpload(data) {
  if (typeof data !== "string") throw new Error("upload data must be a base64 string");
  const b64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  if (
    (data.startsWith("data:") && !/^data:[^,]*;base64,/.test(data)) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)
  ) {
    throw new Error("invalid base64 upload");
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.toString("base64") !== b64) throw new Error("noncanonical base64 upload");
  return bytes;
}

/** @param {string} name */
function safeExtension(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot, 40) : "";
}

/** @param {string} name */
function safeStem(name) {
  const basename = path.basename(name);
  const extension = path.extname(basename);
  const stemSource = extension ? basename.slice(0, -extension.length) : basename;
  const maximumStemLength = Math.max(1, 80 - safeExtension(name).length);
  let stem =
    stemSource
      .replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, maximumStemLength) || "file";
  while (Buffer.byteLength(`${stem}${safeExtension(name)}`, "utf8") > 180)
    stem = Array.from(stem).slice(0, -1).join("");
  return stem || "file";
}

/**
 * Public record shown to the browser. A record from the pre-materials store
 * shape (no `meta`) keeps its old view: every field except the text.
 * @param {StoredRecord | Record<string, unknown>} record
 * @param {{duplicateOf?: string, warnings?: {code: string, message: string}[]}} [options]
 */
export function attachmentPublic(record, options) {
  if (isStoredRecord(record)) return materialPublic(record, options);
  const { text: _text, ...metadata } = record;
  return metadata;
}

/** @param {unknown} record @returns {record is StoredRecord} */
function isStoredRecord(record) {
  const candidate = /** @type {{meta?: unknown, derivative?: unknown}} */ (record);
  return Boolean(candidate?.meta && candidate?.derivative);
}

/**
 * @typedef {import("./materials/derivative.mjs").Derivative} Derivative
 * @typedef {Derivative & {
 *   text?: {chars: number, text: string},
 *   document?: {styleProfile?: Record<string, unknown>, pageCount?: number, chars?: number,
 *     images?: {part: string, bytes?: number, paragraph?: number}[],
 *     tables?: Record<string, unknown>[],
 *     charts?: Record<string, unknown>[],
 *     embeddedImages?: import("./materials/embedded-images.mjs").EmbeddedImagesSection,
 *     pages?: {index: number, chars: number, lowText: boolean, hasImage?: boolean, imageCoverage?: number, text?: string}[],
 *     renderState?: string, renderMessage?: string|null,
 *     renderedPages?: {index: number, file: string, sha256: string, px: {width: number, height: number}}[]},
 *   image?: import("./materials/public-style-profile.mjs").StoredImage,
 *   "deck-template"?: Record<string, unknown>,
 *   table?: {encoding: string, delimiter: string, rowCount: number,
 *     colCount: number, chars: number, headerRow: string[],
 *     columns: {header: string, inferredType: string}[],
 *     rows: string[][], fullRows?: string[][], charts?: Record<string, unknown>[]},
 * }} StoredDerivative
 * @typedef {{version: number, id: string, name: string, size: number,
 *   storeId: string, originalSha256: string,
 *   derivativeSha256: string, parserId: string|null, status: string,
 *   kind: string|null, needsVision: boolean, createdAt: string,
 *   convertedSha256?: string, duplicateOf?: string, route?: string,
 *   bytes?: number, parsed?: boolean, complete?: boolean, parser?: string,
 *   chars?: number, textSha256?: string}} AttachmentMeta
 * @typedef {{meta: AttachmentMeta, derivative: StoredDerivative}} StoredRecord
 * @typedef {import("./materials/text-receipt.mjs").TextReceiptRecord} TextReceiptRecord
 * @typedef {StoredRecord & Partial<TextReceiptRecord>} ReadRecord
 */

/** Records written by the synchronous text-receipt route are never dedupe targets. */
const TEXT_RECEIPT_ROUTE = "text-receipt";

export class AttachmentStore {
  /** @param {string} root */
  constructor(root) {
    this.root = path.resolve(root);
    this.storeId = digest(this.root);
    /** @type {Map<string, {meta: AttachmentMeta}>|undefined} */
    this.indexCache = undefined;
  }

  /** @param {string} id */
  paths(id) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}-[a-zA-Z0-9._\u4e00-\u9fff-]{1,80}$/.test(id)) {
      throw new Error("资料 ID 无效");
    }
    return {
      original: path.join(this.root, id),
      derivative: path.join(this.root, `${id}.derivative.json`),
      logo: path.join(this.root, `${id}.logo`),
      detail: path.join(this.root, `${id}.template-detail.json`),
      kit: path.join(this.root, `${id}.template-kit.json`),
      converted: path.join(this.root, `${id}.converted`),
      metadata: path.join(this.root, `${id}.meta.json`),
    };
  }

  /** @param {string} file */
  regularFile(file) {
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error("上传存储目录不能是符号链接");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("资料必须是上传存储中的普通文件，不能是符号链接");
    if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(this.root)) throw new Error("资料超出上传存储边界");
    return fs.readFileSync(file);
  }

  /** @param {string} name */
  nextId(name) {
    const extension = safeExtension(name).replace(/[^a-z0-9._\u4e00-\u9fff-]/g, "_");
    return `${crypto.randomUUID()}-${safeStem(name)}${extension}`;
  }

  /**
   * Source block shared by derivative envelopes.
   * @param {string} name @param {Uint8Array} bytes @param {string|null} declaredMime
   * @param {string|null} detectedMime @param {boolean} extensionMismatch
   */
  sourceOf(name, bytes, declaredMime, detectedMime, extensionMismatch) {
    return {
      name,
      bytes: bytes.length,
      sha256: digest(bytes),
      declaredMime,
      detectedMime,
      extension: safeExtension(name).slice(0, 40),
      extensionMismatch,
    };
  }

  /**
   * Synchronous text-receipt upload (the pre-materials `POST /api/attachments`
   * contract): only complete UTF-8 text is accepted, anything else throws its
   * Chinese reason before a file exists. The record carries both the text
   * receipt and a `text-utf8-v1` derivative.
   * @param {string} name @param {Uint8Array} bytes
   * @returns {ReadRecord}
   */
  store(name, bytes) {
    const parsed = parseAttachmentBuffer(name, bytes);
    if (!parsed.parsed) throw new Error(parsed.note);
    const id = this.nextId(name);
    const detected = detectType({ name, bytes });
    const result = textParser.parse({ name, bytes });
    const derivative = buildDerivative({
      materialId: id,
      kind: "text",
      source: this.sourceOf(name, bytes, null, detected.ok ? detected.detectedMime : "text/plain", false),
      parserId: textParser.id,
      engine: textParser.engine,
      durationMs: 0,
      warnings: result.warnings,
      summary: result.summary,
      payload: result.payload,
    });
    const record = this.writeRecord({ name: path.basename(name), bytes, derivative, route: TEXT_RECEIPT_ROUTE });
    return { ...record, id, name: record.meta.name, bytes: bytes.length, storeId: this.storeId, ...parsed };
  }

  /**
   * Persist one intake outcome (parsed, unsupported or failed). Writes are
   * all-or-nothing: each file is owned as soon as its exclusive open
   * succeeds, and any failure removes every file this call created.
   * @param {{name: string, bytes: Uint8Array|Buffer, derivative: StoredDerivative,
   *   needsVision?: boolean, converted?: Uint8Array|Buffer}} intake `converted` is the
   *   converted OOXML package of a legacy-format upload: stored next to the original,
   *   pinned in the receipt, and where logos come from.
   * @returns {Promise<StoredRecord>}
   */
  async record(intake) {
    const record = this.writeRecord(intake);
    const { meta, derivative } = record;
    if (derivative.status === "ok" || derivative.status === "partial") {
      this.indexCache?.set(meta.originalSha256, { meta });
      await this.retireSameHash(meta.originalSha256, meta.id);
    }
    return record;
  }

  /**
   * @param {{name: string, bytes: Uint8Array|Buffer, derivative: StoredDerivative,
   *   needsVision?: boolean, converted?: Uint8Array|Buffer, route?: string}} intake
   * @returns {StoredRecord}
   */
  writeRecord({ name, bytes, derivative, needsVision = false, converted, route }) {
    const id = derivative.materialId;
    ensureOversizedLogoNote(derivative);
    ensureCorruptLogoNote(derivative);
    const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
    if (derivativeBytes.length > MATERIAL_MAX_ORIGINAL_BYTES) throw refuse("解析结果过大，无法作为设计源使用");
    const logo = logoBytesOf(converted ?? bytes, derivative);
    const detail = templateDetailBytes(derivative);
    const kit = templateKitBytes(derivative);
    const meta = this.metaFor({ id, name, bytes, derivative, derivativeBytes, needsVision, converted, route });
    fs.mkdirSync(this.root, { recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error("上传存储目录不能是符号链接");
    const files = this.paths(id);
    /** @type {string[]} */
    const written = [];
    try {
      writeExclusive(files.original, bytes, written);
      writeExclusive(files.derivative, derivativeBytes, written);
      if (converted) writeExclusive(files.converted, converted, written);
      if (detail) writeExclusive(files.detail, detail, written);
      if (kit) writeExclusive(files.kit, kit, written);
      if (logo) writeExclusive(files.logo, logo, written);
      writeExclusive(files.metadata, `${JSON.stringify(meta)}\n`, written);
    } catch (error) {
      for (const file of written) unlinkQuietly(file);
      throw error;
    }
    return { meta, derivative };
  }

  /**
   * @param {{id: string, name: string, bytes: Uint8Array, derivative: StoredDerivative,
   *   derivativeBytes: Buffer, needsVision: boolean, converted?: Uint8Array, route?: string}} parts
   * @returns {AttachmentMeta}
   */
  metaFor({ id, name, bytes, derivative, derivativeBytes, needsVision, converted, route }) {
    // Any complete UTF-8 txt/md/csv/tsv/json upload (text or table kind) also carries the text receipt.
    const parsedText = derivative.status === "ok" ? parseAttachmentBuffer(name, bytes) : null;
    return {
      version: 1,
      id,
      name,
      size: bytes.length,
      storeId: this.storeId,
      originalSha256: derivative.source.sha256,
      derivativeSha256: digest(derivativeBytes),
      parserId: derivative.parser?.id ?? null,
      status: derivative.status,
      kind: derivative.kind,
      needsVision,
      createdAt: new Date().toISOString(),
      ...(converted ? { convertedSha256: digest(converted) } : {}),
      ...(route ? { route } : {}),
      ...(parsedText?.parsed ? textReceiptMeta(parsedText, bytes.length) : {}),
    };
  }

  /**
   * Drop same-hash records that findByHash would refuse to reuse. A record
   * that still meets that contract stays, even when a newer copy of the same
   * bytes is stored: its id may already have been returned.
   * @param {string} originalSha256 @param {string} keepId
   * @returns {Promise<void>}
   */
  async retireSameHash(originalSha256, keepId) {
    for (const meta of this.listMeta()) {
      if (meta.originalSha256 !== originalSha256 || meta.id === keepId || meta.route === TEXT_RECEIPT_ROUTE) continue;
      if (await this.reusesRecord(meta.id)) continue;
      removeRecordFiles(this.root, meta.id);
    }
  }

  /** Every readable metadata file in the store. @returns {AttachmentMeta[]} */
  listMeta() {
    /** @type {string[]} */
    let entries;
    try {
      entries = fs.existsSync(this.root) ? fs.readdirSync(this.root) : [];
    } catch {
      return [];
    }
    /** @type {AttachmentMeta[]} */
    const metas = [];
    for (const entry of entries) {
      if (!entry.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(this.regularFile(path.join(this.root, entry)).toString("utf8"));
        if (meta && typeof meta.id === "string" && this.paths(meta.id)) metas.push(meta);
      } catch {
        // Unreadable metadata never blocks new uploads.
      }
    }
    return metas;
  }

  /**
   * Lazily indexed sha256 → meta for dedupe. Only parsed intake records
   * dedupe; rejected bytes are always re-examined.
   * @returns {Map<string, {meta: AttachmentMeta}>}
   */
  index() {
    if (this.indexCache) return this.indexCache;
    /** @type {Map<string, {meta: AttachmentMeta}>} */
    const index = new Map();
    for (const meta of this.listMeta()) {
      if ((meta.status === "ok" || meta.status === "partial") && meta.route !== TEXT_RECEIPT_ROUTE) {
        index.set(meta.originalSha256, { meta });
      }
    }
    this.indexCache = index;
    return index;
  }

  /**
   * The parsed record already stored for these exact bytes, if any.
   * @param {Uint8Array|Buffer} bytes
   * @returns {Promise<StoredRecord|undefined>}
   */
  async findByHash(bytes) {
    const key = digest(bytes);
    const hit = this.index().get(key);
    if (!hit) return undefined;
    try {
      const record = this.read(hit.meta.id);
      if (record && (await this.reuses(record))) return record;
    } catch {
      // The indexed record disappeared or failed verification — re-ingest.
    }
    this.indexCache?.delete(key);
    return undefined;
  }

  /**
   * findByHash's reuse decision for one id; unreadable receipts are not reusable.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async reusesRecord(id) {
    try {
      return await this.reuses(this.read(id));
    } catch {
      return false;
    }
  }

  /**
   * Same predicate findByHash uses once a record has been read.
   * @param {StoredRecord|undefined} record
   * @returns {Promise<boolean>}
   */
  reuses(record) {
    return recordReusable(this, record);
  }

  /**
   * Read and verify a record: the original, derivative and sidecars must
   * match the receipt hashes, and a text receipt is re-verified against the
   * original. Pre-materials records (text receipt only) read as before.
   * @param {string} id
   * @returns {ReadRecord|undefined}
   */
  read(id) {
    const files = this.paths(id);
    if (!fs.existsSync(files.metadata)) return undefined;
    const meta = JSON.parse(this.regularFile(files.metadata).toString("utf8"));
    if (meta?.id !== id || meta?.storeId !== this.storeId) throw new Error("资料不属于当前上传存储");
    if (meta.ownerId !== undefined) throw new Error("资料带有未验证的 owner，不能用于当前创建请求");
    const bytes = this.regularFile(files.original);
    const size = meta.size ?? meta.bytes;
    if (bytes.length !== size || digest(bytes) !== meta.originalSha256) {
      throw new Error("资料原文件已变化，请重新上传");
    }
    const receipt = carriesTextReceipt(meta) ? verifyTextReceipt(meta, bytes) : undefined;
    if (meta.derivativeSha256 === undefined) {
      if (!receipt) throw new Error("资料解析凭据无效，请重新上传");
      return { ...this.receiptOnlyRecord(meta, bytes), ...receipt };
    }
    const derivative = this.verifiedDerivative(id, meta, files);
    return { meta, derivative, ...(receipt ?? {}) };
  }

  /**
   * @param {string} id @param {AttachmentMeta} meta @param {ReturnType<AttachmentStore["paths"]>} files
   * @returns {StoredDerivative}
   */
  verifiedDerivative(id, meta, files) {
    const derivativeBytes = this.regularFile(files.derivative);
    if (digest(derivativeBytes) !== meta.derivativeSha256) throw new Error("资料解析结果已变化，请重新上传");
    const derivative = JSON.parse(derivativeBytes.toString("utf8"));
    if (derivative?.schema !== DERIVATIVE_SCHEMA || derivative.materialId !== id) {
      throw new Error("资料解析凭据无效，请重新上传");
    }
    verifyTemplateDetail(derivative, files.detail, (file) => this.regularFile(file));
    verifyTemplateKit(derivative, files.kit, (file) => this.regularFile(file));
    if (meta.convertedSha256 && digest(this.regularFile(files.converted)) !== meta.convertedSha256) {
      throw new Error("资料转换结果已变化，请重新上传");
    }
    return derivative;
  }

  /**
   * A pre-materials record: its text receipt is the only proof, so the
   * derivative is rebuilt in memory (never written) for the shared views.
   * @param {Record<string, any>} legacy @param {Buffer} bytes
   * @returns {StoredRecord}
   */
  receiptOnlyRecord(legacy, bytes) {
    const result = textParser.parse({ name: legacy.name, bytes });
    const derivative = buildDerivative({
      materialId: legacy.id,
      kind: "text",
      source: this.sourceOf(legacy.name, bytes, null, "text/plain", false),
      parserId: textParser.id,
      engine: textParser.engine,
      durationMs: 0,
      summary: result.summary,
      payload: result.payload,
    });
    /** @type {AttachmentMeta} */
    const meta = {
      ...legacy,
      version: 1,
      id: legacy.id,
      name: legacy.name,
      size: bytes.length,
      storeId: this.storeId,
      originalSha256: legacy.originalSha256,
      derivativeSha256: "",
      parserId: textParser.id,
      status: "ok",
      kind: "text",
      needsVision: false,
      createdAt: legacy.createdAt ?? "",
      route: TEXT_RECEIPT_ROUTE,
    };
    return { meta, derivative };
  }

  /** @param {string} id */
  delete(id) {
    const record = this.read(id);
    if (!record) return false;
    removeRecordFiles(this.root, id);
    this.indexCache?.delete(record.meta.originalSha256);
    return true;
  }
}

/** @param {string} file */
function unlinkQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // The file may already be absent.
  }
}

/**
 * Remove a record's original and every `<id>.*` sidecar (derivative, logo,
 * template detail/kit, converted package, rendered pages), metadata last.
 * @param {string} root @param {string} id
 */
export function removeRecordFiles(root, id) {
  /** @type {string[]} */
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  const metadata = `${id}.meta.json`;
  for (const entry of entries) {
    if (entry !== metadata && (entry === id || entry.startsWith(`${id}.`))) unlinkQuietly(path.join(root, entry));
  }
  unlinkQuietly(path.join(root, metadata));
}
