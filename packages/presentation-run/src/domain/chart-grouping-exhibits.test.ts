import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, test } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { requestedExhibitIssues, type LayoutReview } from "./layout-qa.js";
import type { TodoExhibitKind } from "./page-plan.js";
import { ensureRunLedger } from "./run-ledger.js";
import type { SkillPageInput } from "./skill-pages.js";

const rows: (number | string | null)[][] = [
  ["一月", 30, 20],
  ["二月", 40, 25],
  ["三月", 50, 30],
];

/** A chart element shaped like a canonical write_page result. Grouping is chart-level. */
function chartPage(type: string, options: Record<string, unknown> = {}, seriesNames = ["甲", "乙"]): SkillPageInput {
  return {
    id: "p05",
    pageType: "content",
    elements: [
      {
        elementId: "chart",
        elementType: "chart",
        bounds: [60, 120, 640, 360],
        data: { cols: ["类别", ...seriesNames], rows },
        series: seriesNames.map((name) => ({ type, name, encode: { x: "类别", y: name } })),
        ...options,
      },
    ],
  } as unknown as SkillPageInput;
}

/** The unmet-exhibit messages for one declared kind, through the same matcher review_pages uses. */
function unmet(page: SkillPageInput, exhibit: TodoExhibitKind): string[] {
  return requestedExhibitIssues(page, { title: "图表", exhibits: [exhibit] }).map((issue) => issue.message);
}

describe("chart grouping satisfies stacked and percent-stacked exhibits", () => {
  it("a stacked bar satisfies chart:stacked and a percent-stacked bar satisfies chart:percentStacked", () => {
    assert.deepEqual(unmet(chartPage("bar", { grouping: "stacked" }), "chart:stacked"), []);
    assert.deepEqual(unmet(chartPage("bar", { grouping: "percentStacked" }), "chart:percentStacked"), []);
  });

  it("a clustered bar, with or without explicit grouping, never satisfies a stacked request", () => {
    for (const options of [{}, { grouping: "clustered" }]) {
      assert.equal(unmet(chartPage("bar", options), "chart:stacked").length, 1);
      assert.equal(unmet(chartPage("bar", options), "chart:percentStacked").length, 1);
    }
  });

  it("each grouping satisfies only its own request", () => {
    assert.equal(unmet(chartPage("bar", { grouping: "stacked" }), "chart:percentStacked").length, 1);
    assert.equal(unmet(chartPage("bar", { grouping: "percentStacked" }), "chart:stacked").length, 1);
  });

  it("a grouping on a non-bar kind does not satisfy a stacked request", () => {
    assert.equal(unmet(chartPage("line", { grouping: "stacked" }), "chart:stacked").length, 1);
  });

  it("radar and doughnut exhibits match only their own kinds", () => {
    assert.deepEqual(unmet(chartPage("radar"), "chart:radar"), []);
    assert.equal(unmet(chartPage("bar"), "chart:radar").length, 1);
    assert.deepEqual(unmet(chartPage("doughnut", {}, ["甲"]), "chart:doughnut"), []);
    assert.equal(unmet(chartPage("pie", {}, ["甲"]), "chart:doughnut").length, 1);
    assert.equal(unmet(chartPage("doughnut", {}, ["甲"]), "chart:pie").length, 1);
  });
});

const copy = (title: string) => [
  {
    elementId: "title",
    elementType: "text",
    bounds: [80, 40, 800, 60],
    content: { text: title, fontSize: 28, color: "#111111" },
  },
  {
    elementId: "note",
    elementType: "text",
    bounds: [80, 460, 800, 40],
    content: { text: "数据来源：合成样本，仅供回归测试", fontSize: 14, color: "#111111" },
  },
];

/** A bar chart as write_page receives it; `grouping` is omitted for a clustered bar. */
const barChart = (grouping?: "stacked" | "percentStacked") => ({
  elementId: "chart",
  elementType: "chart",
  bounds: [80, 110, 800, 340],
  data: { cols: ["类别", "甲", "乙"], rows },
  series: [
    { type: "bar", name: "甲", encode: { x: "类别", y: "甲" } },
    { type: "bar", name: "乙", encode: { x: "类别", y: "乙" } },
  ],
  ...(grouping ? { grouping } : {}),
});

test("write_todo declared stacked and percent-stacked exhibits pass review_pages through the domain hands", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chart-grouping-exhibit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "堆叠图展项" });
  writeDomainRuntime(root, { brief: "制作三页柱形图说明。" });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    runDomainHand(name, { ...args, __openSlideStudio: { commandId: name, contextEpochId: "grouping-fixture" } }, root);
  const planned = await call("write_todo", {
    items: [
      { pageId: "p01", title: "分部", layoutFamily: "content", exhibits: ["chart:stacked"] },
      { pageId: "p02", title: "占比", layoutFamily: "content", exhibits: ["chart:percentStacked"] },
      { pageId: "p03", title: "对比", layoutFamily: "content", exhibits: ["chart:stacked"] },
    ],
  });
  assert.equal(planned.ok, true, planned.detail);
  const pages: [string, ReturnType<typeof barChart>][] = [
    ["p01", barChart("stacked")],
    ["p02", barChart("percentStacked")],
    ["p03", barChart()],
  ];
  for (const [id, chart] of pages) {
    const written = await call("write_page", { id, elements: [...copy(`图表 ${id}`), chart] });
    assert.equal(written.ok, true, `${id}: ${written.detail}`);
  }
  const reviewed = await call("review_pages");
  const unmetPages = (reviewed.payload as LayoutReview).issues
    .filter((issue) => issue.code === "missing_requested_exhibit")
    .map((issue) => issue.pageId);
  assert.deepEqual(unmetPages, ["p03"], reviewed.detail);
});
