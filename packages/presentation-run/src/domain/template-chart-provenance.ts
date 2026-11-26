/**
 * Match authored chart series to receipt-verified PPTX template charts.
 *
 * Numeric provenance is trusted only when every charts chunk was read in the
 * current run context and re-hashes to its recorded receipt. Matching uses exact
 * or source-displayed precision, even when categories were relabelled. Such reuse
 * retains attribution and a correction hint, never substitution evidence.
 */
import type { MaterialChunkFact } from "./run-ledger.js";
import type { VerifiedMaterial } from "./material-pack.js";
import { displayedChartValuesMatch } from "./template-chart-number-format.js";
import { partChunkReceiptsValid } from "./template-part-receipts.js";

type RecordValue = Record<string, unknown>;

export type TemplateChartSeries = Readonly<{
  name: string;
  categories: readonly unknown[];
  values: readonly unknown[];
  numFmt?: string;
}>;

export type TemplateChartSource = Readonly<{
  sourcePage: number;
  chartId: string;
  title: string;
  type: string;
  grouping?: string;
  categories: readonly unknown[];
  series: readonly TemplateChartSeries[];
  sourcePeriods: readonly string[];
}>;

export type PageChartSeries = Readonly<{
  type: string;
  encode: Readonly<Record<string, string>>;
}>;

export type PageChartFigure = Readonly<{
  title: string;
  grouping?: string;
  cols: readonly string[];
  rows: readonly (readonly unknown[])[];
  series: readonly PageChartSeries[];
}>;

export type ChartTypeSubstitution = Readonly<{
  sourceType: string;
  targetType: string;
}>;

export type ChartSubstitutionDetail = Readonly<{
  sourcePage: number;
  sourceType: string;
  targetType: string;
}>;

type ChartSubstitutionMatch = Readonly<{
  materialId: string;
  sourcePage: number;
  chart?: Readonly<{
    sourceChartId: string;
    substitution?: ChartTypeSubstitution;
  }>;
}>;

export type TemplateChartFigureMatch = Readonly<{
  sourcePage: number;
  chartId: string;
  sourceType: string;
  outputTypes: readonly string[];
  values: readonly string[];
  sourcePeriods: readonly string[];
  categoriesMatch?: false;
  valueMatch: "exact" | "displayed";
  substitution?: ChartTypeSubstitution;
}>;

/** Keep one delivery disclosure per source chart and target type. */
export function chartSubstitutionsForPage(
  matches: readonly ChartSubstitutionMatch[],
): readonly ChartSubstitutionDetail[] {
  const substitutions = new Map<string, ChartSubstitutionDetail>();
  for (const match of matches) {
    const chart = match.chart;
    const substitution = chart?.substitution;
    if (!chart || !substitution) continue;
    const key = [
      match.materialId,
      match.sourcePage,
      chart.sourceChartId,
      substitution.sourceType,
      substitution.targetType,
    ].join(":");
    substitutions.set(key, {
      sourcePage: match.sourcePage,
      sourceType: substitution.sourceType,
      targetType: substitution.targetType,
    });
  }
  return [...substitutions.values()].sort((left, right) => left.sourcePage - right.sourcePage);
}

export function chartTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    area: "面积图",
    bar: "柱状图",
    combination: "组合图",
    doughnut: "环形图",
    line: "折线图",
    percentStacked: "百分比堆积图",
    pie: "饼图",
    radar: "雷达图",
    scatter: "散点图",
    stacked: "堆积图",
  };
  return labels[type] ?? type;
}

/** Build the Chinese delivery note for source chart substitutions. */
export function chartSubstitutionNote(substitutions: readonly ChartSubstitutionDetail[]): string {
  const notes = substitutions.map((item) => {
    const sourcePage = item.sourcePage > 0 ? `模板第 ${item.sourcePage} 页的` : "模板中的";
    return `${sourcePage}${chartTypeLabel(item.sourceType)}暂以${chartTypeLabel(item.targetType)}代替`;
  });
  return [...new Set(notes)].join("；");
}

/** A write receipt records the disclosure; it never requests another action. */
export function chartSubstitutionReceipt(matches: readonly ChartSubstitutionMatch[]): string | undefined {
  const notes = chartSubstitutionsForPage(matches).map(
    ({ sourcePage, sourceType, targetType }) =>
      `本页图表沿用模板第 ${sourcePage} 页${chartTypeLabel(sourceType)}数据，交付卡片将注明以${chartTypeLabel(targetType)}代替`,
  );
  return notes.length ? `已记录：${[...new Set(notes)].join("；")}` : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

export function numericToken(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (!token || !/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/.test(token)) return undefined;
  const isPercent = token.endsWith("%");
  const number = Number(token.replace(/,/g, "").replace(/%$/, ""));
  return Number.isFinite(number) ? `${String(number)}${isPercent ? "%" : ""}` : undefined;
}

function sameCategory(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  if (typeof left === "number" || typeof right === "number") {
    const leftNumber = numericToken(left);
    const rightNumber = numericToken(right);
    return leftNumber !== undefined && leftNumber === rightNumber;
  }
  return String(left).trim() === String(right).trim();
}

function sameCategories(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => sameCategory(value, right[index]));
}

function valueVector(values: readonly unknown[]): readonly (string | null)[] | undefined {
  if (!values.length) return undefined;
  const result: (string | null)[] = [];
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      result.push(null);
      continue;
    }
    const number = numericToken(value);
    if (number === undefined) return undefined;
    result.push(number);
  }
  return result;
}

function sameVector(left: readonly (string | null)[], right: readonly (string | null)[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareSeries(
  written: readonly (string | null)[],
  source: TemplateChartSeries,
): "exact" | "displayed" | undefined {
  const cached = valueVector(source.values);
  if (!cached || cached.length !== written.length) return undefined;
  if (sameVector(written, cached)) return "exact";
  return displayedChartValuesMatch(written, cached, source.numFmt) ? "displayed" : undefined;
}

function templateChartContext(material: VerifiedMaterial): {
  charts: readonly RecordValue[];
  slides: readonly RecordValue[];
} {
  const template = isRecord(material.derivative["deck-template"]) ? material.derivative["deck-template"] : {};
  const detail = isRecord(template.templateDetail) ? template.templateDetail : {};
  return {
    charts: records(detail.charts),
    slides: records(detail.slides).length ? records(detail.slides) : records(template.slides),
  };
}

/** Return structured source charts only after every current-epoch charts chunk verifies. */
export function readTemplateChartSources(
  material: VerifiedMaterial,
  facts: readonly MaterialChunkFact[],
  sourcePages: readonly Readonly<{ page: number; text: string }>[],
  extractPeriods: (text: string) => readonly string[],
): readonly TemplateChartSource[] {
  if (material.kind !== "deck-template" || !partChunkReceiptsValid(material, facts, "charts")) {
    return [];
  }
  const pageText = new Map(sourcePages.map((page) => [page.page, page.text]));
  const { charts, slides } = templateChartContext(material);
  return charts.flatMap((chart, index) => {
    const sourcePage = Number(chart.slide ?? chart.page ?? chart.index);
    if (!Number.isSafeInteger(sourcePage) || sourcePage <= 0) return [];
    const series = records(chart.series).map((item, seriesIndex) => ({
      name: text(item.name) || `系列 ${seriesIndex + 1}`,
      categories: Array.isArray(item.categories) ? item.categories : [],
      values: Array.isArray(item.values) ? item.values : [],
      ...(text(item.numFmt) ? { numFmt: text(item.numFmt) } : {}),
    }));
    if (!series.length || series.some((item) => !item.values.length)) return [];
    const categories = Array.isArray(chart.categories) ? chart.categories : series[0]!.categories;
    const title = text(chart.title) || text(chart.name);
    // charts returns these source-page periods beside the numeric vectors.
    // A verified charts read therefore suffices even without a slides read.
    const slide = slides.find((item) => Number(item.index ?? item.slide) === sourcePage);
    const sourceText = [
      pageText.get(sourcePage) ?? "",
      text(slide?.title),
      text(slide?.text),
      text(slide?.notes),
      title,
      ...categories.map((value) => String(value ?? "")),
      ...series.flatMap((item) => item.categories.map((value) => String(value ?? ""))),
    ].join("\n");
    const type = text(chart.type) || "unknown";
    const grouping = text(chart.grouping);
    return [
      {
        sourcePage,
        chartId: text(chart.id) || `chart-${index + 1}`,
        title,
        type,
        ...(grouping ? { grouping } : {}),
        categories,
        series,
        sourcePeriods: extractPeriods(sourceText),
      },
    ];
  });
}

/** Extract authored chart tables without changing the existing visible-text path. */
export function pageChartsForFigures(page: unknown): readonly PageChartFigure[] {
  if (!isRecord(page) || !Array.isArray(page.elements)) return [];
  return page.elements.flatMap((raw) => {
    if (!isRecord(raw) || raw.elementType !== "chart") return [];
    const data = isRecord(raw.data) ? raw.data : {};
    const cols = strings(data.cols);
    const rows = Array.isArray(data.rows)
      ? data.rows.filter(Array.isArray).map((row) => row as readonly unknown[])
      : [];
    const series = records(raw.series).map((item) => {
      const encode = isRecord(item.encode)
        ? Object.fromEntries(
            Object.entries(item.encode).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {};
      return { type: text(item.type) || "unknown", encode };
    });
    if (!cols.length || !rows.length || !series.length) return [];
    const title = typeof raw.title === "string" ? raw.title : text(isRecord(raw.title) ? raw.title.text : "");
    const grouping = text(raw.grouping);
    return [{ title, ...(grouping ? { grouping } : {}), cols, rows, series }];
  });
}

function outputColumnValues(chart: PageChartFigure, column: string): readonly unknown[] | undefined {
  const index = chart.cols.indexOf(column);
  if (index < 0) return undefined;
  const values = chart.rows.map((row) => row[index]);
  return values.length ? values : undefined;
}

function pageChartVectors(chart: PageChartFigure):
  | {
      series: readonly Readonly<{
        categories: readonly unknown[];
        values: readonly (string | null)[];
      }>[];
      outputTypes: readonly string[];
      grouping?: string;
    }
  | undefined {
  if (!chart.series.length) return undefined;
  const seriesVectors: {
    categories: readonly unknown[];
    values: readonly (string | null)[];
  }[] = [];
  for (const series of chart.series) {
    const categoryColumn = series.encode.x || series.encode.item || chart.cols[0];
    if (!categoryColumn) return undefined;
    const categories = outputColumnValues(chart, categoryColumn);
    if (!categories) return undefined;
    const valueColumn = series.encode.y || series.encode.value;
    if (!valueColumn) return undefined;
    const rawValues = outputColumnValues(chart, valueColumn);
    const values = rawValues ? valueVector(rawValues) : undefined;
    if (!values) return undefined;
    seriesVectors.push({ categories, values });
  }
  return {
    series: seriesVectors,
    outputTypes: chart.series.map((series) => series.type),
    grouping: chart.grouping,
  };
}

function sourceCategories(chart: TemplateChartSource): readonly unknown[] {
  return chart.categories.length ? chart.categories : (chart.series[0]?.categories ?? []);
}

/** Only stacked and percent-stacked groupings change the chart kind; clustered is the default. */
function stackingOf(grouping: string | undefined): "stacked" | "percentStacked" | undefined {
  return grouping === "stacked" || grouping === "percentStacked" ? grouping : undefined;
}

/** Disclose reuse only when the output kind (type and stacking) differs from the source kind. */
function outputSubstitution(
  source: Pick<TemplateChartSource, "type" | "grouping">,
  output: Readonly<{ outputTypes: readonly string[]; grouping?: string }>,
): ChartTypeSubstitution | undefined {
  const uniqueOutputTypes = [...new Set(output.outputTypes)];
  if (!uniqueOutputTypes.length) return undefined;
  const sourceStacking = stackingOf(source.grouping);
  const unsupported = source.type === "radar" || source.type === "doughnut" || !!sourceStacking;
  if (!unsupported) return undefined;
  const targetType = uniqueOutputTypes.length === 1 ? uniqueOutputTypes[0]! : "combination";
  const targetStacking = stackingOf(output.grouping);
  if (targetType === source.type && targetStacking === sourceStacking) return undefined;
  return {
    sourceType: sourceStacking ?? source.type,
    targetType: targetType === "combination" ? targetType : (targetStacking ?? targetType),
  };
}

/** Attribute numeric reuse independently of semantic fidelity or chart completeness. */
export function matchTemplateChartFigures(
  pageCharts: readonly PageChartFigure[],
  sources: readonly TemplateChartSource[],
): readonly TemplateChartFigureMatch[] {
  const matches: TemplateChartFigureMatch[] = [];
  for (const pageChart of pageCharts) {
    const page = pageChartVectors(pageChart);
    if (!page) continue;
    for (const source of sources) {
      const unused = new Set(source.series.map((_, index) => index));
      const values: string[] = [];
      let allMatched = true;
      let categoriesMatch = true;
      let valueMatch: "exact" | "displayed" = "exact";
      for (const outputSeries of page.series) {
        const candidates = [...unused].flatMap((index) => {
          const match = compareSeries(outputSeries.values, source.series[index]!);
          return match ? [{ index, match }] : [];
        });
        const categoriesOf = (index: number) => {
          const sourceSeries = source.series[index]!;
          return sourceSeries.categories.length ? sourceSeries.categories : sourceCategories(source);
        };
        const candidate =
          candidates.find(({ index }) => sameCategories(outputSeries.categories, categoriesOf(index))) ?? candidates[0];
        if (!candidate) {
          allMatched = false;
          continue;
        }
        const matchIndex = candidate.index;
        if (candidate.match === "displayed") valueMatch = "displayed";
        if (!sameCategories(outputSeries.categories, categoriesOf(matchIndex))) categoriesMatch = false;
        unused.delete(matchIndex);
        for (const value of outputSeries.values) {
          if (value !== null && !values.includes(value)) values.push(value);
        }
      }
      if (!values.length) continue;
      const substitution = allMatched && categoriesMatch && !unused.size ? outputSubstitution(source, page) : undefined;
      matches.push({
        sourcePage: source.sourcePage,
        chartId: source.chartId,
        sourceType: source.grouping || source.type,
        outputTypes: page.outputTypes,
        values,
        valueMatch,
        sourcePeriods: source.sourcePeriods,
        ...(!categoriesMatch ? { categoriesMatch: false as const } : {}),
        ...(substitution ? { substitution } : {}),
      });
    }
  }
  return matches;
}
