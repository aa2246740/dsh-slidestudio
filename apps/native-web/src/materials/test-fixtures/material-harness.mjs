/**
 * Shared harness for store/intake tests: a temporary store, an in-thread
 * parse pool (same worker entry logic, no thread), and the EditorAttachment
 * the materials path (`@open-slidestudio/slides-tools` material-store)
 * resolves from a stored record.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttachmentStore, attachmentContent } from "../../attachments.mjs";
import { ingestAttachment } from "../intake.mjs";
import { runParseJob } from "../parse-worker.mjs";

/** Parses through the same entry logic as the worker, on the test thread. */
export const inThreadPool = {
  maxConcurrent: 2,
  /** @param {{materialId: string, name: string, bytes: Uint8Array, declaredMime?: string}} job */
  run: async (job) => ({ ok: /** @type {const} */ (true), derivative: await runParseJob(job) }),
};

/**
 * A data root whose `output/attachments` is the store, removed after the test.
 * @param {{after: (fn: () => void) => void}} t
 */
export function tempStore(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oss-materials-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new AttachmentStore(path.join(dataRoot, "output", "attachments"));
  return { dataRoot, store };
}

/**
 * @param {AttachmentStore} store @param {string} name @param {Uint8Array} bytes
 * @param {Partial<import("../intake.mjs").IntakeIo>} [io]
 */
export async function ingest(store, name, bytes, io = {}) {
  return ingestAttachment({ store, pool: inThreadPool, ...io }, { name, bytes });
}

/**
 * The selected-material record a host builds from the attachment read body.
 * @param {import("../../attachments.mjs").StoredRecord} record
 * @returns {import("@open-slidestudio/slides-tools").EditorAttachment}
 */
export function editorAttachmentOf(record) {
  const content = attachmentContent(record);
  return {
    id: content.id,
    name: content.name,
    kind: /** @type {import("@open-slidestudio/slides-tools").EditorAttachment["kind"]} */ (content.kind),
    parser: String(content.parser),
    summaryZh: content.summary?.zh ?? "",
    needsVision: content.needsVision,
    bytes: content.bytes,
    storeId: content.storeId,
    originalSha256: content.originalSha256,
    derivativeSha256: content.derivativeSha256,
  };
}

/**
 * Mirror of the DSH host's inline attachment check (`verifiedAttachment` in
 * packages/dsh-slides-host/src/generation-input.ts): the read body must be a
 * complete, owner-free, hash-verified `utf8-full-v1` receipt.
 * @param {string} id @param {Record<string, any>} body @param {(text: string) => string} sha256
 */
export function hostAcceptsTextReceipt(id, body, sha256) {
  const isHash = (/** @type {unknown} */ value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  return (
    body.id === id &&
    body.parsed === true &&
    body.complete === true &&
    body.clipped !== true &&
    body.truncated !== true &&
    body.ownerId === undefined &&
    typeof body.text === "string" &&
    body.text.trim() !== "" &&
    typeof body.name === "string" &&
    body.name.trim() !== "" &&
    isHash(body.storeId) &&
    isHash(body.originalSha256) &&
    isHash(body.textSha256) &&
    body.textSha256 === sha256(body.text) &&
    body.parser === "utf8-full-v1" &&
    Number.isSafeInteger(body.bytes) &&
    body.bytes > 0 &&
    body.chars === body.text.length
  );
}
