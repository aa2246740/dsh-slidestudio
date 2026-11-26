import {
  axisTitlesSvg,
  canvasChartSwatch,
  chartLayoutFor,
  chartRuntime,
  chartSemanticInput,
  chartSvgShell,
  legendSvg,
} from "./chart-paint-layout.js";
import {
  paintComboChartSvg,
  paintDoughnutChartSvg,
  paintRadarChartSvg,
  paintScatterSvg,
  paintStackedChartSvg,
  paintWaterfallSvg,
} from "./chart-paint-special.js";
import { areaFillAttributes, chartFillPlan, injectChartDefs } from "./chart-paint-gradient.js";
import { escapeHtmlText } from "./rich-text-editor.js";
/** @import { RenderElement } from "@open-slidestudio/canvas-session" */
/** @import { CategoricalChartModel } from "@open-slidestudio/pptd-v2" */
/** @import { SpecialChartInput } from "./chart-paint-special.js" */

export { canvasChartSwatch, configureChartRuntime } from "./chart-paint-layout.js";
/** @typedef {RenderElement & {chartFocusRow?: number}} ChartRenderElement */
/** @typedef {{elements: RenderElement[], backgroundCss: string, focusRow: number, neutralChrome?: boolean}} ChartPaintContext */
/**
 *  What the categorical painters below share: the special-chart input plus the value-axis helpers.
 * @typedef {SpecialChartInput & {type: string, yFor: (value: number) => number, zeroY: number, gridSvg: string, axisSvg: string}} CategoricalPaint
 */

const FOCUS_STROKE = ` stroke="#2f86f0" stroke-width="2"`;

/**
 *  The colour behind a chart, by the exporter's shared rule (`chartSurfaceColor` in pptd-v2): the chart's own background, else the topmost opaque plain panel covering it, else the page surface.
 *  A custom path, another preset, a picture, a multi-stop gradient or a translucent panel never sets it (ruling 121). Each element's `solidCss` is the one solid colour its fill shows
 *  (`opaqueSolidHex`), the colour the exporter takes for the panel.
 * @param {ChartRenderElement} el @param {ChartPaintContext} context
 */
export function chartSurfaceOf(el, context) {
  const elements = context.elements;
  // The painter may be handed a copy of the element, so locate it by id.
  const index = elements.findIndex((candidate) => candidate === el || (el.id && candidate.id === el.id));
  return chartRuntime().chartSurfaceColor({
    bounds: el.bounds || [0, 0, 0, 0],
    below:
      index <= 0
        ? []
        : elements.slice(0, index).map((other) => ({
            bounds: other.bounds || [0, 0, 0, 0],
            plainRect: other.plainRect === true,
            hidden: other.hidden === true,
            solidCss: other.solidCss,
          })),
    chartCss: el.chartBackgroundCss,
    pageCss: context.backgroundCss,
  });
}

/**
 *  The context a chart is painted with. Its surroundings (the element under it, the page background) and its chrome come from `page`, the page the chart sits on, so a history preview
 *  or thumbnail paints its own version, not the deck open in the editor.
 * @param {{elements?: RenderElement[], backgroundCss?: string, neutralChrome?: boolean} | null | undefined} page
 * @param {number} focusRow
 * @returns {ChartPaintContext}
 */
export function chartContextOf(page, focusRow) {
  return {
    elements: Array.isArray(page?.elements) ? page.elements : [],
    backgroundCss: page?.backgroundCss || "",
    focusRow,
    neutralChrome: page?.neutralChrome === true,
  };
}

/** @param {ChartRenderElement} el @param {ChartPaintContext} context */
export function paintChartSvg(el, context) {
  // Gradient series need their defs inside this chart's own SVG; injecting once here covers every return path of the painter below.
  const fills = chartFillPlan(el.id, el.chartSeries);
  return injectChartDefs(paintChartMarkup(el, context, fills), fills.defs);
}

/** Ink and grid colours for the surface behind the chart. @param {ChartRenderElement} el @param {ChartPaintContext} context */
function chartInk(el, context) {
  const rt = chartRuntime();
  const darkSurface = rt.isDarkChartSurface(chartSurfaceOf(el, context));
  const chrome = rt.chartChrome(context);
  return {
    ink: darkSurface ? chrome.ink.dark : chrome.ink.light,
    gridColor: darkSurface ? chrome.grid.dark : chrome.grid.light,
  };
}

/** Axis titles at the chart edges, for painters without a reserved title band. @param {ChartRenderElement} el @param {string} ink */
function edgeAxisSvg(el, ink) {
  const px = chartRuntime().CHART_TEXT_PX.axisTitle;
  const [, , w, h] = el.bounds;
  const axis = el.chartAxis || {};
  const x = axis.x
    ? `<text x="${w / 2}" y="${h - 4}" text-anchor="middle" font-size="${px}" fill="${ink}">${escapeHtmlText(axis.x)}</text>`
    : "";
  const y = axis.y
    ? `<text transform="translate(10 ${h / 2}) rotate(-90)" text-anchor="middle" font-size="${px}" fill="${ink}">${escapeHtmlText(axis.y)}</text>`
    : "";
  return x + y;
}

/**
 * @param {ChartRenderElement} el @param {ChartPaintContext} context
 * @param {ReturnType<typeof chartFillPlan>} fills
 */
function paintChartMarkup(el, context, fills) {
  const rt = chartRuntime();
  const [, , w, h] = el.bounds;
  const semanticInput = chartSemanticInput(el);
  const type = rt.chartKind(semanticInput);
  // Deck text is LLM/user data — everything interpolated into the SVG string is escaped so a hostile title/label cannot pivot into markup.
  /** @param {number} i */
  const swatch = (i) => escapeHtmlText(fills.paintFor(i) ?? canvasChartSwatch(el, i));
  const { ink, gridColor } = chartInk(el, context);
  const axisSvg = edgeAxisSvg(el, ink);
  const showLabels = el.chartLabels !== false;
  const title = escapeHtmlText(el.chartTitle || "");
  const titleSvg = title
    ? `<text x="12" y="18" font-size="${rt.CHART_TEXT_PX.title}" fill="${ink}">${title}</text>`
    : "";
  if (type === "waterfall") return paintWaterfallSvg(el, w, h, titleSvg, axisSvg, ink, gridColor);
  if (type === "scatter") return paintScatterSvg(el, w, h, titleSvg, ink, gridColor);
  const categorical = rt.categoricalChartModel(semanticInput);
  const combo =
    new Set(categorical.series.map((series) => series.kind)).size >= 2 &&
    categorical.series.some((series) => series.axis === "secondary");
  if (combo) {
    return paintComboChartSvg(el, w, h, titleSvg, categorical, swatch, ink, gridColor, showLabels);
  }
  const input = categoricalPaint(el, categorical, {
    type,
    titleSvg,
    axisSvg,
    swatch,
    ink,
    gridColor,
    showLabels,
    focusRow: el.chartFocusRow ?? context.focusRow,
  });
  return paintCategorical(input);
}

/** @param {CategoricalPaint} input */
function paintCategorical(input) {
  const { type, categorical } = input;
  if (type === "radar") return paintRadarChartSvg(input);
  if (type === "doughnut") return paintDoughnutChartSvg(input);
  if (categorical.grouping !== "clustered") return paintStackedChartSvg(input);
  if (type === "pie") return paintPieSvg(input);
  if (type === "area" || type === "line") return paintLineAreaSvg(input);
  if (categorical.orientation === "horizontal") return paintHorizontalBarsSvg(input);
  return paintColumnBarsSvg(input);
}

/**
 * Lay out a categorical chart once and collect what every categorical painter reads.
 * @param {ChartRenderElement} el @param {CategoricalChartModel} categorical
 * @param {{type: string, titleSvg: string, axisSvg: string, swatch: (index: number) => string, ink: string, gridColor: string, showLabels: boolean, focusRow: number}} base
 * @returns {CategoricalPaint}
 */
function categoricalPaint(el, categorical, base) {
  const rt = chartRuntime();
  const { CHART_TEXT_PX } = rt;
  const { ink, gridColor, swatch, type } = base;
  const [, , w, h] = el.bounds;
  const scale = categorical.scale;
  const range = Math.max(1e-9, scale.max - scale.min);
  const { layout } = chartLayoutFor(el, categorical);
  const plot = layout.plot;
  /** @param {number} v */
  const yFor = (v) => plot.y + plot.h - ((v - scale.min) / range) * plot.h;
  const valueDecimals = rt.seriesDecimals(categorical.series.flatMap((s) => s.values));
  const gridSvg =
    type === "pie"
      ? ""
      : scale.ticks
          .map((tick) => {
            const y = yFor(tick);
            return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="${gridColor}" stroke-width="1"/><text x="${plot.x - 6}" y="${y + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(rt.formatChartValue(tick, scale.tickDecimals))}</text>`;
          })
          .join("");
  const byCategory = type === "pie" || type === "doughnut";
  const names = byCategory ? categorical.categories : categorical.series.map((s) => s.name);
  return {
    ...base,
    w,
    h,
    layout,
    categorical,
    legend: legendSvg(layout, swatch, ink, CHART_TEXT_PX.legend, names),
    axisTitles: axisTitlesSvg(layout, el.chartAxis || {}, ink),
    catBandY: layout.categoryBand ? layout.categoryBand.y + CHART_TEXT_PX.category : plot.y + plot.h + 13,
    valueText: (v) => rt.formatChartValue(v, valueDecimals || undefined),
    yFor,
    zeroY: yFor(Math.max(scale.min, Math.min(0, scale.max))),
    gridSvg,
  };
}

/** @param {CategoricalPaint} input */
function paintPieSvg(input) {
  const { layout, categorical, swatch, ink, showLabels, w, h } = input;
  const px = chartRuntime().CHART_TEXT_PX.dataLabel;
  const vals = categorical.series[0]?.values || [];
  const sum = vals.reduce((a, b) => a + b, 0);
  const cx = layout.plot.x + layout.plot.w / 2;
  const cy = layout.plot.y + layout.plot.h / 2;
  const r = Math.min(layout.plot.w, layout.plot.h) / 2;
  const chrome = `${input.legend}${input.axisSvg}`;
  if (sum <= 0) return chartSvgShell(w, h, `${input.titleSvg}${chrome}`);
  let a0 = -Math.PI / 2;
  /** @type {string[]} */
  const parts = [];
  vals.forEach((v, i) => {
    if (v <= 0) return;
    const a1 = a0 + (v / sum) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = `M ${cx} ${cy} L ${cx + Math.cos(a0) * r} ${cy + Math.sin(a0) * r} A ${r} ${r} 0 ${large} 1 ${cx + Math.cos(a1) * r} ${cy + Math.sin(a1) * r} Z`;
    parts.push(`<path d="${d}" fill="${swatch(i)}"></path>`);
    if (showLabels) {
      const mid = (a0 + a1) / 2;
      const lx = cx + Math.cos(mid) * r * 0.55;
      const ly = cy + Math.sin(mid) * r * 0.55;
      const pct = Math.round((v / sum) * 100);
      const name = categorical.categories[i] ?? "";
      parts.push(
        `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="${px}" fill="${ink}">${escapeHtmlText(name)} ${pct}%</text>`,
      );
    }
    a0 = a1;
  });
  return chartSvgShell(w, h, `${input.titleSvg}${parts.join("")}${chrome}`);
}

/** @param {CategoricalPaint} input */
function paintLineAreaSvg(input) {
  const { layout, categorical, swatch, ink, showLabels, yFor, zeroY, valueText } = input;
  const { CHART_TEXT_PX } = chartRuntime();
  const plot = layout.plot;
  const categories = categorical.categories;
  const xStep = plot.w / Math.max(1, categories.length);
  /** @param {number} i */
  const center = (i) => plot.x + xStep * i + xStep / 2;
  /** @param {number} v @param {number} i */
  const valueLabel = (v, i) => {
    const y = yFor(v);
    return `<text x="${center(i)}" y="${v >= 0 ? Math.max(plot.y + 11, y - 6) : y + 14}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(valueText(v))}</text>`;
  };
  const paths = categorical.series
    .map((series, s) => {
      const col = series.values;
      const pts = col.map((v, i) => `${center(i)},${yFor(v)}`).join(" ");
      const color = swatch(s);
      const valueLabs = showLabels ? col.map(valueLabel).join("") : "";
      if (input.type === "area") {
        const base = `${center(categories.length - 1)},${zeroY} ${center(0)},${zeroY}`;
        return `<polygon ${areaFillAttributes(color, "55")} stroke="${color}" stroke-width="2" points="${pts} ${base}"></polygon>${valueLabs}`;
      }
      const dots = col.map((v, i) => `<circle cx="${center(i)}" cy="${yFor(v)}" r="3" fill="${color}"/>`).join("");
      return `<polyline fill="none" stroke="${color}" stroke-width="3" points="${pts}"></polyline>${dots}${valueLabs}`;
    })
    .join("");
  const catLabs = categories
    .map(
      (category, i) =>
        `<text x="${center(i)}" y="${input.catBandY}" text-anchor="middle" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(category)}</text>`,
    )
    .join("");
  return chartSvgShell(
    input.w,
    input.h,
    `${input.titleSvg}${input.gridSvg}${paths}${catLabs}${input.legend}${input.axisTitles}`,
  );
}

/** @param {string[]} labels @param {number} fontPx */
function measureChartTextMax(labels, fontPx) {
  const { measureChartText } = chartRuntime();
  return labels.reduce((best, label) => Math.max(best, measureChartText(String(label), fontPx)), 0);
}

/** @param {CategoricalPaint} input */
function paintHorizontalBarsSvg(input) {
  const { layout, categorical, swatch, ink, gridColor, showLabels, focusRow, valueText } = input;
  const { CHART_TEXT_PX, formatChartValue } = chartRuntime();
  const { categories, series: chartSeries, scale } = categorical;
  const plot = layout.plot;
  const seriesCount = Math.max(1, chartSeries.length);
  const range = Math.max(1e-9, scale.max - scale.min);
  const left = plot.x + measureChartTextMax(categories, CHART_TEXT_PX.category) + 8;
  const hPlot = { x: left, y: plot.y, w: Math.max(1, plot.x + plot.w - left), h: plot.h };
  /** @param {number} v */
  const xFor = (v) => hPlot.x + ((v - scale.min) / range) * hPlot.w;
  const zeroX = xFor(Math.max(scale.min, Math.min(0, scale.max)));
  const grid = scale.ticks
    .map((tick) => {
      const x = xFor(tick);
      return `<line x1="${x}" y1="${hPlot.y}" x2="${x}" y2="${hPlot.y + hPlot.h}" stroke="${gridColor}" stroke-width="1"/><text x="${x}" y="${input.catBandY}" text-anchor="middle" font-size="${CHART_TEXT_PX.tick}" fill="${ink}">${escapeHtmlText(formatChartValue(tick, scale.tickDecimals))}</text>`;
    })
    .join("");
  const groupGap = 7;
  const groupH = categories.length
    ? (hPlot.h - groupGap * Math.max(0, categories.length - 1)) / categories.length
    : hPlot.h;
  const barGap = 2;
  const barH = Math.max(3, (groupH - barGap * (seriesCount - 1)) / seriesCount);
  /** @param {number} rowIndex @param {number} groupY */
  const rowBars = (rowIndex, groupY) =>
    chartSeries
      .map((series, seriesIndex) => {
        const value = series.values[rowIndex] || 0;
        const x0 = Math.min(xFor(value), zeroX);
        const x1 = Math.max(xFor(value), zeroX);
        const y = groupY + seriesIndex * (barH + barGap);
        const fill = seriesCount === 1 ? swatch(rowIndex) : swatch(seriesIndex);
        const highlight = focusRow === rowIndex ? FOCUS_STROKE : "";
        const valueLabel =
          showLabels && value !== 0
            ? `<text x="${value >= 0 ? x1 + 4 : x0 - 4}" y="${y + barH / 2 + 3}" text-anchor="${value >= 0 ? "start" : "end"}" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(valueText(value))}</text>`
            : "";
        return `<rect x="${x0}" y="${y}" width="${Math.max(1, x1 - x0)}" height="${barH}" fill="${fill}"${highlight}></rect>${valueLabel}`;
      })
      .join("");
  const bars = categories
    .map((category, rowIndex) => {
      const groupY = hPlot.y + rowIndex * (groupH + groupGap);
      const categoryLabel = `<text x="${hPlot.x - 7}" y="${groupY + groupH / 2 + 3}" text-anchor="end" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(category)}</text>`;
      return categoryLabel + rowBars(rowIndex, groupY);
    })
    .join("");
  return chartSvgShell(input.w, input.h, `${input.titleSvg}${grid}${bars}${input.legend}${input.axisTitles}`);
}

/** @param {CategoricalPaint} input */
function paintColumnBarsSvg(input) {
  const { layout, categorical, swatch, ink, showLabels, focusRow, valueText, yFor, zeroY } = input;
  const { CHART_TEXT_PX } = chartRuntime();
  const { categories, series: chartSeries } = categorical;
  const plot = layout.plot;
  const seriesCount = Math.max(1, chartSeries.length);
  const groupGap = 10;
  const barGap = 2;
  const groupW = categories.length ? (plot.w - groupGap * (categories.length - 1)) / categories.length : plot.w;
  const bw = Math.max(3, (groupW - barGap * (seriesCount - 1)) / seriesCount);
  /** @param {number} i @param {number} s @param {number} gx */
  const bar = (i, s, gx) => {
    const v = chartSeries[s]?.values[i] || 0;
    const y = yFor(v);
    const top = Math.min(y, zeroY);
    const height = Math.max(1, Math.abs(zeroY - y));
    const x = gx + s * (bw + barGap);
    const fill = seriesCount === 1 ? swatch(i) : swatch(s);
    const hl = focusRow === i ? FOCUS_STROKE : "";
    // Same place as the exported outEnd label: just above a positive bar, just below a negative one. The shared layout reserves both bands, so the label stays off the fill and the category names.
    const labelY = v >= 0 ? top - 4 : top + height + 11;
    const valLab =
      showLabels && v !== 0
        ? `<text x="${x + bw / 2}" y="${labelY}" text-anchor="middle" font-size="${CHART_TEXT_PX.dataLabel}" fill="${ink}">${escapeHtmlText(valueText(v))}</text>`
        : "";
    return `<rect x="${x}" y="${top}" width="${bw}" height="${height}" fill="${fill}"${hl}></rect>${valLab}`;
  };
  const bars = categories
    .map((category, i) => {
      const gx = plot.x + i * (groupW + groupGap);
      const parts = Array.from({ length: seriesCount }, (_, s) => bar(i, s, gx));
      const xLab = `<text x="${gx + groupW / 2}" y="${input.catBandY}" text-anchor="middle" font-size="${CHART_TEXT_PX.category}" fill="${ink}">${escapeHtmlText(category)}</text>`;
      return parts.join("") + xLab;
    })
    .join("");
  return chartSvgShell(input.w, input.h, `${input.titleSvg}${input.gridSvg}${bars}${input.legend}${input.axisTitles}`);
}
