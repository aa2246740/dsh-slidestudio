/**
 * Chart kind under a monthly update. The new month's values never equal last month's cached ones, so
 * the value-based substitution check cannot see that a chart changed kind. A page chart with exactly
 * the series names of a chart in last month's deck and the same number of categories is that chart's
 * counterpart (category labels carry the period and are often shortened, so they are not compared).
 * When no counterpart has the page chart's kind (type, or stacking), a non-blocking hint names it so
 * the Agent can restore the kind or say why in the delivery message. Other charts are not judged.
 */
import type { MaterialFigureReading } from "./material-figures.js";
import { chartTypeLabel, type PageChartFigure, type TemplateChartSource } from "./template-chart-provenance.js";

const MAX_LISTED = 4;

type Stacking = "stacked" | "percentStacked";
type Kind = Readonly<{ family: string; stacking?: Stacking }>;

export type ChartKindDrift = Readonly<{
  sourcePage: number;
  sourceKind: string;
  pageKind: string;
}>;

const normalized = (value: unknown): string =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "");

function stackingOf(grouping: string | undefined): Stacking | undefined {
  return grouping === "stacked" || grouping === "percentStacked" ? grouping : undefined;
}

function sourceKind(chart: TemplateChartSource): Kind {
  const stacking = stackingOf(chart.grouping);
  return { family: chart.type, ...(stacking ? { stacking } : {}) };
}

/** Several series types make a combination, as in the template's own combination charts. */
function pageKind(chart: PageChartFigure): Kind {
  const types = [...new Set(chart.series.map((series) => series.type))];
  const stacking = stackingOf(chart.grouping);
  return {
    family: types.length > 1 ? "combination" : (types[0] ?? "unknown"),
    ...(stacking ? { stacking } : {}),
  };
}

function kindLabel(kind: Kind): string {
  const stack = kind.stacking === "stacked" ? "（堆积）" : kind.stacking === "percentStacked" ? "（百分比堆积）" : "";
  return `${chartTypeLabel(kind.family)}${stack}`;
}

const sameKind = (left: Kind, right: Kind): boolean => left.family === right.family && left.stacking === right.stacking;

type Labels = Readonly<{ categories: number; series: ReadonlySet<string> }>;

function pageLabels(chart: PageChartFigure): Labels {
  return {
    categories: chart.rows.length,
    series: new Set(chart.series.map((item) => normalized(item.encode.y ?? item.encode.value)).filter(Boolean)),
  };
}

function sourceLabels(chart: TemplateChartSource): Labels {
  const categories = chart.categories.length ? chart.categories : (chart.series[0]?.categories ?? []);
  return {
    categories: categories.length,
    series: new Set(chart.series.map((item) => normalized(item.name)).filter(Boolean)),
  };
}

/**
 * The page charts that are not the kind of their counterpart in a read template. A chart with
 * several counterparts of different kinds is fine when one of them has the page's kind.
 */
export function chartKindDrifts(
  pageCharts: readonly PageChartFigure[],
  readings: readonly MaterialFigureReading[],
): readonly ChartKindDrift[] {
  const sources = readings.flatMap((reading) => reading.templateCharts ?? []);
  if (!sources.length) return [];
  const drifts: ChartKindDrift[] = [];
  for (const chart of pageCharts) {
    const kind = pageKind(chart);
    if (kind.family === "unknown") continue;
    const labels = pageLabels(chart);
    if (!labels.categories || !labels.series.size) continue;
    const counterparts = sources
      .filter((source) => source.type !== "unknown")
      .filter((source) => {
        const wanted = sourceLabels(source);
        return (
          labels.categories === wanted.categories &&
          labels.series.size === wanted.series.size &&
          [...labels.series].every((name) => wanted.series.has(name))
        );
      })
      .sort((left, right) => left.sourcePage - right.sourcePage);
    if (!counterparts.length || counterparts.some((source) => sameKind(sourceKind(source), kind))) {
      continue;
    }
    const first = counterparts[0]!;
    drifts.push({
      sourcePage: first.sourcePage,
      sourceKind: kindLabel(sourceKind(first)),
      pageKind: kindLabel(kind),
    });
  }
  return drifts;
}

/** Non-blocking hint naming up to four charts; undefined when every chart kept its kind. */
export function chartKindDriftHint(drifts: readonly ChartKindDrift[]): string | undefined {
  if (!drifts.length) return undefined;
  const listed = drifts
    .slice(0, MAX_LISTED)
    .map(
      (item) =>
        `类别和系列名与上月稿第 ${item.sourcePage} 页的图表一致，上月稿是${item.sourceKind}，本页是${item.pageKind}`,
    )
    .join("；");
  return `提示：本页有 ${drifts.length} 个图表和上月稿不是同一种类型：${listed}。月报要保持图表类型，请改回；确有原因时在交付说明里说明。这条提示不阻止保存。`;
}
