/**
 * Number conflicts (CAP-21, VAL-DATA-009, M7-SCR-005): a year written with the period (`2026年Q3`,
 * `2026 Q3`, `FY2026`, `2026年第三季度`, `2026年`) and a month written without one (`3月`) are periods,
 * never metric words, on the page and in the sources. Two periods are compatible when they name the same
 * month or quarter and no different years. Synthetic sources only, through the real chain: `read_material`,
 * `write_page`, the `page.number-conflicts` fact, `compose_deck` and `delivery-provenance.v1.json`
 * `conflicts[]` (the card prints that array as it is). The sources disagree on one metric and period, so a
 * page that states 1500 and reports a source has taken the side of source B.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHINESE_SOURCES,
  ENGLISH_SOURCES,
  assertConflictUsingA,
  assertNoConflict,
  runPage,
  stackedTexts,
  tableBox,
  textBox,
  type Outcome,
  type Sources,
} from "./number-conflicts-testkit.js";

/** Two sources that state `label` as 1502.25 and 1500. */
const pair = (label: string, unit = " 万元"): Sources => [`${label} 1502.25${unit}`, `${label} 1500${unit}`];

/** The page takes the side of source B only: one conflict, B used, both sources listed. */
function assertConflictUsingB(outcome: Outcome, unit = "万"): void {
  assert.deepEqual([outcome.hintLines, outcome.facts, outcome.conflicts.length], [1, 1, 1]);
  const conflict = outcome.conflicts[0]!;
  assert.deepEqual(conflict.used, {
    source: "source-b.txt",
    value: "1500",
    ...(unit ? { unit } : {}),
  });
  assert.deepEqual(
    (conflict.values as { source: string }[]).map((entry) => entry.source),
    ["source-a.txt", "source-b.txt"],
  );
}

/** A table whose first row names the columns, 54 slide pixels per row. */
const grid = (rows: readonly (readonly string[])[]) => [tableBox(rows, [400, 400])];

describe("VAL-DATA-009: a year written with the quarter belongs to the period, not to the metric", () => {
  it("keeps a card value 「2026年Q3 …」 under a caption for the Q3 sources of that metric", async (t) => {
    const card = (value: string) => stackedTexts(["营收", value]);
    assertConflictUsingA(await runPage(t, card("2026年Q3 1502.25 万元"), CHINESE_SOURCES), {
      unit: "万",
    });
    assertConflictUsingB(await runPage(t, card("2026年Q3 1500 万元"), CHINESE_SOURCES));
    assertNoConflict(await runPage(t, card("2026年Q2 1500 万元"), CHINESE_SOURCES));
  });

  it("treats another year of the same quarter as another period", async (t) => {
    const sources = pair("2026年Q3营收");
    const card = (value: string) => stackedTexts(["营收", value]);
    assertConflictUsingA(await runPage(t, card("2026年Q3 1502.25 万元"), sources), { unit: "万" });
    assertNoConflict(await runPage(t, card("2025年Q3 1502.25 万元"), sources));
    assertNoConflict(await runPage(t, card("2025年Q3 1500 万元"), sources));
  });

  it("reads 2026Q3, 2026年第三季度 and 第三季度 as the same quarter as Q3", async (t) => {
    const forms: readonly (readonly [string, string])[] = [
      ["2026Q3营收", "2026Q3"],
      ["2026年第三季度营收", "2026年第三季度"],
      ["第三季度营收", "第三季度"],
    ];
    for (const [label, written] of forms) {
      const own = await runPage(t, stackedTexts(["营收", `${written} 1502.25 万元`]), pair(label));
      assertConflictUsingA(own, { unit: "万" });
      const q3 = await runPage(t, stackedTexts(["营收", `${written} 1502.25 万元`]), CHINESE_SOURCES);
      assertConflictUsingA(q3, { unit: "万" });
    }
    const other = pair("2026年第三季度营收");
    assertNoConflict(await runPage(t, stackedTexts(["营收", "2026年第二季度 1500 万元"]), other));
  });

  it("reads the English forms 2026 Q3 and FY2026 Q3 as Q3 of 2026", async (t) => {
    const card = (value: string) => stackedTexts(["Revenue", value]);
    assertConflictUsingA(await runPage(t, card("2026 Q3 1502.25"), ENGLISH_SOURCES));
    assertConflictUsingA(await runPage(t, card("FY2026 Q3 1502.25"), ENGLISH_SOURCES));
    assertNoConflict(await runPage(t, card("2026 Q2 1500"), ENGLISH_SOURCES));
    const dated = pair("FY2026 Q3 revenue", "");
    assertConflictUsingA(await runPage(t, card("2026 Q3 1502.25"), dated));
    assertNoConflict(await runPage(t, card("2025 Q3 1502.25"), dated));
  });

  it("reads a table column header 「2026 Q3」 as the quarter of the cell under it", async (t) => {
    const rows = (header: string) => [
      ["Metric", header],
      ["Revenue", "1502.25"],
    ];
    assertConflictUsingA(await runPage(t, grid(rows("2026 Q3")), ENGLISH_SOURCES));
    assertNoConflict(await runPage(t, grid(rows("2026 Q2")), ENGLISH_SOURCES));
    assertConflictUsingA(await runPage(t, grid(rows("2026 Q3")), pair("2026 Q3 revenue", "")));
    assertNoConflict(await runPage(t, grid(rows("2025 Q3")), pair("2026 Q3 revenue", "")));
  });
});

describe("VAL-DATA-009: a year written alone is the annual period", () => {
  const annual = pair("2026年营收");

  it("matches the annual sources of the metric and no other year", async (t) => {
    const card = (value: string) => stackedTexts(["营收", value]);
    assertConflictUsingA(await runPage(t, card("2026年 1502.25 万元"), annual), { unit: "万" });
    assertConflictUsingB(await runPage(t, card("2026年 1500 万元"), annual));
    assertNoConflict(await runPage(t, card("2025年 1500 万元"), annual));
    assertConflictUsingA(await runPage(t, card("FY2026 1502.25 万元"), annual), { unit: "万" });
  });

  it("is not a month or a quarter of that year, in either direction", async (t) => {
    const card = (value: string) => stackedTexts(["营收", value]);
    assertNoConflict(await runPage(t, card("2026年 1500 万元"), pair("2026年3月营收")));
    assertNoConflict(await runPage(t, card("2026年 1500 万元"), CHINESE_SOURCES));
    assertNoConflict(await runPage(t, [textBox("annual", "2026年营收 1500万元", 100)], CHINESE_SOURCES));
    assertNoConflict(await runPage(t, card("2026年3月 1500 万元"), annual));
  });
});

describe("VAL-DATA-009: a figure card value 「2026年3月 …」 names no metric of its own", () => {
  const card = (value: string) => stackedTexts(["营收", value]);

  it("claims no source for a metric the card did not state", async (t) => {
    assertNoConflict(await runPage(t, card("2026年3月 1500万元"), pair("2026年3月成本")));
  });

  it("takes the caption's metric, so a conflict on that metric and month is reported", async (t) => {
    const sources = pair("2026年3月营收");
    assertConflictUsingB(await runPage(t, card("2026年3月 1500万元"), sources));
    assertConflictUsingA(await runPage(t, card("2026年3月 1502.25万元"), sources), { unit: "万" });
    assertNoConflict(await runPage(t, card("2026年2月 1500万元"), sources));
  });
});

describe("VAL-DATA-009: a month written without its year is that month of any year", () => {
  const card = (value: string) => stackedTexts(["营收", value]);
  const rows = (header: string) => [
    ["指标", header],
    ["营收", "1500万元"],
  ];

  it("lets a card value 「3月 …」 take the side of the sources of March, with or without a year", async (t) => {
    assertConflictUsingB(await runPage(t, card("3月 1500万元"), pair("3月营收")));
    assertConflictUsingB(await runPage(t, card("3月 1500万元"), pair("2026年3月营收")));
    assertNoConflict(await runPage(t, card("2月 1500万元"), pair("2026年3月营收")));
  });

  it("lets a table column header 「3月」 over a row 「营收」 do the same", async (t) => {
    assertConflictUsingB(await runPage(t, grid(rows("3月")), pair("3月营收")));
    assertConflictUsingB(await runPage(t, grid(rows("3月")), pair("2026年3月营收")));
    assertNoConflict(await runPage(t, grid(rows("2月")), pair("2026年3月营收")));
  });

  it("does not let a page about February take the side of the sources of March", async (t) => {
    const march = pair("3月营收");
    assertNoConflict(await runPage(t, [textBox("inline", "2026年2月营收 1500万元", 100)], march));
    assertNoConflict(await runPage(t, grid(rows("2026年2月")), march));
    assertNoConflict(await runPage(t, [textBox("inline", "2月营收1500万元", 100)], pair("2026年3月营收")));
  });

  it("does not let a page about another year take the side of sources of that month and year", async (t) => {
    const sources = pair("2026年3月营收");
    assertNoConflict(await runPage(t, [textBox("inline", "2025年3月营收 1500万元", 100)], sources));
    assertConflictUsingB(await runPage(t, [textBox("inline", "2026年3月营收 1500万元", 100)], sources));
  });
});

describe("VAL-DATA-009: sources group by month whether or not they write the year", () => {
  const inline = (text: string) => [textBox("inline", text, 100)];

  it("puts 「3月营收」 and 「2026年3月营收」 of two materials into one conflict", async (t) => {
    const mixed: Sources = ["3月营收 1502.25 万元", "2026年3月营收 1500 万元"];
    assertConflictUsingB(await runPage(t, inline("2026年3月营收 1500万元"), mixed));
    assertConflictUsingA(await runPage(t, inline("3月营收 1502.25 万元"), mixed), { unit: "万" });
    const reversed: Sources = ["2026年3月营收 1502.25 万元", "3月营收 1500 万元"];
    assertConflictUsingA(await runPage(t, inline("2026年3月营收 1502.25万元"), reversed), {
      unit: "万",
    });
  });

  it("never puts March and February, or two different years of one month, into one conflict", async (t) => {
    const months: Sources = ["3月营收 1502.25 万元", "2月营收 1500 万元"];
    assertNoConflict(await runPage(t, inline("3月营收 1500万元"), months));
    assertNoConflict(await runPage(t, inline("2月营收 1500万元"), months));
    const years: Sources = ["2026年3月营收 1502.25 万元", "2025年3月营收 1500 万元"];
    assertNoConflict(await runPage(t, inline("2025年3月营收 1500万元"), years));
    assertNoConflict(await runPage(t, inline("2026年3月营收 1500万元"), years));
  });

  it("names the year of the source a page takes, not the year of a source it contradicts", async (t) => {
    const bareAndDated: Sources = ["3月营收 1502.25 万元", "2025年3月营收 1500 万元"];
    assertConflictUsingB(await runPage(t, inline("2025年3月营收 1500万元"), bareAndDated));
    assertNoConflict(await runPage(t, inline("2026年3月营收 1500万元"), bareAndDated));
  });
});

describe("VAL-DATA-009: forms that were already right stay right (guards on ee645ec)", () => {
  const sources = pair("2026年3月营收");

  it("binds a full year-month written inline, in a caption, in a column or in a row", async (t) => {
    assertConflictUsingB(await runPage(t, [textBox("a", "2026年3月营收1500万元", 100)], sources));
    assertConflictUsingB(await runPage(t, stackedTexts(["2026年3月营收", "1500万元"]), sources));
    assertConflictUsingB(
      await runPage(
        t,
        grid([
          ["指标", "2026年3月"],
          ["营收", "1500万元"],
        ]),
        sources,
      ),
    );
    assertConflictUsingB(
      await runPage(
        t,
        grid([
          ["月份", "营收（万元）"],
          ["2026年3月", "1500"],
        ]),
        sources,
      ),
    );
  });

  it("keeps another month of the same year, and the month written without a year, apart or together as before", async (t) => {
    assertNoConflict(await runPage(t, [textBox("a", "2026年2月营收1500万元", 100)], sources));
    assertNoConflict(await runPage(t, stackedTexts(["2026年2月营收", "1500万元"]), sources));
    assertNoConflict(
      await runPage(
        t,
        grid([
          ["指标", "2月"],
          ["营收", "1500万元"],
        ]),
        sources,
      ),
    );
    assertConflictUsingB(await runPage(t, [textBox("a", "2026年3月营收 1500万元", 100)], pair("3月营收")));
    assertConflictUsingB(await runPage(t, [textBox("a", "3月营收1500万元", 100)], sources));
  });
});
