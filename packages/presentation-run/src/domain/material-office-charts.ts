/**
 * Read-only, deterministic rendering of a Word or Excel document's embedded
 * chart data (`derivative.document.charts` / `derivative.table.charts`,
 * CAP-33) as the `read_material part:"charts"` view. The cached OOXML values
 * are rendered as Chinese-headed markdown inside the untrusted-material
 * envelope, so the model can rebuild them as a native write_page chart. A
 * document without charts returns the Chinese note, never an error.
 */
import type { VerifiedMaterial } from "./material-pack.js";

const WRAPPER_OPEN = "<untrusted_reference_material>";
const WRAPPER_CLOSE = "</untrusted_reference_material>";
const NO_CHARTS_NOTE = "未识别到图表。";
const REUSE_NOTE =
  "复用口径：以上数值来自文件内嵌图表的缓存，可直接用于 write_page 的原生图表（barChart/lineChart/pieChart 等）；类别及其顺序必须与数值一起保留，不得改动或臆造数值。";

/** The `read_material` part id for a Word/Excel document's embedded charts. */
export const OFFICE_CHARTS_PART = "charts";

const CHART_TYPE_ZH: Readonly<Record<string, string>> = {
  area: "面积图",
  bar: "柱状图",
  doughnut: "环形图",
  line: "折线图",
  pie: "饼图",
  radar: "雷达图",
  scatter: "散点图",
  combination: "组合图",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Prevent supplied text from ending the untrusted-material envelope. */
function content(value: string): string {
  return value.replace(/<\/untrusted_reference_material/gi, "&lt;/untrusted_reference_material");
}

/** Word/Excel records whose parser reads embedded charts (CAP-33). */
export function officeChartsSupported(material: VerifiedMaterial): boolean {
  if (material.parser.startsWith("docx-ooxml-")) return material.kind === "document";
  if (material.parser.startsWith("xlsx-ooxml-")) return material.kind === "table";
  return false;
}

/** Word/Excel records that actually carry at least one embedded chart. */
export function hasOfficeCharts(material: VerifiedMaterial): boolean {
  return officeChartsSupported(material) && derivativeCharts(material).length > 0;
}

/** The chart list on the derivative; unknown shapes are skipped, never thrown. */
function derivativeCharts(material: VerifiedMaterial): Record<string, unknown>[] {
  const holder = isRecord(material.derivative.document)
    ? material.derivative.document
    : isRecord(material.derivative.table)
      ? material.derivative.table
      : undefined;
  return Array.isArray(holder?.charts) ? holder.charts.filter(isRecord) : [];
}

function chartHeading(chart: Record<string, unknown>, index: number): string {
  const type = text(chart.type) || "unknown";
  const grouping = text(chart.grouping);
  const direction = text(chart.direction);
  const shape = [grouping, direction].filter(Boolean).join(" · ");
  const title = text(chart.title) ? `标题「${content(text(chart.title))}」` : "";
  return `## 图表 ${index + 1} · ${content(CHART_TYPE_ZH[type] ?? type)}${
    shape ? `（${content(shape)}）` : ""
  }${title}`;
}

function chartLines(chart: Record<string, unknown>, index: number): string[] {
  const lines = [chartHeading(chart, index)];
  const sheet = text(chart.sheet);
  if (sheet) lines.push(`工作表「${content(sheet)}」`);
  const seriesList = Array.isArray(chart.series) ? chart.series.filter(isRecord) : [];
  if (!seriesList.length) {
    lines.push("（这个图表没有可读的数据系列）");
    return lines;
  }
  for (const [seriesIndex, series] of seriesList.entries()) {
    const name = text(series.name) || `系列 ${seriesIndex + 1}`;
    lines.push(
      `- 系列「${content(name)}」：类别 ${content(JSON.stringify(series.categories ?? []))}；数值 ${content(
        JSON.stringify(series.values ?? []),
      )}`,
    );
  }
  return lines;
}

/**
 * The `part:"charts"` text for a Word or Excel material. Empty-chart records
 * (and legacy records without the list) return the Chinese note, so a read
 * never fails and never invents content.
 */
export function officeChartsPartText(material: VerifiedMaterial): string {
  const charts = derivativeCharts(material);
  const label = material.kind === "table" ? "Excel" : "Word";
  const body: string[] = [`# ${label}「${material.name}」的图表数据`];
  if (!charts.length) {
    body.push(NO_CHARTS_NOTE);
  } else {
    body.push(
      "数据来自文件内嵌图表的缓存数值；仅作内容参考，请以原文件表格为准。",
      "",
      ...charts.flatMap((chart, index) => [...chartLines(chart, index), ""]),
    );
    while (body.at(-1) === "") body.pop();
    body.push("", REUSE_NOTE);
  }
  return `${WRAPPER_OPEN}\n${body.join("\n")}\n${WRAPPER_CLOSE}`;
}
