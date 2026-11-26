/**
 * Shared chart mapping: canvas SVG and PPTX export must use the same
 * series, colors, value scale, legend, and layout. Everything geometric and
 * typographic comes from `pptd-v2`'s chart-layout contract so the exported
 * chart lands where the canvas painted it.
 */
import {
  alignedSecondaryScale,
  categoricalChartModel,
  chartLayout,
  chartNumberFormatCode,
  chartSwatch,
  CHART_PALETTE,
  formatChartValue,
  resolveChartLegend,
  seriesDecimals,
  widestTickText,
  type CategoricalKind,
  type ChartElement,
  type ChartGrouping,
  type ChartLayout,
  type ChartScale,
  type GradientFill,
  type LegendSpec,
} from "@open-slidestudio/pptd-v2";

/** Re-export so mapChart can share the same palette bookkeeping. */
export { chartSwatch };
export const DEFAULT_CHART_PALETTE = CHART_PALETTE;

export type ChartExportSeries = {
  name: string;
  labels: string[];
  values: number[];
  pptxType: CategoricalKind;
  axis: "primary" | "secondary";
  color: string;
  /** Per-series Excel format code for its data labels. */
  formatCode: string;
  /** Gradient fill the series paints with; written as `a:gradFill` in its `c:spPr`. */
  gradient?: GradientFill;
};

export type ChartExportModel = {
  pptxType: CategoricalKind;
  /** Bar grouping. Stacked and percent-stacked bars take a full overlap (`c:overlap` 100). */
  grouping: ChartGrouping;
  barDir?: "col" | "bar";
  categories: string[];
  series: ChartExportSeries[];
  /** Hex with #; one color per bar (single series) or per series. */
  colors: string[];
  /** Shared nice value axis for the primary axis. */
  scale: ChartScale;
  secondaryScale?: ChartScale;
  /** Kept for compatibility with existing tests: scale.max. */
  valueMax: number;
  primaryValueMax: number;
  secondaryValueMax?: number;
  title?: string;
  legend: LegendSpec;
  showLegend: boolean;
  showValue: boolean;
  /** Max decimals across all series — the workbook display format. */
  dataLabelFormatCode: string;
  /** True when the model spreads `colors` per category (single series bar). */
  perCategoryColors: boolean;
  /** Element-relative geometry shared with the canvas painter. */
  layout: ChartLayout;
};

function chartTitle(el: ChartElement): string | undefined {
  if (!el.title) return undefined;
  if (typeof el.title === "string") return el.title;
  if (typeof el.title === "object" && "text" in el.title) {
    return String((el.title as { text: string }).text);
  }
  return undefined;
}

/**
 * The gradient a series paints with. A single-series chart shares its one fill across every
 * series, as the editor's chart paint does (`chartFillPlan`).
 */
function seriesGradient(el: ChartElement, index: number): GradientFill | undefined {
  const fill = el.series.length === 1 ? el.series[0]?.fill : el.series[index]?.fill;
  return typeof fill === "object" && fill.type === "gradient" ? fill : undefined;
}

export function mapChartElement(el: ChartElement): ChartExportModel {
  const semantic = categoricalChartModel(el);
  const categories = semantic.categories;
  const values = semantic.series.map((series) => series.values);
  const legend = resolveChartLegend(el.legend);
  const secondarySeries = semantic.series.filter((s) => s.axis === "secondary");
  const secondaryScale = secondarySeries.length
    ? alignedSecondaryScale(
        secondarySeries.flatMap((s) => s.values),
        semantic.scale,
      )
    : undefined;
  const dataLabelFormatCode = chartNumberFormatCode(Math.max(0, ...values.map((v) => seriesDecimals(v))));
  const series: ChartExportSeries[] = semantic.series.map((item, index) => ({
    name: item.name,
    labels: categories,
    values: item.values,
    pptxType: item.kind,
    axis: item.axis,
    color: chartSwatch(el, index),
    formatCode: chartNumberFormatCode(seriesDecimals(item.values)),
    gradient: seriesGradient(el, index),
  }));
  const pptxType = semantic.kind;
  // A gradient bar series paints one fill across its bars, so it skips the per-point colours
  // pptxgenjs writes for a single series.
  const perCategoryColors =
    pptxType === "bar" && semantic.series.length === 1 && semantic.orientation === "vertical" && !series[0]?.gradient;
  const sliced = pptxType === "pie" || pptxType === "doughnut";
  const colors = sliced
    ? categories.map((_, i) => chartSwatch(el, i, categories.length))
    : perCategoryColors
      ? // One series is one color. Passing the category count made later bars
        // look like extra series and pull CHART_PALETTE (amber/green) even
        // when the author set a single fill.
        categories.map((_, i) => chartSwatch(el, i, 1))
      : series.map((_, s) => chartSwatch(el, s, series.length));
  const primaryValues = semantic.series
    .filter((series) => series.axis === "primary")
    .flatMap((series) => series.values);
  const secondaryValues = secondarySeries.flatMap((s) => s.values);
  // A percent-stacked axis paints whole percentages, so its left reserve is sized from them.
  const widestTickLabel = widestTickText(semantic.scale, semantic.grouping === "percentStacked");
  const secondaryTickLabels = secondaryScale
    ? secondaryScale.ticks.map((t) => formatChartValue(t, secondaryScale.tickDecimals))
    : undefined;
  const widestSecondaryTickLabel = secondaryTickLabels?.reduce(
    (best, label) => (label.length > best.length ? label : best),
    "0",
  );
  const widestCategoryLabel = categories.reduce(
    (best, label) => (String(label).length > best.length ? String(label) : best),
    "",
  );
  const legendItems = sliced ? categories : series.map((series) => series.name);
  const bounds = el.bounds;
  const layout = chartLayout(
    { w: bounds[2], h: bounds[3] },
    {
      title: chartTitle(el) ?? "",
      legend,
      legendItems,
      widestTickLabel,
      widestCategoryLabel,
      categoryCount: Math.max(1, categories.length),
      hasSecondaryAxis: Boolean(secondaryScale),
      widestSecondaryTickLabel,
      axis: el.axis,
      reserveBelowLabel:
        !sliced && semantic.orientation !== "horizontal" && (semantic.scale.min < 0 || (secondaryScale?.min ?? 0) < 0),
    },
  );
  return {
    pptxType,
    grouping: semantic.grouping,
    barDir: pptxType === "bar" ? (semantic.orientation === "horizontal" ? "bar" : "col") : undefined,
    categories,
    series,
    colors,
    scale: semantic.scale,
    secondaryScale,
    valueMax: semantic.scale.max,
    primaryValueMax: semantic.scale.max,
    secondaryValueMax: secondaryScale?.max,
    title: chartTitle(el),
    legend,
    showLegend: legend.show,
    showValue: el.labels !== false,
    dataLabelFormatCode,
    perCategoryColors,
    layout,
  };
}

export function hexNoHash(color: string): string {
  return color.replace(/^#/, "").toUpperCase();
}
