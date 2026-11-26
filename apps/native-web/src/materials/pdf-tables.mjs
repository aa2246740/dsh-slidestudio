/**
 * CAP-32: PDF table reconstruction. Text items from `unpdf.extractTextItems`
 * (baseline x/y per run) are clustered into rows and columns; when the page's
 * operator list carries stroked ruling lines, the ruled grid assigns cells
 * directly and raises the confidence. Everything is deterministic — the same
 * bytes must produce the same `tables[]` so `read_material` chunk sha256s stay
 * stable — and every failure is contained: tables are a best-effort view,
 * labelled 「自动识别，可能有错位」, never a parse gate. No OCR: a scanned page
 * has no text items and contributes nothing.
 */

import {
  clusterPositions,
  COLUMN_TOLERANCE,
  ROW_TOLERANCE,
  ruleGrid,
  ruleSegmentsFromOperatorList,
} from "./pdf-table-rules.mjs";

export { clusterPositions, ruleGrid, ruleSegmentsFromOperatorList };

/** Bounds for the ruling-line scan; the operator caps mirror pdf-style-hints. */
export const PDF_TABLES_CONFIG = Object.freeze({
  /** Pages whose operator lists are scanned for ruling lines. */
  maxRuledPages: 30,
  maxOperatorsPerPage: 100_000,
  maxOperatorsTotal: 300_000,
  minRows: 2,
  minCols: 2,
  /** A larger table keeps its first rows and flags `truncated`. */
  maxRowsPerTable: 20,
  maxTablesPerPage: 5,
  maxTotalTables: 50,
  maxCellChars: 200,
});

/** Acceptance radius when snapping an item onto a clustered column. */
const COLUMN_SNAP = COLUMN_TOLERANCE * 1.5;

/** @typedef {{text: string, x: number, y: number, fontSize: number}} TableItem */
/** @typedef {import("./pdf-table-rules.mjs").RuleSegments} RuleSegments */
/** @typedef {{page: number, rows: number, cols: number, cells: string[][], confidence: number, ruled: boolean, truncated?: boolean}} PdfTable */
/** @typedef {{getResolvedPDFJS: () => Promise<any>, extractTextItems?: (proxy: any) => Promise<any>}} UnpdfLike */

/**
 * Drop whitespace-only runs, collapse inner whitespace, cap cell length.
 * @param {unknown[]} rawItems @returns {TableItem[]}
 */
function normalizeItems(rawItems) {
  /** @type {TableItem[]} */
  const items = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const record = /** @type {{str?: unknown, x?: unknown, y?: unknown, fontSize?: unknown}} */ (raw);
    const text = typeof record.str === "string" ? record.str.replace(/\s+/g, " ").trim() : "";
    const x = Number(record.x);
    const y = Number(record.y);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    items.push({
      text:
        Array.from(text).length > PDF_TABLES_CONFIG.maxCellChars ? text.slice(0, PDF_TABLES_CONFIG.maxCellChars) : text,
      x,
      y,
      fontSize: Number(record.fontSize) > 0 ? Number(record.fontSize) : 11,
    });
  }
  return items;
}

/** @param {string[][]} cells @param {number} limit @returns {string[][]} */
function truncateRows(cells, limit) {
  if (cells.length <= limit) return cells;
  return cells.slice(0, limit);
}

/**
 * Tables found on one page. The ruled grid wins when it yields a table; the
 * whitespace-aligned clustering is the fallback.
 * @param {TableItem[]} items @param {RuleSegments|undefined} segments
 * @returns {Omit<PdfTable, "page">[]}
 */
export function tableClusters(items, segments) {
  const usable = items.filter(
    (entry) =>
      typeof (/** @type {{text?: unknown}} */ (entry)?.text) === "string" &&
      /** @type {{text: string}} */ (entry).text.trim(),
  );
  if (usable.length < PDF_TABLES_CONFIG.minRows) return [];
  const grid = segments ? ruleGrid(segments) : undefined;
  if (grid) {
    const tables = ruledTables(usable, grid);
    if (tables.length) return tables;
  }
  return unruledTables(usable);
}

/**
 * @param {TableItem[]} items @param {{ys: number[], xs: number[]}} grid
 * @returns {Omit<PdfTable, "page">[]}
 */
function ruledTables(items, grid) {
  const { ys, xs } = grid;
  const rowOf = (/** @type {number} */ y) => {
    for (let row = 0; row < ys.length - 1; row += 1) {
      const top = ys[row];
      const bottom = ys[row + 1];
      if (top === undefined || bottom === undefined) return -1;
      if (y < top && y > bottom) return row;
    }
    return -1;
  };
  const colOf = (/** @type {number} */ x) => {
    for (let col = 0; col < xs.length - 1; col += 1) {
      const left = xs[col];
      const right = xs[col + 1];
      if (left === undefined || right === undefined) return -1;
      if (x >= left && x < right) return col;
    }
    return -1;
  };
  /** @type {Map<number, Map<number, string[]>>} */
  const assigned = new Map();
  for (const entry of items) {
    const row = rowOf(entry.y);
    if (row < 0) continue;
    const col = colOf(entry.x + 0.5);
    if (col < 0) continue;
    const cells = assigned.get(row) ?? new Map();
    const texts = cells.get(col) ?? [];
    texts.push(entry.text);
    cells.set(col, texts);
    assigned.set(row, cells);
  }
  return [assembleTable(assigned, true)].filter((table) => table !== undefined);
}

/**
 * Whitespace-aligned clustering: rows by baseline, columns by shared start-x,
 * contiguous runs of ≥2 multi-column rows.
 * @param {TableItem[]} items @returns {Omit<PdfTable, "page">[]}
 */
function unruledTables(items) {
  const sorted = [...items].sort(
    (left, right) =>
      right.y - left.y || left.x - right.x || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0),
  );
  /** @type {{y: number, items: TableItem[]}[]} */
  const lines = [];
  for (const entry of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.y - entry.y <= ROW_TOLERANCE) {
      last.items.push(entry);
    } else {
      lines.push({ y: entry.y, items: [entry] });
    }
  }
  // Fragments of one cell (split runs) rejoin when the gap is small for the font.
  for (const line of lines) {
    line.items.sort((left, right) => left.x - right.x);
    /** @type {TableItem[]} */
    const merged = [];
    for (const entry of line.items) {
      const previous = merged[merged.length - 1];
      if (previous && entry.x - previous.x < entry.fontSize * 0.75) {
        merged[merged.length - 1] = { ...previous, text: previous.text + entry.text };
      } else {
        merged.push({ ...entry });
      }
    }
    line.items = merged;
  }
  const columnCenters = clusterPositions(
    lines.flatMap((line) => line.items.map((entry) => entry.x)),
    COLUMN_TOLERANCE,
  );
  const columnOf = (/** @type {number} */ x) => {
    let best = -1;
    let bestDistance = COLUMN_SNAP;
    for (let index = 0; index < columnCenters.length; index += 1) {
      const center = columnCenters[index];
      if (center === undefined) continue;
      const distance = Math.abs(center - x);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  };
  /** @type {Omit<PdfTable, "page">[]} */
  const tables = [];
  /** @type {{cells: Map<number, string>, cols: number}[]} */
  let run = [];
  const flushRun = () => {
    if (run.length >= PDF_TABLES_CONFIG.minRows) {
      const grid = new Map();
      run.forEach((line, rowIndex) => grid.set(rowIndex, line.cells));
      const table = assembleTable(grid, false);
      if (table) tables.push(table);
    }
    run = [];
  };
  for (const line of lines) {
    /** @type {Map<number, string>} */
    const cells = new Map();
    for (const entry of line.items) {
      const column = columnOf(entry.x);
      if (column >= 0) cells.set(column, cells.has(column) ? `${cells.get(column)}${entry.text}` : entry.text);
    }
    if (new Set(cells.keys()).size >= PDF_TABLES_CONFIG.minCols) {
      run.push({ cells, cols: new Set(cells.keys()).size });
    } else {
      flushRun();
    }
  }
  flushRun();
  return tables.slice(0, PDF_TABLES_CONFIG.maxTablesPerPage);
}

/**
 * Normalize a row/column assignment map into a trimmed `cells` grid with a
 * consistency-based confidence. Returns undefined below the 2×2 minimum.
 * @param {Map<number, Map<number, string[]>>} assigned @param {boolean} ruled
 * @returns {Omit<PdfTable, "page">|undefined}
 */
function assembleTable(assigned, ruled) {
  const usedRows = [...assigned.keys()].filter((row) => assigned.get(row)?.size).sort((left, right) => left - right);
  /** @type {number[]} */
  const usedCols = [];
  for (const row of usedRows) {
    const rowCells = assigned.get(row);
    if (!rowCells) continue;
    for (const col of rowCells.keys()) {
      if (!usedCols.includes(col)) usedCols.push(col);
    }
  }
  usedCols.sort((left, right) => left - right);
  if (usedRows.length < PDF_TABLES_CONFIG.minRows || usedCols.length < PDF_TABLES_CONFIG.minCols) {
    return undefined;
  }
  const cells = usedRows.map((row) => {
    const rowCells = /** @type {Map<number, string | string[]>} */ (assigned.get(row));
    return usedCols.map((col) => {
      const value = rowCells.get(col);
      const text = Array.isArray(value) ? value.join("") : String(value ?? "");
      return text.trim();
    });
  });
  if (cells.some((row) => row.every((cell) => cell === ""))) {
    // An empty assignment row means the clustering mixed prose into the grid.
    return undefined;
  }
  const counts = cells.map((row) => row.filter((cell) => cell !== "").length);
  const modal = counts.reduce(
    (best, size) =>
      counts.filter((count) => count === size).length > counts.filter((count) => count === best).length ? size : best,
    counts[0],
  );
  const consistent = counts.filter((count) => count === modal).length / counts.length;
  const confidence = Math.round((ruled ? 0.9 - 0.1 * (1 - consistent) : 0.5 + 0.25 * consistent) * 100) / 100;
  const truncated = cells.length > PDF_TABLES_CONFIG.maxRowsPerTable;
  return {
    rows: cells.length,
    cols: usedCols.length,
    cells: truncateRows(cells, PDF_TABLES_CONFIG.maxRowsPerTable),
    confidence: Math.max(0.3, Math.min(1, confidence)),
    ruled,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Ruling segments for the first pages, honouring the shared operator budget.
 * A page over budget simply keeps no rules (position clustering still runs).
 * @param {UnpdfLike} unpdf
 * @param {{getPage: (page: number) => Promise<any>}} proxy @param {number} pageLimit
 * @returns {Promise<Map<number, RuleSegments>>}
 */
async function ruleSegmentsByPage(unpdf, proxy, pageLimit) {
  /** @type {Map<number, RuleSegments>} */
  const byPage = new Map();
  try {
    const pdfjs = await unpdf.getResolvedPDFJS();
    const namesByOperator = new Map(Object.entries(pdfjs.OPS).map(([name, id]) => [id, name]));
    let totalOperators = 0;
    for (let pageNumber = 1; pageNumber <= Math.min(pageLimit, PDF_TABLES_CONFIG.maxRuledPages); pageNumber += 1) {
      const page = await proxy.getPage(pageNumber);
      try {
        const operatorList = await page.getOperatorList();
        const size = operatorList.fnArray.length;
        if (
          size > PDF_TABLES_CONFIG.maxOperatorsPerPage ||
          totalOperators + size > PDF_TABLES_CONFIG.maxOperatorsTotal
        ) {
          break;
        }
        totalOperators += size;
        byPage.set(pageNumber, ruleSegmentsFromOperatorList(operatorList, namesByOperator));
      } finally {
        page.cleanup?.();
      }
    }
  } catch {
    // Ruling lines are optional evidence; clustering works without them.
  }
  return byPage;
}

/**
 * Reconstruct the tables of a PDF. Best effort and deterministic: any failure
 * yields whatever tables were already clustered (usually none), never a throw.
 * @param {{unpdf: UnpdfLike, proxy: {getPage: (page: number) => Promise<any>}, pageLimit: number}} input
 * @returns {Promise<PdfTable[]>}
 */
export async function extractPdfTables({ unpdf, proxy, pageLimit }) {
  /** @type {PdfTable[]} */
  const tables = [];
  try {
    const module = /** @type {{extractTextItems?: (proxy: any) => Promise<any>}} */ (await import("unpdf"));
    const extractTextItems = unpdf?.extractTextItems ?? module.extractTextItems;
    if (!extractTextItems) return tables;
    const extracted = await extractTextItems(proxy);
    const itemsPerPage = Array.isArray(extracted?.items) ? extracted.items : [];
    const limit = Math.max(0, Math.min(Number(pageLimit) || 0, itemsPerPage.length));
    const rules = await ruleSegmentsByPage(unpdf, proxy, limit);
    for (let index = 0; index < limit; index += 1) {
      const pageItems = normalizeItems(itemsPerPage[index]);
      if (!pageItems.length) continue;
      for (const table of tableClusters(pageItems, rules.get(index + 1))) {
        tables.push({ page: index + 1, ...table });
        if (tables.length >= PDF_TABLES_CONFIG.maxTotalTables) return tables;
      }
    }
  } catch {
    // Contained: text extraction above already succeeded, tables stay best effort.
  }
  return tables;
}
