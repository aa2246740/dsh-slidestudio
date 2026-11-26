import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type ChartElement,
  type Page,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx, type Degradation } from "./export-pptd.js";

const TITLE = "季度趋势";
const data = {
  cols: ["类别", "甲", "乙"],
  rows: [
    ["一月", 30, 20],
    ["二月", 40, 25],
    ["三月", 50, 30],
  ],
};

function series(type: string, name: string, extra: Record<string, unknown> = {}) {
  return { type, name, encode: { x: "类别", y: name }, ...extra };
}

function chart(
  elementId: string,
  declared: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): ChartElement {
  return {
    elementId,
    elementType: "chart",
    bounds: [40, 40, 640, 320],
    data,
    series: declared,
    legend: { show: true, position: "bottom" },
    ...extra,
  } as unknown as ChartElement;
}

type Exported = { chart: string; slide: string; degradations: Degradation[] };

/** Export one chart on its own page and return its chart part and that page's slide XML. */
async function exportChart(element: ChartElement): Promise<Exported> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-combo-title-"));
  try {
    const project = createEmptyProject(dir, { title: "组合图" });
    listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("组合图"));
    const page: Page = {
      pageType: "content",
      background: { type: "solid", color: "#FFFFFF" },
      elements: [element as Page["elements"][number]],
    };
    listComposedPage(project, "pages/01-chart.page", page);
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    const chartNames = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    assert.equal(chartNames.length, 1, "one chart part");
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
    return {
      chart: await zip.file(chartNames[0]!)!.async("string"),
      slide: await zip.file(slideNames[slideNames.length - 1]!)!.async("string"),
      degradations: result.report.degradations,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function shapes(slide: string): string[] {
  return slide.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];
}

function titleBoxes(slide: string): string[] {
  return shapes(slide).filter((shape) => shape.includes(`<a:t>${TITLE}</a:t>`));
}

/** Offset and extent of a shape in EMU. */
function frameOf(shape: string): number[] {
  const match = shape.match(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(match, "the text box has an explicit frame");
  return match.slice(1).map(Number);
}

const variants: {
  name: string;
  declared: Record<string, unknown>[];
  extra: Record<string, unknown>;
}[] = [
  {
    name: "stacked bar with a primary-axis line",
    declared: [series("bar", "甲"), series("line", "乙")],
    extra: { grouping: "stacked" },
  },
  {
    name: "clustered bar with a secondary-axis line",
    declared: [series("bar", "甲"), series("line", "乙", { axis: "secondary" })],
    extra: {},
  },
  {
    name: "percent-stacked bar with a secondary-axis line",
    declared: [series("bar", "甲"), series("line", "乙", { axis: "secondary" })],
    extra: { grouping: "percentStacked" },
  },
  {
    name: "stacked bar with a secondary-axis line",
    declared: [series("bar", "甲"), series("line", "乙", { axis: "secondary" })],
    extra: { grouping: "stacked" },
  },
  {
    name: "stacked bar with an area",
    declared: [series("bar", "甲"), series("area", "乙")],
    extra: { grouping: "stacked" },
  },
  {
    name: "clustered bar with a primary-axis line",
    declared: [series("bar", "甲"), series("line", "乙")],
    extra: {},
  },
];

describe("export-native: a bar and line combination keeps its chart title text box", () => {
  for (const variant of variants) {
    it(`writes the title once on the slide: ${variant.name}`, async () => {
      const exported = await exportChart(chart("titled", variant.declared, { title: TITLE, ...variant.extra }));
      assert.equal(titleBoxes(exported.slide).length, 1);
      assert.equal(exported.chart.split(TITLE).length - 1, 0, "the title lives in the text box, not in the chart part");
      assert.deepEqual(
        exported.degradations.filter((item) => item.kind !== "chart-percent-labels-as-values"),
        [],
        "only the known percent-stacked label note may be reported",
      );
    });

    it(`writes no text box without a title: ${variant.name}`, async () => {
      const untitled = await exportChart(chart("plain", variant.declared, variant.extra));
      const titled = await exportChart(chart("titled", variant.declared, { title: TITLE, ...variant.extra }));
      assert.equal(titleBoxes(untitled.slide).length, 0);
      assert.equal(
        shapes(titled.slide).length - shapes(untitled.slide).length,
        1,
        "the title text box is the only shape the title adds",
      );
    });

    it(`places the title where a single-type chart of the same size places it: ${variant.name}`, async () => {
      const combo = await exportChart(chart("titled", variant.declared, { title: TITLE, ...variant.extra }));
      const single = await exportChart(chart("single", [series("bar", "甲")], { title: TITLE }));
      assert.deepEqual(frameOf(titleBoxes(combo.slide)[0]!), frameOf(titleBoxes(single.slide)[0]!));
    });
  }

  it("keeps a single-type chart's title text box as it was", async () => {
    const titled = await exportChart(chart("single", [series("bar", "甲")], { title: TITLE }));
    assert.equal(titleBoxes(titled.slide).length, 1);
    const untitled = await exportChart(chart("single", [series("bar", "甲")]));
    assert.equal(titleBoxes(untitled.slide).length, 0);
  });
});
