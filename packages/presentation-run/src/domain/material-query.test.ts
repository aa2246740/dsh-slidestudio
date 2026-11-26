import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MaterialPackError } from "./material-pack.js";
import { queryMaterialTable, type ExecutedQuery } from "./material-query.js";
import {
  bigCsvRows,
  csvQueryMaterial as csvMaterial,
  genericMonthlySheets as genericMonthly,
  xlsxQueryMaterial as xlsxMaterial,
} from "./material-query.testkit.js";
import type { QueryableMaterial } from "./material-table.js";

/** Integer cents parsed from the text itself: no floating-point accumulation in the oracle. */
const cents = (amount: string): bigint => BigInt(amount.replace(".", ""));

function oracle(rows: { region: string; amount: string }[]) {
  const groups = new Map<string, { sum: bigint; count: number; min: bigint; max: bigint }>();
  for (const row of rows) {
    const value = cents(row.amount);
    const group = groups.get(row.region);
    if (!group) groups.set(row.region, { sum: value, count: 1, min: value, max: value });
    else {
      group.sum += value;
      group.count += 1;
      if (value < group.min) group.min = value;
      if (value > group.max) group.max = value;
    }
  }
  return groups;
}

const toNumber = (value: bigint) => Number(value) / 100;

function run(material: QueryableMaterial, args: Record<string, unknown>): ExecutedQuery {
  return queryMaterialTable(material, args);
}

function refuses(material: QueryableMaterial, args: Record<string, unknown>, pattern: RegExp): void {
  assert.throws(
    () => run(material, args),
    (error: unknown) => {
      assert.ok(error instanceof MaterialPackError, String(error));
      assert.match(error.message, pattern);
      return true;
    },
  );
}

const SUM = { op: "sum", column: "金额", as: "合计" };

describe("VAL-DATA-002: filter, group and aggregate equal an independent computation", () => {
  const rows = bigCsvRows(20_000);
  const material = csvMaterial(20_000);
  const expected = oracle(rows);

  it("groups by region with every aggregate and a share, one row per distinct region", () => {
    const result = run(material, {
      groupBy: ["地区"],
      measures: [
        SUM,
        { op: "count", as: "笔数" },
        { op: "avg", column: "金额", as: "均值" },
        { op: "min", column: "金额", as: "最小" },
        { op: "max", column: "金额", as: "最大" },
      ],
      derive: [{ as: "占比", op: "share", of: "合计" }],
    });
    assert.deepEqual(result.cols, ["地区", "合计", "笔数", "均值", "最小", "最大", "占比"]);
    assert.equal(result.rows.length, expected.size);
    assert.equal(result.rowsScanned, 20_000);
    let shareTotal = 0;
    for (const row of result.rows) {
      const group = expected.get(String(row[0]))!;
      assert.ok(group, `unexpected group ${row[0]}`);
      assert.ok(Math.abs(Number(row[1]) - toNumber(group.sum)) <= 1e-6);
      assert.equal(Number(row[1]).toFixed(2), toNumber(group.sum).toFixed(2));
      assert.equal(row[2], group.count);
      assert.ok(Math.abs(Number(row[3]) - toNumber(group.sum) / group.count) <= 1e-6);
      assert.equal(Number(row[3]).toFixed(2), (toNumber(group.sum) / group.count).toFixed(2));
      assert.equal(row[4], toNumber(group.min));
      assert.equal(row[5], toNumber(group.max));
      shareTotal += Number(row[6]);
    }
    assert.ok(Math.abs(shareTotal - 1) <= 1e-9, `shares sum to ${shareTotal}`);
  });

  it("filters one region", () => {
    const result = run(material, {
      filter: [{ column: "地区", op: "=", value: "华东" }],
      measures: [SUM, { op: "count", as: "笔数" }],
    });
    const east = expected.get("华东")!;
    assert.equal(result.rows.length, 1);
    assert.ok(Math.abs(Number(result.rows[0]![0]) - toNumber(east.sum)) <= 1e-6);
    assert.equal(result.rows[0]![1], east.count);
    assert.equal(result.rowsMatched, east.count);
  });

  it("sums the eight fixed rows to exactly 7204.53, with in and with <", () => {
    const withIn = run(material, {
      filter: [{ column: "序号", op: "in", value: [1, 2, 3, 4, 5, 6, 7, 8] }],
      measures: [SUM],
    });
    assert.deepEqual(withIn.rows, [[7204.53]]);
    const withLess = run(material, {
      filter: [{ column: "序号", op: "<", value: 9 }],
      measures: [SUM],
    });
    assert.deepEqual(withLess.rows, [[7204.53]]);
  });

  it("sorts descending and limits to the top three regions", () => {
    const result = run(material, {
      groupBy: ["地区"],
      measures: [SUM],
      sort: [{ by: "合计", dir: "desc" }],
      limit: 3,
    });
    const top = [...expected.entries()]
      .sort((left, right) => (left[1].sum < right[1].sum ? 1 : left[1].sum > right[1].sum ? -1 : 0))
      .slice(0, 3)
      .map(([region]) => region);
    assert.deepEqual(
      result.rows.map((row) => row[0]),
      top,
    );
    assert.equal(result.rowsReturned, 3);
    assert.ok(result.rowsMatched === 20_000);
  });

  it("reads rows beyond the 200-row derivative preview from the verified original", () => {
    const result = run(material, {
      filter: [{ column: "序号", op: "=", value: 15_000 }],
      measures: [{ op: "max", column: "金额", as: "金额" }],
    });
    const row = rows[14_999]!;
    assert.deepEqual(result.rows, [[Number(row.amount)]]);
  });
});

describe("VAL-DATA-003: derived operations are exact and explicit", () => {
  const sheets = genericMonthly();
  const material = xlsxMaterial(sheets);
  const base = {
    part: "sheet:经营指标",
    groupBy: ["类别"],
    measures: [
      { op: "sum", column: "2026-09", as: "本月" },
      { op: "sum", column: "2026-08", as: "上月" },
      { op: "sum", column: "2025-09", as: "去年同月" },
    ],
  };
  const byCategory = (result: ExecutedQuery, category: string) => result.rows.find((row) => row[0] === category)!;
  const col = (result: ExecutedQuery, name: string) => result.cols.indexOf(name);

  it("computes yoy, mom, ratio, diff and unit against explicit columns", () => {
    const result = run(material, {
      ...base,
      derive: [
        { as: "同比", op: "yoy", of: "本月", base: "去年同月" },
        { as: "环比", op: "mom", of: "本月", base: "上月" },
        { as: "比值", op: "ratio", of: "本月", base: "去年同月" },
        { as: "差值", op: "diff", of: "本月", base: "上月" },
        { as: "万元", op: "unit", of: "本月", factor: 0.0001 },
      ],
    });
    const a = byCategory(result, "指标A");
    const rel = (actual: unknown, wanted: number) =>
      Math.abs(Number(actual) - wanted) <= 1e-9 * Math.max(1, Math.abs(wanted));
    assert.ok(rel(a[col(result, "同比")], (1250.5 - 1000) / 1000));
    assert.ok(rel(a[col(result, "环比")], (1250.5 - 1100.25) / 1100.25));
    assert.ok(rel(a[col(result, "比值")], 1250.5 / 1000));
    assert.ok(rel(a[col(result, "差值")], 1250.5 - 1100.25));
    assert.ok(rel(a[col(result, "万元")], 1250.5 * 0.0001));
    const meta = Object.fromEntries(result.columns.map((column) => [column.name, column]));
    assert.deepEqual(
      [meta["同比"]!.of, meta["同比"]!.base, meta["环比"]!.of, meta["环比"]!.base],
      ["本月", "去年同月", "本月", "上月"],
    );
    assert.equal(meta["万元"]!.factor, 0.0001);
    assert.equal(meta["同比"]!.display, "percent");
    assert.equal(meta["差值"]!.display, "number");
  });

  it("returns null with a Chinese note for a zero or empty base, never Infinity or NaN", () => {
    const result = run(material, {
      ...base,
      derive: [
        { as: "同比", op: "yoy", of: "本月", base: "去年同月" },
        { as: "环比", op: "mom", of: "本月", base: "上月" },
      ],
    });
    assert.equal(byCategory(result, "指标C")[col(result, "环比")], null);
    assert.equal(byCategory(result, "指标D")[col(result, "同比")], null);
    assert.equal(byCategory(result, "指标B")[col(result, "同比")], null);
    assert.ok(
      result.notes.some((note) => /上期为 0，无法计算环比/.test(note)),
      result.notes.join("|"),
    );
    assert.ok(result.notes.some((note) => /去年同期为空，无法计算同比/.test(note)));
    assert.ok(result.notes.some((note) => /本期为空/.test(note)));
    for (const row of result.rows) {
      for (const cell of row) {
        assert.ok(cell === null || typeof cell !== "number" || Number.isFinite(cell));
      }
    }
    assert.doesNotMatch(JSON.stringify(result.rows), /Infinity|NaN/);
  });

  it("reports an all-empty column sum as null instead of a misleading 0", () => {
    const result = run(material, {
      part: "sheet:经营指标",
      filter: [{ column: "类别", op: "=", value: "指标B" }],
      measures: [
        { op: "sum", column: "2026-09", as: "本月" },
        { op: "count", column: "2026-09", as: "有数" },
      ],
    });
    assert.deepEqual(result.rows, [[null, 0]]);
  });

  it("shares divide by the column total of ALL groups, before the limit", () => {
    const result = run(material, {
      part: "sheet:区域分布",
      groupBy: ["类别"],
      measures: [{ op: "sum", column: "2026-08", as: "上月" }],
      derive: [{ as: "占比", op: "share", of: "上月" }],
      sort: [{ by: "上月", dir: "desc" }],
      limit: 1,
    });
    const total = 790.12 + 655.5 + 380.45 + 500.25 + 390.8 + 250.3;
    const first = 790.12 + 500.25;
    assert.equal(result.rows.length, 1);
    assert.ok(Math.abs(Number(result.rows[0]![2]) - first / total) <= 1e-12);
  });

  it("shares of a zero total are null with a note", () => {
    const zeros = xlsxMaterial([
      {
        name: "表",
        header: ["类别", "值"],
        rows: [
          ["甲", 0],
          ["乙", 0],
        ],
      },
    ]);
    const result = run(zeros, {
      groupBy: ["类别"],
      measures: [{ op: "sum", column: "值", as: "合计" }],
      derive: [{ as: "占比", op: "share", of: "合计" }],
    });
    assert.deepEqual(
      result.rows.map((row) => row[2]),
      [null, null],
    );
    assert.ok(result.notes.some((note) => /合计为 0，无法计算占比/.test(note)));
  });

  it("rejects an ambiguous header with the candidate columns", () => {
    const dup = xlsxMaterial([
      {
        name: "表",
        header: ["金额", "地区", "金额"],
        rows: [
          [1, "甲", 2],
          [3, "乙", 4],
        ],
      },
    ]);
    refuses(dup, { measures: [{ op: "sum", column: "金额", as: "合计" }] }, /列名「金额」.*第 1、3 列/);
    const ok = run(dup, { groupBy: ["地区"], measures: [{ op: "count", as: "行数" }] });
    assert.deepEqual(ok.rows, [
      ["甲", 1],
      ["乙", 1],
    ]);
  });

  it("validates derive arguments in Chinese", () => {
    refuses(material, { ...base, derive: [{ as: "同比", op: "yoy", of: "本月" }] }, /derive\[0\].*需要 base/);
    refuses(material, { ...base, derive: [{ as: "万元", op: "unit", of: "本月" }] }, /derive\[0\].*需要 factor/);
    refuses(
      material,
      { ...base, derive: [{ as: "占比", op: "share", of: "本月", base: "上月" }] },
      /derive\[0\].*share.*不需要 base/,
    );
    refuses(
      material,
      { ...base, derive: [{ as: "占比", op: "share", of: "不存在" }] },
      /derive\[0\].of.*「不存在」.*可用：本月、上月、去年同月/,
    );
  });
});

describe("VAL-DATA-004: determinism and bound hashes", () => {
  const material = csvMaterial(500);
  const args = { groupBy: ["地区"], measures: [SUM], sort: [{ by: "合计", dir: "desc" }] };

  it("gives identical query and result hashes for the same query, whatever the key order", () => {
    const first = run(material, args);
    const second = run(material, {
      sort: [{ dir: "desc", by: "合计" }],
      measures: [{ as: "合计", column: "金额", op: "sum" }],
      groupBy: ["地区"],
    });
    assert.equal(first.querySha256, second.querySha256);
    assert.equal(first.resultSha256, second.resultSha256);
    assert.match(first.querySha256, /^[a-f0-9]{64}$/);
    assert.match(first.resultSha256, /^[a-f0-9]{64}$/);
  });

  it("binds the query hash to the material and the result hash to the rows", () => {
    const other = csvMaterial(500, { sha256: "f".repeat(64) });
    assert.notEqual(run(other, args).querySha256, run(material, args).querySha256);
    assert.equal(run(other, args).resultSha256, run(material, args).resultSha256);
    const narrower = run(material, { ...args, limit: 2 });
    assert.notEqual(narrower.resultSha256, run(material, args).resultSha256);
    assert.notEqual(narrower.querySha256, run(material, args).querySha256);
  });

  it("treats formula-looking column names as unknown columns and evaluates nothing", () => {
    const probe = globalThis as { __queryProbe?: number };
    probe.__queryProbe = 0;
    for (const column of ["金额*2", "process.exit()", "globalThis.__queryProbe = 1", "金额 + 1"]) {
      refuses(material, { measures: [{ op: "sum", column, as: "合计" }] }, /没有列「.+」.*可用列：序号、地区、金额/);
      refuses(material, { filter: [{ column, op: "=", value: 1 }], measures: [SUM] }, /没有列/);
      refuses(material, { groupBy: [column], measures: [SUM] }, /没有列/);
    }
    assert.equal(probe.__queryProbe, 0);
  });
});
