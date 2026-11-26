/**
 * Number conflicts (CAP-21, VAL-DATA-009, M7-SCR-005): a number that borrows its metric from a label
 * (the caption of a split card, a table header) keeps the period its own text states. The sources
 * conflict on Q3 revenue only, so a page that states `Q2 1500` takes no side. Synthetic sources only,
 * through the real chain: `read_material`, `write_page`, the `page.number-conflicts` fact,
 * `compose_deck` and `delivery-provenance.v1.json` `conflicts[]`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHINESE_SOURCES,
  assertConflictUsingA,
  assertNoConflict,
  runPage,
  stackedTexts,
  tableBox,
  textBox,
  type Outcome,
} from "./number-conflicts-testkit.js";

/** The page takes the side of source B only: one conflict, B used. */
function assertConflictUsingB(outcome: Outcome): void {
  assert.deepEqual([outcome.hintLines, outcome.facts, outcome.conflicts.length], [1, 1, 1]);
  assert.deepEqual(outcome.conflicts[0]!.used, { source: "source-b.txt", value: "1500" });
}

describe("VAL-DATA-009: the caption of a split card gives the metric, the value its own period", () => {
  it("claims no Q3 source for a Q2 value under a caption that names no period", async (t) => {
    assertNoConflict(await runPage(t, stackedTexts(["Revenue", "Q2 1500"])));
  });

  it("claims none when the caption names the period instead (control)", async (t) => {
    assertNoConflict(await runPage(t, stackedTexts(["Q2 Revenue", "1500"])));
  });

  it("keeps the conflict, with the right winner, for a Q3 value under the same caption", async (t) => {
    assertConflictUsingA(await runPage(t, stackedTexts(["Revenue", "Q3 1502.25"])), {
      label: "Q3 Revenue",
    });
    assertConflictUsingB(await runPage(t, stackedTexts(["Revenue", "Q3 1500"])));
  });

  it("lets the value's own period win over the period of the caption", async (t) => {
    assertNoConflict(await runPage(t, stackedTexts(["Q3 Revenue", "Q2 1500"])));
    assertConflictUsingA(await runPage(t, stackedTexts(["Q2 Revenue", "Q3 1502.25"])));
  });

  it("still counts a value that has no period anywhere for the Q3 conflict", async (t) => {
    assertConflictUsingA(await runPage(t, stackedTexts(["Revenue", "1502.25"])));
    assertConflictUsingB(await runPage(t, stackedTexts(["Revenue", "1500"])));
  });

  it("binds the same way for Chinese captions and units", async (t) => {
    const chinese = (lines: readonly string[]) => runPage(t, stackedTexts(lines), CHINESE_SOURCES);
    assertNoConflict(await chinese(["营收", "Q2 1500 万元"]));
    assertConflictUsingA(await chinese(["营收", "Q3 1502.25 万元"]), { unit: "万" });
  });

  it("reads a caption and a value written as two paragraphs of one element", async (t) => {
    const card = (body: string) => [textBox("card", body, 100, { bounds: [80, 100, 800, 120] })];
    assertNoConflict(await runPage(t, card("Revenue\nQ2 1500")));
    assertConflictUsingA(await runPage(t, card("Revenue\nQ3 1502.25")));
  });
});

describe("VAL-DATA-009: a table header gives the metric, the cell its own period", () => {
  it("keeps the period of a cell under a column header that names the metric", async (t) => {
    const rows = (cell: string) => [
      ["Metric", "Revenue"],
      ["Actual", cell],
    ];
    assertNoConflict(await runPage(t, [tableBox(rows("Q2 1500"), [400, 400])]));
    assertConflictUsingA(await runPage(t, [tableBox(rows("Q3 1502.25"), [400, 400])]));
  });

  it("keeps the period of a cell beside a row header that names the metric", async (t) => {
    assertNoConflict(await runPage(t, [tableBox([["Revenue", "Q2 1500"]], [400, 400])]));
    assertConflictUsingA(await runPage(t, [tableBox([["Revenue", "Q3 1502.25"]], [400, 400])]));
  });

  it("lets the cell's own period win over the period of its column header", async (t) => {
    const rows = [
      ["Metric", "Q3"],
      ["Revenue", "Q2 1500"],
    ];
    assertNoConflict(await runPage(t, [tableBox(rows, [400, 400])]));
  });

  it("keeps the period of a Chinese cell under a period row header", async (t) => {
    const rows = (cell: string) => [
      ["季度", "营收(万元)"],
      ["Q3", cell],
    ];
    const chinese = (cell: string) => runPage(t, [tableBox(rows(cell), [400, 400])], CHINESE_SOURCES);
    assertNoConflict(await chinese("Q2 1500"));
    assertConflictUsingA(await chinese("Q3 1502.25"), { unit: "万" });
  });
});

describe("VAL-DATA-009: a number that states a period but finds no label", () => {
  // The caption is out of reach (the title sits 94 slide pixels above), so no metric is borrowed.
  it("still names its period, so it matches that period of any metric and no other", async (t) => {
    assertNoConflict(await runPage(t, [textBox("bare", "Q2 1500", 160)]));
    assertConflictUsingA(await runPage(t, [textBox("bare", "Q3 1502.25", 160)]));
  });
});
