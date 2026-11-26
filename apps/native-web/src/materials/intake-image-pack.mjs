/**
 * Image pack intake: a ZIP of pictures is parsed in the normal worker queue,
 * then every image member is extracted and independently parsed through that
 * same queue and stored as its own image material. ZIP_LIMITS are enforced by
 * detectType/inspectImagePack before any member bytes are inflated.
 */
import { attachmentPublic } from "../attachments.mjs";
import { MaterialRejection, readZipEntry } from "./zip-guard.mjs";
import { detectType } from "./detect.mjs";
import { buildDerivative, failureDerivative, PARSER_IDS } from "./derivative.mjs";
import { classifyWorkerError } from "./parse-worker.mjs";
import { buildSummaryZh } from "./summary.mjs";
import { ignoredImagePackWarning, inspectImagePack } from "./image-pack.mjs";
import { IMAGE_DERIVATIVE_VERSION } from "./image-style.mjs";
import { commitHash, duplicateResult } from "./intake-dedupe.mjs";

/** @typedef {import("./intake.mjs").IntakeIo} IntakeIo */
/** @typedef {import("./intake.mjs").Upload} Upload */
/** @typedef {import("./intake.mjs").IntakeResult} IntakeResult */
/** @typedef {{code: string, message: string}} Warning */

/** @param {unknown} error */
function classified(error) {
  return error instanceof MaterialRejection ? { code: error.code, message: error.message } : classifyWorkerError(error);
}

/** @param {string} name @param {string} reason @returns {Warning} */
const skipped = (name, reason) => ({ code: "image-entry-skipped", message: `图片条目「${name}」${reason}，已跳过` });

/**
 * Parse and store one pack member, or the warning that explains why it was skipped.
 * @param {IntakeIo} io @param {Uint8Array} packBytes
 * @param {{name: string, entry: import("./zip-guard.mjs").ZipEntry}} candidate
 * @returns {Promise<{record: import("../attachments.mjs").StoredRecord} | {warning: Warning}>}
 */
async function storeMember({ store, pool }, packBytes, candidate) {
  let imageBytes;
  try {
    imageBytes = readZipEntry(packBytes, candidate.entry);
  } catch {
    return { warning: skipped(candidate.name, "无法读取") };
  }
  const imageDetected = detectType({ name: candidate.name, bytes: imageBytes });
  if (!imageDetected.ok || imageDetected.parserId !== PARSER_IDS.image) {
    return { warning: skipped(candidate.name, "内容无法识别") };
  }
  let childOutcome;
  try {
    childOutcome = await pool.run({
      materialId: store.nextId(candidate.name),
      name: candidate.name,
      bytes: imageBytes,
    });
  } catch {
    return { warning: skipped(candidate.name, "解析失败") };
  }
  const child = childOutcome.ok ? childOutcome.derivative : undefined;
  if (!child || child.kind !== "image" || !["ok", "partial"].includes(child.status)) {
    return { warning: skipped(candidate.name, "解析失败") };
  }
  const bytes = imageBytes;
  const record = await commitHash(store, bytes, () =>
    store.record({ name: candidate.name, bytes, derivative: child, needsVision: true }),
  );
  return { record };
}

/**
 * @param {IntakeIo} io @param {Upload} upload
 * @param {{materialId: string, detected: import("./detect.mjs").DetectOk}} context
 * @returns {Promise<IntakeResult>}
 */
export async function ingestImagePack(io, upload, { materialId, detected }) {
  const { store, pool } = io;
  const { name, bytes, declaredMime } = upload;
  const source = store.sourceOf(name, bytes, declaredMime ?? null, detected.detectedMime, detected.extensionMismatch);
  /** @param {string} code @param {string} message @returns {Promise<IntakeResult>} */
  const rejected = async (code, message) => ({
    record: await store.record({
      name,
      bytes,
      derivative: failureDerivative({ materialId, source, code, message, parserId: PARSER_IDS.imagePack }),
    }),
  });

  let packOutcome;
  try {
    packOutcome = await pool.run({ materialId, name, bytes, declaredMime });
  } catch (error) {
    const reason = classified(error);
    return rejected(reason.code, reason.message);
  }
  if (!packOutcome.ok) return rejected(packOutcome.code, packOutcome.message);

  let inspected;
  try {
    inspected = inspectImagePack(bytes);
  } catch (error) {
    if (error instanceof MaterialRejection) return rejected(error.code, error.message);
    return rejected("corrupt", "图片包已损坏或内容不完整，无法解析；请重新导出后上传");
  }

  /** @type {Warning[]} */
  const warnings = [...packOutcome.derivative.warnings];
  const ignoredWarning = ignoredImagePackWarning(inspected.ignoredNames);
  if (ignoredWarning && !warnings.some((warning) => warning.code === ignoredWarning.code)) {
    warnings.push(ignoredWarning);
  }
  const images = await storeMembers(io, bytes, inspected.images, warnings);
  if (!images.length) {
    return rejected("no-images", "图片包中没有可读取的 JPG、PNG、WebP 或 GIF 图片；请检查图片文件后重试");
  }
  const derivative = buildDerivative({
    materialId,
    kind: "image",
    source,
    parserId: PARSER_IDS.imagePack,
    engine: packOutcome.derivative.parser.engine,
    durationMs: packOutcome.derivative.parser.durationMs,
    status: warnings.some((warning) => warning.code === "image-entry-skipped") ? "partial" : "ok",
    warnings,
    summary: buildSummaryZh({ parserId: PARSER_IDS.imagePack, imageCount: images.length }),
    payload: {
      version: IMAGE_DERIVATIVE_VERSION,
      pack: { imageCount: images.length, images, ignoredNames: inspected.ignoredNames },
    },
  });
  return commitHash(store, bytes, async () => {
    const existing = await store.findByHash(bytes);
    if (
      existing?.derivative.parser?.id === PARSER_IDS.imagePack &&
      ["ok", "partial"].includes(existing.derivative.status)
    ) {
      return duplicateResult(existing, upload);
    }
    return { record: await store.record({ name, bytes, derivative, needsVision: true }) };
  });
}

/**
 * Store each member in archive order; identical members collapse to one entry.
 * @param {IntakeIo} io @param {Uint8Array} bytes
 * @param {{name: string, entry: import("./zip-guard.mjs").ZipEntry}[]} candidates
 * @param {Warning[]} warnings
 */
async function storeMembers(io, bytes, candidates, warnings) {
  /** @type {Record<string, unknown>[]} */
  const images = [];
  const seenIds = new Set();
  for (const candidate of candidates) {
    const stored = await storeMember(io, bytes, candidate);
    if ("warning" in stored) {
      warnings.push(stored.warning);
      continue;
    }
    const childRecord = stored.record;
    if (seenIds.has(childRecord.meta.id)) continue;
    seenIds.add(childRecord.meta.id);
    const publicImage = attachmentPublic(childRecord);
    images.push({
      id: childRecord.meta.id,
      name: candidate.name,
      size: childRecord.meta.size,
      kind: "image",
      status: "parsed",
      parser: PARSER_IDS.image,
      summary: publicImage.summary,
      warnings: publicImage.warnings,
      needsVision: true,
    });
  }
  return images;
}
