import assert from "node:assert/strict";
import { test } from "node:test";
import { DERIVATIVE_SCHEMA, PARSER_IDS } from "./derivative.mjs";
import { EMBEDDED_IMAGES_VERSION } from "./embedded-images.mjs";
import { TEMPLATE_KIT_SCHEMA, TEMPLATE_KIT_VERSION, kitCurrent } from "./parsers/pptx-kit-record.mjs";
import { reusableDerivative } from "./reuse-policy.mjs";

/** @typedef {import("../attachments.mjs").StoredRecord} StoredRecord */
/**
 * The document section a test record carries; tests delete the lists to model older copies.
 * @typedef {{tables?: unknown[], charts?: unknown[], styleProfile?: Record<string, unknown>,
 *   embeddedImages: {version: number, images: unknown[]}}} TestDocument
 * @typedef {{sheets: {name: string, rowCount: number, rows: unknown[]}[], charts?: unknown[]}} TestTable
 * @typedef {{
 *   meta: {parserId: string},
 *   derivative: {schema: string, kind: string, source: {detectedMime: string}, parser: {id: string},
 *     summary: {zh: string}, warnings: {code: string, message: string}[],
 *     document: TestDocument, table?: TestTable},
 * }} TestRecord a stored record with only the fields the reuse policy reads
 */

/**
 * Asks the policy about a partial test record; the policy reads only the fields set here.
 * @param {{meta: object, derivative: object}} record
 */
function isReusable(record) {
  return reusableDerivative(/** @type {StoredRecord} */ (/** @type {unknown} */ (record)));
}

const CAP_FIXED =
  "PDF · 12 页 · 第 1、2、3、4、5、6、7、8、9、10 等 12 页几乎没有文字（可能是整页图片），未识别（不做 OCR）";
const CAP_DOUBLED =
  "PDF · 12 页 · 第 1、2、3、4、5、6、7、8、9、10 等 12 页 页几乎没有文字（可能是整页图片），未识别（不做 OCR）";
const WARNING_FIXED =
  "第 1、2、3、4、5、6、7、8、9、10 等 12 页几乎没有可提取的文字，可能是整页图片或扫描件；当前版本不做文字识别（OCR），这几页的内容 Agent 读不到";
const WARNING_DOUBLED =
  "第 1、2、3、4、5、6、7、8、9、10 等 12 页 页几乎没有可提取的文字，可能是整页图片或扫描件；当前版本不做文字识别（OCR），这几页的内容 Agent 读不到";

/**
 * @param {{zh?: string, warnings?: {code: string, message: string}[]}} [overrides]
 * @returns {TestRecord}
 */
function pdfRecord(overrides = {}) {
  const { zh = CAP_FIXED, warnings = [] } = overrides;
  return {
    meta: { parserId: PARSER_IDS.pdf },
    derivative: {
      schema: DERIVATIVE_SCHEMA,
      kind: "document",
      source: { detectedMime: "application/pdf" },
      parser: { id: PARSER_IDS.pdf },
      summary: { zh },
      warnings,
      document: { tables: [], embeddedImages: { version: EMBEDDED_IMAGES_VERSION, images: [] } },
    },
  };
}

/** @param {"docx"|"pdf"} format */
function documentRecordWithout(format) {
  const record = pdfRecord();
  if (format === "docx") {
    record.derivative.source.detectedMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    record.meta.parserId = PARSER_IDS.docx;
    record.derivative.parser.id = PARSER_IDS.docx;
  }
  delete (/** @type {{document?: TestDocument}} */ (record.derivative).document);
  return record;
}

test("a capped low-text PDF record with the fixed wording is reusable", () => {
  assert.equal(isReusable(pdfRecord()), true);
});

test("a current-wording record from a superseded PDF parser is reparsed once", () => {
  const superseded = "pdf-unpdf-v2";
  assert.notEqual(superseded, PARSER_IDS.pdf);
  const record = pdfRecord();
  record.meta.parserId = superseded;
  record.derivative.parser.id = superseded;
  assert.equal(isReusable(record), false);
});

test("a healthy capped scanned-pages warning does not block reuse", () => {
  assert.equal(isReusable(pdfRecord({ warnings: [{ code: "scanned-pages", message: WARNING_FIXED }] })), true);
});

test("a PDF summary that doubles 页 is stale", () => {
  assert.equal(isReusable(pdfRecord({ zh: CAP_DOUBLED })), false);
});

test("a scanned-pages warning that doubles 页 is stale even with a clean summary", () => {
  assert.equal(isReusable(pdfRecord({ warnings: [{ code: "scanned-pages", message: WARNING_DOUBLED }] })), false);
});

/** @param {ReturnType<typeof pdfRecord>} record @param {number} pagesScanned */
function withStyleProfile(record, pagesScanned) {
  record.derivative.document.styleProfile = {
    schema: "style-profile/v1",
    source: "pdf-page-pixels",
    pagesScanned,
    accentColors: [{ hex: "#B40606", share: 1, roles: ["fill"] }],
    neutralColors: [{ hex: "#FFFFFF" }],
    fonts: [],
  };
  return record;
}

test("a stored PDF style profile that measured no pages is reparsed once", () => {
  // Copies written before the page-window fix published pagesScanned 0, which the
  // public contract (1..30) rejects, so the same bytes are parsed again on re-upload.
  assert.equal(isReusable(withStyleProfile(pdfRecord(), 0)), false);
});

test("a stored PDF style profile inside the 1..30 page window stays reusable", () => {
  assert.equal(isReusable(withStyleProfile(pdfRecord(), 1)), true);
  assert.equal(isReusable(withStyleProfile(pdfRecord(), 30)), true);
});

test("a stored PDF style profile outside the 1..30 page window is reparsed once", () => {
  assert.equal(isReusable(withStyleProfile(pdfRecord(), 31)), false);
});

test("the legacy 扫描图片 claim is still stale", () => {
  assert.equal(isReusable(pdfRecord({ zh: "PDF · 4 页 · 第 2、3 页为扫描图片，未识别文字（不做 OCR）" })), false);
});

test("non-PDF records are not judged by the PDF low-text wording rule", () => {
  const record = pdfRecord({ zh: CAP_DOUBLED });
  record.derivative.source.detectedMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  record.meta.parserId = PARSER_IDS.docx;
  record.derivative.parser.id = PARSER_IDS.docx;
  // The current charts list shape: only the PDF wording rule could make this
  // stale, and that rule does not apply to Word records.
  record.derivative.document.charts = [];
  assert.equal(isReusable(record), true);
});

test("VAL-PDF-007: a DOCX or PDF stored before embedded images were extracted is reparsed once", () => {
  assert.equal(isReusable(documentRecordWithout("pdf")), false);
  assert.equal(isReusable(documentRecordWithout("docx")), false);
});

test("VAL-PDF-008: a PDF stored before tables were extracted is reparsed once", () => {
  const record = pdfRecord();
  delete record.derivative.document.tables;
  assert.equal(isReusable(record), false);
});

test("VAL-PDF-008: a PDF with an empty tables list (no tables found) stays reusable", () => {
  assert.equal(isReusable(pdfRecord()), true);
});

test("VAL-PDF-008: a non-tables document (docx) without a tables list is not judged by the PDF tables rule", () => {
  const record = pdfRecord();
  delete record.derivative.document.tables;
  record.derivative.source.detectedMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  record.meta.parserId = PARSER_IDS.docx;
  record.derivative.parser.id = PARSER_IDS.docx;
  record.derivative.document.charts = [];
  assert.equal(isReusable(record), true);
});

/** A stored DOCX record whose document carries the current charts list shape. */
function docxRecord() {
  const record = pdfRecord();
  record.derivative.source.detectedMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  record.meta.parserId = PARSER_IDS.docx;
  record.derivative.parser.id = PARSER_IDS.docx;
  record.derivative.document.charts = [];
  return record;
}

/** A stored XLSX record whose table carries the current charts list shape. */
function xlsxRecord() {
  const record = pdfRecord();
  delete (/** @type {{document?: TestDocument}} */ (record.derivative).document);
  record.derivative.kind = "table";
  record.derivative.source.detectedMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  record.meta.parserId = PARSER_IDS.xlsx;
  record.derivative.parser.id = PARSER_IDS.xlsx;
  record.derivative.table = { sheets: [{ name: "指标", rowCount: 1, rows: [] }], charts: [] };
  return record;
}

test("VAL-FMT-006: a DOCX stored before embedded charts were read is reparsed once", () => {
  const stale = docxRecord();
  delete stale.derivative.document.charts;
  assert.equal(isReusable(stale), false);
  assert.equal(isReusable(docxRecord()), true);
});

test("VAL-FMT-006: an XLSX stored before embedded charts were read is reparsed once", () => {
  const stale = xlsxRecord();
  delete (/** @type {TestTable} */ (stale.derivative.table).charts);
  assert.equal(isReusable(stale), false);
  assert.equal(isReusable(xlsxRecord()), true);
});

test("an embedded-image section from an older shape is stale too", () => {
  const record = pdfRecord();
  record.derivative.document.embeddedImages.version = EMBEDDED_IMAGES_VERSION - 1;
  assert.equal(isReusable(record), false);
});

test("embedded images never make a text or image record stale", () => {
  const record = pdfRecord();
  delete (/** @type {{document?: TestDocument}} */ (record.derivative).document);
  record.derivative.kind = "text";
  record.derivative.source.detectedMime = "text/plain";
  record.meta.parserId = PARSER_IDS.text;
  record.derivative.parser.id = PARSER_IDS.text;
  assert.equal(isReusable(record), true);
});

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** @param {{kit?: unknown, templateKit?: unknown}} [deck] */
function templateRecord(deck = {}) {
  return {
    meta: { parserId: PARSER_IDS.pptx },
    derivative: {
      schema: DERIVATIVE_SCHEMA,
      kind: "deck-template",
      source: { detectedMime: PPTX_MIME },
      parser: { id: PARSER_IDS.pptx },
      summary: { zh: "PPTX 模板" },
      warnings: [],
      "deck-template": {
        kit: { file: "template-kit.json", sha256: "a".repeat(64) },
        templateKit: { schema: TEMPLATE_KIT_SCHEMA, version: TEMPLATE_KIT_VERSION },
        ...deck,
      },
    },
  };
}

test("VAL-KIT-003: a template with the current kit pointer and body is reusable", () => {
  assert.equal(isReusable(templateRecord()), true);
});

test("VAL-KIT-003: a template stored before the kit existed is reparsed once", () => {
  assert.equal(isReusable(templateRecord({ kit: undefined, templateKit: undefined })), false);
  assert.equal(isReusable(templateRecord({ templateKit: undefined })), false);
  assert.equal(isReusable(templateRecord({ kit: undefined })), false);
});

test("VAL-KIT-003: a kit from another version or with a damaged pointer is reparsed once", () => {
  const older = { schema: TEMPLATE_KIT_SCHEMA, version: TEMPLATE_KIT_VERSION - 1 };
  assert.equal(isReusable(templateRecord({ templateKit: older })), false);
  // Records parsed before the group-frame and derived-name fixes carry version 3 (and 2 before the
  // reflection/photo/id fixes); both must be parsed again.
  assert.equal(TEMPLATE_KIT_VERSION, 4);
  for (const version of [2, 3]) {
    const stored = { schema: TEMPLATE_KIT_SCHEMA, version };
    assert.equal(isReusable(templateRecord({ templateKit: stored })), false, String(version));
    assert.equal(
      kitCurrent(templateRecord({ templateKit: stored }).derivative["deck-template"]),
      false,
      String(version),
    );
  }
  assert.equal(isReusable(templateRecord({ kit: { file: "template-kit.json", sha256: "xyz" } })), false);
  assert.equal(isReusable(templateRecord({ kit: { file: "other.json", sha256: "a".repeat(64) } })), false);
});

test("a template kit never makes a non-template record stale", () => {
  assert.equal(isReusable(pdfRecord()), true);
});
