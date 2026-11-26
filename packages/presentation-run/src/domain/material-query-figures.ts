/**
 * Computed-figure check for `write_page`: which numbers a page states are cells of a
 * `query_material` result of this run. Matching follows the displayed precision, so a value the
 * page rounds to two decimals still traces to its exact cell. Never blocks a write.
 */
import type { ProvenanceDeclaration } from "@open-slidestudio/pptd-v2";
import { epochQueryFacts, readQueryResult, type ComputedFigureMatch } from "./material-query-ledger.js";
import { appendFact, factId, type RunToolContext } from "./run-ledger.js";

export type FigureToken = Readonly<{
  raw: string;
  magnitude: number;
  decimals: number;
  percent: boolean;
}>;

export type ComputedCell = Readonly<{
  column: string;
  display: "number" | "percent";
  value: number;
  resultSha256: string;
}>;

export type ComputedFigureCheck = Readonly<{
  cells: readonly ComputedCell[];
  matches: readonly ComputedFigureMatch[];
  /** True when a declared value equals a computed cell at the precision it is written. */
  covers: (value: string) => boolean;
}>;

const TOKEN_PATTERN = /(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(%?)(?![\d.])/g;
const MAX_CELLS = 50_000;

function tokenOf(body: string, percent: boolean): FigureToken | undefined {
  const plain = body.replace(/,/g, "");
  const magnitude = Number(plain);
  if (!Number.isFinite(magnitude)) return undefined;
  const dot = plain.indexOf(".");
  return {
    raw: `${body}${percent ? "%" : ""}`,
    magnitude,
    decimals: dot < 0 ? 0 : plain.length - dot - 1,
    percent,
  };
}

function significantDigits(token: FigureToken): number {
  return token.raw.replace(/[,%.]/g, "").replace(/^0+/, "").length;
}

/** A year-like integer (1900–2100, no separator) names a period, not a computed value. */
function isYear(token: FigureToken): boolean {
  return !token.raw.includes(",") && token.magnitude >= 1900 && token.magnitude <= 2100;
}

/**
 * The figures a page states: decimals and percentages with at least three significant digits, and
 * integers of at least four, except years and the totals 100% and 0% (the M2 figure rules).
 */
export function figureTokens(text: string): readonly FigureToken[] {
  const seen = new Set<string>();
  const found: FigureToken[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = tokenOf(match[1]!, match[2] === "%");
    if (!token || seen.has(token.raw)) continue;
    const fractional = token.decimals > 0 || token.percent;
    if (token.percent && (token.magnitude === 100 || token.magnitude === 0)) continue;
    if (significantDigits(token) < (fractional ? 3 : 4)) continue;
    if (!fractional && isYear(token)) continue;
    seen.add(token.raw);
    found.push(token);
  }
  return found;
}

/** The first number of a declared value, with no significance filter. */
function declaredToken(value: string): FigureToken | undefined {
  const match = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(%?)/.exec(value);
  return match ? tokenOf(match[1]!, match[2] === "%") : undefined;
}

/** Cells of this epoch's verified query results that hold a number (measures and derives only). */
export function epochComputedCells(root: string, contextEpochId: string): readonly ComputedCell[] {
  const cells: ComputedCell[] = [];
  const seen = new Set<string>();
  for (const fact of epochQueryFacts(root, contextEpochId)) {
    // A retried query repeats its hash; a different query with the same rows reads its own columns.
    if (seen.has(fact.querySha256)) continue;
    seen.add(fact.querySha256);
    const stored = readQueryResult(root, fact);
    if (!stored) continue;
    stored.columns.forEach((column, at) => {
      if (column.role === "group" || column.display === "text") return;
      const display = column.display === "percent" ? "percent" : "number";
      for (const row of stored.rows) {
        const value = row[at];
        if (typeof value === "number" && Number.isFinite(value) && cells.length < MAX_CELLS) {
          cells.push({ column: column.name, display, value, resultSha256: fact.resultSha256 });
        }
      }
    });
  }
  return cells;
}

function displayedAs(token: FigureToken, cell: ComputedCell): boolean {
  const candidates =
    cell.display === "percent" ? (token.percent ? [cell.value * 100] : [cell.value * 100, cell.value]) : [cell.value];
  const halfUnit = 0.5 * 10 ** -token.decimals;
  const slack = 1e-9 * Math.max(1, token.magnitude);
  return candidates.some((candidate) => Math.abs(Math.abs(candidate) - token.magnitude) <= halfUnit + slack);
}

/** One match per written value and result: the first cell that value could be a display of. */
export function matchComputedFigures(
  values: readonly string[],
  cells: readonly ComputedCell[],
): readonly ComputedFigureMatch[] {
  const matches: ComputedFigureMatch[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const token = declaredToken(value);
    if (!token) continue;
    for (const cell of cells) {
      const key = `${value}|${cell.resultSha256}`;
      if (seen.has(key) || !displayedAs(token, cell)) continue;
      seen.add(key);
      matches.push({ value, resultSha256: cell.resultSha256, column: cell.column });
    }
  }
  return matches;
}

export function checkComputedFigures(
  root: string,
  context: RunToolContext,
  input: { pageText: string; declaration?: ProvenanceDeclaration },
): ComputedFigureCheck {
  const cells = epochComputedCells(root, context.contextEpochId);
  if (!cells.length) return { cells, matches: [], covers: () => false };
  const written = figureTokens(input.pageText).map((token) => token.raw);
  const declared = (input.declaration?.quoted ?? []).map((item) => item.value.trim());
  const values = [...new Set([...written, ...declared.filter(Boolean)])];
  return {
    cells,
    matches: matchComputedFigures(values, cells),
    covers: (value) => matchComputedFigures([value.trim()], cells).length > 0,
  };
}

export function recordPageComputedFigures(
  root: string,
  context: RunToolContext,
  input: { pageId: string; revision: number; matches: readonly ComputedFigureMatch[] },
): void {
  const payload = { ...input, contextEpochId: context.contextEpochId };
  appendFact(root, {
    type: "page.computed-figures",
    factId: factId("page.computed-figures", payload),
    at: new Date().toISOString(),
    ...payload,
  });
}
