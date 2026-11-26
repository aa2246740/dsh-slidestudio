/**
 * Worker-thread entry for untrusted material parsing. Every parser runs here,
 * never on the server thread: a 10 s timeout or a heap overrun can then be
 * answered with a failed record instead of taking the sidecar down. The
 * protocol is one job per message: {jobId, name, bytes, declaredMime,
 * materialId} in, {jobId, ...result} out.
 */
import crypto from "node:crypto";
import { parentPort } from "node:worker_threads";
import { detectType } from "./detect.mjs";
import { buildDerivative, failureDerivative } from "./derivative.mjs";
import { MaterialRejection } from "./zip-guard.mjs";
import { textParser } from "./parsers/text.mjs";
import { csvParser } from "./parsers/csv.mjs";
import { xlsxParser } from "./parsers/xlsx.mjs";
import { pptxParser } from "./parsers/pptx.mjs";
import { docxParser } from "./parsers/docx.mjs";
import { pdfParser } from "./parsers/pdf.mjs";
import { imageParser } from "./parsers/image.mjs";
import { imagePackParser } from "./parsers/image-pack.mjs";
import { svgRasterParser } from "./parsers/svg-raster.mjs";
import { avifRasterParser } from "./parsers/avif-raster.mjs";
import { thmxParser } from "./parsers/thmx.mjs";

/** Parsers available in this build. Every supported kind has a real parser —
 * detection must never return an id outside this map. */
const PARSERS = new Map(
  [
    textParser,
    csvParser,
    xlsxParser,
    pptxParser,
    docxParser,
    pdfParser,
    imageParser,
    imagePackParser,
    svgRasterParser,
    avifRasterParser,
    thmxParser,
  ].map((parser) => [parser.id, parser]),
);

/** Registered parser ids, for tests and introspection. @returns {string[]} */
export function registeredParserIds() {
  return [...PARSERS.keys()];
}

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * @param {{materialId: string, name: string, bytes: Uint8Array, declaredMime?: string}} job
 * @returns {Promise<import("./derivative.mjs").Derivative>}
 */
export async function runParseJob({ materialId, name, bytes, declaredMime }) {
  const started = Date.now();
  const detected = detectType({ name, bytes, declaredMime });
  if (!detected.ok) {
    return failureDerivative({
      materialId,
      source: {
        name,
        bytes: bytes.length,
        sha256: sha256(bytes),
        declaredMime: declaredMime ?? null,
        detectedMime: null,
        extension: extensionOf(name),
        extensionMismatch: false,
      },
      code: detected.code,
      message: detected.message,
      durationMs: Date.now() - started,
    });
  }
  const parser = PARSERS.get(detected.parserId);
  // Unreachable by contract: detection only ever returns registered ids —
  // there is no "parser not yet enabled" placeholder any more.
  if (!parser) throw new Error(`parser not registered: ${detected.parserId}`);
  const source = {
    name,
    bytes: bytes.length,
    sha256: sha256(bytes),
    declaredMime: declaredMime ?? null,
    detectedMime: detected.detectedMime,
    extension: detected.extension,
    extensionMismatch: detected.extensionMismatch,
  };
  const parsed = await parser.parse({ name, extension: detected.extension, bytes });
  const derivative = buildDerivative({
    materialId,
    kind: detected.kind,
    source,
    parserId: parser.id,
    engine: parser.engine,
    durationMs: Date.now() - started,
    status: parsed.status ?? "ok",
    warnings: [...detected.warnings, ...parsed.warnings],
    truncated: parsed.truncated ?? { applied: false },
    summary: parsed.summary,
    payload: parsed.payload,
  });
  return derivative;
}

/** @param {string} name */
function extensionOf(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot) : "";
}

// Message loop only runs in worker threads; tests import runParseJob directly.
const port = parentPort;
if (port) {
  port.on("message", async (job) => {
    try {
      const derivative = await runParseJob({
        materialId: job.materialId,
        name: job.name,
        bytes: Buffer.from(job.bytes),
        declaredMime: job.declaredMime,
      });
      port.postMessage({ jobId: job.jobId, ok: true, derivative });
    } catch (error) {
      port.postMessage({ jobId: job.jobId, ok: false, ...classifyWorkerError(error) });
    }
  });
}

/**
 * A thrown error inside a worker becomes a stable failure record. Heap
 * overruns surface as RangeError allocation failures — reported as
 * `out-of-memory`, never as a crash.
 * @param {unknown} error
 * @returns {{code: string, message: string}}
 */
export function classifyWorkerError(error) {
  if (error instanceof MaterialRejection) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  if (/allocation|out of memory|out of memory|array buffer|heap/i.test(message)) {
    return { code: "out-of-memory", message: "文件解析占用内存过大，无法完成；请拆分或压缩后重试" };
  }
  return {
    code: "corrupt",
    message: "文件解析失败：文件已损坏或内容不完整，无法解析；请重新导出后上传",
  };
}
