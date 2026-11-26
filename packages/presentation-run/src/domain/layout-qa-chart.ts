import {
  chartGrouping,
  chartKind,
  chartKindIssues,
  type ChartElement,
  type PptdElement,
} from "@open-slidestudio/pptd-v2";
import type { LayoutIssue } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";

/** Chart kinds the editor and the native PPTX both draw. Stacked bars are `bar` plus grouping. */
export const SUPPORTED_CHART_TYPES = new Set([
  "bar",
  "column",
  "line",
  "area",
  "pie",
  "doughnut",
  "radar",
  "waterfall",
  "scatter",
]);

/** A chart is an exhibit only when it is large and opaque enough to read. */
export function isVisibleChartExhibit(element: PptdElement): element is ChartElement {
  if (element.elementType !== "chart") return false;
  const [, , width, height] = element.bounds;
  return width >= 24 && height >= 18 && (element.opacity ?? 1) >= 0.2;
}

/**
 * A stacked or percent-stacked exhibit is a bar chart whose chart-level grouping says so. The
 * grouping is not a series type, so a clustered bar never satisfies the request.
 */
export function isGroupedBarExhibit(element: PptdElement, grouping: "stacked" | "percentStacked"): boolean {
  return isVisibleChartExhibit(element) && chartKind(element) === "bar" && chartGrouping(element) === grouping;
}

/** Unsupported kinds, then refusals shared with `write_page` (grouping, radar and doughnut data). */
export function chartIssues(page: SkillPageInput): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  for (const element of page.elements) {
    if (element.elementType !== "chart") continue;
    const chart = element as ChartElement;
    const type = String(chart.series[0]?.type ?? "bar").toLowerCase();
    if (!SUPPORTED_CHART_TYPES.has(type)) {
      issues.push({
        pageId: page.id,
        code: "unsupported_chart",
        message: `page ${page.id} chart ${chart.elementId} uses unsupported type ${type}`,
      });
      continue;
    }
    for (const message of chartKindIssues(chart, `page ${page.id} chart ${chart.elementId}`)) {
      issues.push({ pageId: page.id, code: "invalid_chart_data", message });
    }
    if (type !== "scatter" && type !== "waterfall") continue;
    const encode = chart.series[0]?.encode;
    const xName = encode?.x;
    const yName = encode?.y;
    const xIndex = xName ? chart.data.cols.indexOf(xName) : -1;
    const yIndex = yName ? chart.data.cols.indexOf(yName) : -1;
    const hasNumericRows =
      xIndex >= 0 &&
      yIndex >= 0 &&
      chart.data.rows.some(
        (row) => Number.isFinite(Number(row[yIndex])) && (type === "waterfall" || Number.isFinite(Number(row[xIndex]))),
      );
    if (xIndex < 0 || yIndex < 0 || xIndex === yIndex || !hasNumericRows) {
      issues.push({
        pageId: page.id,
        code: "invalid_chart_data",
        message: `page ${page.id} chart ${chart.elementId} must encode distinct existing x/y columns with numeric rows for ${type}`,
      });
    }
  }
  return issues;
}
