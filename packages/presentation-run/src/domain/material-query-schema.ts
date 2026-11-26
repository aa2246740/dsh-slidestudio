/**
 * Argument contract of `query_material`. Every check is a Chinese message, so a wrong call
 * explains itself instead of failing in schema English. Column names are plain header strings:
 * nothing here (or in the engine) ever evaluates an expression.
 */
import { MaterialPackError } from "./material-pack.js";

export const FILTER_OPS = ["=", "!=", ">", "<", "in", "contains"] as const;
export const MEASURE_OPS = ["sum", "count", "avg", "min", "max"] as const;
export const DERIVE_OPS = ["share", "yoy", "mom", "ratio", "diff", "unit"] as const;

export type FilterOp = (typeof FILTER_OPS)[number];
export type MeasureOp = (typeof MEASURE_OPS)[number];
export type DeriveOp = (typeof DERIVE_OPS)[number];
export type QueryScalar = string | number | boolean | null;

export type QueryFilter = Readonly<{
  column: string;
  op: FilterOp;
  value: QueryScalar | readonly QueryScalar[];
}>;
export type QueryMeasure = Readonly<{ op: MeasureOp; column?: string; as: string }>;
export type QueryDerive = Readonly<{
  as: string;
  op: DeriveOp;
  of: string;
  base?: string;
  factor?: number;
}>;
export type QuerySort = Readonly<{ by: string; dir: "asc" | "desc" }>;

export type MaterialQuery = Readonly<{
  part?: string;
  filter: readonly QueryFilter[];
  groupBy: readonly string[];
  measures: readonly QueryMeasure[];
  derive: readonly QueryDerive[];
  sort: readonly QuerySort[];
  limit?: number;
}>;

/** Hard result bound; the engine and this schema share it so their messages cannot drift. */
export const QUERY_RESULT_ROW_LIMIT = 200;
export const ROW_LIMIT_MESSAGE = `结果超过 ${QUERY_RESULT_ROW_LIMIT} 行，请加筛选或分组（或用 limit 只取前几行，最多 ${QUERY_RESULT_ROW_LIMIT}）`;

const MAX_NAME_CHARS = 60;
const MAX_ITEMS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, where: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new MaterialPackError(
    `${where}「${typeof value === "string" ? value : (JSON.stringify(value) ?? "空")}」不受支持；可用：${allowed.join("、")}`,
  );
}

function listOf(value: unknown, name: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MaterialPackError(`${name} 必须是数组`);
  if (value.length > MAX_ITEMS) throw new MaterialPackError(`${name} 最多 ${MAX_ITEMS} 项`);
  return value;
}

function nameOf(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MaterialPackError(`${where} 需要非空的列名文字`);
  }
  return value.trim();
}

function aliasOf(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MaterialPackError(`${where} 需要 as（结果列名）`);
  }
  const alias = value.trim();
  if (alias.length > MAX_NAME_CHARS || /[\u0000-\u001f]/.test(alias)) {
    throw new MaterialPackError(`${where} 的 as 过长或含控制字符（最多 ${MAX_NAME_CHARS} 个字）`);
  }
  return alias;
}

function scalarOf(value: unknown, where: string): QueryScalar {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new MaterialPackError(`${where} 的值必须是有限数字`);
    }
    return value as QueryScalar;
  }
  throw new MaterialPackError(`${where} 的值必须是文字、数字、布尔值或 null`);
}

function filterOf(raw: unknown, index: number): QueryFilter {
  const where = `filter[${index}]`;
  if (!isRecord(raw)) throw new MaterialPackError(`${where} 必须是对象 {column, op, value}`);
  const column = nameOf(raw.column, `${where}.column`);
  const op = oneOf(FILTER_OPS, raw.op, `${where}.op`);
  if (!("value" in raw) || raw.value === undefined) {
    throw new MaterialPackError(`${where} 需要 value`);
  }
  if (op === "in") {
    if (!Array.isArray(raw.value) || !raw.value.length || raw.value.length > 500) {
      throw new MaterialPackError(`${where}（op「in」）的 value 必须是 1–500 项的数组`);
    }
    return { column, op, value: raw.value.map((item) => scalarOf(item, where)) };
  }
  const value = scalarOf(raw.value, where);
  if (op === "contains" && (typeof value !== "string" || !value)) {
    throw new MaterialPackError(`${where}（op「contains」）的 value 必须是非空文字`);
  }
  return { column, op, value };
}

function measureOf(raw: unknown, index: number): QueryMeasure {
  const where = `measures[${index}]`;
  if (!isRecord(raw)) throw new MaterialPackError(`${where} 必须是对象 {op, column, as}`);
  const op = oneOf(MEASURE_OPS, raw.op, `${where}.op`);
  const as = aliasOf(raw.as, where);
  if (raw.column === undefined || raw.column === null || raw.column === "") {
    if (op !== "count") throw new MaterialPackError(`${where}（${op}）需要 column`);
    return { op, as };
  }
  return { op, column: nameOf(raw.column, `${where}.column`), as };
}

function deriveOf(raw: unknown, index: number): QueryDerive {
  const where = `derive[${index}]`;
  if (!isRecord(raw)) throw new MaterialPackError(`${where} 必须是对象 {as, op, of, base, factor}`);
  const op = oneOf(DERIVE_OPS, raw.op, `${where}.op`);
  const as = aliasOf(raw.as, where);
  const of = nameOf(raw.of, `${where}.of`);
  const hasBase = raw.base !== undefined && raw.base !== null && raw.base !== "";
  const hasFactor = raw.factor !== undefined && raw.factor !== null;
  const needsBase = op === "yoy" || op === "mom" || op === "ratio" || op === "diff";
  if (needsBase && !hasBase) throw new MaterialPackError(`${where}（${op}）需要 base（对比的列）`);
  if (!needsBase && hasBase) throw new MaterialPackError(`${where}（${op}）不需要 base`);
  if (op === "unit") {
    if (!hasFactor || typeof raw.factor !== "number" || !Number.isFinite(raw.factor)) {
      throw new MaterialPackError(`${where}（unit）需要 factor（数字），例如元换算成万元用 0.0001`);
    }
    return { as, op, of, factor: raw.factor };
  }
  if (hasFactor) throw new MaterialPackError(`${where}（${op}）不需要 factor`);
  return needsBase ? { as, op, of, base: nameOf(raw.base, `${where}.base`) } : { as, op, of };
}

function sortOf(raw: unknown, index: number): QuerySort {
  const where = `sort[${index}]`;
  if (!isRecord(raw)) throw new MaterialPackError(`${where} 必须是对象 {by, dir}`);
  const dir = raw.dir === undefined ? "asc" : oneOf(["asc", "desc"] as const, raw.dir, `${where}.dir`);
  return { by: nameOf(raw.by, `${where}.by`), dir };
}

/**
 * Validate and canonicalize the call. Unknown keys are ignored (providers add envelope fields);
 * everything that changes the result is normalized so equal queries hash equally.
 */
export function parseMaterialQuery(args: Record<string, unknown>): MaterialQuery {
  const filter = listOf(args.filter, "filter").map(filterOf);
  const groupBy = listOf(args.groupBy, "groupBy").map((item, index) => nameOf(item, `groupBy[${index}]`));
  const measures = listOf(args.measures, "measures").map(measureOf);
  if (!measures.length) {
    throw new MaterialPackError(
      'query_material 需要至少一个 measures，例如 [{"op":"count","as":"行数"}] 或 [{"op":"sum","column":"金额","as":"合计"}]',
    );
  }
  const derive = listOf(args.derive, "derive").map(deriveOf);
  const sort = listOf(args.sort, "sort").map(sortOf);
  const names = [...groupBy, ...measures.map((item) => item.as), ...derive.map((item) => item.as)];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new MaterialPackError(`结果列名「${name}」重复，请换一个 as`);
    seen.add(name);
  }
  let limit: number | undefined;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1) {
      throw new MaterialPackError(`limit 必须是 1–${QUERY_RESULT_ROW_LIMIT} 的整数`);
    }
    if (args.limit > QUERY_RESULT_ROW_LIMIT) throw new MaterialPackError(ROW_LIMIT_MESSAGE);
    limit = args.limit;
  }
  const part = typeof args.part === "string" && args.part.trim() ? args.part.trim() : undefined;
  return {
    ...(part ? { part } : {}),
    filter,
    groupBy,
    measures,
    derive,
    sort,
    ...(limit !== undefined ? { limit } : {}),
  };
}
