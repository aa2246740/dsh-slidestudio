/**
 * The table a `query_material` call runs on: header plus every data row of one sheet (xlsx) or of
 * the CSV, read from the receipt-verified material. Derivative previews are never used for CSV.
 */
import { csvAllRows } from "./material-content.js";
import { MaterialPackError, type VerifiedMaterial } from "./material-pack.js";

export type QueryableMaterial = Pick<
  VerifiedMaterial,
  "name" | "kind" | "parser" | "derivative" | "originalBytes" | "sha256"
>;

export type QueryTable = Readonly<{
  /** The part the rows came from: `rows` for CSV, `sheet:<name>` for a worksheet. */
  part: string;
  /** How Chinese messages name this table, e.g. 资料「月报.xlsx」工作表「经营指标」. */
  label: string;
  header: readonly string[];
  rows: readonly (readonly unknown[])[];
}>;

const SHEET_PREFIX = "sheet:";

const NOT_A_TABLE: Readonly<Record<string, string>> = {
  document: "文档（PDF 或 Word）",
  image: "图片",
  text: "文本",
  "deck-template": "PPT 模板",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notTableMessage(material: QueryableMaterial): string {
  const what = NOT_A_TABLE[material.kind] ?? "非表格资料";
  const hint =
    material.kind === "deck-template"
      ? "模板里的表格和图表数值请用 read_material 的 tables / charts 分段读取"
      : "请用 read_material 阅读它的内容";
  return `资料「${material.name}」是${what}，不是表格，不能用 query_material；${hint}`;
}

function headerNames(header: readonly unknown[], width: number): string[] {
  const names = header.map((cell, index) => (typeof cell === "string" && cell.trim() ? cell.trim() : `列${index + 1}`));
  for (let index = names.length; index < width; index += 1) names.push(`列${index + 1}`);
  return names;
}

function csvTable(material: QueryableMaterial, part: string | undefined): QueryTable {
  if (part !== undefined && part !== "rows") {
    throw new MaterialPackError(`资料「${material.name}」是 CSV 表格，part 只能是 rows（或不填），不是「${part}」`);
  }
  const all = csvAllRows(material);
  const declared = isRecord(material.derivative.table) ? material.derivative.table.headerRow : [];
  const header = headerNames(Array.isArray(declared) && declared.length ? declared : (all[0] ?? []), 0);
  return { part: "rows", label: `资料「${material.name}」`, header, rows: all.slice(1) };
}

function sheetTable(
  material: QueryableMaterial,
  sheets: readonly Record<string, unknown>[],
  part: string | undefined,
): QueryTable {
  const names = sheets.map((sheet) => String(sheet.name ?? ""));
  const listed = names.map((name) => `${SHEET_PREFIX}${name}`).join("、");
  let name: string | undefined;
  if (part === undefined) {
    if (names.length !== 1) {
      throw new MaterialPackError(`资料「${material.name}」有多个工作表，请用 part 指定其一：${listed}`);
    }
    name = names[0];
  } else {
    name = part.startsWith(SHEET_PREFIX) ? part.slice(SHEET_PREFIX.length) : part;
  }
  const index = names.indexOf(name ?? "");
  const sheet = sheets[index];
  if (!sheet) {
    throw new MaterialPackError(`资料「${material.name}」没有名为「${name}」的工作表；可用 part：${listed || "无"}`);
  }
  const full = Array.isArray(sheet.fullRows) ? sheet.fullRows : undefined;
  const rows = (full ?? (Array.isArray(sheet.rows) ? sheet.rows : [])).filter(Array.isArray);
  const width = Number.isSafeInteger(sheet.colCount) ? Number(sheet.colCount) : 0;
  return {
    part: `${SHEET_PREFIX}${name}`,
    label: `资料「${material.name}」工作表「${name}」`,
    header: headerNames(Array.isArray(sheet.headerRow) ? sheet.headerRow : [], width),
    rows: rows as readonly (readonly unknown[])[],
  };
}

export function loadQueryTable(material: QueryableMaterial, part: string | undefined): QueryTable {
  if (material.kind !== "table") throw new MaterialPackError(notTableMessage(material));
  const table = isRecord(material.derivative.table) ? material.derivative.table : {};
  const sheets = Array.isArray(table.sheets) ? table.sheets.filter(isRecord) : [];
  if (material.parser === "csv-v1" || !sheets.length) return csvTable(material, part);
  return sheetTable(material, sheets, part);
}
