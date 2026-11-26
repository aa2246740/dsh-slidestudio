/**
 * Test-only attachment store for the PDF render and page modules: the
 * structural `PdfAttachmentStore` contract (root, paths, regularFile, read)
 * with the same hash receipts as the editor's store, plus `add`, which parses a
 * PDF with the real parser into a `material-derivative/v1` record.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildDerivative } from "./derivative.mjs";
import { pdfParser } from "./parsers/pdf.mjs";
import { removePdfPages } from "./pdf-page-store.mjs";

/** @param {Uint8Array} bytes */
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** @typedef {import("./pdf-page-store.mjs").PdfStoredRecord} PdfStoredRecord */

export class PdfFixtureStore {
  /** @param {string} root */
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** @param {string} id */
  paths(id) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}-[a-zA-Z0-9._-]{1,80}$/.test(id)) {
      throw new Error("资料 ID 无效");
    }
    return {
      original: path.join(this.root, id),
      derivative: path.join(this.root, `${id}.derivative.json`),
      metadata: path.join(this.root, `${id}.meta.json`),
    };
  }

  /** @param {string} file @returns {Buffer} */
  regularFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("资料必须是普通文件");
    if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(this.root)) {
      throw new Error("资料超出上传存储边界");
    }
    return fs.readFileSync(file);
  }

  /** @param {string} id @returns {PdfStoredRecord|undefined} */
  read(id) {
    const files = this.paths(id);
    if (!fs.existsSync(files.metadata)) return undefined;
    const meta = JSON.parse(this.regularFile(files.metadata).toString("utf8"));
    if (digest(this.regularFile(files.original)) !== meta.originalSha256) {
      throw new Error("资料原文件已变化");
    }
    const derivativeBytes = this.regularFile(files.derivative);
    if (digest(derivativeBytes) !== meta.derivativeSha256) throw new Error("资料解析结果已变化");
    return { meta, derivative: JSON.parse(derivativeBytes.toString("utf8")) };
  }

  /** @param {string} id */
  delete(id) {
    if (!this.read(id)) return false;
    const files = this.paths(id);
    fs.unlinkSync(files.original);
    fs.unlinkSync(files.derivative);
    removePdfPages(this, id);
    fs.unlinkSync(files.metadata);
    return true;
  }

  /**
   * Parse and store one PDF the way intake records a successful parse.
   * @param {string} name @param {Uint8Array} bytes
   * @returns {Promise<PdfStoredRecord>}
   */
  async add(name, bytes) {
    const id = `${crypto.randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
    const started = Date.now();
    const parsed = await pdfParser.parse({ name, bytes });
    const derivative = buildDerivative({
      materialId: id,
      kind: pdfParser.kind,
      source: {
        name,
        bytes: bytes.length,
        sha256: digest(bytes),
        declaredMime: null,
        detectedMime: "application/pdf",
        extension: ".pdf",
        extensionMismatch: false,
      },
      parserId: pdfParser.id,
      engine: pdfParser.engine,
      durationMs: Date.now() - started,
      status: parsed.status,
      truncated: parsed.truncated,
      warnings: parsed.warnings,
      summary: parsed.summary,
      payload: parsed.payload,
    });
    const files = this.paths(id);
    const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
    fs.writeFileSync(files.original, bytes, { flag: "wx" });
    fs.writeFileSync(files.derivative, derivativeBytes, { flag: "wx" });
    const meta = {
      id,
      name,
      size: bytes.length,
      originalSha256: digest(bytes),
      derivativeSha256: digest(derivativeBytes),
    };
    fs.writeFileSync(files.metadata, `${JSON.stringify(meta)}\n`, { flag: "wx" });
    const record = this.read(id);
    if (!record) throw new Error("fixture record was not written");
    return record;
  }
}
