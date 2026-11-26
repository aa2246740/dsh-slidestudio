import { DERIVATIVE_SCHEMA, LEGACY_CONVERSION_RULE, PARSER_IDS } from "./derivative.mjs";
import { IMAGE_DERIVATIVE_VERSION } from "./image-style.mjs";
import { embeddedImagesCurrent } from "./embedded-images.mjs";
import { MAX_PDF_STYLE_PAGES } from "./pdf-style-hints.mjs";
import { kitCurrent } from "./parsers/pptx-kit-record.mjs";

const CURRENT_PARSER_BY_KIND_AND_MIME = new Map([
  ["text:text/plain", PARSER_IDS.text],
  ["text:text/markdown", PARSER_IDS.text],
  ["text:application/json", PARSER_IDS.text],
  ["table:text/csv", PARSER_IDS.csv],
  ["table:text/tab-separated-values", PARSER_IDS.csv],
  ["table:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", PARSER_IDS.xlsx],
  ["document:application/pdf", PARSER_IDS.pdf],
  ["document:application/vnd.openxmlformats-officedocument.wordprocessingml.document", PARSER_IDS.docx],
  ["deck-template:application/vnd.openxmlformats-officedocument.presentationml.presentation", PARSER_IDS.pptx],
  ["deck-template:application/vnd.openxmlformats-officedocument.presentationml.template", PARSER_IDS.pptx],
  ["deck-template:application/vnd.ms-officetheme", PARSER_IDS.thmx],
  ["image:image/svg+xml", PARSER_IDS.svg],
  ["image:image/avif", PARSER_IDS.avif],
  ["image:image/png", PARSER_IDS.image],
  ["image:image/jpeg", PARSER_IDS.image],
  ["image:image/gif", PARSER_IDS.image],
  ["image:image/webp", PARSER_IDS.image],
  ["image:application/zip", PARSER_IDS.imagePack],
]);

/** A stored legacy conversion parses as the OOXML target of its family. */
const CONVERTED_PARSER_BY_KIND = new Map([
  ["document", PARSER_IDS.docx],
  ["table", PARSER_IDS.xlsx],
  ["deck-template", PARSER_IDS.pptx],
]);

/**
 * The parser a current record of this kind must come from: a legacy conversion needs the current
 * conversion rule, any other record a detected MIME type.
 * @param {import("../attachments.mjs").StoredRecord["derivative"]} derivative
 * @param {string} kind @param {unknown} mime @returns {string|undefined}
 */
function currentParserIdOf(derivative, kind, mime) {
  if (derivative.conversion) {
    if (derivative.conversion.rule !== LEGACY_CONVERSION_RULE) return undefined;
    return CONVERTED_PARSER_BY_KIND.get(kind);
  }
  if (typeof mime !== "string") return undefined;
  return CURRENT_PARSER_BY_KIND_AND_MIME.get(`${kind}:${mime}`);
}

/**
 * CAP-33: Word/Excel records written before embedded charts were read have
 * no `charts` list; the same bytes are parsed once so their read_material
 * part:"charts" view exists. An empty list is a real 「未识别到图表」 result.
 * @param {import("../attachments.mjs").StoredRecord["derivative"]} derivative
 */
function chartsCurrent(derivative) {
  if (derivative.parser?.id === PARSER_IDS.docx) return Array.isArray(derivative.document?.charts);
  if (derivative.parser?.id === PARSER_IDS.xlsx) return Array.isArray(derivative.table?.charts);
  return true;
}

/**
 * A stored parse can be reused only when it was produced by the current
 * parser for its detected content type, its summary has no obsolete PDF
 * low-text claim and a DOCX/PDF carries the current embedded-image section.
 * A legacy conversion also requires the current conversion rule; a newer
 * converter engine alone is not a reason to convert again.
 * Old copies remain available to projects already materialized.
 * @param {import("../attachments.mjs").StoredRecord|undefined} record
 */
export function reusableDerivative(record) {
  if (!record) return false;
  const { derivative, meta } = record;
  if (derivative.schema !== DERIVATIVE_SCHEMA) return false;
  const kind = derivative.kind;
  const mime = derivative.source?.detectedMime;
  if (typeof kind !== "string") return false;

  const currentParserId = currentParserIdOf(derivative, kind, mime);
  if (!currentParserId || derivative.parser?.id !== currentParserId || meta.parserId !== currentParserId) {
    return false;
  }

  if (
    kind === "document" &&
    mime === "application/pdf" &&
    (pdfWordingStale(derivative) || pdfStyleProfileStale(derivative) || pdfTablesStale(derivative))
  ) {
    return false;
  }
  if (!chartsCurrent(derivative)) return false;
  if (kind === "image" && derivative.image?.version !== IMAGE_DERIVATIVE_VERSION) return false;
  // Templates stored before the template kit existed (or under an older kit version) have no
  // current `deck-template.kit`; the same bytes are parsed once more.
  if (
    kind === "deck-template" &&
    derivative.parser?.id !== PARSER_IDS.thmx &&
    !kitCurrent(derivative["deck-template"])
  ) {
    return false;
  }
  // DOCX/PDF records written before embedded pictures were extracted have no
  // `document.embeddedImages`; the same bytes are parsed once more.
  return embeddedImagesCurrent(derivative);
}

/**
 * A stored PDF record is stale when its low-text sentence still claims
 * 「扫描图片」 or doubles the 页 counter (「…等 12 页 页几乎没有…」) — both mark
 * copies written before the current neutral wording, so the same bytes are
 * re-parsed once on re-upload.
 * @param {import("./derivative.mjs").Derivative} derivative
 */
function pdfWordingStale(derivative) {
  const summary = derivative.summary?.zh;
  if (typeof summary === "string" && (summary.includes("扫描图片") || summary.includes("页 页"))) {
    return true;
  }
  return derivative.warnings.some((warning) => warning.code === "scanned-pages" && warning.message.includes("页 页"));
}

/**
 * A stored PDF style profile must count 1..30 measured pages, the bound the
 * public contract publishes. Copies written before the page-window fix reported
 * 0 pages for vector-less PDFs, so the same bytes are parsed once more.
 * @param {import("../attachments.mjs").StoredDerivative} derivative
 */
function pdfStyleProfileStale(derivative) {
  const pagesScanned = derivative.document?.styleProfile?.pagesScanned;
  return typeof pagesScanned === "number" && (pagesScanned < 1 || pagesScanned > MAX_PDF_STYLE_PAGES);
}

/**
 * Copies written before PDF table reconstruction (CAP-32) have no
 * `document.tables` list at all; the same bytes are parsed once so their
 * `read_material part:"tables"` view exists. An empty list is a real
 * 「未识别到表格」 result and stays reusable.
 * @param {import("../attachments.mjs").StoredDerivative} derivative
 */
function pdfTablesStale(derivative) {
  return !Array.isArray(derivative.document?.tables);
}
