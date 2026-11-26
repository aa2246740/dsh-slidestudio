import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MaterialPackError } from "./material-pack.js";
import { MATERIAL_QUERY_LIMITS, queryMaterialTable, type ExecutedQuery } from "./material-query.js";
import {
  csvQueryMaterial as csvMaterial,
  genericMonthlySheets as genericMonthly,
  xlsxQueryMaterial as xlsxMaterial,
} from "./material-query.testkit.js";
import type { QueryableMaterial } from "./material-table.js";

/** Integer cents parsed from the text itself: no floating-point accumulation in the oracle. */

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

describe("VAL-DATA-005: errors and caps are Chinese and leave no partial result", () => {
  const material = csvMaterial(300);

  it("refuses more than 200 rows, with or without a limit", () => {
    const wide = csvMaterial(300);
    refuses(wide, { groupBy: ["序号"], measures: [{ op: "count", as: "行数" }] }, /结果超过 200 行，请加筛选或分组/);
    refuses(wide, { groupBy: ["序号"], measures: [{ op: "count", as: "行数" }], limit: 201 }, /结果超过 200 行/);
    const exact = run(wide, {
      groupBy: ["序号"],
      measures: [{ op: "count", as: "行数" }],
      limit: 200,
    });
    assert.equal(exact.rows.length, 200);
    refuses(wide, { measures: [SUM], limit: 0 }, /limit 必须是 1–200 的整数/);
    refuses(wide, { measures: [SUM], limit: 2.5 }, /limit 必须是 1–200 的整数/);
  });

  it("names the allowed values for an unsupported op", () => {
    refuses(
      material,
      { filter: [{ column: "地区", op: "~", value: "华" }], measures: [SUM] },
      /filter\[0\]\.op「~」.*可用：=、!=、>、<、in、contains/,
    );
    refuses(
      material,
      { measures: [{ op: "median", column: "金额", as: "中位" }] },
      /measures\[0\]\.op「median」.*可用：sum、count、avg、min、max/,
    );
    refuses(
      material,
      { measures: [SUM], derive: [{ as: "x", op: "growth", of: "合计" }] },
      /derive\[0\]\.op「growth」.*可用：share、yoy、mom、ratio、diff、unit/,
    );
  });

  it("requires measures and well-formed arguments", () => {
    refuses(material, {}, /至少一个 measures/);
    refuses(material, { measures: [{ op: "sum", as: "合计" }] }, /measures\[0\].*sum.*需要 column/);
    refuses(material, { measures: [{ op: "sum", column: "金额" }] }, /measures\[0\].*需要 as/);
    refuses(material, { measures: [SUM, SUM] }, /结果列名「合计」重复/);
    refuses(material, { groupBy: ["地区"], measures: [{ op: "count", as: "地区" }] }, /结果列名「地区」重复/);
    refuses(material, { filter: "x", measures: [SUM] }, /filter 必须是数组/);
    refuses(
      material,
      { filter: [{ column: "地区", op: "in", value: "华东" }], measures: [SUM] },
      /filter\[0\].*in.*数组/,
    );
    refuses(material, { measures: [SUM], sort: [{ by: "不存在", dir: "asc" }] }, /sort\[0\]\.by「不存在」.*可用：合计/);
  });

  it("names the column when a numeric aggregate meets a non-numeric cell", () => {
    refuses(material, { measures: [{ op: "sum", column: "地区", as: "合计" }] }, /列「地区」.*不是数值.*第 1 行.*华东/);
    for (const op of ["avg", "min", "max"]) {
      refuses(material, { measures: [{ op, column: "地区", as: "x" }] }, /列「地区」.*不是数值/);
    }
    const counted = run(material, { measures: [{ op: "count", column: "地区", as: "有值" }] });
    assert.deepEqual(counted.rows, [[300]]);
  });

  it("only checks the rows a filter keeps", () => {
    const noisy = xlsxMaterial([
      {
        name: "表",
        header: ["类别", "值"],
        rows: [
          ["甲", 10],
          ["说明", "N/A"],
          ["乙", "1,234.50"],
        ],
      },
    ]);
    const filtered = run(noisy, {
      filter: [{ column: "类别", op: "!=", value: "说明" }],
      measures: [{ op: "sum", column: "值", as: "合计" }],
    });
    assert.deepEqual(filtered.rows, [[1244.5]]);
    refuses(noisy, { measures: [{ op: "sum", column: "值", as: "合计" }] }, /列「值」.*第 2 行.*N\/A/);
    const percent = xlsxMaterial([{ name: "表", header: ["类别", "值"], rows: [["甲", "12%"]] }]);
    refuses(percent, { measures: [{ op: "sum", column: "值", as: "合计" }] }, /列「值」.*不是数值/);
  });

  it("lists sheet names for an unknown or missing sheet, and the CSV part", () => {
    const book = xlsxMaterial(genericMonthly());
    refuses(
      book,
      { part: "sheet:没有的表", measures: [{ op: "count", as: "行数" }] },
      /没有名为「没有的表」的工作表.*sheet:经营指标、sheet:区域分布/,
    );
    refuses(book, { measures: [{ op: "count", as: "行数" }] }, /有多个工作表.*sheet:经营指标、sheet:区域分布/);
    const bare = run(book, { part: "区域分布", measures: [{ op: "count", as: "行数" }] });
    assert.deepEqual(bare.rows, [[6]]);
    assert.equal(bare.part, "sheet:区域分布");
    refuses(material, { part: "sheet:表", measures: [{ op: "count", as: "行数" }] }, /CSV.*rows/);
    assert.equal(run(material, { part: "rows", measures: [{ op: "count", as: "行数" }] }).part, "rows");
    const single = xlsxMaterial([genericMonthly()[0]!]);
    assert.equal(run(single, { measures: [{ op: "count", as: "行数" }] }).part, "sheet:经营指标");
  });

  it("lists the available columns when a column is unknown", () => {
    refuses(
      xlsxMaterial(genericMonthly()),
      { part: "sheet:经营指标", groupBy: ["月份"], measures: [{ op: "count", as: "行数" }] },
      /没有列「月份」.*可用列：类别、系列、2026-09、2026-08、2025-09/,
    );
  });

  it("refuses materials that are not tables, with the right Chinese reason", () => {
    const wrap = (kind: QueryableMaterial["kind"], derivative: Record<string, unknown> = {}) =>
      ({
        ...csvMaterial(3),
        kind,
        parser: kind === "deck-template" ? "pptx-ooxml-v2" : "pdf-unpdf-v1",
        derivative,
      }) satisfies QueryableMaterial;
    const args = { measures: [{ op: "count", as: "行数" }] };
    refuses(wrap("document", { document: { pageCount: 1 } }), args, /是文档.*不是表格.*read_material/);
    refuses(wrap("image"), args, /是图片.*不是表格/);
    refuses(wrap("text"), args, /是文本.*不是表格/);
    refuses(wrap("deck-template"), args, /PPT 模板.*不是表格.*tables.*charts/);
    refuses(
      wrap("deck-template", {
        "deck-template": { templateDetail: { tables: [{ rows: [["a"]] }] } },
      }),
      args,
      /PPT 模板.*不是表格.*tables.*charts/,
    );
  });

  it("stops above the scan cap and above the time cap (injected clock)", () => {
    assert.ok(Object.isFrozen(MATERIAL_QUERY_LIMITS));
    assert.deepEqual(MATERIAL_QUERY_LIMITS, {
      maxScanRows: 100_000,
      maxMillis: 3_000,
      maxResultRows: 200,
    });
    const six = csvMaterial(6);
    assert.throws(
      () => queryMaterialTable(six, { measures: [SUM] }, { limits: { maxScanRows: 5 } }),
      /共 6 行.*超过单次查询 5 行的上限/,
    );
    assert.equal(queryMaterialTable(six, { measures: [SUM] }, { limits: { maxScanRows: 6 } }).rows.length, 1);
    let tick = 0;
    assert.throws(
      () =>
        queryMaterialTable(
          csvMaterial(8_000),
          { measures: [SUM] },
          {
            now: () => (tick += 1_000),
          },
        ),
      /超过 3 秒.*加筛选/,
    );
    const over = xlsxMaterial([
      {
        name: "表",
        header: ["值"],
        rows: Array.from({ length: MATERIAL_QUERY_LIMITS.maxScanRows + 1 }, (_, i) => [i]),
      },
    ]);
    assert.throws(
      () => queryMaterialTable(over, { measures: [{ op: "count", as: "行数" }] }),
      /超过单次查询 100,000 行的上限/,
    );
  });

  it("handles an empty selection", () => {
    const none = run(material, {
      filter: [{ column: "地区", op: "=", value: "不存在" }],
      measures: [SUM, { op: "avg", column: "金额", as: "均值" }, { op: "count", as: "笔数" }],
    });
    assert.deepEqual(none.rows, [[null, null, 0]]);
    const grouped = run(material, {
      filter: [{ column: "地区", op: "=", value: "不存在" }],
      groupBy: ["地区"],
      measures: [SUM],
    });
    assert.deepEqual(grouped.rows, []);
  });

  it("matches numbers as numbers and text as trimmed text", () => {
    const mixed = xlsxMaterial([
      {
        name: "表",
        header: ["代码", "名称", "值"],
        rows: [
          ["001", " 甲 ", 5],
          ["002", "乙", 7],
          [null, "丙", 9],
        ],
      },
    ]);
    const count = (filter: unknown) =>
      run(mixed, { filter: [filter], measures: [{ op: "count", as: "行数" }] }).rows[0]![0];
    assert.equal(count({ column: "代码", op: "=", value: 1 }), 1);
    assert.equal(count({ column: "名称", op: "=", value: "甲" }), 1);
    assert.equal(count({ column: "名称", op: "contains", value: "乙" }), 1);
    assert.equal(count({ column: "值", op: ">", value: 6 }), 2);
    assert.equal(count({ column: "名称", op: "in", value: ["甲", "丙", "丁"] }), 2);
    assert.equal(count({ column: "代码", op: "=", value: "" }), 1);
    assert.equal(count({ column: "代码", op: "!=", value: "001" }), 2);
    const grouped = run(mixed, { groupBy: ["代码"], measures: [{ op: "count", as: "行数" }] });
    assert.deepEqual(grouped.rows, [
      ["001", 1],
      ["002", 1],
      [null, 1],
    ]);
  });
});
