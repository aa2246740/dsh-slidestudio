import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChartElement } from "./types.js";
import { categoricalChartModel, chartKind } from "./chart-semantics.js";
import { canonicalWritePageIssues } from "./write-page-schema.js";
import { createEmptyProject, listComposedPage, loadProject, saveProject, titleOnlyCoverPage } from "./parse.js";

const cols = ["类别", "甲", "乙"];
const rows: (number | string | null)[][] = [
  ["一月", 30, 20],
  ["二月", 40, 25],
  ["三月", 50, 30],
];

/** A chart element as `write_page` receives it. The chart-level grouping is optional. */
function chart(
  type: string,
  extra: Record<string, unknown> = {},
  options: { rows?: (number | string | null)[][]; series?: Record<string, unknown>[] } = {},
): ChartElement {
  return {
    elementId: `chart-${type}`,
    elementType: "chart",
    bounds: [40, 40, 640, 360],
    data: { cols, rows: options.rows ?? rows },
    series: options.series ?? [{ type, encode: { x: "类别" } }],
    ...extra,
  } as unknown as ChartElement;
}

function pageIssues(element: ChartElement): string[] {
  return canonicalWritePageIssues({ id: "p-chart", elements: [element] });
}

/** Every regular file below `dir` keyed by relative path, for byte-level comparisons. */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else out[path.relative(dir, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  visit(dir);
  return out;
}

describe("chart kinds: radar, doughnut, stacked and percent-stacked", () => {
  it("chartKind names the radar and doughnut kinds instead of folding them into bar", () => {
    assert.equal(chartKind(chart("radar")), "radar");
    assert.equal(chartKind(chart("doughnut")), "doughnut");
    assert.equal(chartKind(chart("bar")), "bar");
  });

  it("radar keeps every category as a vertex of every series", () => {
    const model = categoricalChartModel(chart("radar"));
    assert.equal(model.kind, "radar");
    assert.deepEqual(model.categories, ["一月", "二月", "三月"]);
    assert.deepEqual(
      model.series.map((series) => [series.name, series.values]),
      [
        ["甲", [30, 40, 50]],
        ["乙", [20, 25, 30]],
      ],
    );
  });

  it("doughnut reads its single series as one slice per category", () => {
    const model = categoricalChartModel(
      chart("doughnut", {}, { series: [{ type: "doughnut", name: "甲", encode: { x: "类别", y: "甲" } }] }),
    );
    assert.equal(model.kind, "doughnut");
    assert.deepEqual(model.categories, ["一月", "二月", "三月"]);
    assert.deepEqual(model.series[0]?.values, [30, 40, 50]);
  });

  it("the chart-level grouping defaults to clustered and is kept for bars", () => {
    assert.equal(categoricalChartModel(chart("bar")).grouping, "clustered");
    assert.equal(
      categoricalChartModel(chart("bar", { grouping: "stacked" }) as unknown as ChartElement).grouping,
      "stacked",
    );
  });

  it("stacked bars widen the value scale to the stacked category total", () => {
    // Category 三月 stacks to 80, which a clustered scale of 50 would clip.
    const model = categoricalChartModel(chart("bar", { grouping: "stacked" }) as unknown as ChartElement);
    assert.equal(model.grouping, "stacked");
    assert.ok(model.scale.max >= 80, `scale max ${model.scale.max} must cover the total 80`);
  });

  it("percent-stacked bars use a 0 to 100 percent scale", () => {
    const model = categoricalChartModel(chart("bar", { grouping: "percentStacked" }) as unknown as ChartElement);
    assert.equal(model.grouping, "percentStacked");
    assert.equal(model.scale.min, 0);
    assert.equal(model.scale.max, 1);
  });

  it("percent-stacked bars with a negative value use a -100 to 100 percent scale", () => {
    const model = categoricalChartModel(
      chart(
        "bar",
        { grouping: "percentStacked" },
        { rows: [["一月", -25, 75], rows[1]!, rows[2]!] },
      ) as unknown as ChartElement,
    );
    assert.equal(model.grouping, "percentStacked");
    assert.equal(model.scale.min, -1);
    assert.equal(model.scale.max, 1);
  });

  it("a stacked bar plus line combo keeps the line series as its own kind", () => {
    const element = chart(
      "bar",
      { grouping: "stacked" },
      {
        series: [
          { type: "bar", name: "甲", encode: { x: "类别", y: "甲" } },
          { type: "line", name: "乙", encode: { x: "类别", y: "乙" } },
        ],
      },
    );
    const model = categoricalChartModel(element);
    assert.deepEqual(
      model.series.map((series) => series.kind),
      ["bar", "line"],
    );
    assert.deepEqual(pageIssues(element), []);
  });

  it("refuses a radar chart with fewer than three categories in Chinese", () => {
    const issues = pageIssues(chart("radar", {}, { rows: rows.slice(0, 2) }));
    assert.ok(
      issues.some((issue) => /雷达图.*3/.test(issue)),
      `expected a Chinese radar category message, got ${JSON.stringify(issues)}`,
    );
  });

  it("refuses a doughnut with a negative value in Chinese", () => {
    const issues = pageIssues(
      chart(
        "doughnut",
        {},
        {
          rows: [
            ["一月", 30, 20],
            ["二月", -4, 25],
          ],
          series: [{ type: "doughnut", name: "甲", encode: { x: "类别", y: "甲" } }],
        },
      ),
    );
    assert.ok(
      issues.some((issue) => /环形图.*负数/.test(issue)),
      `expected a Chinese doughnut message, got ${JSON.stringify(issues)}`,
    );
  });

  it("refuses percentStacked on a pie in Chinese", () => {
    const issues = pageIssues(chart("pie", { grouping: "percentStacked" }));
    assert.ok(
      issues.some((issue) => /饼图/.test(issue) && /percentStacked/.test(issue)),
      `expected a Chinese pie message, got ${JSON.stringify(issues)}`,
    );
  });

  it("refuses stacking on a line chart in Chinese", () => {
    const issues = pageIssues(chart("line", { grouping: "stacked" }));
    assert.ok(
      issues.some((issue) => /柱形图/.test(issue)),
      `expected a Chinese stacking message, got ${JSON.stringify(issues)}`,
    );
  });

  it("refuses stacked and percentStacked as series types and points to grouping", () => {
    for (const type of ["stacked", "percentStacked"]) {
      const issues = pageIssues(chart(type));
      assert.ok(
        issues.some((issue) => /grouping/.test(issue)),
        `${type} must not be a series type: ${JSON.stringify(issues)}`,
      );
    }
  });

  it("accepts the grouping enum only with the three documented values", () => {
    for (const grouping of ["clustered", "stacked", "percentStacked"]) {
      assert.deepEqual(pageIssues(chart("bar", { grouping })), [], grouping);
    }
    assert.ok(pageIssues(chart("bar", { grouping: "exploded" })).length > 0);
  });

  it("round-trips chart grouping through save and load without changing bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-kinds-roundtrip-"));
    try {
      const project = createEmptyProject(dir, { title: "堆叠图" });
      listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("堆叠图"));
      project.pages[0]!.page.elements = [chart("bar", { grouping: "percentStacked" }) as never];
      saveProject(project);
      const before = hashTree(dir);
      const loaded = loadProject(dir);
      assert.equal(
        (loaded.pages[0]!.page.elements[0] as ChartElement & { grouping?: string }).grouping,
        "percentStacked",
      );
      saveProject(loaded);
      assert.deepEqual(hashTree(dir), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a gradient series fill through save and load without changing bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-fill-roundtrip-"));
    try {
      const gradient = {
        type: "gradient",
        gradientType: "linear",
        angle: 90,
        stops: [
          { position: 0, color: "#2563EB" },
          { position: 1, color: "#10B981", alpha: 0.5 },
        ],
      };
      const project = createEmptyProject(dir, { title: "渐变系列" });
      listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("渐变系列"));
      project.pages[0]!.page.elements = [
        chart(
          "bar",
          {},
          { series: [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" }, fill: gradient }] },
        ) as never,
      ];
      saveProject(project);
      const before = hashTree(dir);
      const loaded = loadProject(dir);
      const series = (loaded.pages[0]!.page.elements[0] as ChartElement).series[0];
      assert.deepEqual(series?.fill, gradient);
      saveProject(loaded);
      assert.deepEqual(hashTree(dir), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
