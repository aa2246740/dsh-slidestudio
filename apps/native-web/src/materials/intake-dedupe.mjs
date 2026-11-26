/**
 * Intake dedupe helpers shared by the normal pipeline and the legacy-format
 * conversion branch: the per (store, hash) commit lock, and the answer for an
 * upload whose bytes already have a record. The editor is single-user local,
 * so identical bytes in one store are one material.
 */
import crypto from "node:crypto";
import { detectType } from "./detect.mjs";

/** @type {Map<string, Promise<void>>} */
const commitTails = new Map();

/**
 * The stored record wins for identical bytes. The extension-mismatch warning
 * belongs to THIS upload's name, though: a renamed copy of an already-stored
 * file must still be told the truth about its extension, so the response
 * recomputes detection warnings.
 * @param {import("../attachments.mjs").StoredRecord} existing
 * @param {{name: string, bytes: Uint8Array, declaredMime?: string}} upload
 */
export function duplicateResult(existing, { name, bytes, declaredMime }) {
  const detected = detectType({ name, bytes, declaredMime });
  const stored = existing.derivative.warnings ?? [];
  const uploadWarnings = [
    ...(detected.ok ? detected.warnings : []),
    ...stored.filter((warning) => warning.code !== "extension-mismatch"),
  ];
  return { record: existing, duplicateOf: existing.meta.id, uploadWarnings };
}

/**
 * Serialize the commit for one store and byte hash. Two uploads can both
 * miss the first dedupe check; the second commit then reuses the record the
 * first one already returned.
 * @template T
 * @param {{root: string}} store
 * @param {Uint8Array} bytes
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export function commitHash(store, bytes, fn) {
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const key = `${store.root}\0${hash}`;
  const previous = commitTails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  commitTails.set(key, tail);
  void tail.finally(() => {
    if (commitTails.get(key) === tail) commitTails.delete(key);
  });
  return run;
}
