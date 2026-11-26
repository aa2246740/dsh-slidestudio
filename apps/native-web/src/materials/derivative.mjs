/**
 * `material-derivative/v1` envelope helpers plus the shared rejection error.
 * The derivative is stored next to the original; the receipt pins both file
 * hashes so reads never need to re-run a parser.
 */

export const DERIVATIVE_SCHEMA = "material-derivative/v1";

/** Conversion contract version: a stored legacy conversion is reused only under this rule. */
export const LEGACY_CONVERSION_RULE = "legacy-convert-v1";

/** Parser ids owned by each milestone of the materials mission. */
export const PARSER_IDS = {
  text: "text-utf8-v1",
  csv: "csv-v1",
  xlsx: "xlsx-ooxml-v1",
  pptx: "pptx-ooxml-v2",
  pdf: "pdf-unpdf-v4",
  docx: "docx-ooxml-v1",
  image: "image-sharp-v1",
  imagePack: "image-pack-v1",
  svg: "svg-raster-v1",
  avif: "avif-raster-v1",
  thmx: "thmx-theme-v1",
};

/** Outcomes the user cannot fix by retrying the same file. */
const UNSUPPORTED_CODES = new Set([
  "unsupported-type",
  "legacy-office-format",
  "type-mismatch",
  "encrypted",
  "macro-enabled",
  "corrupt",
  "archive-limit",
  "too-large",
  "empty",
  "unsupported-encoding",
  "too-many-images",
  "no-images",
  "decoder-unavailable",
]);

/** @param {string} code */
export function failureStatus(code) {
  return UNSUPPORTED_CODES.has(code) ? "unsupported" : "failed";
}

/**
 * @typedef {{schema: string, materialId: string, kind: string|null,
 *   source: {name: string, bytes: number, sha256: string, declaredMime: string|null,
 *     detectedMime: string|null, extension: string, extensionMismatch: boolean},
 *   parser: {id: string|null, engine: string, durationMs: number},
 *   status: "ok"|"partial"|"failed"|"unsupported",
 *   truncated: {applied: boolean, reason?: string, limits?: object},
 *   warnings: {code: string, message: string}[],
 *   summary: {zh: string, facts?: object}|null,
 *   errorCode?: string, message?: string,
 *   conversion?: {from: string, to: string, engine: string, engineVersion: string|undefined,
 *     rule: string, durationMs: number, convertedSha256: string, convertedBytes: number,
 *     isolation: string}}} Derivative
 */

/**
 * Shared parser result: a payload keyed by kind, a Chinese summary and the
 * warnings/truncation bookkeeping shared by every parser. `status` marks a
 * degraded-but-successful parse (e.g. scanned PDF pages) as "partial"; the
 * public record still shows "parsed".
 * @template P
 * @typedef {{payload: P, summary: {zh: string, facts?: object},
 *   status?: "ok"|"partial",
 *   warnings: {code: string, message: string}[],
 *   truncated?: {applied: boolean, reason?: string, limits?: object}}} ParserResult
 */

/**
 * @param {{materialId: string, kind: string|null, source: Derivative["source"],
 *   parserId: string|null, engine: string, durationMs: number,
 *   status?: "ok"|"partial", truncated?: Derivative["truncated"],
 *   warnings?: {code: string, message: string}[], summary: Derivative["summary"],
 *   payload?: object}} parts
 * @returns {Derivative}
 */
export function buildDerivative({
  materialId,
  kind,
  source,
  parserId,
  engine,
  durationMs,
  status = "ok",
  truncated = { applied: false },
  warnings = [],
  summary,
  payload,
}) {
  return {
    schema: DERIVATIVE_SCHEMA,
    materialId,
    kind,
    source,
    parser: { id: parserId, engine, durationMs },
    status,
    truncated,
    warnings,
    summary,
    ...(payload && kind ? { [/** @type {string} */ (kind)]: payload } : {}),
  };
}

/**
 * A rejection record: the user's reason in Chinese, stable code, no payload.
 * @param {{materialId: string, source: Derivative["source"], code: string,
 *   message: string, parserId?: string|null, durationMs?: number}} parts
 * @returns {Derivative}
 */
export function failureDerivative({ materialId, source, code, message, parserId = null, durationMs = 0 }) {
  return {
    schema: DERIVATIVE_SCHEMA,
    materialId,
    kind: null,
    source,
    parser: { id: parserId, engine: "", durationMs },
    status: failureStatus(code),
    truncated: { applied: false },
    warnings: [],
    summary: null,
    errorCode: code,
    message,
  };
}
