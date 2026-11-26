/**
 * OOXML packages a (fake) converter can hand back for a legacy upload, built
 * in memory with fflate: readable documents, decks and workbooks for the
 * clean path, and macro, zip-bomb and WPS-decoy packages the re-validation
 * must refuse. Nothing here needs the on-disk sample generator.
 */
import { strToU8, unzipSync, zipSync } from "fflate";
import { buildPptx, tinyPng } from "../../testlib/pptx-fixture.mjs";
import { docxWithBody, textParagraph } from "./docx-media.mjs";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const SHEET_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml";

/** @param {string} text */
const escapeXml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** @param {number} index zero-based column */
const columnName = (index) => String.fromCharCode(65 + index);

/** @param {(string|number)[][]} rows */
function sheetDataXml(rows) {
  return rows
    .map((row, r) => {
      const cells = row.map((value, c) => {
        const ref = `${columnName(c)}${r + 1}`;
        return typeof value === "number"
          ? `<c r="${ref}"><v>${value}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
      });
      return `<row r="${r + 1}">${cells.join("")}</row>`;
    })
    .join("");
}

/**
 * A one-sheet workbook with inline strings, optionally carrying a picture part.
 * @param {{rows?: (string|number)[][], withPicture?: boolean}} [spec]
 * @returns {Buffer}
 */
export function workbook({ rows = [], withPicture = false } = {}) {
  /** @type {Record<string, Uint8Array>} */
  const files = {
    "[Content_Types].xml": strToU8(
      `${XML_DECL}<Types xmlns="${CT_NS}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Default Extension="png" ContentType="image/png"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="${SHEET_CT}.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${SHEET_CT}.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `${XML_DECL}<workbook xmlns="${SHEET_NS}" xmlns:r="${R_NS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `${XML_DECL}<worksheet xmlns="${SHEET_NS}"><sheetData>${sheetDataXml(rows)}</sheetData></worksheet>`,
    ),
  };
  if (withPicture) files["xl/media/image1.png"] = tinyPng();
  return Buffer.from(zipSync(files));
}

/** What a converter answers per family on the clean path. */
export const CONVERTED = {
  ppt: () => buildPptx(),
  doc: () => docxWithBody(textParagraph("季度经营报告正文"), []),
  xls: () =>
    workbook({
      rows: [
        ["季度", "营收"],
        ["一季度", 1204],
        ["二季度", 1388],
      ],
    }),
};

/** An OLE-signed blob standing in for a VBA project. */
const vbaProject = () => {
  const bytes = new Uint8Array(520);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  for (let index = 8; index < bytes.length; index += 1) bytes[index] = (index * 31) % 251;
  return bytes;
};

/** @type {Record<"pptm"|"docm"|"sneaky-xlsx", [contentType: string, part: string]>} */
const MACRO_SHAPES = {
  pptm: [
    "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
    "ppt/presentation.xml",
  ],
  docm: ["application/vnd.ms-word.document.macroEnabled.main+xml", "word/document.xml"],
  "sneaky-xlsx": [`${SHEET_CT}.sheet.main+xml`, "xl/workbook.xml"],
};

/**
 * A macro-enabled package: a vbaProject.bin beside the main part, under a
 * macroEnabled content type except for the sneaky workbook.
 * @param {keyof typeof MACRO_SHAPES} shape
 */
export function macroPackage(shape) {
  const [contentType, part] = MACRO_SHAPES[shape];
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `${XML_DECL}<Types xmlns="${CT_NS}"><Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/${part}" ContentType="${contentType}"/></Types>`,
      ),
      [part]: strToU8(`${XML_DECL}<root/>`),
      [`${part.replace(/[^/]+$/, "")}vbaProject.bin`]: vbaProject(),
    }),
  );
}

/** A docx-shaped zip with more entries than the archive limit allows. */
export function entryBomb() {
  /** @type {Record<string, Uint8Array>} */
  const entries = {};
  for (let index = 0; index < 5001; index += 1) entries[`p/${index}.bin`] = new Uint8Array(0);
  return Buffer.from(zipSync(entries, { level: 0 }));
}

/** An xlsx-shaped zip whose only sheet inflates far beyond the ratio limit. */
export function ratioBomb() {
  return Buffer.from(
    zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(4 * 1024 * 1024) }, { level: 9 }),
  );
}

/**
 * The same package with the first `<a:t>` of each listed part replaced.
 * @param {Uint8Array} bytes @param {Record<string, string>} replace part → new text
 */
export function withSlideText(bytes, replace) {
  const entries = unzipSync(new Uint8Array(bytes));
  for (const [part, text] of Object.entries(replace)) {
    const xml = Buffer.from(entries[part] ?? new Uint8Array()).toString("utf8");
    entries[part] = strToU8(xml.replace(/<a:t>[^<]*<\/a:t>/, `<a:t>${text}</a:t>`));
  }
  return Buffer.from(zipSync(entries));
}

/** @returns {Buffer} bytes no detector recognises */
export function noiseBytes() {
  return Buffer.from(Array.from({ length: 600 }, (_, index) => (index * 37 + 11) % 251));
}
