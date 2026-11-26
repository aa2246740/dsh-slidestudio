import { escapeHtmlText } from "./rich-text-editor.js";

/** @typedef {import("@open-slidestudio/canvas-session").RenderElement} RenderElement */
/** @typedef {import("@open-slidestudio/pptd-v2").CategoricalChartModel} CategoricalChartModel */
/** @typedef {import("@open-slidestudio/pptd-v2").ChartScale} ChartScale */
/** @typedef {import("@open-slidestudio/pptd-v2").ChartLayout} ChartLayout */
/** @typedef {{scale?: ChartScale, secondaryScale?: ChartScale, categories?: string[], title?: string}} LayoutOptions */
/**
 *  The chart runtime the painters read: the browser loads it from `/runtime/chart-semantics.js` and `/runtime/chart-layout.js` (the pptd-v2 build), Node tests from `@open-slidestudio/pptd-v2`.
 *  Browser modules here never import `/runtime/` themselves; the editor hands the runtime over once with `configureChartRuntime`.
 * @typedef {Pick<typeof import("@open-slidestudio/pptd-v2"),
 *  "categoricalChartModel" | "chartKind" | "chartSurfaceColor" | "isDarkChartSurface" | "waterfallChartModel" | "scatterChartModel" | "placeScatterLabels"
 *  | "CHART_TEXT_PX" | "chartChrome" | "chartLayout" | "chartSwatch" | "formatChartValue" | "measureChartText" | "seriesDecimals" | "resolveChartLegend"
 *  | "widestTickText" | "alignedSecondaryScale" | "percentText">} ChartRuntime
 */

/** @type {ChartRuntime | null} */
let runtime = null;

/**
 * Hand the painters the shared chart runtime. Call once before the first chart paints.
 * @param {ChartRuntime} next
 */
export function configureChartRuntime(next) {
  runtime = next;
}

/** @returns {ChartRuntime} */
export function chartRuntime() {
  if (!runtime) throw new Error("Chart runtime is not configured; call configureChartRuntime first");
  return runtime;
}

/** @param {RenderElement} el @param {number} i */
export function canvasChartSwatch(el, i) {
  const declaredSeriesCount = Array.isArray(el.chartSeries) ? el.chartSeries.length : 0;
  const dataSeriesCount = Math.max(0, (el.chartData?.cols?.length || 0) - 1);
  const seriesCount = Math.max(declaredSeriesCount, dataSeriesCount);
  return chartRuntime().chartSwatch(
    {
      colors: el.chartColors,
      // Explicit colors return before reading series; retain that short-circuit.
      get series() {
        if (!el.chartSeries) throw new TypeError("Chart series are missing");
        return el.chartSeries;
      },
    },
    i,
    seriesCount,
  );
}

/** @param {RenderElement} el @returns {Parameters<ChartRuntime["chartKind"]>[0]} */
export function chartSemanticInput(el) {
  return {
    data: el.chartData || { cols: [], rows: [] },
    series: Array.isArray(el.chartSeries) && el.chartSeries.length ? el.chartSeries : [{ type: el.chartType || "bar" }],
    // The render model carries the bar grouping; without it stacked bars read as clustered.
    grouping: el.chartGrouping,
  };
}

/** @param {string[]} labels */
function widestLabel(labels) {
  return labels.reduce((best, label) => (label.length > best.length ? label : best), "");
}

/** Kinds that paint no value labels below the axis, so they never reserve space for them. */
const NO_BELOW_LABEL_KINDS = new Set(["pie", "doughnut", "radar", "scatter", "waterfall"]);

/**
 * Whether the layout keeps a band for value labels under a negative bar.
 * @param {string} kind @param {CategoricalChartModel | null} categorical
 * @param {ChartScale | undefined} scale @param {ChartScale | undefined} secondaryScale
 */
function reservesBelowLabel(kind, categorical, scale, secondaryScale) {
  if (NO_BELOW_LABEL_KINDS.has(kind) || categorical?.orientation === "horizontal") return false;
  return (scale?.min ?? 0) < 0 || (secondaryScale?.min ?? 0) < 0;
}

/**
 *  Shared painter plumbing: resolve the legend spec, run the same chartLayout the exporter uses, and convert every rect to the element's local frame. `tickLabels`/`categoryLabels` feed the axis reserves.
 * @param {RenderElement} el @param {CategoricalChartModel | null} categorical @param {LayoutOptions} [opts]
 */
export function chartLayoutFor(el, categorical, opts = {}) {
  const rt = chartRuntime();
  const legend = rt.resolveChartLegend(el.chartLegend);
  const axis = el.chartAxis || {};
  const scale = opts.scale || categorical?.scale;
  const tickDecimals = scale ? scale.tickDecimals : 0;
  // A percent-stacked axis paints whole percentages, so its left reserve is sized from them.
  const widestTickLabel = scale ? rt.widestTickText(scale, categorical?.grouping === "percentStacked") : "0";
  const categories = categorical?.categories ?? opts.categories ?? [];
  const secondaryScale = opts.secondaryScale;
  const widestSecondaryTickLabel = secondaryScale
    ? widestLabel(secondaryScale.ticks.map((t) => rt.formatChartValue(t, secondaryScale.tickDecimals)))
    : undefined;
  const kind = rt.chartKind(chartSemanticInput(el));
  const legendItems =
    kind === "pie" || kind === "doughnut" ? categories : (categorical?.series ?? []).map((series) => series.name);
  const layout = rt.chartLayout(
    { w: el.bounds[2], h: el.bounds[3] },
    {
      title: el.chartTitle || opts.title || "",
      legend,
      legendItems,
      widestTickLabel,
      widestCategoryLabel: widestLabel(categories.map(String)),
      categoryCount: Math.max(1, categories.length),
      hasSecondaryAxis: Boolean(secondaryScale),
      widestSecondaryTickLabel,
      axis: { x: axis.x, y: axis.y, secondaryY: axis.secondaryY },
      reserveBelowLabel: reservesBelowLabel(kind, categorical, scale, secondaryScale),
    },
  );
  return { legend, layout, scale, tickDecimals };
}

/** @param {ChartLayout} layout @param {(index: number) => string} swatch @param {string} ink @param {number} [fontPx] @param {string[]} [names] */
export function legendSvg(layout, swatch, ink, fontPx = chartRuntime().CHART_TEXT_PX.legend, names) {
  if (!layout.legend) return "";
  return layout.legend.items
    .map((item, index) => {
      const label = names?.[index] ?? item.name;
      return (
        `<rect x="${item.swatch.x}" y="${item.swatch.y}" width="${item.swatch.w}" height="${item.swatch.h}" fill="${escapeHtmlText(swatch(index))}"></rect>` +
        `<text x="${item.textAnchor.x}" y="${item.textAnchor.y}" font-size="${fontPx}" fill="${ink}">${escapeHtmlText(label)}</text>`
      );
    })
    .join("");
}

const SLIDE_FONT_STACK = 'Arial, "微软雅黑", "Microsoft YaHei", "PingFang SC", sans-serif';

/** The outer `<svg>` every chart painter returns, in the element's own pixel frame. @param {number} w @param {number} h @param {string} body */
export function chartSvgShell(w, h, body) {
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${SLIDE_FONT_STACK}">${body}</svg>`;
}

/**
 * Axis titles placed in the bands the shared layout reserved for them.
 * @param {ChartLayout} layout @param {{x?: string, y?: string, secondaryY?: string}} axis @param {string} ink
 * @param {boolean} [secondary] also paint the secondary value-axis title
 */
export function axisTitlesSvg(layout, axis, ink, secondary = false) {
  const px = chartRuntime().CHART_TEXT_PX.axisTitle;
  const { axisTitleX: x, axisTitleY: y, axisTitleSecondaryY: right } = layout;
  const xTitle = x
    ? `<text x="${x.x + x.w / 2}" y="${x.y + x.h - 3}" text-anchor="middle" font-size="${px}" fill="${ink}">${escapeHtmlText(axis.x || "")}</text>`
    : "";
  const yTitle = y
    ? `<text transform="translate(${y.x + px - 2} ${y.y + y.h / 2}) rotate(-90)" text-anchor="middle" font-size="${px}" fill="${ink}">${escapeHtmlText(axis.y || "")}</text>`
    : "";
  const rightTitle =
    secondary && right
      ? `<text transform="translate(${right.x + 4} ${right.y + right.h / 2}) rotate(90)" text-anchor="middle" font-size="${px}" fill="${ink}">${escapeHtmlText(axis.secondaryY || "")}</text>`
      : "";
  return xTitle + yTitle + rightTitle;
}
