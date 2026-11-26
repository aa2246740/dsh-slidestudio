/**
 * The metric a number on a written page is tied to (CAP-21, VAL-DATA-009, M7-SCR-005): table cells by
 * their row and column headers, chart cells by category and column name, and the value half of a figure
 * card by the caption element directly above it or to its left.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { labelKey, pageStatesValue, statedNumbers } from "./figure-conflicts.js";
import { pageTextForFigures } from "./page-figure-text.js";
import { pageStatedNumbers } from "./page-stated-numbers.js";

type Box = [number, number, number, number];

function text(
  id: string,
  content: string,
  bounds: Box | undefined,
  extra: { fontSize?: number; [field: string]: unknown } = {},
) {
  const { fontSize = 18, ...rest } = extra;
  return {
    elementId: id,
    elementType: "text",
    ...(bounds ? { bounds } : {}),
    content: { text: content, fontSize },
    ...rest,
  };
}

const page = (...elements: Record<string, unknown>[]) => ({ id: "p1", elements });
const table = (rows: readonly (readonly unknown[])[]) => ({
  elementId: "t",
  elementType: "table",
  rows,
});
const keysOf = (target: unknown) => pageStatedNumbers(target).map((number) => number.key);
const keyOf = (label: string) => labelKey(label)!;

describe("a table cell takes its row header and its column header", () => {
  it("joins the two headers, whichever of them holds the metric and whichever the period", () => {
    const metricDown = pageStatedNumbers(
      page(
        table([
          ["Metric", "Q3"],
          ["Revenue", "1502.25"],
        ]),
      ),
    );
    assert.deepEqual(metricDown, [{ value: 1502.25, key: "revenue|Q3" }]);
    const periodDown = pageStatedNumbers(
      page(
        table([
          ["季度", "营收(万元)"],
          ["Q3", "1502.25"],
        ]),
      ),
    );
    assert.deepEqual(periodDown, [{ value: 1502.25, key: keyOf("Q3 营收") }]);
    assert.equal(pageStatesValue(periodDown, keyOf("Q3 营收"), 1502.25), true);
    assert.equal(pageStatesValue(periodDown, keyOf("Q3 成本"), 1502.25), false);
    assert.equal(pageStatesValue(periodDown, keyOf("Q2 营收"), 1502.25), false);
  });

  it("gives every cell of a grid its own headers", () => {
    const grid = page(
      table([
        ["指标", "Q2", "Q3"],
        ["营收", "1,388", "1,502.25"],
        ["成本", "455.7", "498.1"],
      ]),
    );
    assert.deepEqual(
      pageStatedNumbers(grid).map((number) => [number.value, number.key]),
      [
        [1388, keyOf("营收 Q2")],
        [1502.25, keyOf("营收 Q3")],
        [455.7, keyOf("成本 Q2")],
        [498.1, keyOf("成本 Q3")],
      ],
    );
  });

  it("drops a trailing unit and ignores a header that is only a number", () => {
    const years = page(
      table([
        ["指标", "2024"],
        ["营收(万元)", "1500"],
      ]),
    );
    const cell = pageStatedNumbers(years).find((number) => number.value === 1500);
    assert.equal(cell?.key, keyOf("营收"), "the year names nothing, so the row header alone binds");
    const pairs = page(
      table([
        ["营收", "1502.25"],
        ["成本", "1500"],
      ]),
    );
    assert.deepEqual(keysOf(pairs), [keyOf("营收"), keyOf("成本")]);
  });

  it("keeps the label a cell carries in its own clause, and leaves a cell with no header unlabelled", () => {
    const own = page(
      table([
        ["Metric", "Q3"],
        ["Revenue", "Cost 1500"],
      ]),
    );
    assert.deepEqual(keysOf(own), [keyOf("Cost")]);
    assert.deepEqual(keysOf(page(table([["1502.25"]]))), [undefined]);
  });

  it("reads cells given as plain strings, as objects and as rich text, one number each", () => {
    const rows = [
      ["Metric", { text: "<p>Q3</p>" }],
      [{ text: "Revenue" }, { text: "<p>1,502.25</p>" }],
      ["Cost", "1500"],
    ];
    assert.deepEqual(
      pageStatedNumbers(page(table(rows))).map((number) => [number.value, number.key]),
      [
        [1502.25, keyOf("Revenue Q3")],
        [1500, keyOf("Cost Q3")],
      ],
    );
  });
});

describe("a chart data cell takes its category and its column name", () => {
  const chart = (rows: readonly (readonly unknown[])[]) => ({
    elementId: "c",
    elementType: "chart",
    data: { cols: ["季度", "营收", "成本"], rows },
  });

  it("binds each value to its series", () => {
    assert.deepEqual(
      pageStatedNumbers(page(chart([["Q3", 1502.25, 1500]]))).map((n) => [n.value, n.key]),
      [
        [1502.25, keyOf("Q3 营收")],
        [1500, keyOf("Q3 成本")],
      ],
    );
  });

  it("leaves a cell unlabelled when the chart names no column for it", () => {
    const noCols = { elementId: "c", elementType: "chart", data: { rows: [[1, 2]] } };
    assert.deepEqual(keysOf(page(noCols)), [undefined, undefined]);
  });
});

describe("a number alone on its line takes the caption line above it in the same element", () => {
  const card = (body: string) => page(text("card", body, [80, 100, 400, 120]));

  it("binds a value to the caption above it, over a blank line too", () => {
    assert.deepEqual(keysOf(card("Q3 营收\n1502.25")), [keyOf("Q3 营收")]);
    assert.deepEqual(keysOf(card("Q3 营收\n\n1502.25 万元")), [keyOf("Q3 营收")]);
    assert.deepEqual(keysOf(card("<p>Q3 营收</p><p>1502.25</p>")), [keyOf("Q3 营收")]);
    assert.deepEqual(keysOf(card("Q3 营收（万元）\n1502.25")), [keyOf("Q3 营收")]);
  });

  it("binds each value to its own caption", () => {
    assert.deepEqual(keysOf(card("Q3 营收\n1502.25\nQ3 成本\n1500")), [keyOf("Q3 营收"), keyOf("Q3 成本")]);
  });

  it("leaves a line unlabelled when the line above is not a caption or the line names a metric itself", () => {
    assert.deepEqual(keysOf(card("Q3 营收\n1502.25\n1500")), [keyOf("Q3 营收"), undefined]);
    assert.deepEqual(keysOf(card("本季度要点\n1500 万元营收达成")), [undefined]);
    assert.deepEqual(keysOf(card("Q3 营收 1502.25\n1500")), [keyOf("Q3 营收"), undefined]);
  });
});

describe("a figure card's value takes the nearest caption element above it or to its left", () => {
  const caption = (box: Box, content = "Q3 营收", extra = {}) => text("caption", content, box, extra);
  const value = (box: Box | undefined, content = "1502.25", extra = {}) => text("value", content, box, extra);
  const keyFor = (...elements: Record<string, unknown>[]) =>
    pageStatedNumbers(page(...elements)).find((number) => number.value === 1502.25)?.key;

  it("takes a caption directly above, and one directly to its left on the same row", () => {
    assert.equal(keyFor(caption([80, 100, 200, 36]), value([80, 160, 200, 36])), keyOf("Q3 营收"));
    assert.equal(keyFor(caption([80, 200, 150, 36]), value([250, 200, 200, 36])), keyOf("Q3 营收"));
    assert.equal(keyFor(caption([80, 100, 200, 36]), value([80, 136, 200, 36])), keyOf("Q3 营收"), "touching boxes");
  });

  it("takes no caption that is below, to the right, off to the side or too far away", () => {
    assert.equal(keyFor(caption([80, 260, 200, 36]), value([80, 160, 200, 36])), undefined);
    assert.equal(keyFor(caption([400, 160, 200, 36]), value([80, 160, 200, 36])), undefined);
    assert.equal(keyFor(caption([500, 100, 200, 36]), value([80, 160, 200, 36])), undefined);
    assert.equal(keyFor(caption([80, 40, 200, 36]), value([80, 160, 200, 36])), undefined);
    assert.equal(keyFor(caption([20, 160, 40, 36]), value([250, 160, 200, 36])), undefined);
  });

  it("takes the nearest caption; above beats left on a tie; the earlier element beats the later", () => {
    const farther = text("farther", "Q3 成本", [80, 40, 200, 60]);
    const nearer = text("nearer", "Q3 营收", [80, 110, 200, 40]);
    assert.equal(keyFor(farther, nearer, value([80, 160, 200, 60])), keyOf("Q3 营收"));
    const left = text("left", "Q3 成本", [130, 200, 150, 40]);
    const above = text("above", "Q3 营收", [300, 140, 200, 40]);
    assert.equal(keyFor(left, above, value([300, 200, 200, 40])), keyOf("Q3 营收"));
    assert.equal(keyFor(above, left, value([300, 200, 200, 40])), keyOf("Q3 营收"));
    const first = text("first", "Q3 营收", [80, 100, 200, 36]);
    const second = text("second", "Q3 成本", [300, 100, 200, 36]);
    assert.equal(keyFor(first, second, value([80, 160, 420, 36])), keyOf("Q3 营收"));
    assert.equal(keyFor(second, first, value([80, 160, 420, 36])), keyOf("Q3 成本"));
  });

  it("never takes a caption set larger than the value, or one in another group", () => {
    const heading = caption([80, 100, 200, 36], "Q3 营收", { fontSize: 28 });
    assert.equal(keyFor(heading, value([80, 160, 200, 36])), undefined);
    const sameSize = caption([80, 100, 200, 36], "Q3 营收", { fontSize: 40 });
    assert.equal(keyFor(sameSize, value([80, 160, 200, 36], "1502.25", { fontSize: 40 })), keyOf("Q3 营收"));
    const other = caption([80, 100, 200, 36], "Q3 营收", { groupId: "g1" });
    assert.equal(keyFor(other, value([80, 160, 200, 36], "1502.25", { groupId: "g2" })), undefined);
    assert.equal(keyFor(other, value([80, 160, 200, 36], "1502.25", { groupId: "g1" })), keyOf("Q3 营收"));
    assert.equal(keyFor(other, value([80, 160, 200, 36])), keyOf("Q3 营收"), "an ungrouped value");
  });

  it("takes no text that is not a caption, and no hidden caption or page chrome", () => {
    const at = (content: string, extra = {}) =>
      keyFor(caption([80, 100, 200, 36], content, extra), value([80, 160, 200, 36]));
    assert.equal(at("Q3 营收 1498"), undefined, "a caption that states a figure");
    assert.equal(at("万元"), undefined, "a unit alone");
    assert.equal(
      at("本季度公司整体经营情况良好并且营收成本等主要指标全部达到了年初设定的目标"),
      undefined,
      "a sentence",
    );
    assert.equal(at("Q3 营收", { hidden: true }), undefined);
    assert.equal(at("Q3 营收", { layoutRole: "footer" }), undefined);
    assert.equal(at("2026年 营收"), keyOf("2026年 营收"), "a year is not a figure");
  });

  it("leaves a value unlabelled when it has no bounds, names a metric itself, or has no caption anywhere", () => {
    assert.equal(keyFor(caption([80, 100, 200, 36]), value(undefined)), undefined);
    const named = text("named", "共 1502.25 人参加", [80, 160, 200, 36]);
    assert.equal(keyFor(caption([80, 100, 200, 36]), named), undefined);
    assert.equal(keyFor(value([80, 160, 200, 36])), undefined);
  });

  it("keeps a number inside its own clause as it was", () => {
    const inline = text("inline", "Q3 成本 1502.25 万元", [80, 160, 200, 36]);
    assert.equal(keyFor(caption([80, 100, 200, 36]), inline), keyOf("Q3 成本"));
  });
});

describe("the numbers a page states do not change, only their labels", () => {
  it("states the same values as the flat page text", () => {
    const rich = {
      id: "p1",
      notes: "备注：Q3 营收 1502.25",
      elements: [
        text("a", "Q3 营收\n1502.25\n成本 1500 万元", [80, 100, 400, 120]),
        { ...text("b", "同比 +8.2%", [80, 240, 200, 36]), title: { text: "1498" } },
        table([
          ["指标", "Q3"],
          ["毛利", "498.1"],
        ]),
        {
          elementId: "c",
          elementType: "chart",
          data: { cols: ["季度", "营收"], rows: [["Q3", 1388]] },
        },
      ],
    };
    const values = (numbers: readonly { value: number }[]) =>
      numbers.map((number) => number.value).sort((left, right) => left - right);
    assert.deepEqual(values(pageStatedNumbers(rich)), values(statedNumbers(pageTextForFigures(rich))));
  });

  it("states nothing for something that is not a page", () => {
    assert.deepEqual(pageStatedNumbers(undefined), []);
    assert.deepEqual(pageStatedNumbers({ elements: "none" }), []);
  });
});

describe("a number that borrows its metric keeps the period its own text states", () => {
  const caption = (content: string) => text("caption", content, [80, 100, 200, 36]);
  const value = (content: string) => text("value", content, [80, 160, 200, 36]);
  const split = (captionText: string, valueText: string) =>
    pageStatedNumbers(page(caption(captionText), value(valueText)));
  const cells = (rows: readonly (readonly unknown[])[]) => pageStatedNumbers(page(table(rows)));

  it("takes the metric of the caption element and the period of the value", () => {
    assert.deepEqual(split("Revenue", "Q2 1500"), [{ value: 1500, key: "revenue|Q2" }]);
    assert.deepEqual(split("Q2 Revenue", "1500"), [{ value: 1500, key: "revenue|Q2" }]);
  });

  it("lets the period of the value win over the period of the caption, and uses the caption's alone", () => {
    assert.deepEqual(split("Q3 Revenue", "Q2 1500"), [{ value: 1500, key: "revenue|Q2" }]);
    assert.deepEqual(split("Q3 Revenue", "1500"), [{ value: 1500, key: "revenue|Q3" }]);
    assert.deepEqual(split("Revenue", "1500"), [{ value: 1500, key: "revenue|" }]);
  });

  it("keeps every period a value states, in the order a label key lists them", () => {
    assert.deepEqual(split("Revenue", "Q3 Q2 1500"), [{ value: 1500, key: "revenue|Q2,Q3" }]);
  });

  it("reads a Chinese caption and a unit", () => {
    assert.deepEqual(split("营收", "Q2 1500 万元"), [{ value: 1500, key: "营收|Q2" }]);
    assert.deepEqual(split("Q3 营收", "1500 万元"), [{ value: 1500, key: "营收|Q3" }]);
  });

  it("applies to the line above in the same element", () => {
    const card = (body: string) => pageStatedNumbers(page(text("card", body, [80, 100, 400, 120])));
    assert.deepEqual(card("Revenue\nQ2 1500"), [{ value: 1500, key: "revenue|Q2" }]);
    assert.deepEqual(card("Q3 Revenue\nQ2 1500"), [{ value: 1500, key: "revenue|Q2" }]);
    assert.deepEqual(card("Q3 Revenue\n1500"), [{ value: 1500, key: "revenue|Q3" }]);
  });

  it("applies to a table cell under a column header and beside a row header", () => {
    assert.deepEqual(
      cells([
        ["Metric", "Revenue"],
        ["Actual", "Q2 1500"],
      ]),
      [{ value: 1500, key: "actualrevenue|Q2" }],
    );
    assert.deepEqual(cells([["Revenue", "Q2 1500"]]), [{ value: 1500, key: "revenue|Q2" }]);
  });

  it("lets a cell's own period win over the period of its header, and uses the header's alone", () => {
    const under = (cell: string) => [
      ["Metric", "Q3"],
      ["Revenue", cell],
    ];
    assert.deepEqual(cells(under("Q2 1500")), [{ value: 1500, key: "revenue|Q2" }]);
    assert.deepEqual(cells(under("1500")), [{ value: 1500, key: "revenue|Q3" }]);
    const down = [
      ["季度", "营收(万元)"],
      ["Q3", "Q2 1500"],
    ];
    assert.deepEqual(cells(down), [{ value: 1500, key: "营收|Q2" }]);
  });

  it("applies to a chart data cell written with a period", () => {
    const chart = {
      elementId: "c",
      elementType: "chart",
      data: { cols: ["季度", "营收"], rows: [["Q3", "Q2 1500"]] },
    };
    assert.deepEqual(pageStatedNumbers(page(chart)), [{ value: 1500, key: "营收|Q2" }]);
  });

  it("keeps a number with a period and no label as that period of any metric", () => {
    const lone = pageStatedNumbers(page(value("Q2 1500")));
    assert.deepEqual(lone, [{ value: 1500, key: "|Q2" }]);
    assert.equal(pageStatesValue(lone, keyOf("Q2 Revenue"), 1500), true);
    assert.equal(pageStatesValue(lone, keyOf("Revenue"), 1500), true, "a metric with no period");
    assert.equal(pageStatesValue(lone, keyOf("Q3 Revenue"), 1500), false);
    assert.deepEqual(keysOf(page(value("1500"))), [undefined], "no period anywhere stays a wildcard");
  });

  it("makes the bound number count for its own period only", () => {
    const stated = split("Revenue", "Q2 1500");
    assert.equal(pageStatesValue(stated, keyOf("Q2 Revenue"), 1500), true);
    assert.equal(pageStatesValue(stated, keyOf("Revenue"), 1500), true, "a metric with no period");
    assert.equal(pageStatesValue(stated, keyOf("Q3 Revenue"), 1500), false);
    assert.equal(pageStatesValue(stated, keyOf("Q3 Cost"), 1500), false);
  });

  it("leaves the flat page text, which has no labels outside a clause, as it was", () => {
    const flat = statedNumbers("Revenue\nQ2 1500");
    assert.deepEqual(flat, [{ value: 1500, key: undefined }]);
    assert.equal(pageStatesValue(flat, keyOf("Q3 Revenue"), 1500), true);
  });
});

describe("a year or a month written in front of a number is its period", () => {
  const caption = (content: string) => text("caption", content, [80, 100, 200, 36]);
  const value = (content: string) => text("value", content, [80, 160, 200, 36]);
  const keyOfValue = (captionText: string, valueText: string, amount: number) =>
    pageStatedNumbers(page(caption(captionText), value(valueText))).find((number) => number.value === amount)?.key;

  it("lets a card value 「2026年Q3 …」 borrow the caption's metric and keep its quarter", () => {
    assert.equal(keyOfValue("营收", "2026年Q3 1502.25 万元", 1502.25), "营收|2026年Q3");
    assert.equal(keyOfValue("Revenue", "2026 Q3 1502.25", 1502.25), "revenue|2026年Q3");
    assert.equal(keyOfValue("Revenue", "FY2026 Q3 1502.25", 1502.25), "revenue|2026年Q3");
    assert.equal(keyOfValue("营收", "2026年第三季度 1502.25", 1502.25), "营收|2026年Q3");
    assert.equal(keyOfValue("营收", "2026Q3 1502.25", 1502.25), "营收|2026年Q3");
  });

  it("lets a card value 「2026年 …」 and 「3月 …」 do the same with the year and the month", () => {
    assert.equal(keyOfValue("营收", "2026年 1502.25 万元", 1502.25), "营收|2026年");
    assert.equal(keyOfValue("营收", "3月 1500万元", 1500), "营收|3月");
    assert.equal(keyOfValue("营收", "2026年3月 1500万元", 1500), "营收|2026年3月");
  });

  it("does not take the metric of the caption for a value that names its own", () => {
    assert.equal(keyOfValue("营收", "2026年3月 成本 1500万元", 1500), "成本|2026年3月");
  });

  it("lets the period of the value win over the period of the caption", () => {
    assert.equal(keyOfValue("2026年 营收", "Q3 1500", 1500), "营收|Q3");
    assert.equal(keyOfValue("Q3 营收", "2026年 1500", 1500), "营收|2026年");
    assert.equal(keyOfValue("2026年 营收", "1500", 1500), "营收|2026年");
  });

  it("reads a table header 「2026 Q3」 or 「3月」 or 「2026年」 as a period, whichever way the table runs", () => {
    const cell = (rows: readonly (readonly string[])[], amount: number) =>
      pageStatedNumbers(page(table(rows))).find((number) => number.value === amount)?.key;
    assert.equal(
      cell(
        [
          ["Metric", "2026 Q3"],
          ["Revenue", "1502.25"],
        ],
        1502.25,
      ),
      "revenue|2026年Q3",
    );
    assert.equal(
      cell(
        [
          ["指标", "3月"],
          ["营收", "1500万元"],
        ],
        1500,
      ),
      "营收|3月",
    );
    assert.equal(
      cell(
        [
          ["指标", "2026年"],
          ["营收", "1500万元"],
        ],
        1500,
      ),
      "营收|2026年",
    );
    assert.equal(
      cell(
        [
          ["月份", "营收(万元)"],
          ["3月", "1500"],
        ],
        1500,
      ),
      "营收|3月",
    );
    assert.equal(
      cell(
        [
          ["年份", "营收(万元)"],
          ["2026年", "1500"],
        ],
        1500,
      ),
      "营收|2026年",
    );
    assert.equal(
      cell(
        [
          ["季度", "营收(万元)"],
          ["2026 Q3", "1500"],
        ],
        1500,
      ),
      "营收|2026年Q3",
    );
  });

  it("joins a year in one header with a quarter or a month in the other", () => {
    const cell = (rows: readonly (readonly string[])[], amount: number) =>
      pageStatedNumbers(page(table(rows))).find((number) => number.value === amount)?.key;
    assert.equal(
      cell(
        [
          ["Q3 营收", "2026年"],
          ["Q3 营收", "1500"],
        ],
        1500,
      ),
      "营收|2026年Q3",
    );
    assert.equal(
      cell(
        [
          ["2026年 营收", "3月"],
          ["2026年 营收", "1500"],
        ],
        1500,
      ),
      "营收|2026年3月",
    );
  });

  it("makes a bound number count for compatible periods only", () => {
    const monthly = pageStatedNumbers(page(caption("营收"), value("3月 1500万元")));
    assert.equal(pageStatesValue(monthly, keyOf("3月营收"), 1500), true);
    assert.equal(pageStatesValue(monthly, keyOf("2026年3月营收"), 1500), true);
    assert.equal(pageStatesValue(monthly, keyOf("2026年2月营收"), 1500), false);
    assert.equal(pageStatesValue(monthly, keyOf("成本"), 1500), false);
    const dated = pageStatedNumbers(page(caption("营收"), value("2026年Q3 1500万元")));
    assert.equal(pageStatesValue(dated, keyOf("Q3 营收"), 1500), true);
    assert.equal(pageStatesValue(dated, keyOf("2025年Q3 营收"), 1500), false);
    assert.equal(pageStatesValue(dated, keyOf("Q2 营收"), 1500), false);
  });
});
