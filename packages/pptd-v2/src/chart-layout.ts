/** Shared chart layout for the canvas and the PPTX exporter. Served as `/runtime/chart-layout.js`; keep it free of Node-only APIs. */
import type { ChartElement, ChartSeries } from "./types.js";

export type Rect = Readonly<{ x: number; y: number; w: number; h: number }>;
export type Point = Readonly<{ x: number; y: number }>;

/** Palette shared by the canvas and the exporter. */
export const CHART_PALETTE = ["#2563EB", "#F59E0B", "#10B981", "#EF4444", "#8B5CF6"] as const;

export {
  CHART_GRID,
  CHART_GRID_NEUTRAL,
  CHART_INK,
  CHART_INK_NEUTRAL,
  chartChrome,
  type ChartChrome,
} from "./chart-chrome.js";

/**
 * Chart text sizes in slide px (the same space `el.bounds` lives in). The
 * canvas writes these as SVG `font-size`; the exporter converts them with
 * `cssPxToPt`. Sizes are fixed slide metrics and never scale with the chart.
 */
export const CHART_TEXT_PX = {
  title: 14,
  legend: 10,
  /** Tick labels on the value axis and scatter axes. */
  tick: 9,
  /** Category labels under/over the axis. */
  category: 10,
  /** Value labels on bars/points. */
  dataLabel: 9,
  axisTitle: 10,
  /** Scatter point labels carry weight 600. */
  scatterLabel: 9,
} as const;

/**
 * Marker the chart XML patcher splits into `<a:latin>` and `<a:ea>`. Charts
 * use the slide default pair, so this is the same value as the font policy's
 * `CHART_FONT_FACE`; chart-layout does not import that module because the
 * browser loads this file on its own.
 */
export const CHART_FONT_FACE = "Arial***微软雅黑";

function seriesFill(series: ChartSeries | undefined): string | undefined {
  const fill = series?.fill;
  if (typeof fill === "string") {
    const s = fill.trim();
    return s || undefined;
  }
  if (fill && typeof fill === "object" && "color" in fill) {
    const c = (fill as { color?: unknown }).color;
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

/**
 * Same swatch rule on both renderers: explicit `el.colors`, then the series
 * fill, then the palette. `seriesCount` may exceed `series.length` when the
 * data table carries more value columns than declared series.
 */
export function chartSwatch(el: Pick<ChartElement, "colors" | "series">, index: number, seriesCount?: number): string {
  const dataSeriesCount = Math.max(0, ((el as ChartElement).data?.cols?.length ?? 1) - 1);
  const effectiveCount = seriesCount ?? Math.max(el.series.length, dataSeriesCount);
  // Single-series: the canvas spreads `el.colors` across categories, so index
  // i addresses the i-th swatch; a missing explicit color falls back to the
  // colors[0] series color. Multi-series: index i addresses the i-th series.
  const explicit =
    effectiveCount <= 1 ? el.colors?.[index]?.trim() || el.colors?.[0]?.trim() : el.colors?.[index]?.trim();
  if (explicit) return explicit;
  const direct = seriesFill(el.series[index]);
  if (direct) return direct;
  if (effectiveCount <= 1) {
    const single = seriesFill(el.series[0]);
    if (single) return single;
  }
  return CHART_PALETTE[index % CHART_PALETTE.length]!;
}

/* ------------------------------------------------------------------ */
/* Number formatting                                                   */
/* ------------------------------------------------------------------ */

const MAX_DECIMALS = 3;

/** Decimals needed to render `values` exactly, capped at MAX_DECIMALS. */
export function seriesDecimals(values: readonly number[]): number {
  let decimals = 0;
  for (const raw of values) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const text = String(v);
    // Exponential forms like 1e-7 render far below the label resolution.
    if (/e/i.test(text)) {
      decimals = MAX_DECIMALS;
      break;
    }
    const dot = text.indexOf(".");
    if (dot < 0) continue;
    decimals = Math.min(MAX_DECIMALS, Math.max(decimals, text.length - dot - 1));
    if (decimals >= MAX_DECIMALS) break;
  }
  return decimals;
}

function decimalsForStep(step: number): number {
  if (step >= 1) return 0;
  const text = String(step);
  const dot = text.indexOf(".");
  if (dot < 0) return 0;
  return Math.min(MAX_DECIMALS, text.length - dot - 1);
}

/**
 * Shared chart number format: thousands separators, `decimals` fraction
 * digits (explicit) or the minimal needed (omitted). A negative value always
 * keeps its minus sign (U+2212). `signed` also writes an explicit plus on a
 * positive value, as waterfall deltas do.
 */
export function formatChartValue(value: number, decimals?: number, opts?: { signed?: boolean }): string {
  const v = Number(value) || 0;
  const absolute = Math.abs(v);
  const body =
    decimals === undefined
      ? Number.isInteger(absolute)
        ? absolute.toLocaleString("en-US")
        : absolute.toLocaleString("en-US", { maximumFractionDigits: MAX_DECIMALS })
      : absolute.toLocaleString("en-US", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
  if (v < 0) return `−${body}`;
  return opts?.signed && v > 0 ? `+${body}` : body;
}

/** Excel number-format code matching formatChartValue (without sign flag). */
export function chartNumberFormatCode(decimals: number): string {
  if (decimals <= 0) return "#,##0";
  return `#,##0.${"0".repeat(Math.min(decimals, MAX_DECIMALS))}`;
}

/** `#,##0.00;-#,##0.00;;` hides zeros on both halves; used for combo labels. */
export function chartZeroHiddenFormatCode(formatCode: string): string {
  return `${formatCode};-${formatCode};;`;
}

/**
 * Whole-percent text of a percent-stacked share or tick. The canvas paints it on a percent axis
 * and in segment labels; the exported "0%" axis format shows the same text.
 */
export function percentText(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * The longest value-axis tick text a chart paints. A percent-stacked axis paints percentages, so
 * its left reserve is sized from them, not from the number labels.
 */
export function widestTickText(scale: ChartScale, percent: boolean): string {
  return scale.ticks
    .map((tick) => (percent ? percentText(tick) : formatChartValue(tick, scale.tickDecimals)))
    .reduce((best, label) => (label.length > best.length ? label : best), "0");
}

/* ------------------------------------------------------------------ */
/* Nice value axis                                                     */
/* ------------------------------------------------------------------ */

export type ChartScale = Readonly<{
  min: number;
  max: number;
  step: number;
  /** Interior gridline values (min..max exclusive endpoints included). */
  ticks: number[];
  /** Decimals needed to render `step` exactly. */
  tickDecimals: number;
}>;

const NICE_STEPS = [1, 2, 2.5, 5, 10];

function niceStep(roughStep: number): number {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const fraction = roughStep / magnitude;
  for (const nice of NICE_STEPS) {
    if (fraction <= nice) return nice * magnitude;
  }
  return 10 * magnitude;
}

/**
 * One deterministic nice scale for the canvas and the exporter. Supports
 * negatives and values < 1, always returns a non-empty tick set, and snaps
 * min/max onto step boundaries so the canvas grid and PowerPoint's own
 * `min/max/majorUnit` land on the same values.
 *
 * `includeZero` is for bars/lines (the canvas draws a zero baseline);
 * floating-range charts (waterfall, scatter) pass `false`.
 */
export function niceScale(values: readonly number[], opts?: { includeZero?: boolean; tickCount?: number }): ChartScale {
  const tickCount = Math.max(2, Math.floor(opts?.tickCount ?? 5));
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) {
    return { min: 0, max: 1, step: 0.5, ticks: [0, 0.5, 1], tickDecimals: 1 };
  }
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (opts?.includeZero && hi < 0) {
    // An all-negative series still needs the zero baseline to be visible.
    hi = 0;
  }
  if (opts?.includeZero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    // A single value still needs a readable axis. Pad without crossing zero
    // on a includeZero axis so an all-positive series stays positive-only.
    if (lo === 0) {
      hi = 1;
    } else if (opts?.includeZero) {
      const pad = Math.max(Math.abs(lo) * 0.1, 1);
      if (lo < 0) hi += pad;
      else lo -= pad;
    } else {
      const pad = Math.max(Math.abs(lo) * 0.1, 1);
      lo -= pad;
      hi += pad;
    }
  }
  const roughStep = (hi - lo) / tickCount;
  const step = niceStep(roughStep);
  let min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  // Kill float dust so ticks land on exact step multiples.
  const decimals = Math.max(decimalsForStep(step), seriesDecimals([min, max]));
  const fix = (v: number) => Number(v.toFixed(decimals + 2));
  min = fix(min);
  max = fix(max);
  const ticks: number[] = [];
  for (let v = min; v <= max + step * 1e-9; v += step) ticks.push(fix(v));
  return { min, max, step, ticks, tickDecimals: decimalsForStep(step) };
}

/**
 * Secondary axis of a combo chart: reuse the primary tick count so both
 * gridline rows align.
 */
export function alignedSecondaryScale(values: readonly number[], primary: ChartScale): ChartScale {
  return niceScale(values, {
    includeZero: true,
    tickCount: primary.ticks.length - 1,
  });
}

/* ------------------------------------------------------------------ */
/* Legend spec                                                         */
/* ------------------------------------------------------------------ */

export type LegendPosition = "top" | "bottom" | "left" | "right";

export type LegendSpec = Readonly<{ show: boolean; position: LegendPosition }>;

const LEGEND_POSITION_ALIASES: Record<string, LegendPosition> = {
  top: "top",
  t: "top",
  bottom: "bottom",
  b: "bottom",
  left: "left",
  l: "left",
  right: "right",
  r: "right",
};

/**
 * Resolve the PPTD `legend` field — `true`, `false`, `{show}`, `{position}`
 * or a mix — into a single show/position contract used by both renderers.
 */
export function resolveChartLegend(legend: ChartElement["legend"]): LegendSpec {
  if (legend === true) return { show: true, position: "right" };
  if (!legend || typeof legend !== "object") {
    return { show: false, position: "right" };
  }
  const record = legend as Record<string, unknown>;
  const show = record.show === undefined ? true : Boolean(record.show);
  const raw = String(record.position ?? "right").toLowerCase();
  const position = LEGEND_POSITION_ALIASES[raw] ?? "right";
  return { show, position };
}

/* ------------------------------------------------------------------ */
/* Text measurement                                                    */
/* ------------------------------------------------------------------ */

/**
 * Approximate rendered width of chart label text in px. CJK and full-width
 * punctuation measure 1em; the rest uses a conservative Latin width. A 10%
 * padding factor keeps the canvas painter and PowerPoint's own text metrics
 * on the same side of tight edges.
 */
export function measureChartText(text: string, fontPx: number): number {
  let units = 0;
  for (const ch of Array.from(String(text))) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide = cp >= 0x2e80 || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x3000 && cp <= 0x303f);
    units += wide ? 1 : 0.56;
  }
  return units * fontPx * 1.1;
}

/* ------------------------------------------------------------------ */
/* Chart layout                                                        */
/* ------------------------------------------------------------------ */

export type ChartLayoutOptions = {
  title?: string;
  legend: LegendSpec;
  /** Item names: series names, or category names for pie. */
  legendItems: string[];
  /** Longest value-axis tick label, for the left reserve. */
  widestTickLabel: string;
  /** Longest category label, for the bottom reserve. */
  widestCategoryLabel?: string;
  categoryCount: number;
  hasSecondaryAxis?: boolean;
  /** Secondary-axis tick label width, for the right reserve. */
  widestSecondaryTickLabel?: string;
  /**
   * Leave a band under the plot, above the category names, for a label that
   * sits below a negative bar or point. Omit it for pie and horizontal bars.
   */
  reserveBelowLabel?: boolean;
  axis?: { x?: string; y?: string; secondaryY?: string };
};

export type LegendItemLayout = Readonly<{
  name: string;
  swatch: Rect;
  text: Rect;
  textAnchor: Point;
}>;

export type LegendLayout = Readonly<{
  position: LegendPosition;
  area: Rect;
  items: LegendItemLayout[];
}>;

export type ChartLayout = Readonly<{
  /** Element-relative title band; absent when the chart has no title. */
  title?: Rect;
  /** Inner plot area (where bars/points render), element-relative. */
  plot: Rect;
  legend?: LegendLayout;
  /** Category labels band under/over the plot; absent for pie. */
  categoryBand?: Rect;
  /** Element-relative rect for the x axis title text. */
  axisTitleX?: Rect;
  axisTitleY?: Rect;
  axisTitleSecondaryY?: Rect;
}>;

const LEGEND_SWATCH = 9;
const LEGEND_ITEM_GAP = 16;
const LEGEND_ENTRY_PAD = 8;
const LEGEND_LINE_H = 14;

function legendRows(
  items: string[],
  maxWidth: number,
  fontPx: number,
): { rows: number; width: number; positions: Array<{ x: number; y: number; w: number }> } {
  const positions: Array<{ x: number; y: number; w: number }> = [];
  let x = 0;
  let row = 0;
  let widest = 0;
  for (const name of items) {
    const itemW = measureChartText(name, fontPx);
    const entry = LEGEND_SWATCH + 4 + itemW + LEGEND_ENTRY_PAD;
    if (x > 0 && x + entry > maxWidth) {
      row += 1;
      x = 0;
    }
    positions.push({ x, y: row * (LEGEND_LINE_H + 2), w: itemW });
    widest = Math.max(widest, x + entry);
    x += entry + LEGEND_ITEM_GAP;
  }
  return { rows: row + 1, width: widest, positions };
}

/**
 * Compute the element-relative geometry every painter/exporter shares:
 * title band, legend area + items, category label band, axis-title rects and
 * the inner plot rect. Reserves are computed from actual label text so ticks,
 * legend and axis titles never overlap and stay inside the chart bounds.
 */
export function chartLayout(bounds: { w: number; h: number }, opts: ChartLayoutOptions): ChartLayout {
  const w = Math.max(40, bounds.w);
  const h = Math.max(40, bounds.h);
  let top = 10;
  let bottom = h;
  let left = 0;
  let right = w;

  const title = opts.title?.trim()
    ? ({ x: 12, y: 6, w: Math.max(1, w - 24), h: CHART_TEXT_PX.title + 4 } as Rect)
    : undefined;
  if (title) top = Math.max(top, title.y + title.h + 6);

  // Axis titles reserve their own edges before the legend.
  let axisTitleX: Rect | undefined;
  if (opts.axis?.x?.trim()) {
    const band = CHART_TEXT_PX.axisTitle + 4;
    axisTitleX = { x: 0, y: bottom - band, w, h: band };
    bottom -= band + 2;
  }
  let axisTitleY: Rect | undefined;
  if (opts.axis?.y?.trim()) {
    const band = CHART_TEXT_PX.axisTitle + 4;
    axisTitleY = { x: 0, y: top, w: band, h: Math.max(1, bottom - top) };
    left += band + 2;
  }
  let axisTitleSecondaryY: Rect | undefined;
  if (opts.hasSecondaryAxis && opts.axis?.secondaryY?.trim()) {
    const band = CHART_TEXT_PX.axisTitle + 4;
    axisTitleSecondaryY = { x: w - band, y: top, w: band, h: Math.max(1, bottom - top) };
    right -= band + 2;
  }

  const fontPx = CHART_TEXT_PX.legend;
  let legend: LegendLayout | undefined;
  const items = (opts.legendItems ?? []).filter((name) => String(name).trim());
  if (opts.legend.show && items.length) {
    if (opts.legend.position === "bottom" || opts.legend.position === "top") {
      const laid = legendRows(items, Math.max(60, right - left - 8), fontPx);
      const areaH = laid.rows * (LEGEND_LINE_H + 2) + 4;
      const y = opts.legend.position === "bottom" ? bottom - areaH - 2 : top;
      const area: Rect = {
        x: left + 4,
        y,
        w: Math.min(right - left - 8, laid.width + 8),
        h: areaH,
      };
      legend = {
        position: opts.legend.position,
        area,
        items: laid.positions.map((p, i) => ({
          name: items[i]!,
          swatch: { x: area.x + 4 + p.x, y: area.y + p.y + 2, w: LEGEND_SWATCH, h: LEGEND_SWATCH },
          text: {
            x: area.x + 4 + p.x + LEGEND_SWATCH + 4,
            y: area.y + p.y,
            w: p.w + 4,
            h: LEGEND_LINE_H,
          },
          textAnchor: { x: area.x + 4 + p.x + LEGEND_SWATCH + 4, y: area.y + p.y + fontPx },
        })),
      };
      if (opts.legend.position === "bottom") bottom = area.y - 4;
      else top = area.y + area.h + 4;
    } else {
      // Column legend: one item per row, wrapped names are not supported in
      // either renderer so long names just widen the reserve (bounded).
      const itemWidths = items.map((name) => measureChartText(name, fontPx));
      const widestItem = Math.max(...itemWidths);
      const colW = Math.min(Math.max(56, right - left - 60), LEGEND_SWATCH + 4 + widestItem + 12);
      const areaH = items.length * (LEGEND_LINE_H + 2) + 4;
      const x = opts.legend.position === "left" ? left + 4 : right - colW - 4;
      const y = Math.min(Math.max(top, top + (bottom - top - areaH) / 2), bottom - areaH);
      const area: Rect = { x, y: Math.max(top, y), w: colW, h: Math.min(areaH, bottom - top) };
      legend = {
        position: opts.legend.position,
        area,
        items: items.map((name, i) => ({
          name,
          swatch: {
            x: area.x + 4,
            y: area.y + 4 + i * (LEGEND_LINE_H + 2) + 2,
            w: LEGEND_SWATCH,
            h: LEGEND_SWATCH,
          },
          text: {
            x: area.x + 4 + LEGEND_SWATCH + 4,
            y: area.y + 4 + i * (LEGEND_LINE_H + 2),
            w: Math.max(4, area.w - LEGEND_SWATCH - 12),
            h: LEGEND_LINE_H,
          },
          textAnchor: {
            x: area.x + 4 + LEGEND_SWATCH + 4,
            y: area.y + 4 + i * (LEGEND_LINE_H + 2) + fontPx,
          },
        })),
      };
      if (opts.legend.position === "left") left = area.x + area.w + 4;
      else right = area.x - 6;
    }
  }

  // Value-axis tick labels reserve the left edge (and the right edge for a
  // secondary axis).
  const tickW = measureChartText(opts.widestTickLabel || "0", CHART_TEXT_PX.tick);
  left += tickW + 8;
  if (opts.hasSecondaryAxis) {
    const secondaryW = measureChartText(opts.widestSecondaryTickLabel || "0", CHART_TEXT_PX.tick);
    right -= secondaryW + 8;
  }

  // Category labels sit under (or above for horizontal bars handled by the
  // caller) the plot; two lines max keeps tall names from eating the plot.
  const catW = measureChartText(opts.widestCategoryLabel ?? "", CHART_TEXT_PX.category);
  const categoryCount = Math.max(1, opts.categoryCount);
  const slotW = (right - left) / categoryCount;
  const catLines = catW > slotW * 1.15 && catW > 40 ? 2 : 1;
  let categoryBand: Rect | undefined;
  const catH = catLines * (CHART_TEXT_PX.category + 3) + 2;
  categoryBand = { x: left, y: bottom - catH, w: Math.max(1, right - left), h: catH };
  bottom -= catH;

  // Data labels sit above the tallest bar, and below a bar that ends under
  // zero. The lower band keeps that label off the category names.
  top += CHART_TEXT_PX.dataLabel + 4;
  if (opts.reserveBelowLabel) bottom -= CHART_TEXT_PX.dataLabel + 4;
  left += 2;
  right -= 4;
  bottom -= 4;

  const plot: Rect = {
    x: left,
    y: top,
    w: Math.max(1, right - left),
    h: Math.max(1, bottom - top),
  };
  return { title, plot, legend, categoryBand, axisTitleX, axisTitleY, axisTitleSecondaryY };
}
