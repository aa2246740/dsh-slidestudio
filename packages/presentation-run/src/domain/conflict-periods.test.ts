import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compatibleGroups,
  periodPart,
  periodYear,
  periodsCompatible,
  sharedPeriods,
  splitPeriods,
} from "./conflict-periods.js";
import { extractPeriodLabels } from "./material-periods.js";

const periodsOf = (label: string) => splitPeriods(label).periods;
const restOf = (label: string) => splitPeriods(label).rest.replace(/\s+/g, "");

describe("VAL-DATA-009: the periods a label names", () => {
  it("reads every supported form as a period and takes its words out of the metric", () => {
    const forms: readonly (readonly [string, string])[] = [
      ["2026年3月", "2026年3月"],
      ["2026年3月末", "2026年3月末"],
      ["2026年1-2月", "2026年1-2月"],
      ["2026年上半年", "2026年上半年"],
      ["26年3月", "26年3月"],
      ["Q3", "Q3"],
      ["2026年Q3", "2026年Q3"],
      ["2026Q3", "2026年Q3"],
      ["2026 Q3", "2026年Q3"],
      ["FY2026 Q3", "2026年Q3"],
      ["2026年第三季度", "2026年Q3"],
      ["2026年 第3季度", "2026年Q3"],
      ["第三季度", "Q3"],
      ["第4季度", "Q4"],
      ["FY2026", "2026年"],
      ["2026年", "2026年"],
      ["3月", "3月"],
      ["3月末", "3月末"],
      ["03月", "3月"],
    ];
    for (const [form, token] of forms) {
      assert.deepEqual(periodsOf(`营收 ${form}`), [token], form);
      assert.equal(restOf(`营收 ${form}`), "营收", form);
      assert.deepEqual(periodsOf(`${form}营收`), [token], form);
    }
  });

  it("joins a year written apart from the quarter or month it belongs to", () => {
    assert.deepEqual(periodsOf("2026年 3月 营收"), ["2026年3月"]);
    assert.deepEqual(periodsOf("Q3 FY2026 营收"), ["2026年Q3"]);
    assert.deepEqual(periodsOf("Revenue 2026年 Q3"), ["2026年Q3"]);
    assert.deepEqual(periodsOf("营收 3月 2026年"), ["2026年3月"]);
    assert.deepEqual(periodsOf("2026年 和 2025年 与 Q3"), ["2025年", "2026年", "Q3"], "two years: no guess");
    assert.deepEqual(periodsOf("FY2026 与 2026年 与 Q3"), ["2026年Q3"], "the same year twice");
  });

  it("takes a label whose rest is only a year for a label with no metric", () => {
    assert.deepEqual(splitPeriods("Q3 2026"), { rest: "", periods: ["2026年Q3"] });
    assert.deepEqual(splitPeriods("2026"), { rest: "", periods: [] });
    assert.equal(restOf("营收 2026"), "营收2026", "a year after a metric word stays a metric word");
  });

  it("sorts the periods and counts each once", () => {
    assert.deepEqual(periodsOf("Q3 Q2 Q3"), ["Q2", "Q3"]);
    assert.deepEqual(periodsOf("3月 2026年Q3"), ["2026年Q3", "3月"]);
  });

  it("leaves relative periods, weeks, days and bare ranges as the words they were", () => {
    for (const label of [
      "本月 营收",
      "上月 营收",
      "去年同期 营收",
      "同比 营收",
      "环比 营收",
      "累计 营收",
      "YTD revenue",
      "第3周 营收",
      "9月30日 营收",
      "9月30号 营收",
      "1-3月 营收",
      "第3月 营收",
      "13月 营收",
      "三季度 营收",
    ]) {
      assert.deepEqual(periodsOf(label), [], label);
      assert.equal(splitPeriods(label).rest, label, label);
    }
  });

  it("returns the same periods as extractPeriodLabels for every form it already read", () => {
    for (const text of [
      "2026年1-2月",
      "截至2026年2月末",
      "26年2月数据",
      "2026年上半年",
      "2026年下半年",
      "Q1 至 Q4",
      "2026年9月",
      "2026年1-2月与26年3月",
      "营收 Q3 成本 Q2",
      "没有期间的指标",
    ]) {
      assert.deepEqual(periodsOf(text), [...extractPeriodLabels(text)].sort(), text);
    }
  });
});

describe("VAL-DATA-009: two periods are compatible when they name the same time", () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ["3月", "2026年3月", true],
    ["3月", "2026年2月", false],
    ["2月", "2026年3月", false],
    ["3月", "3月", true],
    ["3月", "3月末", false],
    ["Q3", "2026年Q3", true],
    ["2026年Q3", "Q3", true],
    ["2026年Q3", "2025年Q3", false],
    ["2026年Q3", "2026年Q2", false],
    ["Q3", "3月", false],
    ["2026年", "2026年", true],
    ["2026年", "2025年", false],
    ["2026年", "2026年3月", false],
    ["2026年", "2026年Q3", false],
    ["2026年", "Q3", false],
    ["2026年", "3月", false],
    ["2026年3月", "2026年3月", true],
    ["2026年3月", "2025年3月", false],
    ["2026年上半年", "上半年", true],
    ["2026年1-2月", "2026年2月", false],
    ["26年3月", "26年3月", true],
    ["26年3月", "2026年3月", false],
  ];

  it("compares the month or quarter, then the years when both name one", () => {
    for (const [left, right, expected] of cases) {
      assert.equal(periodsCompatible([left], [right]), expected, `${left} ~ ${right}`);
      assert.equal(periodsCompatible([right], [left]), expected, `${right} ~ ${left}`);
    }
  });

  it("treats a label with no period as compatible with every period", () => {
    for (const other of ["3月", "2026年", "2026年Q3", "Q3"]) {
      assert.equal(periodsCompatible([], [other]), true, other);
      assert.equal(periodsCompatible([other], []), true, other);
    }
    assert.equal(periodsCompatible([], []), true);
  });

  it("asks the label with fewer periods to find a partner for each of its periods", () => {
    assert.equal(periodsCompatible(["Q3"], ["Q3", "Q4"]), true);
    assert.equal(periodsCompatible(["2026年Q3"], ["Q3", "Q4"]), true);
    assert.equal(periodsCompatible(["Q2"], ["Q3", "Q4"]), false);
    assert.equal(periodsCompatible(["Q3", "Q4"], ["2025年Q3", "2026年Q4"]), true);
  });

  it("names the month, quarter or half-year of a period, and 年 for a year alone", () => {
    assert.equal(periodPart("2026年3月"), "3月");
    assert.equal(periodPart("2026年Q3"), "Q3");
    assert.equal(periodPart("2026年上半年"), "上半年");
    assert.equal(periodPart("26年3月"), "3月");
    assert.equal(periodPart("2026年"), "年");
    assert.equal(periodPart("Q3"), "Q3");
    assert.equal(periodPart("3月"), "3月");
  });
});

describe("VAL-DATA-009: period lists group into the sets that can be about one time (M7-SCR-009)", () => {
  it("puts two years of one quarter into two sets and a list with no year into both", () => {
    const lists = [["2025年Q3"], ["2026年Q3"], ["2025年Q3"], ["2026年Q3"], ["Q3"]];
    assert.deepEqual(compatibleGroups(lists), [
      [0, 2, 4],
      [1, 3, 4],
    ]);
  });

  it("gives one set to lists that all fit, and a set of its own to a list that fits none", () => {
    assert.deepEqual(compatibleGroups([["Q3"], ["2026年Q3"], ["Q3"]]), [[0, 1, 2]]);
    assert.deepEqual(compatibleGroups([["2025年3月"], ["2026年3月"]]), [[0], [1]]);
    assert.deepEqual(compatibleGroups([[], ["2025年3月"], ["2026年3月"]]), [
      [0, 1],
      [0, 2],
    ]);
    assert.deepEqual(compatibleGroups([]), []);
  });

  it("orders the sets by their indices and lists each set ascending", () => {
    const lists = [["2027年Q3"], ["Q3"], ["2025年Q3"], ["2026年Q3"], ["2025年Q3"]];
    assert.deepEqual(compatibleGroups(lists), [
      [0, 1],
      [1, 2, 4],
      [1, 3],
    ]);
  });

  it("does not grow with the number of figures: two hundred years are two hundred small sets", () => {
    const years = Array.from({ length: 200 }, (_, index) => [`${1900 + index}年Q3`]);
    const sets = compatibleGroups([[], ...years]);
    assert.equal(sets.length, 200);
    assert.ok(sets.every((set) => set.length === 2 && set[0] === 0));
  });

  it("searches the distinct lists, so thousands of figures with the same periods stay one set", () => {
    const lists = [...Array.from({ length: 3000 }, () => ["2026年Q3"]), []];
    const sets = compatibleGroups(lists);
    assert.equal(sets.length, 1);
    assert.equal(sets[0]!.length, 3001);
    assert.deepEqual(sets[0]!.slice(0, 3), [0, 1, 2]);
  });

  it("names a period's year, and none for a quarter or month written without one", () => {
    assert.equal(periodYear("2026年Q3"), "2026");
    assert.equal(periodYear("2026年"), "2026");
    assert.equal(periodYear("26年3月"), "26");
    assert.equal(periodYear("Q3"), undefined);
    assert.equal(periodYear("3月"), undefined);
  });

  it("shares the form that names a year wherever one list does", () => {
    assert.deepEqual(sharedPeriods([["Q3"], ["2026年Q3"]]), ["2026年Q3"]);
    assert.deepEqual(sharedPeriods([["Q3"], ["Q3"]]), ["Q3"]);
    assert.deepEqual(sharedPeriods([["2026年3月"], ["3月"], ["2026年3月"]]), ["2026年3月"]);
    assert.deepEqual(sharedPeriods([["Q3", "Q4"], ["2026年Q3"]]), ["2026年Q3", "Q4"]);
    assert.deepEqual(sharedPeriods([[], []]), []);
  });
});
