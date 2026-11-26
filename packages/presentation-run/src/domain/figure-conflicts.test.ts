import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRIEF_RANK,
  DOCUMENT_RANK,
  TABLE_RANK,
  captionKey,
  clausedNumbers,
  detectNumberConflicts,
  headerMetric,
  isNearMatchConflict,
  labelKey,
  namesNoMetric,
  pageStatesValue,
  proseFigures,
  relativeDifference,
  statedNumbers,
  tableFigures,
  type ConflictSource,
} from "./figure-conflicts.js";

const TABLE_TEXT = [
  "# 表「季度经营.xlsx」sheet:季度营收",
  "共 4 行数据 · 本段第 1–4 行",
  "列：季度 | 营收(万元) | 毛利(万元)",
  "1\tQ1\t1234.5\t410.2",
  "2\tQ2\t1388\t455.7",
  "3\tQ3\t1502.25\t498.1",
  "4\tQ4\t1675.8\t560.35",
].join("\n");

function sources(table: string, document: string, brief = ""): readonly ConflictSource[] {
  return [
    ...(brief ? [{ source: "你的要求", rank: BRIEF_RANK, figures: proseFigures(brief) } as ConflictSource] : []),
    { source: "季度经营.xlsx", rank: TABLE_RANK, figures: tableFigures(table) },
    { source: "运营简报.pdf", rank: DOCUMENT_RANK, figures: proseFigures(document) },
  ];
}

describe("VAL-DATA-009: the 0.1 %–5 % range", () => {
  it("includes both ends and excludes the values just outside them", () => {
    // Relative difference is the gap over the smaller value, so round numbers sit exactly on the ends.
    assert.equal(relativeDifference(1000, 1001), 0.001);
    assert.equal(isNearMatchConflict(1000, 1001), true, "exactly 0.1 % is reported");
    assert.equal(isNearMatchConflict(100000, 100099.9), false, "0.0999 % is rounding");
    assert.equal(isNearMatchConflict(1000, 1000.5), false);
    assert.equal(isNearMatchConflict(100, 105), true, "exactly 5 % is reported");
    assert.equal(isNearMatchConflict(100, 105.1), false, "5.1 % is a different quantity");
    assert.equal(isNearMatchConflict(1502.25, 1500), true, "0.15 % is reported");
    assert.equal(isNearMatchConflict(1502.25, 1502), false, "0.017 % is rounding");
    assert.equal(isNearMatchConflict(1502.25, 1600), false, "6.5 % is a different quantity");
  });

  it("is symmetric and never reports equal values", () => {
    assert.equal(isNearMatchConflict(105, 100), isNearMatchConflict(100, 105));
    assert.equal(isNearMatchConflict(1500, 1500), false);
    assert.equal(isNearMatchConflict(0, 5), false);
  });

  it("holds the same ends through detection of labelled figures", () => {
    const at = (table: number, document: number) =>
      detectNumberConflicts(sources(TABLE_TEXT.replace("1502.25", String(table)), `Q3 营收 ${document}`));
    assert.equal(at(1000, 1001).length, 1);
    assert.equal(at(100000, 100099.9).length, 0);
    assert.equal(at(100, 105).length, 1);
    assert.equal(at(100, 105.1).length, 0);
  });
});

describe("labelled figures", () => {
  it("reads the words before a number as its label and the word after as its unit", () => {
    const [figure] = proseFigures("Q3 营收 1500 万");
    assert.deepEqual(figure, {
      key: "营收|Q3",
      label: "Q3 营收",
      token: "1500",
      value: 1500,
      unit: "万",
    });
  });

  it("strips verbs between the label and the number", () => {
    assert.equal(proseFigures("Q3 营收写 1500 万")[0]?.label, "Q3 营收");
    assert.equal(proseFigures("Q3 营收达到 1500 万元")[0]?.label, "Q3 营收");
    assert.equal(proseFigures("Q3 营收：1500")[0]?.label, "Q3 营收");
    assert.equal(proseFigures("制作 3 页测试：Q3 营收写 1500 万。")[0]?.label, "Q3 营收");
  });

  it("takes the label from the clause the number is in", () => {
    const figures = proseFigures("Q3 营收为 1500 万元，毛利 498.1 万元");
    assert.deepEqual(
      figures.map((figure) => [figure.label, figure.token]),
      [
        ["Q3 营收", "1500"],
        ["毛利", "498.1"],
      ],
    );
  });

  it("skips dates, page counts, short numbers and unlabelled or generic labels", () => {
    assert.deepEqual(proseFigures("2026年 营收"), []);
    assert.deepEqual(proseFigures("截至 2026-09-30 营收"), []);
    assert.deepEqual(proseFigures("共 120 页"), []);
    assert.deepEqual(proseFigures("Q3 营收 50"), []);
    assert.deepEqual(proseFigures("1500"), []);
    assert.deepEqual(proseFigures("同比增长 5.23%"), []);
    assert.deepEqual(proseFigures("## 第 3 页 营收 1500"), []);
  });

  it("reads a table cell with its row label, column header and header unit", () => {
    const q3 = tableFigures(TABLE_TEXT).find((figure) => figure.token === "1502.25");
    assert.deepEqual(q3, {
      key: "营收|Q3",
      label: "Q3 营收",
      token: "1502.25",
      value: 1502.25,
      unit: "万",
    });
  });

  it("needs a row label: a table of bare numbers has no labelled figures", () => {
    const bare = ["列：序号 | 金额", "1\t1\t1502.25", "2\t2\t1388"].join("\n");
    assert.deepEqual(tableFigures(bare), []);
  });

  it("gives the same key to the same metric in the same period however it is written", () => {
    assert.equal(labelKey("Q3 营收"), labelKey("营收 Q3"));
    assert.notEqual(labelKey("Q2 营收"), labelKey("Q3 营收"));
    assert.notEqual(labelKey("2026年8月 营收"), labelKey("2026年9月 营收"));
    assert.equal(labelKey("同比"), undefined);
  });
});

describe("conflict detection", () => {
  it("reports the spec example: Q3 营收 1502.25 in a workbook against 1500 in a document", () => {
    const found = detectNumberConflicts(sources(TABLE_TEXT, "Q3 营收 1500 万元，同比增长 8.2%。"));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.label, "Q3 营收");
    assert.deepEqual(
      found[0]!.members.map((member) => [member.source, member.token, member.unit]),
      [
        ["季度经营.xlsx", "1502.25", "万"],
        ["运营简报.pdf", "1500", "万"],
      ],
    );
  });

  it("reports a brief number against a material number", () => {
    const found = detectNumberConflicts(sources(TABLE_TEXT, "无关内容", "Q3 营收写 1500 万"));
    assert.equal(found.length, 1);
    assert.deepEqual(
      found[0]!.members.map((member) => [member.source, member.rank, member.token]),
      [
        ["你的要求", BRIEF_RANK, "1500"],
        ["季度经营.xlsx", TABLE_RANK, "1502.25"],
      ],
    );
  });

  it("ignores another period, another metric, another unit and the same source twice", () => {
    // Q2 is 1388 in the workbook, so 1500 is 8 % away; Q3 is a different period for this label.
    assert.equal(detectNumberConflicts(sources(TABLE_TEXT, "Q2 营收 1500")).length, 0);
    assert.equal(detectNumberConflicts(sources(TABLE_TEXT, "Q3 毛利 1500")).length, 0);
    assert.equal(detectNumberConflicts(sources(TABLE_TEXT, "Q3 营收 1500 亿")).length, 0);
    const twice = detectNumberConflicts([
      {
        source: "同一份.pdf",
        rank: DOCUMENT_RANK,
        figures: proseFigures("Q3 营收 1500\nQ3 营收 1502"),
      },
    ]);
    assert.equal(twice.length, 0);
  });

  it("treats a missing unit as compatible with any unit", () => {
    assert.equal(detectNumberConflicts(sources(TABLE_TEXT, "Q3 营收 1500")).length, 1);
  });

  it("does not stop at eight conflicts: the page filter, not the detector, decides which matter", () => {
    const labels = ["华东", "华南", "华北", "西南", "西北", "东北", "华中", "海外", "线上"];
    const text = (offset: number) =>
      labels.map((label, index) => `Q3 ${label}收入 ${1000 + index * 100 + offset} 万元`).join("\n");
    const found = detectNumberConflicts([
      { source: "甲方简报.pdf", rank: DOCUMENT_RANK, figures: proseFigures(text(2.25)) },
      { source: "乙方简报.pdf", rank: DOCUMENT_RANK, figures: proseFigures(text(0)) },
    ]);
    assert.equal(found.length, 9);
    assert.equal(found[8]!.label, "Q3 线上收入");
    assert.deepEqual(
      found[8]!.members.map((member) => member.token),
      ["1802.25", "1800"],
    );
  });

  it("tells sources apart by their id: equal names with different ids conflict, one id under two names does not", () => {
    const left = proseFigures("Q3 营收 1502.25");
    const right = proseFigures("Q3 营收 1500");
    const sameName = detectNumberConflicts([
      { source: "季度经营.xlsx", sourceId: "material-a", rank: TABLE_RANK, figures: left },
      { source: "季度经营.xlsx", sourceId: "material-b", rank: TABLE_RANK, figures: right },
    ]);
    assert.equal(sameName.length, 1);
    assert.deepEqual(
      sameName[0]!.members.map((member) => [member.sourceId, member.source]),
      [
        ["material-a", "季度经营.xlsx"],
        ["material-b", "季度经营.xlsx"],
      ],
    );
    const sameMaterial = detectNumberConflicts([
      { source: "季度经营.xlsx", sourceId: "material-a", rank: TABLE_RANK, figures: left },
      { source: "季度经营（改名）.xlsx", sourceId: "material-a", rank: TABLE_RANK, figures: right },
    ]);
    assert.deepEqual(sameMaterial, []);
  });

  it("lists every source that disagrees, without repeating a source's value", () => {
    const found = detectNumberConflicts([
      ...sources(TABLE_TEXT, "Q3 营收 1500 万"),
      { source: "另一份.txt", rank: DOCUMENT_RANK, figures: proseFigures("Q3 营收 1490 万") },
    ]);
    assert.equal(found.length, 1);
    assert.deepEqual(
      found[0]!.members.map((member) => member.token),
      ["1502.25", "1500", "1490"],
    );
  });
});

describe("numbers a page states", () => {
  it("drops thousand separators so 1,502.25 equals 1502.25", () => {
    const stated = statedNumbers("营收 1,502.25 万元，毛利 498.1");
    assert.equal(
      stated.some((number) => number.value === 1502.25),
      true,
    );
    assert.equal(
      statedNumbers("营收 1,502.25").some((number) => number.value === 1500),
      false,
    );
  });

  it("ties each number to the metric of its own clause, or to none", () => {
    assert.deepEqual(statedNumbers("Q3 营收 1502.25 万元，成本 1500 万元\n1498"), [
      { value: 1502.25, key: "营收|Q3" },
      { value: 1500, key: "成本|" },
      { value: 1498, key: undefined },
    ]);
  });
});

describe("a stated number counts for a metric only when its label agrees", () => {
  const key = labelKey("Q3 营收")!;

  it("accepts the metric under extra words in front, and a number with no label", () => {
    for (const page of ["Q3 营收 1500", "本季度营收 1500", "2026年Q3 营收 1500", "1500"]) {
      assert.equal(pageStatesValue(statedNumbers(page), key, 1500), true, page);
    }
  });

  it("refuses another metric, extra words after it, and another period", () => {
    for (const page of ["Q3 成本 1500", "营收目标 1500", "Q3 营收同比增长 1500", "Q2 营收 1500"]) {
      assert.equal(pageStatesValue(statedNumbers(page), key, 1500), false, page);
    }
  });

  it("compares periods only where both labels name one", () => {
    assert.equal(pageStatesValue(statedNumbers("营收 1500"), key, 1500), true);
    assert.equal(pageStatesValue(statedNumbers("Q3 营收 1500"), labelKey("营收")!, 1500), true);
  });

  it("needs the value itself", () => {
    assert.equal(pageStatesValue(statedNumbers("Q3 营收 1500"), key, 1502.25), false);
  });
});

describe("the label parts of a page that sit outside a clause", () => {
  it("drops a trailing unit from a header and keeps the metric", () => {
    assert.deepEqual(headerMetric("营收(万元)"), { metric: "营收", unit: "万" });
    assert.deepEqual(headerMetric("Q3 营收（%）"), { metric: "Q3 营收", unit: "%" });
    assert.deepEqual(headerMetric("成本"), { metric: "成本", unit: "" });
  });

  it("names no metric once its numbers and units are taken out", () => {
    for (const value of ["1,502.25 万元", "1500", "Q3 1502.25", "同比 +8.2%", "合计 1500 元", "98%"]) {
      assert.equal(namesNoMetric(value), true, value);
    }
    for (const value of ["Q3 营收 1502.25", "营收", "共 1500 人参加", "Revenue 1500"]) {
      assert.equal(namesNoMetric(value), false, value);
    }
  });

  it("takes a short label that states no figure as a caption", () => {
    assert.equal(captionKey("Q3 营收"), labelKey("Q3 营收"));
    assert.equal(captionKey("Q3 营收（万元）"), labelKey("Q3 营收"));
    assert.equal(captionKey("营收：\n"), labelKey("营收"));
    assert.equal(captionKey("2026年 营收"), labelKey("2026年 营收"), "a year is not a figure");
    assert.equal(captionKey("总览\nQ3 Revenue"), labelKey("Q3 Revenue"), "the last line names it");
  });

  it("refuses a value, a unit, a figure inside the text and a sentence", () => {
    assert.equal(captionKey("1502.25"), undefined);
    assert.equal(captionKey("万元"), undefined);
    assert.equal(captionKey("同比"), undefined);
    assert.equal(captionKey("Q3 营收 1502.25"), undefined);
    assert.equal(captionKey("总览 1502.25\nQ3 营收"), undefined, "any line with a figure");
    assert.equal(captionKey("本季度公司整体经营情况良好并且营收成本等主要指标全部达到了年初设定的目标"), undefined);
    assert.equal(captionKey(""), undefined);
  });
});

describe("VAL-DATA-009: a year or a month written in a label is a period, not a metric word", () => {
  it("keys every supported form by its metric and its periods", () => {
    const quarter = "营收|2026年Q3";
    for (const label of [
      "2026年Q3 营收",
      "2026Q3营收",
      "2026 Q3 营收",
      "FY2026 Q3 营收",
      "2026年第三季度营收",
      "营收 2026 Q3",
    ]) {
      assert.equal(labelKey(label), quarter, label);
    }
    assert.equal(labelKey("第三季度营收"), "营收|Q3");
    assert.equal(labelKey("2026年 营收"), "营收|2026年");
    assert.equal(labelKey("FY2026 revenue"), "revenue|2026年");
    assert.equal(labelKey("3月营收"), "营收|3月");
    assert.equal(labelKey("营收 3月"), "营收|3月", "a table header joined after the metric");
    assert.equal(labelKey("2026年 3月 营收"), "营收|2026年3月");
    assert.equal(labelKey("3月营收"), labelKey("营收 3月"));
  });

  it("names no metric for a label that is only periods or a period and a year", () => {
    for (const label of ["2026年", "2026年Q3", "2026 Q3", "FY2026 Q3", "3月", "Q3 2026", "2026年3月"]) {
      assert.equal(labelKey(label), undefined, label);
    }
  });

  it("keeps the forms that were periods before exactly as they were keyed", () => {
    assert.equal(labelKey("Q3 营收"), "营收|Q3");
    assert.equal(labelKey("2026年8月 营收"), "营收|2026年8月");
    assert.equal(labelKey("26年8月 营收"), "营收|26年8月");
    assert.equal(labelKey("2026年上半年 营收"), "营收|2026年上半年");
    assert.equal(labelKey("2026年1-2月 营收"), "营收|2026年1-2月");
    assert.equal(labelKey("Q3 Q2 营收"), "营收|Q2,Q3");
  });

  it("keeps relative periods, weeks and days as metric words", () => {
    assert.equal(labelKey("本月营收"), "本月营收|");
    assert.equal(labelKey("去年同期营收"), "去年同期营收|");
    assert.equal(labelKey("YTD revenue"), "ytdrevenue|");
    assert.equal(labelKey("第3周营收"), "第3周营收|");
    assert.equal(labelKey("9月30日营收"), "9月30日营收|");
  });

  it("reads the label of a source figure and of a table cell the same way", () => {
    assert.equal(proseFigures("2026年Q3营收 1502.25 万元")[0]?.key, "营收|2026年Q3");
    assert.equal(proseFigures("第三季度营收 1502.25 万元")[0]?.key, "营收|Q3");
    assert.equal(proseFigures("3月营收 1502.25 万元")[0]?.key, "营收|3月");
    assert.equal(proseFigures("2026年营收 1502.25 万元")[0]?.key, "营收|2026年");
    const table = ["列：月份 | 营收(万元)", "1\t3月\t1502.25", "2\t2026年2月\t1388"].join("\n");
    assert.deepEqual(
      tableFigures(table).map((figure) => figure.key),
      ["营收|3月", "营收|2026年2月"],
    );
  });

  it("names no metric for the value half of a card that starts with a period", () => {
    for (const value of [
      "2026年3月 1500万元",
      "2026年Q3 1502.25 万元",
      "2026年 1502.25 万元",
      "3月 1500万元",
      "FY2026 Q3 1502.25",
      "2026Q3 1502.25",
      "2026年第三季度 1502.25",
    ]) {
      assert.equal(namesNoMetric(value), true, value);
    }
    for (const value of ["2026年3月 营收 1500", "3月营收 1500", "2026年Q3 成本", "FY2026 Revenue 1500"]) {
      assert.equal(namesNoMetric(value), false, value);
    }
  });

  it("keeps the period a number states in its own clause, and no metric for it", () => {
    const last = (text: string) => clausedNumbers(text).at(-1);
    assert.deepEqual(last("2026年Q3 1500"), { value: 1500, key: undefined, periods: ["2026年Q3"] });
    assert.deepEqual(last("3月 1500"), { value: 1500, key: undefined, periods: ["3月"] });
    assert.deepEqual(last("3月营收 1500"), { value: 1500, key: "营收|3月", periods: ["3月"] });
    assert.deepEqual(statedNumbers("Q3 营收 1502.25 万元，成本 1500 万元\n1498"), [
      { value: 1502.25, key: "营收|Q3" },
      { value: 1500, key: "成本|" },
      { value: 1498, key: undefined },
    ]);
  });
});

describe("VAL-DATA-009: sources meet by month or quarter and are paired by year", () => {
  const document = (source: string, text: string): ConflictSource => ({
    source,
    rank: DOCUMENT_RANK,
    figures: proseFigures(text),
  });
  const found = (...texts: readonly string[]) =>
    detectNumberConflicts(texts.map((text, index) => document(`源${index}.pdf`, text)));

  it("puts a month written with and without its year into one conflict", () => {
    const [conflict] = found("3月营收 1502.25 万元", "2026年3月营收 1500 万元");
    assert.deepEqual(
      conflict?.members.map((member) => [member.token, member.key]),
      [
        ["1502.25", "营收|3月"],
        ["1500", "营收|2026年3月"],
      ],
    );
    assert.equal(found("2026年Q3营收 1502.25", "Q3营收 1500").length, 1);
    assert.equal(found("2026年营收 1502.25", "2026年营收 1500").length, 1);
  });

  it("keeps another month, another quarter and another year apart", () => {
    assert.equal(found("3月营收 1502.25", "2月营收 1500").length, 0);
    assert.equal(found("2026年3月营收 1502.25", "2026年2月营收 1500").length, 0);
    assert.equal(found("2026年Q3营收 1502.25", "2026年Q2营收 1500").length, 0);
    assert.equal(found("2026年3月营收 1502.25", "2025年3月营收 1500").length, 0);
    assert.equal(found("2026年营收 1502.25", "2025年营收 1500").length, 0);
  });

  it("keeps a year alone apart from a month, a quarter and a figure with no period", () => {
    assert.equal(found("2026年营收 1502.25", "2026年3月营收 1500").length, 0);
    assert.equal(found("2026年营收 1502.25", "2026年Q3营收 1500").length, 0);
    assert.equal(found("2026年营收 1502.25", "营收 1500").length, 0);
  });

  it("never pairs two different years through a source that names none", () => {
    assert.equal(
      found("2025年3月营收 1500", "2026年3月营收 1502.25", "3月营收 5000").length,
      0,
      "the two years are 0.15 % apart but are not the same month",
    );
    // The source that names no year conflicts with each year on its own; the years never share a candidate.
    const through = found("3月营收 1502.25", "2025年3月营收 1500", "2026年3月营收 1490");
    assert.deepEqual(
      through.map((candidate) => candidate.members.map((member) => member.token)),
      [
        ["1502.25", "1500"],
        ["1502.25", "1490"],
      ],
    );
    assert.deepEqual(
      through.map((candidate) => candidate.label),
      ["2025年3月营收", "2026年3月营收"],
    );
  });

  it("gives each member the key it was stated with", () => {
    const [conflict] = found("3月营收 1502.25", "2025年3月营收 1500");
    assert.deepEqual(
      conflict?.members.map((member) => member.key),
      ["营收|3月", "营收|2025年3月"],
    );
  });
});

describe("VAL-DATA-009: a stated number counts for a period only when the periods are compatible", () => {
  const states = (page: string, label: string, value = 1500) =>
    pageStatesValue(statedNumbers(page), labelKey(label)!, value);

  it("lets a month without a year fit that month of any year, and no other month", () => {
    assert.equal(states("2026年3月营收 1500", "3月营收"), true);
    assert.equal(states("2026年2月营收 1500", "3月营收"), false);
    assert.equal(states("2月营收 1500", "2026年3月营收"), false);
    assert.equal(states("3月营收 1500", "2026年3月营收"), true);
    assert.equal(states("2025年3月营收 1500", "2026年3月营收"), false);
  });

  it("lets a quarter without a year fit that quarter of any year", () => {
    assert.equal(states("2026年Q3 营收 1500", "Q3 营收"), true);
    assert.equal(states("Q3 营收 1500", "2026年Q3 营收"), true);
    assert.equal(states("2025年Q3 营收 1500", "2026年Q3 营收"), false);
    assert.equal(states("2026年Q2 营收 1500", "Q3 营收"), false);
    assert.equal(states("2026年第三季度营收 1500", "FY2026 Q3 营收"), true);
  });

  it("takes a year alone for the annual period", () => {
    assert.equal(states("2026年营收 1500", "2026年营收"), true);
    assert.equal(states("2025年营收 1500", "2026年营收"), false);
    assert.equal(states("2026年营收 1500", "营收"), true, "a metric with no period");
    assert.equal(states("营收 1500", "2026年营收"), true, "a page number with no period");
    assert.equal(states("2026年营收 1500", "Q3 营收"), false);
    assert.equal(states("Q3 营收 1500", "2026年营收"), false);
    assert.equal(states("2026年营收 1500", "2026年3月营收"), false);
  });
});
