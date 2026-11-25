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
import { exportProjectToPptx } from "./export-pptd.js";

export const cols = ["类别", "甲", "乙"];
export const rows: (number | string | null)[][] = [
  ["一月", 30, 20],
  ["二月", 40, 25],
  ["三月", 50, 30],
];
export const gradient = {
  type: "gradient",
  gradientType: "linear",
  angle: 90,
  stops: [
    { position: 0, color: "#2563EB" },
    { position: 1, color: "#10B981", alpha: 0.5 },
  ],
};

export function chart(
  elementId: string,
  series: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  data: { cols: string[]; rows: (number | string | null)[][] } = { cols, rows },
): ChartElement {
  return {
    elementId,
    elementType: "chart",
    bounds: [40, 40, 420, 200],
    data,
    series,
    ...extra,
  } as unknown as ChartElement;
}

export function chartNumber(name: string): number {
  return Number(name.match(/chart(\d+)\.xml$/)?.[1] ?? 0);
}

/** Export each element on its own page and return the chart part XML in the order given. */
export async function exportChartParts(elements: ChartElement[]): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-chart-labels-"));
  try {
    const project = createEmptyProject(dir, { title: "图表标签" });
    listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图表标签"));
    for (const [index, element] of elements.entries()) {
      const page: Page = {
        pageType: "content",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [element as Page["elements"][number]],
      };
      listComposedPage(project, `pages/${String(index + 1).padStart(2, "0")}-chart.page`, page);
    }
    saveProject(project);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true, JSON.stringify(result.report.degradations));
    const zip = await JSZip.loadAsync(result.data);
    const names = Object.keys(zip.files)
      .filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))
      .sort((a, b) => chartNumber(a) - chartNumber(b));
    assert.equal(names.length, elements.length, "one chart part per element");
    const parts: string[] = [];
    for (const name of names) parts.push(await zip.file(name)!.async("string"));
    return parts;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
