import type { ChartElement } from "./types.js";
import { categoricalChartModel, chartKind, type SupportedChartKind } from "./chart-semantics.js";

const KIND_LABELS: Record<SupportedChartKind, string> = {
  bar: "柱形图",
  line: "折线图",
  area: "面积图",
  pie: "饼图",
  radar: "雷达图",
  doughnut: "环形图",
  waterfall: "瀑布图",
  scatter: "散点图",
};

/** Smallest category count that makes a radar polygon. */
const RADAR_MIN_CATEGORIES = 3;

/**
 * Chinese refusals for chart kinds and groupings that cannot be drawn the same way in the
 * editor and the native PPTX. Shared by `write_page` and `edit_elements`.
 */
export function chartKindIssues(chart: ChartElement, path: string): string[] {
  const issues: string[] = [];
  for (const [index, series] of chart.series.entries()) {
    const type = String(series.type ?? "")
      .trim()
      .toLowerCase();
    if (type === "stacked" || type === "percentstacked") {
      const grouping = type === "stacked" ? "stacked" : "percentStacked";
      issues.push(
        `${path}.series[${index}].type 不能是 "${series.type}"：堆叠请保持 type 为 bar，并设置 grouping 为 "${grouping}"`,
      );
    }
  }
  const kind = chartKind(chart);
  const grouping = chart.grouping ?? "clustered";
  if (grouping !== "clustered" && kind !== "bar") {
    issues.push(`${path}: ${KIND_LABELS[kind]}不支持 ${grouping} 分组，堆叠和百分比堆叠只适用于柱形图`);
  }
  if (kind === "radar" && chart.data.rows.length < RADAR_MIN_CATEGORIES) {
    issues.push(`${path}: 雷达图至少需要 ${RADAR_MIN_CATEGORIES} 个类别，当前 ${chart.data.rows.length} 个`);
  }
  if (kind === "doughnut") {
    if (chart.series.length !== 1) issues.push(`${path}: 环形图只能有一个数据系列`);
    const values = categoricalChartModel(chart).series[0]?.values ?? [];
    if (values.some((value) => value < 0)) issues.push(`${path}: 环形图的数值不能为负数`);
  }
  return issues;
}
