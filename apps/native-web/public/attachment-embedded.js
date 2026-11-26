import { EMBEDDED_COPY } from "./material-scope.js";
import { INVALID_REPLY, record, text } from "./generation-data.js";
import { listSeparator } from "./attachment-image-metadata.js";
import { t } from "./i18n.js";
const HOSTS = new Set(["docx-ooxml-v1", "pdf-unpdf-v4"]);
const ORIGINS = new Set(["docx", "pdf"]);
const POSITION_KEYS = /** @type {const} */ (["paragraph", "page", "table", "row", "column"]);

/** One picture extracted from a DOCX/PDF: an ordinary image material plus where it came from.
 * @typedef {{
 *  id: string, name: string, size: number, kind: "image", status: "parsed", parser: "image-sharp-v1", summary: {zh: string}, warnings: {code: string, message: string}[], needsVision: boolean, origin: "docx"|"pdf", note: string,
 *  position: {paragraph?: number, page?: number, table?: number, row?: number, column?: number}, width?: number, height?: number, }} EmbeddedImage */

/** @param {Record<string, unknown>} data */
function validIdentity(data) {
  return (
    Boolean(text(data.id).trim()) &&
    Boolean(text(data.name).trim()) &&
    data.kind === "image" &&
    data.status === "parsed" &&
    data.parser === "image-sharp-v1"
  );
}

/** @param {Record<string, unknown>} data */
function validEntry(data) {
  return (
    validIdentity(data) &&
    typeof data.size === "number" &&
    Number.isSafeInteger(data.size) &&
    data.size >= 0 &&
    typeof record(data.summary).zh === "string" &&
    Array.isArray(data.warnings) &&
    typeof data.needsVision === "boolean" &&
    ORIGINS.has(text(data.origin)) &&
    Boolean(text(data.note).trim())
  );
}

/** @param {unknown} value @returns {EmbeddedImage["position"]} */
function positionOf(value) {
  const position = record(value);
  /** @type {EmbeddedImage["position"]} */
  const out = {};
  for (const key of POSITION_KEYS) {
    const entry = position[key];
    if (typeof entry === "number") out[key] = entry;
  }
  return out;
}

/** @param {unknown} value @returns {{code: string, message: string}[]} */
function warningList(value) {
  return (Array.isArray(value) ? value : [])
    .map((warning) => record(warning))
    .filter((warning) => typeof warning.code === "string" && typeof warning.message === "string")
    .map((warning) => ({ code: text(warning.code), message: text(warning.message) }));
}

/** @param {unknown} entry @returns {EmbeddedImage} */
function parseEmbeddedEntry(entry) {
  const data = record(entry);
  if (!validEntry(data)) throw new Error(INVALID_REPLY);
  return {
    id: text(data.id),
    name: text(data.name),
    size: /** @type {number} */ (data.size),
    kind: "image",
    status: "parsed",
    parser: "image-sharp-v1",
    summary: { zh: text(record(data.summary).zh) },
    warnings: warningList(data.warnings),
    needsVision: data.needsVision === true,
    origin: /** @type {"docx"|"pdf"} */ (data.origin),
    note: text(data.note),
    position: positionOf(data.position),
    ...(typeof data.width === "number" ? { width: data.width } : {}),
    ...(typeof data.height === "number" ? { height: data.height } : {}),
  };
}

/** Strictly decode `embeddedImages`; only a parsed DOCX/PDF may carry them.
 * @param {unknown} value @param {unknown} parser @param {unknown} kind @param {string} status
 * @returns {EmbeddedImage[]|undefined} */
export function parseEmbeddedImages(value, parser, kind, status) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 40 ||
    kind !== "document" ||
    status !== "parsed" ||
    typeof parser !== "string" ||
    !HOSTS.has(parser)
  ) {
    throw new Error(INVALID_REPLY);
  }
  return value.map(parseEmbeddedEntry);
}

/** Chip detail lines for a document's embedded pictures; the sentences come from the shared
 *  copy table. `sentIds` are the pictures an earlier send already carried (the document went with them); `continues` says the pictures that did not fit ride later messages, as the editor does.
 * @param {EmbeddedImage[]} images @param {number} omitted pictures that did not fit the quota
 * @param {number} maxTurnImages
 * @param {{sentIds?: ReadonlySet<string>, documentSent?: boolean, continues?: boolean}} [state]
 * @returns {string[]} */
export function embeddedImageLines(images, omitted, maxTurnImages, state = {}) {
  if (!images.length) return [];
  const { sentIds = new Set(), documentSent = false, continues = false } = state;
  const left = images.filter((image) => !sentIds.has(image.id));
  const shown = left.slice(0, 6).map((image) => image.note);
  const rest = left.length > shown.length ? t(" 等 {n} 张", { n: left.length }) : "";
  const list = shown.join(listSeparator());
  const lines = documentSent
    ? [EMBEDDED_COPY.remaining(images.length, images.length - left.length, left.length, list, rest)]
    : [EMBEDDED_COPY.included(images.length, list, rest)];
  if (omitted > 0) {
    lines.push(EMBEDDED_COPY.omitted(omitted, maxTurnImages, continues));
  }
  return lines;
}
