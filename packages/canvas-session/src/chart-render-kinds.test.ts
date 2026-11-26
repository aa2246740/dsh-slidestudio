import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type ChartElement,
  type Page,
} from "@open-slidestudio/pptd-v2";
import { openSession, renderModel } from "./index.js";

const cols = ["类别", "甲", "乙"];
const rows = [
  ["一月", 30, 20],
  ["二月", 40, 25],
  ["三月", 50, 30],
];

function chart(
  elementId: string,
  series: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): ChartElement {
  return {
    elementId,
    elementType: "chart",
    bounds: [40, 40, 420, 240],
    data: { cols, rows },
    series,
    ...extra,
  } as unknown as ChartElement;
}

describe("canvas-session render model carries the chart kinds the editor paints", () => {
  it("reports the kind, grouping and gradient series fill of each chart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-chart-kinds-"));
    try {
      const project = createEmptyProject(dir, { title: "图表类型" });
      listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图表类型"));
      const gradient = {
        type: "gradient",
        gradientType: "linear",
        angle: 90,
        stops: [
          { position: 0, color: "#2563EB" },
          { position: 1, color: "#10B981" },
        ],
      };
      const page: Page = {
        pageType: "content",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          chart("radar", [{ type: "radar", encode: { x: "类别" } }]),
          chart("stacked", [{ type: "bar", encode: { x: "类别" } }], { grouping: "stacked" }),
          chart("doughnut", [{ type: "doughnut", name: "甲", encode: { x: "类别", y: "甲" } }]),
          chart("gradient", [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" }, fill: gradient }]),
        ] as Page["elements"],
      };
      listComposedPage(project, "pages/02-charts.page", page);
      saveProject(project);

      const surface = renderModel(openSession(dir, { pageIndex: 1 }));
      const byId = new Map(surface.elements.filter((element) => element.chart).map((element) => [element.id, element]));
      assert.equal(byId.get("radar")?.chartType, "radar");
      assert.equal(byId.get("radar")?.chartGrouping, "clustered");
      assert.equal(byId.get("stacked")?.chartType, "bar");
      assert.equal(byId.get("stacked")?.chartGrouping, "stacked");
      assert.equal(byId.get("doughnut")?.chartType, "doughnut");
      assert.deepEqual(byId.get("gradient")?.chartSeries?.[0]?.fill, gradient);
      assert.equal(byId.get("gradient")?.chartGrouping, "clustered");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
