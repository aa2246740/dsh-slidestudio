/**
 * Number conflicts (CAP-21, VAL-DATA-009, M7-SCR-009): a conflict belongs to one period. Two sources that
 * both state a quarter for two years form one conflict per year, never one conflict that mixes the years,
 * so a year-over-year page that takes a side in each is reported twice and a single-year page names its own
 * year. Synthetic sources only, through the real chain: `read_material`, `write_page`, the
 * `page.number-conflicts` fact, `compose_deck` and `delivery-provenance.v1.json` `conflicts[]`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conflictLines, type DeliveryConflict } from "./delivery-conflicts.js";
import { runPage, stackedTexts, tableBox, textBox, type Outcome, type Sources } from "./number-conflicts-testkit.js";

type Reported = {
  label: string;
  values: { source: string; value: string }[];
  used: { source: string; value: string };
  pages: number[];
};

/** What the user is told about each conflict: its label, the source it used and the values it lists. */
const row = (label: string, used: string, values: readonly string[]) => `${label} | ${used} | ${values.join(", ")}`;

const reported = (outcome: Outcome): string[] =>
  (outcome.conflicts as unknown as Reported[]).map((conflict) =>
    row(
      conflict.label,
      `${conflict.used.source} ${conflict.used.value}`,
      conflict.values.map((entry) => `${entry.source} ${entry.value}`),
    ),
  );

/** The hint, the fact (one per page), the delivery entries and the card lines all report `expected`. */
function assertReports(outcome: Outcome, expected: readonly string[]): void {
  assert.deepEqual(reported(outcome), expected, "delivery conflicts[]");
  assert.equal(outcome.hintLines, expected.length, "write hint lines");
  assert.equal(outcome.facts, expected.length ? 1 : 0, "page.number-conflicts facts");
  const card = conflictLines(outcome.conflicts as unknown as readonly DeliveryConflict[]).filter((line) =>
    line.startsWith("数字不一致："),
  );
  assert.equal(card.length, expected.length, "card lines");
  for (const conflict of outcome.conflicts as unknown as Reported[]) {
    assert.deepEqual(conflict.pages, [1], "one page, listed once");
  }
}

const A25 = "source-a.txt 1502.25";
const B25 = "source-b.txt 1500";
const A26 = "source-a.txt 1602.4";
const B26 = "source-b.txt 1600";
const prior = (metric: string, used: string) => row(`2025年Q3${metric}`, used, [A25, B25]);
const current = (metric: string, used: string) => row(`2026年Q3${metric}`, used, [A26, B26]);

/** Both sources state the quarter for two years; each year differs by 0.15 % and 0.0625 % apart from the other source. */
const ENGLISH_YEARS: Sources = [
  "2025年Q3 Revenue 1502.25\n2026年Q3 Revenue 1602.4",
  "2025年Q3 Revenue 1500\n2026年Q3 Revenue 1600",
];
const CHINESE_YEARS: Sources = [
  "2025年Q3营收 1502.25万元\n2026年Q3营收 1602.4万元",
  "2025年Q3营收 1500万元\n2026年Q3营收 1600万元",
];
const EN = " Revenue";
const CN = "营收";

const inline = (text: string) => [textBox("inline", text, 100)];
const grid = (rows: readonly (readonly string[])[], widths: readonly number[] = [300, 250, 250]) => [
  tableBox(rows, widths),
];

describe("VAL-DATA-009: the independent-years probe (M7-SCR-009)", () => {
  it("reports the prior year of two two-year sources under its own year only", async (t) => {
    const outcome = await runPage(t, inline("2025年Q3 Revenue 1502.25"), ENGLISH_YEARS);
    assertReports(outcome, [prior(EN, A25)]);
  });

  it("reports the current year under its own year only, not under the prior year's label", async (t) => {
    const outcome = await runPage(t, inline("2026年Q3 Revenue 1602.4"), ENGLISH_YEARS);
    assertReports(outcome, [current(EN, A26)]);
  });

  it("reports both years, each with its own pair of values, when the page takes source A's side in both", async (t) => {
    const outcome = await runPage(
      t,
      [textBox("prior", "2025年Q3 Revenue 1502.25", 100), textBox("current", "2026年Q3 Revenue 1602.4", 160)],
      ENGLISH_YEARS,
    );
    assertReports(outcome, [prior(EN, A25), current(EN, A26)]);
  });
});

describe("VAL-DATA-009: a year-over-year page reports the conflict of each year", () => {
  it("reads a table with one column per year", async (t) => {
    const rows = (prior25: string, current26: string) => [
      ["指标", "2025年Q3", "2026年Q3"],
      ["营收", prior25, current26],
    ];
    assertReports(await runPage(t, grid(rows("1502.25", "1602.4")), CHINESE_YEARS), [prior(CN, A25), current(CN, A26)]);
    assertReports(await runPage(t, grid(rows("1500", "1600")), CHINESE_YEARS), [prior(CN, B25), current(CN, B26)]);
    assertReports(await runPage(t, grid(rows("1502.25", "1600")), CHINESE_YEARS), [prior(CN, A25), current(CN, B26)]);
  });

  it("reads one figure card per year, each under the caption 「营收」", async (t) => {
    const cards = (first: string, second: string) =>
      stackedTexts(["营收", `2025年Q3 ${first}万元`, "营收", `2026年Q3 ${second}万元`]);
    assertReports(await runPage(t, cards("1502.25", "1602.4"), CHINESE_YEARS), [prior(CN, A25), current(CN, A26)]);
    assertReports(await runPage(t, cards("1500", "1602.4"), CHINESE_YEARS), [prior(CN, B25), current(CN, A26)]);
  });

  it("reads one sentence that states both years", async (t) => {
    assertReports(await runPage(t, inline("2025年Q3营收 1502.25万元；2026年Q3营收 1602.4万元"), CHINESE_YEARS), [
      prior(CN, A25),
      current(CN, A26),
    ]);
    assertReports(await runPage(t, inline("2025年Q3营收 1500万元，2026年Q3营收 1600万元"), CHINESE_YEARS), [
      prior(CN, B25),
      current(CN, B26),
    ]);
    assertReports(await runPage(t, inline("2025年Q3 Revenue 1500; 2026年Q3 Revenue 1602.4"), ENGLISH_YEARS), [
      prior(EN, B25),
      current(EN, A26),
    ]);
  });

  it("names the year the page states and no other, in a table with one column", async (t) => {
    const column = (header: string, value: string) =>
      grid(
        [
          ["指标", header],
          ["营收", value],
        ],
        [400, 400],
      );
    assertReports(await runPage(t, column("2026年Q3", "1602.4"), CHINESE_YEARS), [current(CN, A26)]);
    assertReports(await runPage(t, column("2025年Q3", "1500"), CHINESE_YEARS), [prior(CN, B25)]);
    assertReports(await runPage(t, column("2024年Q3", "1500"), CHINESE_YEARS), []);
  });
});

describe("VAL-DATA-009: a page that shows both sides of one period's conflict has disclosed it", () => {
  it("stays silent about the period whose two values are on the page", async (t) => {
    assertReports(
      await runPage(t, inline("2026年Q3 Revenue 1602.4 (source A), 2026年Q3 Revenue 1600 (source B)"), ENGLISH_YEARS),
      [],
    );
  });

  it("still reports the other year's conflict on the same page", async (t) => {
    const outcome = await runPage(
      t,
      [
        textBox("both", "2026年Q3营收 1602.4万元，2026年Q3营收 1600万元", 100),
        textBox("one", "2025年Q3营收 1502.25万元", 160),
      ],
      CHINESE_YEARS,
    );
    assertReports(outcome, [prior(CN, A25)]);
  });

  it("is not satisfied by one year's value and the other year's value", async (t) => {
    // 1502.25 is source A's 2025 value and 1600 is source B's 2026 value: neither year shows both sides.
    assertReports(await runPage(t, inline("2025年Q3营收 1502.25万元；2026年Q3营收 1600万元"), CHINESE_YEARS), [
      prior(CN, A25),
      current(CN, B26),
    ]);
  });
});

describe("VAL-DATA-009: a source that writes no year joins the conflict of every year it conflicts in", () => {
  /** Source A states the quarter without a year; source B states it for two years, 0.15 % and 0.5 % away. */
  const WITHOUT_YEAR: Sources = ["Q3营收 1502.25万元", "2025年Q3营收 1500万元\n2026年Q3营收 1510万元"];
  const WITH_2025 = row("2025年Q3营收", "source-a.txt 1502.25", ["source-a.txt 1502.25", B25]);
  const WITH_2026 = row("2026年Q3营收", "source-a.txt 1502.25", ["source-a.txt 1502.25", "source-b.txt 1510"]);

  it("forms one conflict with the same-quarter member that has a year", async (t) => {
    const mixed: Sources = ["Q3营收 1502.25万元", "2026年Q3营收 1500万元"];
    const outcome = await runPage(t, inline("2026年Q3营收 1500万元"), mixed);
    assertReports(outcome, [row("Q3营收", "source-b.txt 1500", ["source-a.txt 1502.25", "source-b.txt 1500"])]);
    const months: Sources = ["3月营收 1502.25万元", "2026年3月营收 1500万元"];
    assertReports(await runPage(t, inline("3月营收 1502.25万元"), months), [
      row("3月营收", "source-a.txt 1502.25", ["source-a.txt 1502.25", "source-b.txt 1500"]),
    ]);
  });

  it("lets the page's year choose the year's conflict", async (t) => {
    assertReports(await runPage(t, inline("2025年Q3营收 1500万元"), WITHOUT_YEAR), [
      row("2025年Q3营收", "source-b.txt 1500", ["source-a.txt 1502.25", B25]),
    ]);
    assertReports(await runPage(t, inline("2026年Q3营收 1510万元"), WITHOUT_YEAR), [
      row("2026年Q3营收", "source-b.txt 1510", ["source-a.txt 1502.25", "source-b.txt 1510"]),
    ]);
    assertReports(await runPage(t, inline("2025年Q3营收 1502.25万元"), WITHOUT_YEAR), [WITH_2025]);
    assertReports(await runPage(t, inline("2026年Q3营收 1502.25万元"), WITHOUT_YEAR), [WITH_2026]);
    assertReports(await runPage(t, inline("2024年Q3营收 1502.25万元"), WITHOUT_YEAR), []);
  });

  it("reports each year once for a number that names no year", async (t) => {
    assertReports(await runPage(t, inline("Q3营收 1502.25万元"), WITHOUT_YEAR), [WITH_2025, WITH_2026]);
  });

  it("does not put a year-less source into the conflict of a year it does not conflict in", async (t) => {
    // Source C writes no year and is 0.5 % from the 2026 values and 7 % from the 2025 ones.
    const three: readonly string[] = [...CHINESE_YEARS, "Q3营收 1610万元"];
    assertReports(await runPage(t, inline("Q3营收 1610万元"), three), [
      row("2026年Q3营收", "source-c.txt 1610", [A26, B26, "source-c.txt 1610"]),
    ]);
  });

  it("keeps one conflict when two year-less sources and a dated one agree on the period", async (t) => {
    const three: readonly string[] = ["Q3营收 1502.25万元", "Q3营收 1500万元", "2026年Q3营收 1500万元"];
    const outcome = await runPage(t, inline("Q3营收 1500万元"), three);
    assert.equal(outcome.conflicts.length, 1);
    assert.equal(outcome.hintLines, 1);
    assert.deepEqual(
      (outcome.conflicts[0] as unknown as Reported).values.map((entry) => entry.source),
      ["source-a.txt", "source-b.txt", "source-c.txt"],
    );
  });
});

describe("VAL-DATA-009: a year that no source states is not a period of the conflict", () => {
  it("takes no side for a page about the year in between or after", async (t) => {
    assertReports(await runPage(t, inline("2027年Q3营收 1502.25万元"), CHINESE_YEARS), []);
    assertReports(await runPage(t, inline("2025年Q2营收 1502.25万元"), CHINESE_YEARS), []);
  });
});

/**
 * The 39-case triage matrix of the year/month fix (1a04252), rebuilt from the independent review: one
 * page, one conflict between source A (1502.25) and source B (1500), and the page states 1500 where it
 * takes a side. Guards on 1a04252: these pass before and after the split into candidates.
 */
describe("VAL-DATA-009: the 39-case triage matrix keeps its expected column", () => {
  const pair = (label: string, unit = "万元"): Sources => [`${label} 1502.25${unit}`, `${label} 1500${unit}`];
  const card = (caption: string, value: string) => stackedTexts([caption, value]);
  const table = (column: string, rowName: string, value = "1500万元") => [
    tableBox(
      [
        ["指标", column],
        [rowName, value],
      ],
      [400, 400],
    ),
  ];
  const annual = pair("2026年营收");
  const march = pair("2026年3月营收");
  const bareMarch = pair("3月营收");
  const quarter = pair("Q3 营收");
  const english = pair("Q3 Revenue", "");
  const fiscal = pair("FY2026 Q3 revenue", "");
  const cases: readonly (readonly [string, readonly Record<string, unknown>[], Sources, number])[] = [
    ["1", inline("2026年3月营收1500万元"), march, 1],
    ["1n", inline("2026年2月营收1500万元"), march, 0],
    ["1x", inline("2026年3月营收1500万元"), pair("2026年3月成本"), 0],
    ["2", card("营收", "2026年3月 1500万元"), march, 1],
    ["2n", card("营收", "2026年3月 1500万元"), pair("2026年2月营收"), 0],
    ["2x", card("营收", "2026年3月 1500万元"), pair("2026年3月成本"), 0],
    ["2y", card("营收", "2026年Q3 1500万元"), pair("2026年Q3营收"), 1],
    ["2y'", card("营收", "2026年Q3 1500万元"), quarter, 1],
    ["2yn", card("营收", "2026年Q2 1500万元"), quarter, 0],
    ["2c", card("营收", "2026年第三季度 1500万元"), pair("2026年第三季度营收"), 1],
    ["2q", card("营收", "2026Q3 1500万元"), pair("2026Q3营收"), 1],
    ["2m", card("营收", "3月 1500万元"), bareMarch, 1],
    ["2m'", card("营收", "3月 1500万元"), march, 1],
    ["2Y", card("营收", "2026年 1500万元"), march, 0],
    ["2Ya", card("营收", "2026年 1500万元"), annual, 1],
    ["3", card("2026年3月营收", "1500万元"), march, 1],
    ["3n", card("2026年2月营收", "1500万元"), march, 0],
    ["4", table("2026年3月", "营收"), march, 1],
    ["4n", table("2026年2月", "营收"), march, 0],
    ["5", table("营收（万元）", "2026年3月", "1500"), march, 1],
    ["5n", table("营收（万元）", "2026年2月", "1500"), march, 0],
    ["6a", inline("2026年3月营收1500万元"), bareMarch, 1],
    ["6an", inline("2026年2月营收1500万元"), bareMarch, 0],
    ["6b", table("2026年3月", "营收"), bareMarch, 1],
    ["6bn", table("2026年2月", "营收"), bareMarch, 0],
    ["6c", inline("3月营收1500万元"), march, 1],
    ["6cn", inline("2月营收1500万元"), march, 0],
    ["6d", table("3月", "营收"), march, 1],
    ["6dn", table("2月", "营收"), march, 0],
    ["6e", table("3月", "营收"), bareMarch, 1],
    ["7a", inline("FY2026 Q3 revenue 1500"), fiscal, 1],
    ["7a'", inline("FY2026 Q3 revenue 1500"), english, 1],
    ["7an", inline("FY2025 Q3 revenue 1500"), fiscal, 0],
    ["7b", card("Revenue", "2026 Q3 1500"), english, 1],
    ["7b'", card("Revenue", "2026 Q3 1500"), fiscal, 1],
    ["7bn", card("Revenue", "2026 Q2 1500"), english, 0],
    ["7c", table("2026 Q3", "Revenue", "1500"), english, 1],
    ["7c'", table("2026 Q3", "Revenue", "1500"), pair("2026 Q3 revenue", ""), 1],
    ["7cn", table("2026 Q2", "Revenue", "1500"), english, 0],
  ];

  it("has 39 cases", () => assert.equal(cases.length, 39));

  for (const [id, elements, sources, expected] of cases) {
    it(`case ${id}: ${expected} conflict${expected === 1 ? ", source B used" : "s"}`, async (t) => {
      const outcome = await runPage(t, elements, sources);
      assert.deepEqual([outcome.hintLines, outcome.facts, outcome.conflicts.length], [expected, expected, expected]);
      for (const conflict of outcome.conflicts as unknown as Reported[]) {
        assert.deepEqual(conflict.used.source, "source-b.txt");
        assert.equal(conflict.used.value, "1500");
      }
    });
  }
});
