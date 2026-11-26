import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pageNumberCellsForFigures } from "./page-figure-cells.js";
import { isWholeFigure } from "./vision-values.js";

describe("page number cells: whole figures in native charts and tables", () => {
  it("keeps the chart values and table numbers that hold one whole figure, as written", () => {
    const page = {
      elements: [
        {
          elementType: "chart",
          data: {
            cols: ["月份", "达标率"],
            rows: [
              ["1月", 89.6],
              ["2月", "-12.00%"],
            ],
          },
        },
        {
          elementType: "table",
          rows: [
            ["指标", "增长 5 个点"],
            ["本月", "5"],
            ["同比", { text: "<p>1,234.5</p>" }],
          ],
        },
      ],
    };
    assert.deepEqual(pageNumberCellsForFigures(page), ["89.6", "-12.00%", "5", "1,234.5"]);
  });

  it("does not read running text, category labels or text boxes as data", () => {
    const page = {
      elements: [
        { elementType: "text", content: { text: "第 5 页" } },
        { elementType: "chart", data: { rows: [["第 2 次", "1月"]] } },
      ],
    };
    assert.deepEqual(pageNumberCellsForFigures(page), []);
  });

  it("returns nothing for a page without elements", () => {
    assert.deepEqual(pageNumberCellsForFigures(undefined), []);
    assert.deepEqual(pageNumberCellsForFigures({}), []);
  });
});

describe("whole figure check", () => {
  it("accepts a cell that is exactly one figure in any written form", () => {
    for (const text of ["5", "-12.00%", "1,234.5", ".5", "＋7.25％", " 89.6 "]) {
      assert.equal(isWholeFigure(text), true, text);
    }
  });

  it("rejects running text, labels, empty cells and two figures", () => {
    for (const text of ["第 5 页", "1月", "", "5 5", "2026年"]) {
      assert.equal(isWholeFigure(text), false, text);
    }
  });
});
