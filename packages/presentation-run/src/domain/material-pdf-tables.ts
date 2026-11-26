/**
 * Read-only, deterministic rendering of a PDF's reconstructed tables
 * (`derivative.document.tables`, CAP-32) as the `read_material part:"tables"`
 * view. Chinese-headed markdown inside the untrusted-material envelope, labelled
 * 自动识别，可能有错位. `## 第 N 页` headings keep the provenance page attribution
 * working (splitChunkPages), so a quoted cell value lands on its source page.
 * A PDF without tables returns the Chinese note, never an error.
 */
import type { VerifiedMaterial } from "./material-pack.js";

const WRAPPER_OPEN = "<untrusted_reference_material>";
const WRAPPER_CLOSE = "</untrusted_reference_material>";
const MISALIGNMENT_LABEL = "自动识别，可能有错位；单元格文字按空白归一化，请以原文件为准。";

/** The `read_material` part id for a PDF's reconstructed tables. */
export const PDF_TABLES_PART = "tables";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type TableEntry = Readonly<{
  page: number;
  rows: number;
  cols: number;
  cells: readonly (readonly string[])[];
  confidence: number;
  truncated: boolean;
}>;

function parseTable(value: Record<string, unknown>): TableEntry | undefined {
  const page = Number(value.page);
  const cells = Array.isArray(value.cells)
    ? value.cells.filter(Array.isArray).map((row) => (row as unknown[]).map((cell) => String(cell ?? "")))
    : [];
  if (!Number.isSafeInteger(page) || page < 1 || cells.length === 0) return undefined;
  const cols = cells.reduce((max, row) => Math.max(max, row.length), 0);
  if (cols < 1) return undefined;
  const confidence = Number(value.confidence);
  const declaredRows = Number(value.rows);
  const declaredCols = Number(value.cols);
  return {
    page,
    rows: Number.isSafeInteger(declaredRows) && declaredRows > 0 ? declaredRows : cells.length,
    cols: Number.isSafeInteger(declaredCols) && declaredCols > 0 ? declaredCols : cols,
    cells: cells.map((row) => Array.from({ length: cols }, (__, index) => row[index] ?? "")),
    confidence: Number.isFinite(confidence) && confidence > 0 && confidence <= 1 ? confidence : 0.5,
    truncated: value.truncated === true,
  };
}

/** Tables listed on the derivative; unknown shapes are skipped, never thrown. */
function derivativeTables(material: VerifiedMaterial): TableEntry[] {
  const document = isRecord(material.derivative.document) ? material.derivative.document : {};
  return Array.isArray(document.tables)
    ? document.tables
        .filter(isRecord)
        .map(parseTable)
        .filter((entry): entry is TableEntry => entry !== undefined)
    : [];
}

/** Markdown cell: pipes escaped, line breaks flattened, envelope close neutralized. */
function markdownCell(text: string): string {
  return text
    .replace(/<\/untrusted_reference_material/gi, "&lt;/untrusted_reference_material")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function tableBlock(table: TableEntry, index: number): string[] {
  const confidence = `${Math.round(table.confidence * 100)}%`;
  const lines = [
    `表格 ${index + 1} · ${table.rows} 行 × ${table.cols} 列 · 置信度 ${confidence}${
      table.truncated ? "（超出上限，仅保留前部分行）" : ""
    }`,
  ];
  for (const [rowIndex, row] of table.cells.entries()) {
    const cells = row.map(markdownCell);
    lines.push(`| ${cells.join(" | ")} |`);
    if (rowIndex === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
  }
  return lines;
}

/** Every extracted page low-text (or none carries usable text) → scan wording. */
function scanOnlyNote(material: VerifiedMaterial): boolean {
  const document = isRecord(material.derivative.document) ? material.derivative.document : {};
  const pages = Array.isArray(document.pages)
    ? document.pages.filter(isRecord).filter((page) => Number(page.index) >= 1)
    : [];
  return pages.length > 0 && pages.every((page) => page.lowText === true);
}

/**
 * The `part:"tables"` text for a PDF material. Empty when the derivative has no
 * reconstructed tables (plain text PDF → 未识别到表格；all-low-text PDF → 扫描页
 * 不识别表格), so a read never fails and never invents content.
 */
export function pdfTablesPartText(material: VerifiedMaterial): string {
  const tables = derivativeTables(material);
  const body: string[] = [`# PDF「${material.name}」的表格`];
  if (!tables.length) {
    body.push(scanOnlyNote(material) ? "扫描页不识别表格：这些页面几乎没有可提取的文字。" : "未识别到表格。");
  } else {
    body.push(MISALIGNMENT_LABEL, "");
    let currentPage = 0;
    for (const [index, table] of tables.entries()) {
      if (table.page !== currentPage) {
        currentPage = table.page;
        body.push(`## 第 ${table.page} 页`, "");
      }
      body.push(...tableBlock(table, index), "");
    }
    while (body.at(-1) === "") body.pop();
  }
  return `${WRAPPER_OPEN}\n${body.join("\n")}\n${WRAPPER_CLOSE}`;
}
