/**
 * Legacy Office/WPS branch of intake: an OLE file the normal detection
 * refuses as `legacy-office-format` is classified first (encryption, macros,
 * vendor), in every availability state. Encrypted, WPS-secure and macro files
 * are refused outright, before readiness and without a converter run. The
 * rest converts through the optional LibreOffice converter and the converted
 * OOXML package is re-validated through the ordinary parse pool before it
 * becomes a material. Without an available converter a non-security input
 * returns null and the caller stores the same rejection it always has.
 *
 * The editor is single-user and local: records carry no owner. Identical
 * bytes in one store are converted once and the stored record is reused.
 */
import crypto from "node:crypto";
import { classifyLegacyOffice } from "./cfb.mjs";
import { mimeTypeZh, SUPPORTED_TYPES_ZH } from "./detect.mjs";
import { failureDerivative, LEGACY_CONVERSION_RULE } from "./derivative.mjs";
import { attachEmbeddedImages, hostsEmbeddedImages } from "./embedded-images.mjs";
import { commitHash, duplicateResult } from "./intake-dedupe.mjs";
import { finishConvertedDerivative, LEGACY_COPY, revalidationRefusal } from "./legacy-intake-checks.mjs";
import { classifyWorkerError } from "./parse-worker.mjs";
import { MaterialRejection } from "./zip-guard.mjs";

export { LEGACY_COPY };

/** Converter failure code → the design copy the user sees.
 * @type {Record<import("./legacy-convert.mjs").ConvertCode, string>} */
const CONVERTER_COPY = {
  timeout: LEGACY_COPY.timeout,
  "out-of-memory": LEGACY_COPY.oom,
  "convert-busy": LEGACY_COPY.busy,
  "convert-failed": LEGACY_COPY.failed,
  corrupt: LEGACY_COPY.corrupt,
  "too-large": LEGACY_COPY.tooLarge,
};

/** @typedef {"doc"|"xls"|"ppt"} LegacyFamily */

/** @type {Record<LegacyFamily, {mime: string, msExt: string, wpsExt: string, kind: string, to: string,
 *   extensions: string[]}>} */
export const LEGACY_FAMILY_INFO = {
  doc: {
    mime: "application/msword",
    msExt: ".doc",
    wpsExt: ".wps",
    kind: "document",
    to: "docx",
    extensions: [".doc", ".wps"],
  },
  xls: {
    mime: "application/vnd.ms-excel",
    msExt: ".xls",
    wpsExt: ".et",
    kind: "table",
    to: "xlsx",
    extensions: [".xls", ".et"],
  },
  ppt: {
    mime: "application/vnd.ms-powerpoint",
    msExt: ".ppt",
    wpsExt: ".dps",
    kind: "deck-template",
    to: "pptx",
    extensions: [".ppt", ".dps"],
  },
};

/**
 * @typedef {import("../attachments.mjs").StoredDerivative} LegacyDerivative
 * @typedef {import("../attachments.mjs").StoredRecord} LegacyStoredRecord
 * @typedef {Pick<import("../attachments.mjs").AttachmentStore, "root" | "sourceOf" | "findByHash" |
 *   "record">} LegacyIntakeStore the part of the attachment store legacy intake uses (ownerless)
 * @typedef {{ok: true, derivative: LegacyDerivative} | {ok: false, code: string, message: string}} LegacyParseOutcome
 * @typedef {{run: (job: {materialId: string, name: string, bytes: Uint8Array}) =>
 *   Promise<LegacyParseOutcome>}} LegacyIntakePool
 * @typedef {{available: boolean, ready: () => Promise<unknown>,
 *   waitReady?: (timeoutMs?: number) => Promise<boolean>,
 *   info: () => unknown,
 *   run: (input: {bytes: Uint8Array, family: string, vendor?: string}) =>
 *     Promise<import("./legacy-convert.mjs").ConvertSuccess |
 *             import("./legacy-convert.mjs").ConvertFailure>,
 * }} LegacyConverterLike
 * @typedef {{record: LegacyStoredRecord, duplicateOf?: string,
 *   uploadWarnings?: {code: string, message: string}[]}} LegacyIntakeResult
 */

const MAX_CONVERTED_BYTES = 50 * 1024 * 1024;
const LEGACY_FORMATS_SUFFIX = "旧版 .ppt / .doc / .xls 和 WPS .dps / .et / .wps 会自动转换";

/** The converter is either the object itself or the lazy thunk server.mjs holds.
 * @param {LegacyConverterLike | (() => LegacyConverterLike)} input @returns {LegacyConverterLike} */
function resolveConverter(input) {
  return typeof input === "function" ? input() : input;
}

/**
 * Waits for the converter's shared warm-up at most its own timeout bound
 * (uploads during warm-up wait ≤ timeoutMs). A fake converter without
 * waitReady keeps the direct semantics tests inject.
 * @param {LegacyConverterLike} converter @returns {Promise<boolean>} false when the bound expired
 */
async function readiness(converter) {
  if (typeof converter.waitReady === "function") return converter.waitReady();
  await converter.ready();
  return true;
}

/**
 * The supported-types sentence names the legacy formats only when a converter
 * can actually take them; otherwise the message is today's, word for word.
 * @param {LegacyConverterLike | (() => LegacyConverterLike)} legacyConverter
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function withLegacyFormatsSentence(legacyConverter, message) {
  const converter = resolveConverter(legacyConverter);
  const warmedUp = await readiness(converter);
  if (!warmedUp || !converter.available || !message.includes(SUPPORTED_TYPES_ZH)) return message;
  return message.replace(SUPPORTED_TYPES_ZH, `${SUPPORTED_TYPES_ZH}；${LEGACY_FORMATS_SUFFIX}`);
}

/** The mark prepended to the summary and shown on the chip: 「（由 .doc 转换）」.
 * @param {LegacyFamily} family @param {"ms"|"wps"} vendor */
export function conversionMark(family, vendor) {
  const info = LEGACY_FAMILY_INFO[family];
  const from = vendor === "wps" ? info.wpsExt : info.msExt;
  return { from, prefix: `（由 ${vendor === "wps" ? "WPS " : ""}${from} 转换）` };
}

/** @param {string} name */
function extensionOf(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot) : "";
}

/** @param {import("./cfb.mjs").LegacyClassification} verdict @returns {[string, string]|null} */
function securityRefusal(verdict) {
  if (!verdict.ok) return null;
  if (verdict.encrypted) {
    return ["encrypted", verdict.wpsSecure ? LEGACY_COPY.wpsSecure : LEGACY_COPY.encrypted];
  }
  return verdict.macro ? ["macro-enabled", LEGACY_COPY.macro] : null;
}

/**
 * The converted package re-enters the normal OOXML intake: same worker, same
 * limits, same macro and zip-bomb refusals as a direct upload.
 * @param {LegacyIntakePool} pool
 * @param {{materialId: string, name: string, bytes: Uint8Array}} job
 * @returns {Promise<LegacyParseOutcome>}
 */
async function parseConverted(pool, job) {
  try {
    return await pool.run(job);
  } catch (error) {
    const classified =
      error instanceof MaterialRejection ? { code: error.code, message: error.message } : classifyWorkerError(error);
    return { ok: false, ...classified };
  }
}

/**
 * @typedef {{store: LegacyIntakeStore, pool: LegacyIntakePool, converter: LegacyConverterLike,
 *   name: string, bytes: Uint8Array, declaredMime?: string, materialId: string,
 *   family: LegacyFamily, vendor: "ms"|"wps", extension: string, mismatch: boolean,
 *   source: () => LegacyDerivative["source"],
 *   rejected: (code: string, message: string) => Promise<LegacyIntakeResult>}} ConversionContext
 */

/** @param {ConversionContext} ctx @returns {Promise<LegacyIntakeResult>} */
async function convertAndStore(ctx) {
  const { store, pool, converter, name, bytes, family, rejected } = ctx;
  const ran = await converter.run({ bytes, family, vendor: ctx.vendor });
  if (!ran.ok) return rejected(ran.code, CONVERTER_COPY[ran.code] ?? LEGACY_COPY.failed);
  if (ran.bytes.length > MAX_CONVERTED_BYTES) return rejected("too-large", LEGACY_COPY.tooLarge);

  const stem = name.replace(/\.[^.]*$/, "") || "converted";
  const outcome = await parseConverted(pool, {
    materialId: ctx.materialId,
    name: `${stem}.${ran.to}`,
    bytes: ran.bytes,
  });
  const refusal = revalidationRefusal(outcome, {
    kind: LEGACY_FAMILY_INFO[family].kind,
    family,
    convertedBytes: ran.bytes,
  });
  if (refusal || !outcome.ok) {
    return rejected(...(refusal ?? ["corrupt", LEGACY_COPY.corrupt]));
  }
  const derivative = outcome.derivative;
  finishConvertedDerivative(derivative, {
    mark: conversionMark(family, ctx.vendor),
    family,
    vendor: ctx.vendor,
    extension: ctx.extension,
    mismatchMime: ctx.mismatch ? mimeTypeZh(LEGACY_FAMILY_INFO[family].mime) : null,
    source: ctx.source(),
    conversion: {
      to: `.${ran.to}`,
      engine: "libreoffice",
      engineVersion: ran.engineVersion,
      rule: LEGACY_CONVERSION_RULE,
      durationMs: ran.durationMs,
      convertedSha256: crypto.createHash("sha256").update(ran.bytes).digest("hex"),
      convertedBytes: ran.bytes.length,
      isolation: ran.isolation,
    },
  });
  // Embedded pictures come out of the converted package and are committed before the parent.
  /** @type {Parameters<typeof attachEmbeddedImages>[0]} */
  const embedded = /** @type {never} */ ({ store, pool, name, bytes: ran.bytes, derivative });
  if (hostsEmbeddedImages(embedded.derivative)) await attachEmbeddedImages(embedded);
  return { record: await store.record({ name, bytes, derivative, converted: ran.bytes }) };
}

/**
 * Convert one legacy upload into a normal material, or store its refusal.
 * Returns null only when the converter is unavailable: the caller then stores
 * the same rejection it would have stored without this branch.
 * @param {{store: LegacyIntakeStore, pool: LegacyIntakePool,
 *   legacyConverter: LegacyConverterLike | (() => LegacyConverterLike)}} io
 * @param {{name: string, bytes: Uint8Array, declaredMime?: string, materialId: string}} upload
 * @returns {Promise<LegacyIntakeResult|null>}
 */
export async function legacyOfficeOutcome({ store, pool, legacyConverter }, { name, bytes, declaredMime, materialId }) {
  const converter = resolveConverter(legacyConverter);
  // Bounded classification runs first, in every availability state. Explicit
  // encrypted/WPS-secure/macro findings reject here, before readiness: none
  // of them waits for warm-up, and none reaches the converter.
  const extension = extensionOf(name);
  const verdict = classifyLegacyOffice(bytes, extension);
  const family = verdict.family;
  const mismatch = Boolean(family && !LEGACY_FAMILY_INFO[family].extensions.includes(extension));
  const source = () =>
    store.sourceOf(name, bytes, declaredMime ?? null, family ? LEGACY_FAMILY_INFO[family].mime : null, mismatch);
  /** @param {string} code @param {string} message @returns {Promise<LegacyIntakeResult>} */
  const rejected = async (code, message) => ({
    record: await store.record({
      name,
      bytes,
      derivative: failureDerivative({ materialId, source: source(), code, message }),
    }),
  });

  const security = securityRefusal(verdict);
  if (security) return rejected(...security);
  // Non-security inputs wait for the shared warm-up at most timeoutMs; an
  // expired wait is the existing retryable timeout and warm-up continues.
  if (!(await readiness(converter))) return rejected("timeout", LEGACY_COPY.timeout);
  if (!converter.available) return null;
  // Available: a container that cannot be read safely is corrupt, never offered to soffice.
  if (!verdict.ok || !family) return rejected("corrupt", LEGACY_COPY.corrupt);

  // Conversion and commit share the intake lock of (store, hash): two
  // simultaneous uploads of one file convert once and the second reuses the record.
  return commitHash(store, bytes, async () => {
    const again = await store.findByHash(bytes);
    if (again) return duplicateResult(again, { name, bytes, declaredMime });
    return convertAndStore({
      store,
      pool,
      converter,
      name,
      bytes,
      declaredMime,
      materialId,
      family,
      vendor: verdict.vendor,
      extension,
      mismatch,
      source,
      rejected,
    });
  });
}
