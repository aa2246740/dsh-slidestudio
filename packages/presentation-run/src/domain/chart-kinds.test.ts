import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewSkillPages } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import { parseCanonicalPagePlan } from "./page-plan.js";
import { TODO_EXHIBIT_KINDS } from "./page-plan.js";
import { inferTodoExhibits } from "./todo-exhibits.js";

const rows: (number | string | null)[][] = [
  ["一月", 30, 20],
  ["二月", 40, 25],
  ["三月", 50, 30],
];

/** A content page holding one chart element, shaped like a canonical write_page result. */
function chartPage(type: string, options: Record<string, unknown> = {}, chartRows = rows) {
  return {
    id: "p05",
    pageType: "content",
    elements: [
      {
        elementId: "chart-kind",
        elementType: "chart",
        bounds: [60, 120, 640, 360],
        data: { cols: ["类别", "甲", "乙"], rows: chartRows },
        series: [{ type, encode: { x: "类别", y: "甲" } }],
        ...options,
      },
    ],
  } as unknown as SkillPageInput;
}

function chartCodes(page: SkillPageInput): string[] {
  return reviewSkillPages([page], { mode: "compose" }).issues.map((issue) => issue.code);
}

describe("layout QA and page plan accept the four chart kinds", () => {
  it("does not report unsupported_chart for radar, doughnut, stacked or percent-stacked bars", () => {
    for (const page of [
      chartPage("radar"),
      chartPage("doughnut"),
      chartPage("bar", { grouping: "stacked" }),
      chartPage("bar", { grouping: "percentStacked" }),
    ]) {
      assert.equal(chartCodes(page).includes("unsupported_chart"), false);
    }
  });

  it("reports a radar chart with fewer than three categories as invalid chart data", () => {
    const review = reviewSkillPages([chartPage("radar", {}, rows.slice(0, 2))], {
      mode: "compose",
    });
    assert.ok(
      review.issues.some((issue) => issue.code === "invalid_chart_data"),
      JSON.stringify(review.issues),
    );
  });

  it("reports a doughnut with a negative value as invalid chart data", () => {
    const review = reviewSkillPages(
      [
        chartPage("doughnut", {}, [
          ["一月", 30, 20],
          ["二月", -4, 25],
        ]),
      ],
      { mode: "compose" },
    );
    assert.ok(review.issues.some((issue) => issue.code === "invalid_chart_data"));
  });

  it("reports percent-stacked on a pie as invalid chart data", () => {
    const review = reviewSkillPages([chartPage("pie", { grouping: "percentStacked" })], {
      mode: "compose",
    });
    assert.ok(review.issues.some((issue) => issue.code === "invalid_chart_data"));
  });

  it("lists the four kinds as typed exhibits and accepts chart:radar in a plan", () => {
    for (const kind of ["chart:radar", "chart:doughnut", "chart:stacked", "chart:percentStacked"]) {
      assert.ok((TODO_EXHIBIT_KINDS as readonly string[]).includes(kind), kind);
    }
    const plan = parseCanonicalPagePlan([
      {
        pageId: "pages/05_radar.page",
        title: "能力雷达",
        layoutFamily: "content",
        exhibits: ["chart:radar"],
      },
    ]);
    assert.deepEqual(plan[0]?.exhibits, ["chart:radar"]);
  });

  it("infers the new exhibit kinds from brief wording without mistaking one for another", () => {
    assert.ok(inferTodoExhibits("用雷达图比较六项能力").includes("chart:radar"));
    assert.ok(inferTodoExhibits("环形图展示份额").includes("chart:doughnut"));
    assert.ok(inferTodoExhibits("百分比堆叠柱形图").includes("chart:percentStacked"));
    assert.ok(inferTodoExhibits("堆叠柱形图展示分部").includes("chart:stacked"));
    assert.ok(!inferTodoExhibits("百分比堆叠柱形图").includes("chart:stacked"));
    assert.ok(!inferTodoExhibits("堆叠柱形图").includes("chart:percentStacked"));
  });
});
