/**
 * Chart kind under a monthly update: a page chart whose categories and series names are those of a
 * chart in last month's deck, but whose kind differs, gets a non-blocking hint. Values are new, so
 * the match is by labels. Everything runs through the real domain hands.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { PRODUCE_GATE_REL_FILES } from "../produce-gate-files.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { MONTHLY_PARTS, MONTHLY_TEMPLATE_ID, writeMonthlyTemplate } from "./monthly-template.testkit.js";
import { ensureRunLedger } from "./run-ledger.js";

const CONTEXT = { commandId: "kind-drift", contextEpochId: "kind-drift-epoch" };
const MAP = { from: "2026-08", to: "2026-09" };
const CATEGORIES = ["华北", "华东", "华南"];
/** Last month's combination chart plots two month-end values; this month's labels are shorter. */
const OLD_PERIODS = ["2025年8月末（人）", "2026年8月末（人）"];
const NEW_PERIODS = ["2025年9月", "2026年9月"];
const PLAN = ["p1", "p2", "p3"].map((pageId, index) => ({
  pageId,
  title: `本月月报 ${index + 1}`,
  layoutFamily: "content",
  exhibits: ["none"],
}));

/** Last month's chart 7 is a stacked column chart with a total line; charts 5 and 9 stay bars. */
const STACKED_COMBINATION = {
  "chart-7": {
    type: "combination",
    grouping: "stacked",
    combo: [
      { type: "bar", grouping: "stacked", direction: "column" },
      { type: "line", grouping: "standard" },
    ],
    series: [
      { name: "线上", categories: OLD_PERIODS, values: [10.5, 11.5] },
      { name: "线下", categories: OLD_PERIODS, values: [20.5, 21.5] },
      { name: "合计", categories: OLD_PERIODS, values: [31, 33] },
    ],
  },
};

function project(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chart-kind-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "月报更新" });
  writeDomainRuntime(root, { brief: "制作 3 页测试：用上月稿和本月数据更新月报。" });
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
  writeMonthlyTemplate(root, STACKED_COMBINATION);
  return root;
}

function call(root: string, name: string, args: Record<string, unknown>, commandId = name) {
  return runDomainHand(name, { ...args, __openSlideStudio: { ...CONTEXT, commandId } }, root);
}

async function readTemplate(root: string) {
  const material = verifyMaterial(root, MONTHLY_TEMPLATE_ID);
  for (const part of MONTHLY_PARTS) {
    for (let offset = 0; offset < materialChunkCount(material, part); offset += 1) {
      const read = await call(
        root,
        "read_material",
        { materialId: MONTHLY_TEMPLATE_ID, part, offset },
        `read-${part}-${offset}`,
      );
      assert.equal(read.ok, true, read.detail);
    }
  }
}

type SeriesSpec = Readonly<{ name: string; type: "bar" | "line" }>;

function chartPage(
  id: string,
  series: readonly SeriesSpec[],
  options: { grouping?: "stacked"; categories?: readonly string[] } = {},
) {
  const categories = options.categories ?? CATEGORIES;
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: `${id}-title`,
        elementType: "text",
        bounds: [80, 40, 800, 60],
        content: { text: `本月月报 ${id}`, fontSize: 28 },
      },
      {
        elementId: `${id}-chart`,
        elementType: "chart",
        bounds: [80, 140, 800, 300],
        data: {
          cols: ["类别", ...series.map((item) => item.name)],
          rows: categories.map((category, row) => [
            category,
            ...series.map((_, column) => 100 + row * 10 + column + 0.25),
          ]),
        },
        series: series.map((item) => ({
          name: item.name,
          type: item.type,
          encode: { x: "类别", y: item.name },
        })),
        ...(options.grouping ? { grouping: options.grouping } : {}),
        labels: false,
        legend: true,
      },
    ],
  };
}

async function write(root: string, page: ReturnType<typeof chartPage>): Promise<string> {
  const result = await call(root, "write_page", page, `write-${page.id}`);
  assert.equal(result.ok, true, result.detail);
  return String((result.payload as Record<string, unknown>).hint ?? "");
}

const STACKED_BARS: readonly SeriesSpec[] = [
  { name: "线上", type: "bar" },
  { name: "线下", type: "bar" },
  { name: "合计", type: "bar" },
];
const STACKED_COMBINATION_SERIES: readonly SeriesSpec[] = [
  { name: "线上", type: "bar" },
  { name: "线下", type: "bar" },
  { name: "合计", type: "line" },
];

async function monthlyProject(t: { after(fn: () => void): void }, withMap = true): Promise<string> {
  const root = project(t);
  const todo = await call(root, "write_todo", {
    items: PLAN,
    ...(withMap ? { periodMap: MAP } : {}),
  });
  assert.equal(todo.ok, true, todo.detail);
  await readTemplate(root);
  return root;
}

describe("write_page hint: a chart that is not the kind of its counterpart in last month's deck", () => {
  it("is part of the produce-path fingerprint", () => {
    const rel = "packages/presentation-run/dist/domain/chart-kind-drift.js";
    assert.ok((PRODUCE_GATE_REL_FILES as readonly string[]).includes(rel));
  });

  it("names a stacked combination chart that lost its line series", async (t) => {
    const root = await monthlyProject(t);
    const hint = await write(root, chartPage("p1", STACKED_BARS, { grouping: "stacked", categories: NEW_PERIODS }));
    assert.match(hint, /和上月稿不是同一种类型/);
    assert.match(hint, /上月稿第 7 页/);
    assert.match(hint, /上月稿是组合图（堆积），本页是柱状图（堆积）/);
    assert.match(hint, /这条提示不阻止保存/);
  });

  it("stays silent when the page keeps the combination, and for the other labels of the page", async (t) => {
    const root = await monthlyProject(t);
    const kept = await write(
      root,
      chartPage("p1", STACKED_COMBINATION_SERIES, { grouping: "stacked", categories: NEW_PERIODS }),
    );
    assert.doesNotMatch(kept, /和上月稿不是同一种类型/);
    const unrelated = await write(
      root,
      chartPage("p2", [{ name: "新指标", type: "line" }], { categories: ["东北", "西北", "西南"] }),
    );
    assert.doesNotMatch(unrelated, /和上月稿不是同一种类型/);
  });

  it("catches a bar chart that became a line chart and accepts the same bar chart", async (t) => {
    const root = await monthlyProject(t);
    const asLine = await write(root, chartPage("p1", [{ name: "本月值", type: "line" }]));
    assert.match(asLine, /上月稿第 5 页/);
    assert.match(asLine, /上月稿是柱状图，本页是折线图/);
    const asBar = await write(root, chartPage("p2", [{ name: "本月值", type: "bar" }]));
    assert.doesNotMatch(asBar, /和上月稿不是同一种类型/);
  });

  it("only runs for a monthly update that declared its period map", async (t) => {
    const root = await monthlyProject(t, false);
    const hint = await write(root, chartPage("p1", STACKED_BARS, { grouping: "stacked", categories: NEW_PERIODS }));
    assert.doesNotMatch(hint, /和上月稿不是同一种类型/);
  });
});
