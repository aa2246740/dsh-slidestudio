/**
 * Cell semantics of `query_material`: what counts as empty, as a number or as text, how a filter
 * compares, and how numbers are summed without floating-point drift. Pure and deterministic.
 */
import type { FilterOp, QueryScalar } from "./material-query-schema.js";

export type ParsedCell =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "number"; value: number; text: string }>
  | Readonly<{ kind: "text"; text: string }>;

const EMPTY: ParsedCell = Object.freeze({ kind: "empty" });
const NUMBER_TEXT = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$|^[+-]?\.\d+(?:[eE][+-]?\d+)?$/;

/** Cells are scalars; a `{text, value}` object (template-style cell) is read through its value. */
function scalar(cell: unknown): unknown {
  if (cell && typeof cell === "object" && !Array.isArray(cell)) {
    const record = cell as Record<string, unknown>;
    return record.value ?? record.text ?? null;
  }
  return cell;
}

export function parseCell(cell: unknown): ParsedCell {
  const value = scalar(cell);
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "number", value, text: String(value) }
      : { kind: "text", text: String(value) };
  }
  const text = String(value).trim();
  if (!text) return EMPTY;
  if (typeof value === "string" && NUMBER_TEXT.test(text)) {
    const number = Number(text.replace(/,/g, ""));
    if (Number.isFinite(number)) return { kind: "number", value: number, text };
  }
  return { kind: "text", text };
}

/** The value a group-by or listing shows: empty → null, numbers stay numbers, text is trimmed. */
export function displayCell(cell: unknown): string | number | boolean | null {
  const value = scalar(cell);
  if (typeof value === "boolean") return value;
  const parsed = parseCell(value);
  if (parsed.kind === "empty") return null;
  return typeof value === "number" && parsed.kind === "number" ? parsed.value : parsed.text;
}

function parseScalar(value: QueryScalar): ParsedCell {
  return parseCell(typeof value === "boolean" ? String(value) : value);
}

function looseEquals(cell: ParsedCell, value: QueryScalar): boolean {
  if (value === null || value === "") return cell.kind === "empty";
  if (cell.kind === "empty") return false;
  const target = parseScalar(value);
  if (cell.kind === "number" && target.kind === "number") return cell.value === target.value;
  return cell.text === (target.kind === "empty" ? "" : target.text);
}

/** One filter test. Mixed number/text ordering never matches rather than guessing. */
export function matchesFilter(cell: ParsedCell, op: FilterOp, value: QueryScalar | readonly QueryScalar[]): boolean {
  if (op === "in") return (value as readonly QueryScalar[]).some((item) => looseEquals(cell, item));
  const one = value as QueryScalar;
  if (op === "=") return looseEquals(cell, one);
  if (op === "!=") return !looseEquals(cell, one);
  if (cell.kind === "empty") return false;
  if (op === "contains") return cell.text.includes(String(one));
  const target = parseScalar(one);
  if (cell.kind === "number" && target.kind === "number") {
    return op === ">" ? cell.value > target.value : cell.value < target.value;
  }
  if (cell.kind === "text" && target.kind === "text") {
    return op === ">" ? cell.text > target.text : cell.text < target.text;
  }
  return false;
}

/** Neumaier-compensated sum: the same total whatever the row order or magnitude spread. */
export function exactSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + compensation;
}

/** 15 significant digits: drops binary noise (7204.530000000001) without losing real precision. */
export function cleanNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const cleaned = Number(value.toPrecision(15));
  return cleaned === 0 ? 0 : cleaned;
}

/** Order for sorting result cells: numbers before text, empty last, ties keep input order. */
export function compareCells(
  left: string | number | boolean | null,
  right: string | number | boolean | null,
  direction: "asc" | "desc",
): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  const rank = (cell: string | number | boolean) => (typeof cell === "number" ? 0 : 1);
  let order: number;
  if (rank(left) !== rank(right)) order = rank(left) - rank(right);
  else if (typeof left === "number" && typeof right === "number") order = left - right;
  else order = String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
  return direction === "desc" && rank(left) === rank(right) ? -order : order;
}
