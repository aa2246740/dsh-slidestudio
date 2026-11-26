/**
 * Intake pipeline: dedupe → detect → parse (worker pool) → store record.
 * Every outcome — parsed, unsupported or failed — becomes a record the user
 * can see; nothing silently disappears. The editor is single-user local:
 * identical bytes in one store dedupe to one record, and no record carries an
 * owner.
 */
import { MaterialRejection } from "./zip-guard.mjs";
import { detectType } from "./detect.mjs";
import { failureDerivative, PARSER_IDS } from "./derivative.mjs";
import { classifyWorkerError } from "./parse-worker.mjs";
import { attachEmbeddedImages, hostsEmbeddedImages } from "./embedded-images.mjs";
import { startPdfImages } from "./pdf-images-start.mjs";
import { commitHash, duplicateResult } from "./intake-dedupe.mjs";
import { ingestImagePack } from "./intake-image-pack.mjs";

/**
 * Optional collaborators. The PDF render queue, the PDF picture runner and
 * the legacy-format converter live in their own modules, loaded only when the
 * server wires them in.
 * @typedef {{store: import("../attachments.mjs").AttachmentStore,
 *   pool: Pick<import("./parse-pool.mjs").ParsePool, "run"> & {maxConcurrent?: number},
 *   renderQueue?: import("./pdf-render.mjs").PdfRenderQueue,
 *   pdfImages?: import("./pdf-images-run.mjs").PdfImageRunner,
 *   legacyConverter?: import("./legacy-intake.mjs").LegacyConverterLike |
 *     (() => import("./legacy-intake.mjs").LegacyConverterLike)}} IntakeIo
 * @typedef {{name: string, bytes: Uint8Array, declaredMime?: string}} Upload
 * @typedef {{record: import("../attachments.mjs").StoredRecord, duplicateOf?: string,
 *   uploadWarnings?: {code: string, message: string}[]}} IntakeResult
 */

/**
 * @param {unknown} error
 * @returns {{code: string, message: string}}
 */
export function classifyParseError(error) {
  return error instanceof MaterialRejection ? { code: error.code, message: error.message } : classifyWorkerError(error);
}

/**
 * @param {IntakeIo} io
 * @param {Upload} upload
 * @returns {Promise<IntakeResult>}
 */
export async function ingestAttachment(io, upload) {
  const { store } = io;
  const { name, bytes, declaredMime } = upload;
  // Identical bytes → the existing record wins; no second copy.
  const existing = await store.findByHash(bytes);
  if (existing) return duplicateResult(existing, upload);

  const detected = detectType({ name, bytes, declaredMime });
  const materialId = store.nextId(name);

  /** @param {{code: string, message: string, parserId?: string|null}} failure */
  const failureRecord = async ({ code, message, parserId = null }) => {
    const source = store.sourceOf(name, bytes, declaredMime ?? null, null, false);
    const derivative = failureDerivative({ materialId, source, code, message, parserId });
    return { record: await store.record({ name, bytes, derivative }) };
  };

  if (!detected.ok) {
    const converted = await legacyBranch(io, upload, materialId, detected);
    return converted ?? failureRecord(converted === null ? detected : await legacyMessage(io, detected));
  }
  if (detected.parserId === PARSER_IDS.imagePack) {
    return ingestImagePack(io, upload, { materialId, detected });
  }
  return parseAndCommit(io, upload, { materialId, detected, failureRecord });
}

/**
 * Legacy Office/WPS files convert when a converter is available. Returns the
 * converted outcome, `null` to store the detection rejection unchanged, or
 * `undefined` when the rejection message should list the convertible formats.
 * @param {IntakeIo} io @param {Upload} upload @param {string} materialId
 * @param {{code: string, message: string}} detected
 * @returns {Promise<IntakeResult|null|undefined>}
 */
async function legacyBranch(io, upload, materialId, detected) {
  if (!io.legacyConverter) return null;
  if (detected.code === "legacy-office-format") {
    const { legacyOfficeOutcome } = await import("./legacy-intake.mjs");
    const outcome = await legacyOfficeOutcome(
      { store: io.store, pool: /** @type {never} */ (io.pool), legacyConverter: io.legacyConverter },
      { name: upload.name, bytes: upload.bytes, declaredMime: upload.declaredMime, materialId },
    );
    return outcome ? /** @type {IntakeResult} */ (/** @type {unknown} */ (outcome)) : null;
  }
  return detected.code === "unsupported-type" ? undefined : null;
}

/**
 * @param {IntakeIo} io @param {{code: string, message: string}} detected
 * @returns {Promise<{code: string, message: string}>}
 */
async function legacyMessage(io, detected) {
  const { withLegacyFormatsSentence } = await import("./legacy-intake.mjs");
  const converter = /** @type {NonNullable<IntakeIo["legacyConverter"]>} */ (io.legacyConverter);
  return { ...detected, message: await withLegacyFormatsSentence(converter, detected.message) };
}

/**
 * A PDF's pictures are read in their own process while its text is parsed
 * in a worker; neither needs the other. A parse that fails (or any other
 * early exit) abandons the reading.
 * @param {IntakeIo} io @param {Upload} upload
 * @param {{materialId: string, detected: import("./detect.mjs").DetectOk,
 *   failureRecord: (failure: {code: string, message: string}) => Promise<IntakeResult>}} context
 * @returns {Promise<IntakeResult>}
 */
async function parseAndCommit(io, upload, { materialId, detected, failureRecord }) {
  const { store, pool, pdfImages } = io;
  const { name, bytes, declaredMime } = upload;
  const abandonPictures = new AbortController();
  const extraction =
    detected.parserId === PARSER_IDS.pdf && pdfImages
      ? startPdfImages(pdfImages, bytes, abandonPictures.signal)
      : undefined;
  try {
    let outcome;
    try {
      outcome = await pool.run({ materialId, name, bytes, declaredMime });
    } catch (error) {
      return failureRecord(classifyParseError(error));
    }
    if (!outcome.ok) return failureRecord(outcome);
    const derivative = /** @type {import("../attachments.mjs").StoredDerivative} */ (outcome.derivative);
    // needsVision is true for image materials — the vision notice and view_material key off it.
    const needsVision = derivative.kind === "image";
    // Pictures inside a DOCX/PDF are registered before the document is committed so its
    // derivative can list their ids; a lost dedupe race discards them.
    const embedded = hostsEmbeddedImages(derivative)
      ? await attachEmbeddedImages({
          store,
          pool: /** @type {never} */ (pool),
          pdfImages,
          extraction,
          name,
          bytes,
          derivative,
        })
      : undefined;
    return await commitHash(store, bytes, async () => {
      const again = await store.findByHash(bytes);
      if (again) {
        for (const id of embedded?.createdIds ?? []) store.delete(id);
        return duplicateResult(again, upload);
      }
      const record = await store.record({ name, bytes, derivative, needsVision });
      await queuePdfRender(io, record);
      return { record };
    });
  } finally {
    abandonPictures.abort();
  }
}

/**
 * @param {IntakeIo} io @param {import("../attachments.mjs").StoredRecord} record
 */
async function queuePdfRender(io, record) {
  if (!io.renderQueue || !record.derivative.parser?.id?.startsWith("pdf-unpdf-")) return;
  const { enqueuePdfRender } = await import("./pdf-render-store.mjs");
  enqueuePdfRender({
    store: /** @type {never} */ (io.store),
    queue: io.renderQueue,
    record: /** @type {never} */ (record),
  });
}
