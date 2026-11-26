/**
 * Test-only builders for `query_material` fixtures: a seeded 20 000-row CSV (mirrors F-BIGCSV)
 * and the committed generic monthly workbook, as in-memory materials and as materialized
 * project records.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "../catalog.js";
import type { QueryableMaterial } from "./material-table.js";
import { writeMaterialFixture } from "./material-testkit.js";

export const QUERY_REGIONS = ["华东", "华南", "华北", "西南", "东北", "西北"] as const;

/** Rows 1–8 are fixed and sum to 7204.53; the rest are seeded. */
const FIXED_ROWS: readonly (readonly [string, string])[] = [
  ["华东", "1203.17"],
  ["华南", "987.42"],
  ["华东", "640.55"],
  ["华北", "1120.08"],
  ["华南", "905.31"],
  ["华东", "833.46"],
  ["西南", "777.77"],
  ["华北", "736.77"],
];

export type CsvRow = { region: string; amount: string };

export function bigCsvRows(count: number): CsvRow[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const fixed = FIXED_ROWS[index];
    if (fixed) return { region: fixed[0], amount: fixed[1] };
    const cents = ((n * 7919) % 1_000_000) + 37;
    return { region: QUERY_REGIONS[n % QUERY_REGIONS.length]!, amount: (cents / 100).toFixed(2) };
  });
}

const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function csvParts(count: number): { originalBytes: Buffer; derivative: Record<string, unknown> } {
  const rows = bigCsvRows(count);
  const text = ["序号,地区,金额", ...rows.map((row, index) => `${index + 1},${row.region},${row.amount}`)].join("\n");
  return {
    originalBytes: Buffer.from(text, "utf8"),
    derivative: {
      table: {
        encoding: "UTF-8",
        delimiter: ",",
        rowCount: count,
        colCount: 3,
        headerRow: ["序号", "地区", "金额"],
        columns: [],
        // The derivative keeps only a preview; queries must read the original bytes.
        rows: rows.slice(0, 200).map((row, index) => [String(index + 1), row.region, row.amount]),
      },
    },
  };
}

export function csvQueryMaterial(count: number, overrides: Partial<QueryableMaterial> = {}): QueryableMaterial {
  const { originalBytes, derivative } = csvParts(count);
  return {
    name: "明细.csv",
    kind: "table",
    parser: "csv-v1",
    sha256: sha(originalBytes),
    originalBytes,
    derivative,
    ...overrides,
  };
}

export type QuerySheet = { name: string; header: string[]; rows: unknown[][] };

function sheetDerivative(sheets: readonly QuerySheet[]): Record<string, unknown> {
  return {
    table: {
      sheetCount: sheets.length,
      rowCount: sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0),
      sheets: sheets.map((sheet) => ({
        name: sheet.name,
        hidden: false,
        rowCount: sheet.rows.length,
        colCount: sheet.header.length,
        headerRow: sheet.header,
        headerRowIndex: 1,
        columns: [],
        rows: sheet.rows.slice(0, 200),
        ...(sheet.rows.length > 200 ? { fullRows: sheet.rows } : {}),
      })),
    },
  };
}

export function xlsxQueryMaterial(
  sheets: readonly QuerySheet[],
  overrides: Partial<QueryableMaterial> = {},
): QueryableMaterial {
  const originalBytes = Buffer.from(`xlsx-${JSON.stringify(sheets)}`);
  return {
    name: "月报.xlsx",
    kind: "table",
    parser: "xlsx-ooxml-v1",
    sha256: sha(originalBytes),
    originalBytes,
    derivative: sheetDerivative(sheets),
    ...overrides,
  };
}

const MONTHLY_DIR = () => path.join(resolveRepoRoot(), "test-fixtures", "monthly");

/** The committed generic workbook's sheets, exactly as its manifest declares them. */
export function genericMonthlySheets(): QuerySheet[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(MONTHLY_DIR(), "monthly-generic.manifest.json"), "utf8")) as {
    columns: string[];
    sheets: { name: string; rows: unknown[][] }[];
  };
  return manifest.sheets.map((sheet) => ({
    name: sheet.name,
    header: manifest.columns,
    rows: sheet.rows,
  }));
}

/** Materialize the CSV the way `writeSessionMaterials` lays a table out. */
export function writeCsvQueryMaterial(projectRoot: string, id: string, count = 300, name = "明细.csv"): void {
  const { originalBytes, derivative } = csvParts(count);
  writeMaterialFixture(projectRoot, {
    id,
    name,
    kind: "table",
    parser: "csv-v1",
    originalBytes,
    derivative,
    parts: [{ part: "rows", label: `${count} 行`, rows: count, cols: 3 }],
  });
}

/** Materialize a workbook's sheets as an XLSX table material; its cells are the derivative. */
export function writeSheetsQueryMaterial(
  projectRoot: string,
  id: string,
  sheets: readonly QuerySheet[],
  options: { name?: string; originalBytes?: Buffer } = {},
): void {
  writeMaterialFixture(projectRoot, {
    id,
    name: options.name ?? "月报.xlsx",
    kind: "table",
    parser: "xlsx-ooxml-v1",
    originalBytes: options.originalBytes ?? Buffer.from(`xlsx-${JSON.stringify(sheets)}`),
    derivative: sheetDerivative(sheets),
    parts: sheets.map((sheet) => ({
      part: `sheet:${sheet.name}`,
      label: `工作表「${sheet.name}」`,
      rows: sheet.rows.length,
      cols: sheet.header.length,
    })),
  });
}

/** Materialize the committed `monthly-generic.xlsx` bytes with its declared cells as the derivative. */
export function writeMonthlyQueryMaterial(projectRoot: string, id: string, name = "monthly-generic.xlsx"): void {
  writeSheetsQueryMaterial(projectRoot, id, genericMonthlySheets(), {
    name,
    originalBytes: fs.readFileSync(path.join(MONTHLY_DIR(), "monthly-generic.xlsx")),
  });
}
