/**
 * Number conflicts (CAP-21, VAL-DATA-009, M7-SCR-005): a number a page keeps in a native table cell or
 * in a card whose caption is another text element is bound to its metric like a number written inside
 * one clause. Synthetic sources only, through the real chain: `read_material`, `write_page`, the
 * `page.number-conflicts` fact, `compose_deck` and `delivery-provenance.v1.json` `conflicts[]`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHINESE_SOURCES as CHINESE,
  assertConflictUsingA,
  assertNoConflict,
  stackedTexts as stacked,
  tableBox as table,
  textBox as text,
  runPage as run,
  type Bounds,
} from "./number-conflicts-testkit.js";

describe("VAL-DATA-009: a figure card whose caption is another text element", () => {
  it("keeps the conflict when both values sit in clauses of their own (control)", async (t) => {
    const outcome = await run(t, stacked(["Q3 Revenue 1502.25", "Q3 Cost 1500"]));
    assertConflictUsingA(outcome, { label: "Q3 Revenue" });
  });

  it("takes the caption above a lone value (control)", async (t) => {
    assertConflictUsingA(await run(t, stacked(["Q3 Revenue", "1502.25"])));
  });

  it("keeps the conflict, with the right winner, when the other value is the value of another card", async (t) => {
    const outcome = await run(t, stacked(["Q3 Revenue", "1502.25", "Q3 Cost", "1500"]));
    assertConflictUsingA(outcome);
  });

  it("claims no source when the other source's value is the only value, under another caption", async (t) => {
    assertNoConflict(await run(t, stacked(["Q3 Cost", "1500"])));
  });

  it("binds the same way for Chinese captions and units", async (t) => {
    const both = await run(t, stacked(["Q3 营收", "1502.25 万元", "Q3 成本", "1500 万元"]), CHINESE);
    assertConflictUsingA(both, { unit: "万", label: "Q3 营收" });
    assertNoConflict(await run(t, stacked(["Q3 成本", "1500 万元"]), CHINESE));
  });

  it("binds a caption and a value written as two paragraphs of one element", async (t) => {
    const card = (body: string) => [text("card", body, 100, { bounds: [80, 100, 800, 120] })];
    assertConflictUsingA(await run(t, card("Q3 Revenue\n1502.25\nQ3 Cost\n1500")));
    assertNoConflict(await run(t, card("Q3 Cost\n1500")));
  });
});

describe("VAL-DATA-009: a native table cell", () => {
  it("keeps the conflict when the other value is in the same table (control: one metric)", async (t) => {
    const rows = [
      ["Metric", "Q3"],
      ["Revenue", "1502.25"],
    ];
    assertConflictUsingA(await run(t, [table(rows, [400, 400])]), { label: "Q3 Revenue" });
  });

  it("keeps the conflict, with the right winner, when the other value is another row", async (t) => {
    const rows = [
      ["Metric", "Q3"],
      ["Revenue", "1502.25"],
      ["Cost", "1500"],
    ];
    assertConflictUsingA(await run(t, [table(rows, [400, 400])]));
  });

  it("claims no source when the other source's value is only in another row", async (t) => {
    const rows = [
      ["Metric", "Q3"],
      ["Cost", "1500"],
    ];
    assertNoConflict(await run(t, [table(rows, [400, 400])]));
  });

  it("binds a table written the way a source workbook is: periods down, metrics across", async (t) => {
    const rows = [
      ["季度", "营收(万元)", "成本(万元)"],
      ["Q3", "1502.25", "1500"],
    ];
    const costOnly = [
      ["季度", "成本(万元)"],
      ["Q3", "1500"],
    ];
    const both = await run(t, [table(rows, [300, 250, 250])], CHINESE);
    assertConflictUsingA(both, { unit: "万", label: "Q3 营收" });
    assertNoConflict(await run(t, [table(costOnly, [400, 400])], CHINESE));
  });

  it("holds a cell to the period of its column", async (t) => {
    // 1500 is Q2 revenue on this page; the conflict is about Q3, so only the Q3 cell takes a side.
    const rows = [
      ["Metric", "Q2", "Q3"],
      ["Revenue", "1500", "1502.25"],
    ];
    assertConflictUsingA(await run(t, [table(rows, [300, 250, 250])]));
  });

  it("binds a two-column table of metric and value", async (t) => {
    const rows = [
      ["Revenue Q3", "1502.25"],
      ["Cost Q3", "1500"],
    ];
    assertConflictUsingA(await run(t, [table(rows, [400, 400])]));
    assertNoConflict(await run(t, [table([["Cost Q3", "1500"]], [400, 400])]));
  });
});

describe("VAL-DATA-009: a chart's data cells", () => {
  const chart = (rows: readonly (readonly (string | number)[])[]) => ({
    elementId: "metrics-chart",
    elementType: "chart",
    bounds: [80, 100, 800, 300] as Bounds,
    data: { cols: ["季度", "营收", "成本"], rows },
    series: [
      { type: "bar", name: "营收", encode: { x: "季度", y: "营收" } },
      { type: "bar", name: "成本", encode: { x: "季度", y: "成本" } },
    ],
    title: "季度指标",
  });

  it("binds a value to its series and category", async (t) => {
    assertConflictUsingA(await run(t, [chart([["Q3", 1502.25, 1500]])], CHINESE), { unit: "万" });
    assertNoConflict(await run(t, [chart([["Q3", 1400, 1500]])], CHINESE));
  });
});

describe("VAL-DATA-009: a number with no label anywhere on the page", () => {
  it("still counts for the metric, as before", async (t) => {
    assertConflictUsingA(await run(t, [text("bare", "1502.25", 160)]));
  });

  it("still counts when the only caption is too far above to belong to the value", async (t) => {
    // The caption ends 274 slide pixels above a 36-pixel-high value: another part of the page.
    const outcome = await run(t, [text("caption", "Q3 Cost", 90), text("bare", "1500", 400)]);
    assert.equal(outcome.conflicts.length, 1);
    assert.deepEqual(outcome.conflicts[0]!.used, { source: "source-b.txt", value: "1500" });
  });
});
