/**
 * Reads `legacy-rejection-r1.json`, the rejection records round 1 (commit
 * e7d164b) stored for four legacy Office uploads, and turns a fresh upload into
 * the same normalized shape so a test can compare the two with `deepEqual`.
 * Normalization follows DECISIONS #39: the public record loses its `id`, the
 * derivative keeps its exact bytes, and `meta.json` loses `id` and `createdAt`.
 * The editor is single-user local, so records carry no owner: an `ownerId` a
 * store might still write is dropped too, and the golden holds none.
 * Values that depend on the run (the generated id, the store directory hash and
 * the derivative hash that covers the id) are replaced by placeholders.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

const ID_PLACEHOLDER = "@@ID@@";
const STORE_PLACEHOLDER = "@@STORE_ROOT_SHA256@@";
const DERIVATIVE_PLACEHOLDER = "@@DERIVATIVE_SHA256@@";

/**
 * @typedef {{
 *   name: string,
 *   sha256: string,
 *   bytes: number,
 *   publicRecord: Record<string, unknown>,
 *   derivative: string,
 *   meta: Record<string, unknown>,
 *   storedFiles: string[],
 *   bytesGzipBase64?: string,
 *   sameBytesAs?: string,
 * }} GoldenSample
 * @typedef {{
 *   capture: {commit: string, decision: string, method: string, ownerless?: string},
 *   samples: GoldenSample[],
 * }} Golden
 * @typedef {{root: string, storeId: string, paths: (id: string) => {derivative: string, metadata: string}}} GoldenStore
 */

/** @returns {Golden} */
export function loadGolden() {
  const file = new URL("./legacy-rejection-r1.json", import.meta.url);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** @param {Uint8Array} bytes */
export const sha256Hex = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * The upload bytes of one golden sample, checked against its recorded hash.
 * @param {Golden} golden
 * @param {string} name
 * @returns {Buffer}
 */
export function goldenBytes(golden, name) {
  const sample = golden.samples.find((candidate) => candidate.name === name);
  if (!sample) throw new Error(`the golden has no sample named ${name}`);
  const source = sample.sameBytesAs
    ? golden.samples.find((candidate) => candidate.name === sample.sameBytesAs)
    : sample;
  if (!source?.bytesGzipBase64) throw new Error(`${name}: the golden holds no bytes for it`);
  const bytes = zlib.gunzipSync(Buffer.from(source.bytesGzipBase64, "base64"));
  if (sha256Hex(bytes) !== sample.sha256 || bytes.length !== sample.bytes) {
    throw new Error(`${name}: the decoded bytes do not match the recorded hash`);
  }
  return bytes;
}

/**
 * A golden sample as `normalizeUpload` returns it: without the bytes it was uploaded from.
 * @param {GoldenSample} sample
 * @returns {Omit<GoldenSample, "bytesGzipBase64" | "sameBytesAs">}
 */
export function expectedRecord({ bytesGzipBase64, sameBytesAs, ...record }) {
  return record;
}

/**
 * One stored upload in the golden's shape.
 * @param {GoldenStore} store
 * @param {{
 *   name: string,
 *   bytes: Uint8Array,
 *   id: string,
 *   publicRecord: Record<string, unknown>,
 *   idNames?: Map<string, string>,
 * }} upload `publicRecord` is the JSON the route answers with; `idNames` maps an
 *   earlier record's id to the sample name that made it (for `duplicateOf`)
 * @returns {Omit<GoldenSample, "bytesGzipBase64" | "sameBytesAs">}
 */
export function normalizeUpload(store, { name, bytes, id, publicRecord, idNames = new Map() }) {
  const files = store.paths(id);
  const derivative = fs.readFileSync(files.derivative, "utf8");
  if (derivative.split(id).length !== 2) {
    throw new Error(`${name}: the id must occur once in the derivative`);
  }
  const meta = JSON.parse(fs.readFileSync(files.metadata, "utf8"));
  if (meta.id !== id) throw new Error(`${name}: meta.json carries another id`);
  if (meta.storeId !== store.storeId) throw new Error(`${name}: meta.json carries another store`);
  if (meta.derivativeSha256 !== sha256Hex(Buffer.from(derivative))) {
    throw new Error(`${name}: meta.json does not hash the derivative`);
  }
  const normalizedRecord = { ...publicRecord };
  delete normalizedRecord.id;
  const duplicateOf = normalizedRecord.duplicateOf;
  if (typeof duplicateOf === "string") {
    const named = idNames.get(duplicateOf);
    if (!named) throw new Error(`${name}: duplicateOf names an unknown record`);
    normalizedRecord.duplicateOf = `${ID_PLACEHOLDER}:${named}`;
  }
  delete meta.id;
  delete meta.createdAt;
  delete meta.ownerId;
  meta.storeId = STORE_PLACEHOLDER;
  meta.derivativeSha256 = DERIVATIVE_PLACEHOLDER;
  const storedFiles = fs
    .readdirSync(store.root)
    .filter((file) => file.startsWith(id))
    .sort()
    .map((file) => file.split(id).join(ID_PLACEHOLDER));
  return {
    name,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    publicRecord: normalizedRecord,
    derivative: derivative.split(id).join(ID_PLACEHOLDER),
    meta,
    storedFiles,
  };
}
