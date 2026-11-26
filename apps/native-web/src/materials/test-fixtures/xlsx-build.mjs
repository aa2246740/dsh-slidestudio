/**
 * Hand-built minimal XLSX workbooks for parser and intake tests (styles/numFmt
 * dates, date1904, sheet-count caps, missing parts).
 */
import { strToU8, zipSync } from "fflate";

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
export const OFFICE_DOC_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
export const SHEET_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";

export const esc = (/** @type {string} */ text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 1-based column index → spreadsheet letters (A, B, … Z, AA). */
export const columnLetter = (/** @type {number} */ index) => {
  let n = index;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/**
 * Hand-built minimal workbook for cases the generator's fixtures do not cover
 * (styles/numFmt dates, date1904, sheet-count caps, missing parts).
 * @param {{name: string, rows: {ref: string, t?: string, s?: string, v?: string,
 *   text?: string, formula?: string}[][], hidden?: boolean, merges?: string[],
 *   dimension?: string}[]} sheets
 * @param {{stylesXml?: string, date1904?: boolean, sharedStrings?: string[]}} [options]
 */
export function buildXlsx(sheets, { stylesXml, date1904, sharedStrings } = {}) {
  const workbook =
    `${XML_DECL}<workbook xmlns="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"${date1904 ? ' date1904="1"' : ""}><sheets>` +
    sheets
      .map(
        (sheet, i) =>
          `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}"${sheet.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`,
      )
      .join("") +
    `</sheets></workbook>`;
  /** @type {Record<string, Uint8Array>} */
  const files = {
    "[Content_Types].xml": strToU8(
      `${XML_DECL}<Types xmlns="${RELS_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_DOC_REL}" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="${SHEET_REL}" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        `</Relationships>`,
    ),
  };
  sheets.forEach((sheet, i) => {
    const rows = sheet.rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">` +
          row
            .map((cell) => {
              const attrs = `${cell.t ? ` t="${cell.t}"` : ""}${cell.s ? ` s="${cell.s}"` : ""}`;
              if (cell.text !== undefined)
                return `<c r="${cell.ref}"${attrs} t="inlineStr"><is><t>${esc(cell.text)}</t></is></c>`;
              if (cell.formula !== undefined)
                return `<c r="${cell.ref}"${attrs}><f>${esc(cell.formula)}</f><v>${cell.v}</v></c>`;
              return `<c r="${cell.ref}"${attrs}><v>${cell.v}</v></c>`;
            })
            .join("") +
          `</row>`,
      )
      .join("");
    const merges = sheet.merges?.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges
          .map((ref) => `<mergeCell ref="${ref}"/>`)
          .join("")}</mergeCells>`
      : "";
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `${XML_DECL}<worksheet xmlns="${MAIN_NS}">` +
        (sheet.dimension ? `<dimension ref="${sheet.dimension}"/>` : "") +
        `${merges}<sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  if (stylesXml) files["xl/styles.xml"] = strToU8(stylesXml);
  if (sharedStrings)
    files["xl/sharedStrings.xml"] = strToU8(
      `${XML_DECL}<sst xmlns="${MAIN_NS}" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
        sharedStrings.map((text) => `<si><t>${esc(text)}</t></si>`).join("") +
        `</sst>`,
    );
  return Buffer.from(zipSync(files, { level: 6 }));
}
