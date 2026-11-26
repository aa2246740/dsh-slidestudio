/**
 * `xlsx-ooxml-v1` — Excel workbooks. Sheets (with hidden state), the header
 * row, per-column inferred types, merged ranges and formula cells (cached
 * `<v>` values only) are read with @xmldom/xmldom on top of the guarded zip
 * reader. Preview rows are capped per sheet; the full row set is retained in
 * the derivative (`sheets[].fullRows`) so later paging never re-parses the
 * original file. CAP-33: every sheet's embedded charts are read as cached
 * data through its drawing part.
 */
import { MaterialRejection } from "../zip-guard.mjs";
import { buildSummaryZh } from "../summary.mjs";
import {
  PackageReader,
  attrOf,
  childrenOf,
  descendantsOf,
  firstOf,
  localNameOf,
  padded,
  parseCellRef,
  parseRels,
  parseXml,
  resolvePartPath,
} from "./ooxml.mjs";
import { readSheetCharts } from "./office-charts.mjs";

export const XLSX_MAX_SHEETS = 50;
export const XLSX_MAX_CELLS = 1_000_000;
export const XLSX_PREVIEW_ROWS = 200;
const INFERENCE_ROWS = 1000;

/** Built-in numFmt ids that render a serial number as a date/time. */
const BUILTIN_DATE_FMTS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56,
  57, 58,
]);

const TOO_LARGE_SHEETS = `工作簿包含超过 ${XLSX_MAX_SHEETS} 个工作表，超出解析上限；请拆分后再上传`;
const TOO_LARGE_CELLS = `工作簿单元格超过 ${XLSX_MAX_CELLS.toLocaleString("en-US")} 个，超出解析上限；请拆分后再上传`;
const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const DATE1904_OFFSET_DAYS = 1462;

/** One parsed cell value with its kind. @typedef {{value: string|number|boolean|null, kind: "string"|"number"|"boolean"|"date"|"error"|"empty"}} CellValue */

/** @typedef {{rowNumber: number, cells: Map<number, CellValue>}} RawRow */

/**
 * One sheet payload. `rows` is the preview (≤200 data rows); `fullRows`
 * carries ALL data rows when the preview was capped, so paging never has to
 * re-parse the original file.
 * @typedef {{name: string, hidden: boolean, rowCount: number, colCount: number,
 *   headerRow: string[], headerRowIndex: number,
 *   columns: {header: string, inferredType: string}[],
 *   rows: (string|number|boolean|null)[][],
 *   fullRows?: (string|number|boolean|null)[][],
 *   merges: string[], dimension?: string, formulaCells: number}} XlsxSheet
 */

export const xlsxParser = {
  id: "xlsx-ooxml-v1",
  engine: "fflate + @xmldom/xmldom",
  /** @type {"table"} */
  kind: "table",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @returns {import("../derivative.mjs").ParserResult<object>}
   */
  parse({ bytes }) {
    const pkg = new PackageReader(bytes);
    const workbookPart = "xl/workbook.xml";
    const workbookText = pkg.text(workbookPart);
    if (workbookText === undefined) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
    const workbook = parseXml(workbookText, workbookPart);
    const date1904Raw = attrOf(workbook, "date1904");
    const date1904 = date1904Raw === "1" || date1904Raw === "true";

    const rels = parseRels(pkg, workbookPart);
    /** @type {{name: string, state: string|null, part: string}[]} */
    const sheetRefs = [];
    const sheetsEl = firstOf(workbook, "sheets");
    if (sheetsEl) {
      for (const sheetEl of childrenOf(sheetsEl, "sheet")) {
        const relId = attrOf(sheetEl, "r:id");
        const target = relId ? rels.get(relId)?.target : undefined;
        sheetRefs.push({
          name: attrOf(sheetEl, "name") ?? `工作表${sheetRefs.length + 1}`,
          state: attrOf(sheetEl, "state"),
          part: target ? resolvePartPath(workbookPart, target) : "",
        });
      }
    }
    if (sheetRefs.length > XLSX_MAX_SHEETS) throw new MaterialRejection("too-large", TOO_LARGE_SHEETS);

    const sharedStrings = readSharedStrings(pkg);
    const dateStyles = readDateStyles(pkg);

    /** @type {XlsxSheet[]} */
    const sheets = [];
    /** @type {Record<string, unknown>[]} */
    const charts = [];
    /** @type {{code: string, message: string}[]} */
    const warnings = [];
    let cellTotal = 0;
    let totalRows = 0;
    for (const ref of sheetRefs) {
      const sheetText = ref.part ? pkg.text(ref.part) : undefined;
      if (sheetText === undefined) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
      const parsed = parseSheet(sheetText, ref.part, {
        sharedStrings,
        dateStyles,
        date1904,
        budget: XLSX_MAX_CELLS - cellTotal,
      });
      cellTotal += parsed.cellCount;
      if (cellTotal > XLSX_MAX_CELLS) throw new MaterialRejection("too-large", TOO_LARGE_CELLS);
      totalRows += parsed.rowCount;
      sheets.push({
        ...parsed.sheet,
        name: ref.name,
        hidden: ref.state === "hidden" || ref.state === "veryHidden",
      });
      // CAP-33: this sheet's embedded charts, if a drawing part carries any.
      const sheetRels = ref.part ? parseRels(pkg, ref.part) : new Map();
      const sheetCharts = readSheetCharts(pkg, ref.part, sheetRels, ref.name);
      charts.push(...sheetCharts.charts);
      warnings.push(...sheetCharts.warnings);
    }

    const hiddenCount = sheets.filter((sheet) => sheet.hidden).length;
    const firstHeaders = sheets[0]?.headerRow ?? [];
    return {
      payload: {
        sheetCount: sheets.length,
        hiddenSheetCount: hiddenCount,
        rowCount: totalRows,
        sheets,
        // Always present: an empty list is a real 「未识别到图表」 result and is
        // what keeps stored records current (reuse-policy).
        charts,
      },
      summary: buildSummaryZh({
        parserId: this.id,
        sheetCount: sheets.length,
        hiddenSheetCount: hiddenCount,
        rowCount: totalRows,
        headers: firstHeaders,
        chartCount: charts.length,
      }),
      warnings: [...warnings, ...buildPreviewWarnings(sheets)],
      truncated: {
        applied: sheets.some((sheet) => sheet.fullRows),
        reason: sheets.some((sheet) => sheet.fullRows) ? "preview-rows" : undefined,
        limits: { previewRows: XLSX_PREVIEW_ROWS },
      },
    };
  },
};

/** Shared strings: phonetic runs (rPh) are ignored.
 * @param {PackageReader} pkg
 * @returns {string[]}
 */
function readSharedStrings(pkg) {
  const text = pkg.text("xl/sharedStrings.xml");
  if (text === undefined) return [];
  const root = parseXml(text, "xl/sharedStrings.xml");
  return childrenOf(root, "si").map((si) =>
    descendantsOf(si, "t")
      .filter((t) => !hasAncestor(t, "rPh"))
      .map((t) => t.textContent ?? "")
      .join(""),
  );
}

/** @param {import("./ooxml.mjs").DomNode} node @param {string} local */
function hasAncestor(node, local) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (localNameOf(parent) === local) return true;
  }
  return false;
}

/**
 * Style table: for every cellXfs index, whether the number format renders
 * dates. Custom formats are date-like when their code keeps d/m/y/h/s letters
 * outside quoted and bracketed sections.
 * @param {PackageReader} pkg
 * @returns {boolean[]}
 */
function readDateStyles(pkg) {
  const text = pkg.text("xl/styles.xml");
  /** @type {boolean[]} */
  const flags = [];
  if (text === undefined) return flags;
  const root = parseXml(text, "xl/styles.xml");
  /** @type {Map<number, string>} */
  const custom = new Map();
  const numFmts = firstOf(root, "numFmts");
  if (numFmts) {
    for (const fmt of childrenOf(numFmts, "numFmt")) {
      const id = Number(attrOf(fmt, "numFmtId"));
      if (Number.isFinite(id)) custom.set(id, attrOf(fmt, "formatCode") ?? "");
    }
  }
  const cellXfs = firstOf(root, "cellXfs");
  if (!cellXfs) return flags;
  for (const xf of childrenOf(cellXfs, "xf")) {
    const id = Number(attrOf(xf, "numFmtId") ?? 0);
    const code = custom.get(id);
    flags.push(BUILTIN_DATE_FMTS.has(id) || (code !== undefined && looksLikeDateFormat(code)));
  }
  return flags;
}

/** @param {string} code */
export function looksLikeDateFormat(code) {
  return /[dmyhs]/i.test(code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, ""));
}

/**
 * Excel serial number → ISO date string (UTC). 1900 and 1904 systems differ
 * by a constant 1462 days.
 * @param {number} serial @param {boolean} date1904
 * @returns {string|null}
 */
export function excelSerialToIso(serial, date1904) {
  if (!Number.isFinite(serial)) return null;
  const days = date1904 ? serial + DATE1904_OFFSET_DAYS : serial;
  const ms = Math.round((days - EXCEL_EPOCH_OFFSET_DAYS) * 86400000);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Parse one worksheet part into the sheet payload.
 * @param {string} xmlText @param {string} part
 * @param {{sharedStrings: string[], dateStyles: boolean[], date1904: boolean,
 *   budget: number}} ctx
 * @returns {{sheet: XlsxSheet, rowCount: number, cellCount: number}}
 */
function parseSheet(xmlText, part, ctx) {
  const root = parseXml(xmlText, part);
  const dimensionEl = firstOf(root, "dimension");
  const dimension = dimensionEl ? attrOf(dimensionEl, "ref") : null;
  /** @type {RawRow[]} */
  const rawRows = [];
  let cellCount = 0;
  let formulaCells = 0;
  /** @type {Map<number, number>} */
  const dateCounts = new Map();
  const sheetData = firstOf(root, "sheetData");
  if (sheetData) {
    for (const rowEl of childrenOf(sheetData, "row")) {
      /** @type {Map<number, CellValue>} */
      const cells = new Map();
      for (const cellEl of childrenOf(rowEl, "c")) {
        cellCount += 1;
        if (cellCount > ctx.budget) throw new MaterialRejection("too-large", TOO_LARGE_CELLS);
        const parsedCell = readCell(cellEl, ctx);
        if (parsedCell) {
          cells.set(parsedCell.col, parsedCell.cell);
          if (parsedCell.cell.kind === "date") {
            dateCounts.set(parsedCell.col, (dateCounts.get(parsedCell.col) ?? 0) + 1);
          }
          if (parsedCell.formula) formulaCells += 1;
        }
      }
      rawRows.push({ rowNumber: rawRows.length + 1, cells });
    }
  }

  const maxCol = Math.max(0, ...rawRows.map((row) => Math.max(0, ...row.cells.keys())));
  const colCount = Math.max(1, maxCol);
  /** @param {RawRow} row @returns {(string|number|boolean|null)[]} */
  const rowsOf = (row) =>
    padded(
      Array.from({ length: colCount }, (_, i) => row.cells.get(i + 1)?.value ?? null),
      colCount,
    );

  // Header heuristic: the first row whose non-empty cells are all strings and
  // which has at least two of them. A merged title row (one cell) never wins.
  let headerIndex = -1;
  for (let i = 0; i < rawRows.length && i < 50; i += 1) {
    const candidate = rawRows[i];
    if (!candidate) continue;
    const values = rowsOf(candidate);
    const nonEmpty = values.filter((v) => v !== null && !(typeof v === "string" && !v.trim()));
    if (nonEmpty.length >= 2 && nonEmpty.every((v) => typeof v === "string")) {
      headerIndex = i;
      break;
    }
  }

  const dataRows = rawRows.slice(headerIndex + 1);
  const headerRowRaw = headerIndex >= 0 ? rawRows[headerIndex] : undefined;
  const headerRow = headerRowRaw
    ? rowsOf(headerRowRaw).map((value, i) => (typeof value === "string" && value.trim()) || `列${i + 1}`)
    : null;

  /** @type {{header: string, inferredType: string}[]} */
  const columns = Array.from({ length: colCount }, (_, i) => ({
    header: headerRow?.[i] ?? `列${i + 1}`,
    inferredType: inferColumnType(dataRows, i + 1, dateCounts.get(i + 1) ?? 0),
  }));

  const allRows = dataRows.map((row) => rowsOf(row));
  const previewRows = allRows.slice(0, XLSX_PREVIEW_ROWS);
  const merges = descendantsOf(root, "mergeCell")
    .map((el) => attrOf(el, "ref"))
    .filter((ref) => typeof ref === "string");

  const truncated = allRows.length > XLSX_PREVIEW_ROWS;
  const sheet = /** @type {XlsxSheet} */ ({
    hidden: false,
    rowCount: allRows.length,
    colCount,
    headerRow: headerRow ?? [],
    headerRowIndex: headerIndex + 1,
    columns,
    rows: previewRows,
    ...(truncated ? { fullRows: allRows } : {}),
    merges,
    ...(dimension ? { dimension } : {}),
    formulaCells,
  });
  return { sheet, rowCount: allRows.length, cellCount };
}

/** Cell types with their own value rule; any other `t` reads like an untyped numeric cell. */
const TYPED_CELLS = new Set(["s", "inlineStr", "b", "e", "d"]);

/**
 * @param {string} type @param {string|null} vText @param {import("./ooxml.mjs").DomNode} cellEl
 * @param {string[]} sharedStrings @returns {CellValue}
 */
function typedCellValue(type, vText, cellEl, sharedStrings) {
  if (type === "s") {
    // A shared-string cell without a value reads as empty, like the numeric fallback.
    if (vText === null) return { value: null, kind: "empty" };
    return { value: sharedStrings[Number(vText)] ?? null, kind: "string" };
  }
  if (type === "inlineStr") {
    const isEl = firstOf(cellEl, "is");
    return { value: isEl ? (isEl.textContent ?? "") : null, kind: "string" };
  }
  if (type === "b") return { value: vText === "1", kind: "boolean" };
  if (type === "e") return { value: vText ?? "#VALUE!", kind: "error" };
  return { value: vText ?? null, kind: "date" };
}

/**
 * Untyped cells are numbers; a date number format turns the serial into an ISO date.
 * @param {string|null} vText @param {boolean} dateStyle @param {boolean} date1904
 * @returns {CellValue}
 */
function numericCellValue(vText, dateStyle, date1904) {
  if (vText === null || vText === "") return { value: null, kind: "empty" };
  const number = Number(vText);
  if (!Number.isFinite(number)) return { value: vText, kind: "string" };
  if (!dateStyle) return { value: number, kind: "number" };
  const iso = excelSerialToIso(number, date1904);
  return { value: iso ?? number, kind: iso ? "date" : "number" };
}

/**
 * One cell → {col, cell, formula}. Missing/empty cells return null so the
 * column map stays sparse.
 * @param {import("./ooxml.mjs").DomNode} cellEl
 * @param {{sharedStrings: string[], dateStyles: boolean[], date1904: boolean}} ctx
 * @returns {{col: number, cell: CellValue, formula: boolean}|null}
 */
function readCell(cellEl, ctx) {
  const ref = attrOf(cellEl, "r") ?? "";
  const location = parseCellRef(ref);
  if (!location) return null;
  const type = attrOf(cellEl, "t");
  const styleIndex = Number(attrOf(cellEl, "s") ?? 0);
  const vEl = firstOf(cellEl, "v");
  const vText = vEl ? (vEl.textContent ?? "") : null;
  const hasFormula = firstOf(cellEl, "f") !== null;

  const { value, kind } =
    type === null || !TYPED_CELLS.has(type)
      ? numericCellValue(vText, ctx.dateStyles[styleIndex] === true, ctx.date1904)
      : typedCellValue(type, vText, cellEl, ctx.sharedStrings);
  if (value === null && !hasFormula) return null;
  return { col: location.col, cell: { value, kind }, formula: hasFormula };
}

/**
 * Column type from the retained data rows (first 1000); a column with any
 * date-formatted cell is a date column.
 * @param {RawRow[]} dataRows @param {number} col @param {number} dateCount
 * @returns {"number"|"boolean"|"date"|"text"}
 */
export function inferColumnType(dataRows, col, dateCount) {
  if (dateCount > 0) return "date";
  const seen = { number: 0, boolean: 0, string: 0 };
  let checked = 0;
  for (const row of dataRows) {
    if (checked >= INFERENCE_ROWS) break;
    const cell = row.cells.get(col);
    if (!cell || cell.value === null) continue;
    checked += 1;
    if (cell.kind === "boolean") seen.boolean += 1;
    else if (cell.kind === "number") seen.number += 1;
    else if (cell.kind === "string") seen.string += 1;
  }
  if (!checked) return "text";
  if (seen.number > 0 && !seen.boolean && !seen.string) return "number";
  if (seen.boolean > 0 && !seen.number && !seen.string) return "boolean";
  return "text";
}

/**
 * @param {XlsxSheet[]} sheets
 * @returns {{code: string, message: string}[]}
 */
function buildPreviewWarnings(sheets) {
  return sheets
    .filter((sheet) => sheet.fullRows)
    .map((sheet) => ({
      code: "preview-truncated",
      message: `工作表「${sheet.name}」仅预览前 ${XLSX_PREVIEW_ROWS} 行，完整 ${sheet.rowCount.toLocaleString("en-US")} 行可分页读取`,
    }));
}
