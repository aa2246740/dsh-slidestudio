/**
 * Deterministic table queries for the agent tool `query_material` (CAP-15): filter → group →
 * measures → derive → sort → limit over the rows of a verified CSV/XLSX material. The Host
 * computes; the model never does arithmetic, and no expression is ever evaluated: a column is a
 * header string or an error.
 */
import { stableSha256 } from "./hashing.js";
import {
  cleanNumber,
  compareCells,
  displayCell,
  exactSum,
  matchesFilter,
  parseCell,
  type ParsedCell,
} from "./material-query-cells.js";
import { MaterialPackError } from "./material-pack.js";
import {
  parseMaterialQuery,
  ROW_LIMIT_MESSAGE,
  type DeriveOp,
  type MaterialQuery,
  type QueryDerive,
} from "./material-query-schema.js";
import { loadQueryTable, type QueryTable, type QueryableMaterial } from "./material-table.js";

export type QueryLimits = Readonly<{
  /** Data rows of the sheet or CSV a single query may scan. */
  maxScanRows: number;
  /** Wall-clock budget of one query. */
  maxMillis: number;
  maxResultRows: number;
}>;

/** One exported constant for every cap a query is subject to (VAL-DATA-005). */
export const MATERIAL_QUERY_LIMITS: QueryLimits = Object.freeze({
  maxScanRows: 100_000,
  maxMillis: 3_000,
  maxResultRows: 200,
});

export type QueryCell = string | number | boolean | null;

export type QueryColumn = Readonly<{
  name: string;
  role: "group" | "measure" | "derive";
  op?: string;
  source?: string;
  of?: string;
  base?: string;
  factor?: number;
  /** `percent`: the value is a fraction to show ×100 with a % sign. */
  display: "text" | "number" | "percent";
}>;

export type MaterialQueryResult = Readonly<{
  part: string;
  cols: readonly string[];
  columns: readonly QueryColumn[];
  rows: readonly (readonly QueryCell[])[];
  notes: readonly string[];
  rowsScanned: number;
  rowsMatched: number;
  rowsReturned: number;
}>;

export type QueryRunOptions = Readonly<{
  now?: () => number;
  limits?: Partial<QueryLimits>;
}>;

export type ExecutedQuery = MaterialQueryResult &
  Readonly<{ query: MaterialQuery; querySha256: string; resultSha256: string }>;

const CLOCK_STRIDE = 1_024;
const MAX_LISTED = 40;
const MAX_NOTES = 20;

const AGGREGATE_VERB: Readonly<Record<string, string>> = {
  sum: "求和",
  avg: "求平均",
  min: "取最小值",
  max: "取最大值",
};

/** What each derive says when it has no value; yoy/mom/ratio/diff compare `of` with `base`. */
const DERIVE_WORDS: Readonly<Record<DeriveOp, { of: string; base: string; zero: string; what: string }>> = {
  share: { of: "本行", base: "", zero: "", what: "占比" },
  yoy: { of: "本期", base: "去年同期", zero: "去年同期为 0", what: "同比" },
  mom: { of: "本期", base: "上期", zero: "上期为 0", what: "环比" },
  ratio: { of: "分子", base: "基数", zero: "基数为 0", what: "比值" },
  diff: { of: "本期", base: "基数", zero: "", what: "差值" },
  unit: { of: "本行", base: "", zero: "", what: "换算" },
};

function listNames(names: readonly string[]): string {
  return names.length > MAX_LISTED
    ? `${names.slice(0, MAX_LISTED).join("、")}等共 ${names.length} 列`
    : names.join("、");
}

/** The one column a name points at; an unknown or ambiguous name is an error, never a guess. */
function resolveColumn(table: QueryTable, name: string): number {
  const hits = table.header.flatMap((title, index) => (title === name ? [index] : []));
  if (!hits.length) {
    throw new MaterialPackError(`${table.label}没有列「${name}」；可用列：${listNames(table.header)}`);
  }
  if (hits.length > 1) {
    throw new MaterialPackError(
      `列名「${name}」在表头出现了 ${hits.length} 次（第 ${hits.map((i) => i + 1).join("、")} 列），无法确定指哪一列；请先在原表里给重名的列改名后重新上传`,
    );
  }
  return hits[0]!;
}

type Group = { key: QueryCell[]; positions: number[] };
type Row = { cells: QueryCell[]; notes: { as: string; message: string }[] };

function snippet(text: string): string {
  const chars = Array.from(text);
  return chars.length > 20 ? `${chars.slice(0, 20).join("")}…` : text;
}

function derivedCell(
  derive: QueryDerive,
  of: number | null,
  base: number | null,
  factor: number | undefined,
): { value: number | null; note?: string } {
  const words = DERIVE_WORDS[derive.op];
  const none = (reason: string) => ({ value: null, note: `${reason}，无法计算${words.what}` });
  if (of === null) return none(`${words.of}为空`);
  if (derive.op === "unit") return { value: cleanNumber(of * (factor ?? 1)) };
  if (base === null) return none(`${words.base}为空`);
  if (derive.op === "diff") return { value: cleanNumber(of - base) };
  if (base === 0) return none(words.zero);
  return { value: cleanNumber(derive.op === "ratio" ? of / base : (of - base) / base) };
}

export function runMaterialQuery(
  table: QueryTable,
  query: MaterialQuery,
  options: QueryRunOptions = {},
): MaterialQueryResult {
  const limits = { ...MATERIAL_QUERY_LIMITS, ...options.limits };
  const clock = options.now ?? Date.now;
  const started = clock();
  const checkClock = (position: number): void => {
    if (position % CLOCK_STRIDE === 0 && clock() - started > limits.maxMillis) {
      throw new MaterialPackError(`查询用时超过 ${limits.maxMillis / 1_000} 秒上限，已停止；请加筛选条件缩小范围`);
    }
  };
  if (table.rows.length > limits.maxScanRows) {
    throw new MaterialPackError(
      `${table.label}共 ${table.rows.length.toLocaleString("en-US")} 行，超过单次查询 ${limits.maxScanRows.toLocaleString("en-US")} 行的上限；请拆分文件后重新上传`,
    );
  }
  const filters = query.filter.map((item) => ({ ...item, at: resolveColumn(table, item.column) }));
  const groupAt = query.groupBy.map((name) => resolveColumn(table, name));
  const measureAt = query.measures.map((item) => (item.column === undefined ? -1 : resolveColumn(table, item.column)));

  const kept: number[] = [];
  table.rows.forEach((row, rowIndex) => {
    checkClock(rowIndex);
    if (filters.every((item) => matchesFilter(parseCell(row[item.at]), item.op, item.value))) {
      kept.push(rowIndex);
    }
  });

  const parsedColumns = new Map<number, ParsedCell[]>();
  const column = (at: number): ParsedCell[] => {
    let parsed = parsedColumns.get(at);
    if (!parsed) {
      parsed = kept.map((rowIndex) => parseCell(table.rows[rowIndex]?.[at]));
      parsedColumns.set(at, parsed);
    }
    return parsed;
  };
  query.measures.forEach((item, position) => {
    if (item.op === "count" || measureAt[position]! < 0) return;
    const offender = column(measureAt[position]!).findIndex((cell) => cell.kind === "text");
    if (offender < 0) return;
    const cell = column(measureAt[position]!)[offender] as { text: string };
    throw new MaterialPackError(
      `列「${item.column}」含有不是数值的内容（第 ${kept[offender]! + 1} 行：「${snippet(cell.text)}」），无法${AGGREGATE_VERB[item.op]}；请先用 filter 去掉这些行，或改用 count`,
    );
  });

  const groups = new Map<string, Group>();
  if (!groupAt.length) {
    groups.set("", { key: [], positions: kept.map((_, position) => position) });
  } else {
    kept.forEach((rowIndex, position) => {
      checkClock(position);
      const key = groupAt.map((at) => displayCell(table.rows[rowIndex]?.[at]));
      const id = JSON.stringify(key);
      const group = groups.get(id);
      if (group) group.positions.push(position);
      else groups.set(id, { key, positions: [position] });
    });
  }

  const columns: QueryColumn[] = [
    ...query.groupBy.map((name) => ({
      name,
      role: "group" as const,
      source: name,
      display: "text" as const,
    })),
    ...query.measures.map((item) => ({
      name: item.as,
      role: "measure" as const,
      op: item.op,
      ...(item.column !== undefined ? { source: item.column } : {}),
      display: "number" as const,
    })),
  ];
  const rows: Row[] = [...groups.values()].map((group) => {
    const cells: QueryCell[] = [...group.key];
    query.measures.forEach((item, position) => {
      const parsed = measureAt[position]! >= 0 ? column(measureAt[position]!) : undefined;
      if (item.op === "count") {
        cells.push(
          parsed ? group.positions.filter((at) => parsed[at]!.kind !== "empty").length : group.positions.length,
        );
        return;
      }
      const values = group.positions.flatMap((at) => {
        const cell = parsed![at]!;
        return cell.kind === "number" ? [cell.value] : [];
      });
      if (!values.length) cells.push(null);
      else if (item.op === "sum") cells.push(cleanNumber(exactSum(values)));
      else if (item.op === "avg") cells.push(cleanNumber(exactSum(values) / values.length));
      else {
        // A loop, not Math.min(...values): one group can hold every row of a 100 000-row sheet.
        cells.push(values.reduce((best, value) => (item.op === "min" ? Math.min(best, value) : Math.max(best, value))));
      }
    });
    return { cells, notes: [] };
  });

  const notes: string[] = [];
  const numericAt = (name: string, where: string): number => {
    const at = columns.findIndex((item) => item.name === name && item.role !== "group" && item.display !== "text");
    if (at < 0) {
      const usable = columns.filter((item) => item.role !== "group").map((item) => item.name);
      throw new MaterialPackError(
        `${where}「${name}」不是已有的度量列（measures 或前面 derive 的 as）；可用：${usable.join("、") || "无"}`,
      );
    }
    return at;
  };
  query.derive.forEach((item, position) => {
    const ofAt = numericAt(item.of, `derive[${position}].of`);
    const baseAt = item.base === undefined ? -1 : numericAt(item.base, `derive[${position}].base`);
    const words = DERIVE_WORDS[item.op];
    const numeric = (row: Row, at: number): number | null =>
      typeof row.cells[at] === "number" ? (row.cells[at] as number) : null;
    let total: number | null = null;
    if (item.op === "share") {
      const present = rows.flatMap((row) => numeric(row, ofAt) ?? []);
      total = present.length ? exactSum(present) : null;
      if (total === 0) notes.push(`「${item.as}」：合计为 0，无法计算${words.what}`);
    }
    for (const row of rows) {
      const of = numeric(row, ofAt);
      let derived: { value: number | null; note?: string };
      if (item.op === "share") {
        derived =
          of === null
            ? { value: null, note: `本行「${item.of}」为空，无法计算${words.what}` }
            : total === null || total === 0
              ? { value: null }
              : { value: cleanNumber(of / total) };
      } else {
        derived = derivedCell(item, of, baseAt >= 0 ? numeric(row, baseAt) : null, item.factor);
      }
      row.cells.push(derived.value);
      if (derived.note) row.notes.push({ as: item.as, message: derived.note });
    }
    columns.push({
      name: item.as,
      role: "derive",
      op: item.op,
      of: item.of,
      ...(item.base !== undefined ? { base: item.base } : {}),
      ...(item.factor !== undefined ? { factor: item.factor } : {}),
      display: item.op === "share" || item.op === "yoy" || item.op === "mom" ? "percent" : "number",
    });
  });

  const cols = columns.map((item) => item.name);
  query.sort.forEach((item, position) => {
    if (!cols.includes(item.by)) {
      throw new MaterialPackError(`sort[${position}].by「${item.by}」不是结果列；可用：${cols.join("、")}`);
    }
  });
  for (const item of [...query.sort].reverse()) {
    const at = cols.indexOf(item.by);
    rows.sort((left, right) => compareCells(left.cells[at]!, right.cells[at]!, item.dir));
  }
  const total = rows.length;
  if (query.limit === undefined && total > limits.maxResultRows) {
    throw new MaterialPackError(ROW_LIMIT_MESSAGE);
  }
  const returned = query.limit === undefined ? rows : rows.slice(0, query.limit);
  if (returned.length < total) {
    notes.push(`共 ${total} 行结果，只返回前 ${returned.length} 行（limit）`);
  }
  const rowNotes = returned.flatMap((row, rowAt) =>
    row.notes.map((entry) => {
      const label = row.cells
        .slice(0, query.groupBy.length)
        .map((cell) => (cell === null ? "（空）" : String(cell)))
        .join("／");
      return `第 ${rowAt + 1} 行${label ? `（${snippet(label)}）` : ""}「${entry.as}」：${entry.message}`;
    }),
  );
  const listed = [...notes, ...rowNotes];
  const finalNotes =
    listed.length > MAX_NOTES
      ? [...listed.slice(0, MAX_NOTES), `另有 ${listed.length - MAX_NOTES} 处同类说明未列出`]
      : listed;
  return {
    part: table.part,
    cols,
    columns,
    rows: returned.map((row) => row.cells),
    notes: finalNotes,
    rowsScanned: table.rows.length,
    rowsMatched: kept.length,
    rowsReturned: returned.length,
  };
}

/** Parse the call, load the verified table, run it, and bind the hashes. */
export function queryMaterialTable(
  material: QueryableMaterial,
  args: Record<string, unknown>,
  options: QueryRunOptions = {},
): ExecutedQuery {
  const parsed = parseMaterialQuery(args);
  const table = loadQueryTable(material, parsed.part);
  const query: MaterialQuery = { ...parsed, part: table.part };
  const result = runMaterialQuery(table, query, options);
  return {
    ...result,
    query,
    querySha256: stableSha256({ materialSha256: material.sha256, query }),
    resultSha256: stableSha256({ cols: result.cols, rows: result.rows }),
  };
}
