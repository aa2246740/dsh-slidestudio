import type { ChartElement, ChartGrouping } from "./types.js";
import { columnIndex, finiteNumber } from "./chart-columns.js";
import { niceScale, type ChartScale } from "./chart-layout.js";
export type { WaterfallBar, WaterfallChartModel } from "./chart-waterfall.js";
export { waterfallChartModel } from "./chart-waterfall.js";

export type SupportedChartKind = "bar" | "line" | "pie" | "area" | "waterfall" | "scatter" | "radar" | "doughnut";

/** Chart kinds that share the categorical data contract (categories plus value series). */
export type CategoricalKind = "bar" | "line" | "area" | "pie" | "radar" | "doughnut";

export type ScatterPoint = {
  label: string;
  x: number;
  y: number;
};

export type ScatterChartModel = {
  xName: string;
  yName: string;
  points: ScatterPoint[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xScale: ChartScale;
  yScale: ChartScale;
};

export type CategoricalChartSeries = {
  name: string;
  values: number[];
  kind: CategoricalKind;
  axis: "primary" | "secondary";
};

export type CategoricalChartModel = {
  kind: CategoricalKind;
  /** Bar grouping; always `clustered` unless the kind is `bar`. */
  grouping: ChartGrouping;
  orientation: "vertical" | "horizontal";
  categories: string[];
  series: CategoricalChartSeries[];
  /** @deprecated use `scale.max`; kept for compatibility. */
  valueMax: number;
  /** Shared nice value axis (supports negatives and values < 1). */
  scale: ChartScale;
};

export type ScatterLabelPoint = Readonly<{
  label: string;
  x: number;
  y: number;
}>;

export type ScatterLabelPlacement = Readonly<{
  label: string;
  pointX: number;
  pointY: number;
  textX: number;
  baseline: number;
  anchor: "start" | "end";
  box: Readonly<{ left: number; top: number; right: number; bottom: number }>;
}>;

type ChartSemanticInput = Pick<ChartElement, "data" | "series" | "grouping">;

function categoricalKind(raw: unknown): CategoricalKind {
  const type = String(raw ?? "bar")
    .trim()
    .toLowerCase();
  if (type === "line" || type === "area" || type === "pie" || type === "radar" || type === "doughnut") {
    return type;
  }
  return "bar";
}

export function chartKind(input: ChartSemanticInput): SupportedChartKind {
  const raw = String(input.series[0]?.type ?? "bar")
    .trim()
    .toLowerCase();
  if (
    raw === "line" ||
    raw === "pie" ||
    raw === "area" ||
    raw === "waterfall" ||
    raw === "scatter" ||
    raw === "radar" ||
    raw === "doughnut"
  ) {
    return raw;
  }
  return "bar";
}

/** Bar grouping from the chart element. Anything other than stacked or percentStacked is clustered. */
export function chartGrouping(input: Pick<ChartElement, "grouping">): ChartGrouping {
  return input.grouping === "stacked" || input.grouping === "percentStacked" ? input.grouping : "clustered";
}

/**
 * Value axis for the series. Stacked bars must cover each category's stacked total (negative
 * values stack below zero); line series in a combo keep their own values. Percent-stacked bars
 * read each segment's signed share of the category's absolute total: 0 to 100 percent, or -100 to
 * 100 percent when a bar holds a negative value, so the scale is 0 to 1 or -1 to 1.
 */
function groupedScale(series: CategoricalChartSeries[], grouping: ChartGrouping): ChartScale {
  if (grouping === "percentStacked") {
    const negative = series.some((item) => item.kind === "bar" && item.values.some((value) => value < 0));
    return niceScale(negative ? [-1, 1] : [0, 1], { includeZero: true });
  }
  if (grouping === "clustered") {
    return niceScale(
      series.flatMap((item) => item.values),
      { includeZero: true },
    );
  }
  const bars = series.filter((item) => item.kind === "bar");
  const others = series.filter((item) => item.kind !== "bar");
  const categoryCount = Math.max(0, ...bars.map((item) => item.values.length));
  const totals: number[] = [];
  for (let index = 0; index < categoryCount; index += 1) {
    const cell = (item: CategoricalChartSeries) => item.values[index] ?? 0;
    totals.push(
      bars.reduce((sum, item) => sum + Math.max(0, cell(item)), 0),
      bars.reduce((sum, item) => sum + Math.min(0, cell(item)), 0),
    );
  }
  return niceScale([...totals, ...others.flatMap((item) => item.values)], { includeZero: true });
}

function isNumericColumn(input: ChartSemanticInput, index: number): boolean {
  const populated = input.data.rows
    .map((row) => row[index])
    .filter((value) => value != null && String(value).trim() !== "");
  return populated.length > 0 && populated.every((value) => Number.isFinite(Number(value)));
}

function encodedColumnIndex(input: ChartSemanticInput, encodedName: string | undefined): number {
  if (!encodedName) return -1;
  return input.data.cols.indexOf(encodedName);
}

/**
 * Resolve category/value columns from the declared chart encoding. A bar with
 * numeric X and categorical Y is horizontal. Other Cartesian charts keep X as
 * the category axis and Y as the value axis. This is the shared data contract
 * for the editor and native PPTX writer.
 */
export function categoricalChartModel(input: ChartSemanticInput): CategoricalChartModel {
  const kind = categoricalKind(chartKind(input));
  const grouping: ChartGrouping = kind === "bar" ? chartGrouping(input) : "clustered";
  const first = input.series[0];
  const cols = input.data.cols;
  const rows = input.data.rows;

  // A doughnut reads its single series exactly like a pie: one value per category.
  if (kind === "pie" || kind === "doughnut") {
    const declaredCategory =
      encodedColumnIndex(input, first?.encode?.category) >= 0
        ? encodedColumnIndex(input, first?.encode?.category)
        : encodedColumnIndex(input, first?.encode?.x);
    const categoryIndex = declaredCategory >= 0 ? declaredCategory : 0;
    const declaredValue =
      encodedColumnIndex(input, first?.encode?.value) >= 0
        ? encodedColumnIndex(input, first?.encode?.value)
        : encodedColumnIndex(input, first?.encode?.y);
    const valueIndex =
      declaredValue >= 0
        ? declaredValue
        : cols.findIndex((_, index) => index !== categoryIndex && isNumericColumn(input, index));
    const safeValueIndex = valueIndex >= 0 ? valueIndex : Math.min(1, Math.max(0, cols.length - 1));
    const values = rows.map((row) => finiteNumber(row[safeValueIndex]));
    return {
      kind,
      grouping: "clustered",
      orientation: "vertical",
      categories: rows.map((row) => String(row[categoryIndex] ?? "")),
      series: [
        {
          name: first?.name ?? cols[safeValueIndex] ?? "值",
          values,
          kind,
          axis: first?.axis ?? "primary",
        },
      ],
      valueMax: Math.max(1, ...values),
      scale: niceScale(values.filter((v) => v > 0).length ? values : [1], {
        includeZero: true,
      }),
    };
  }

  const declaredX = encodedColumnIndex(input, first?.encode?.x);
  const declaredY = encodedColumnIndex(input, first?.encode?.y);
  const xIndex = declaredX >= 0 ? declaredX : 0;
  const fallbackY = cols.findIndex((_, index) => index !== xIndex && isNumericColumn(input, index));
  const yIndex = declaredY >= 0 ? declaredY : fallbackY >= 0 ? fallbackY : Math.min(1, Math.max(0, cols.length - 1));
  const orientation =
    kind === "bar" && isNumericColumn(input, xIndex) && !isNumericColumn(input, yIndex) ? "horizontal" : "vertical";
  const categoryIndex = orientation === "horizontal" ? yIndex : xIndex;
  const valueKey = orientation === "horizontal" ? "x" : "y";
  const numericCandidates = cols
    .map((_, index) => index)
    .filter((index) => index !== categoryIndex && isNumericColumn(input, index));
  const definitions =
    input.series.length === 1 &&
    encodedColumnIndex(input, input.series[0]?.encode?.[valueKey]) < 0 &&
    numericCandidates.length > 1
      ? numericCandidates.map((index) => ({
          name: cols[index],
          valueIndex: index,
          kind: categoricalKind(first?.type),
          axis: first?.axis ?? "primary",
        }))
      : input.series.map((series, seriesIndex) => {
          const declared = encodedColumnIndex(input, series.encode?.[valueKey]);
          const valueIndex =
            declared >= 0 ? declared : (numericCandidates[seriesIndex] ?? numericCandidates[0] ?? yIndex);
          return {
            name: series.name ?? cols[valueIndex] ?? `系列${seriesIndex + 1}`,
            valueIndex,
            kind: categoricalKind(series.type),
            axis: series.axis ?? "primary",
          };
        });
  const safeDefinitions = definitions.length
    ? definitions
    : numericCandidates.map((index) => ({
        name: cols[index],
        valueIndex: index,
        kind: categoricalKind(first?.type),
        axis: first?.axis ?? "primary",
      }));
  const series = safeDefinitions.map((definition) => ({
    name: definition.name ?? "值",
    values: rows.map((row) => finiteNumber(row[definition.valueIndex])),
    kind: definition.kind,
    axis: definition.axis,
  }));
  const scale = groupedScale(series, grouping);
  return {
    kind,
    grouping,
    orientation,
    categories: rows.map((row) => String(row[categoryIndex] ?? "")),
    series,
    valueMax: scale.max,
    scale,
  };
}

export function scatterChartModel(input: ChartSemanticInput): ScatterChartModel {
  const series = input.series[0];
  const xIndex = columnIndex(input, series?.encode?.x, 1);
  const yIndex = columnIndex(input, series?.encode?.y, 2);
  let labelIndex = 0;
  if (labelIndex === xIndex || labelIndex === yIndex) {
    labelIndex = input.data.cols.findIndex((_, index) => index !== xIndex && index !== yIndex);
  }
  const points = input.data.rows.map((row, index) => ({
    label: labelIndex >= 0 ? String(row[labelIndex] ?? `P${index + 1}`) : `P${index + 1}`,
    x: finiteNumber(row[xIndex]),
    y: finiteNumber(row[yIndex]),
  }));
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const xScale = niceScale(xValues);
  const yScale = niceScale(yValues);
  return {
    xName: input.data.cols[xIndex] ?? series?.encode?.x ?? "X",
    yName: input.data.cols[yIndex] ?? series?.encode?.y ?? "Y",
    points,
    xMin: xScale.min,
    xMax: xScale.max,
    yMin: yScale.min,
    yMax: yScale.max,
    xScale,
    yScale,
  };
}

/** `[x, y, w, h]` in slide px, the shape of `el.bounds`. */
export type ChartSurfaceBounds = readonly [number, number, number, number];

/** What the chart surface rule reads from one element painted under a chart. */
export type ChartSurfaceCandidate = Readonly<{
  bounds: ChartSurfaceBounds;
  /** A plain preset rectangle (pptd-v2 `isPlainRectShape`). Only these can supply a surface. */
  plainRect?: boolean;
  hidden?: boolean;
  /**
   * The panel's one opaque solid colour from `opaqueSolidHex` (`#RRGGBB` or `#RGB`). Unset for a
   * picture, a gradient of two or more stops, and a translucent fill.
   */
  solidCss?: string;
}>;

export type ChartSurfaceInput = Readonly<{
  bounds: ChartSurfaceBounds;
  /** Elements painted under the chart, in paint order (bottom first). */
  below: readonly ChartSurfaceCandidate[];
  /** The chart's own background, as CSS or hex. */
  chartCss?: string;
  /** The page surface: the page background, or a full-page plain rectangle. */
  pageCss?: string;
}>;

const OPAQUE_SOLID = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** The first colour of a CSS paint: a hex, or the channels of `rgb()` / `rgba()`. */
const FIRST_COLOUR =
  /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z])|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i;

/**
 * The colour a chart's ink reads against (ruling 121, M5-SCR-010), shared by the editor and the
 * exporter. The chart's own background wins. Otherwise the topmost visible plain rectangle that
 * covers the chart and whose `solidCss` (the shared `opaqueSolidHex`) is set. Otherwise the page
 * surface. A custom path, another preset, a picture, a gradient of two or more stops or a
 * translucent panel never sets the surface.
 */
export function chartSurfaceColor(input: ChartSurfaceInput): string {
  if (input.chartCss) return input.chartCss;
  const [x, y, w, h] = input.bounds;
  let surface: string | undefined;
  for (const panel of input.below) {
    const [px, py, pw, ph] = panel.bounds;
    if (panel.hidden || panel.plainRect !== true || !panel.solidCss) continue;
    if (!OPAQUE_SOLID.test(panel.solidCss.trim())) continue;
    if (px <= x && py <= y && px + pw >= x + w && py + ph >= y + h) surface = panel.solidCss;
  }
  return surface ?? input.pageCss ?? "";
}

function channelsOf(match: RegExpExecArray): [number, number, number] {
  const hex = match[1];
  if (!hex) return [Number(match[2]), Number(match[3]), Number(match[4])];
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/**
 * Whether a surface is dark: YIQ brightness below 140. It reads the first colour of its CSS paint.
 * A solid surface is its colour. A page or chart background gradient reads its first stop, the
 * colour the exporter takes for it.
 */
export function isDarkChartSurface(css: string): boolean {
  const match = FIRST_COLOUR.exec(css);
  if (!match) return false;
  const [r, g, b] = channelsOf(match);
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

/** Greedy deterministic label placement shared by the DOM and PPTX renderers. */
export function placeScatterLabels(
  points: readonly ScatterLabelPoint[],
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>,
  fontSize = 9,
): ScatterLabelPlacement[] {
  const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  return points.map((point) => {
    const labelWidth = Math.max(fontSize * 2.7, Array.from(point.label).length * fontSize);
    const rightSide = point.x > bounds.left + (bounds.right - bounds.left) * 0.62;
    const nearTop = point.y < bounds.top + fontSize * 3.3;
    const horizontal: Array<{ dx: number; anchor: "start" | "end" }> = rightSide
      ? [
          { dx: -fontSize, anchor: "end" },
          { dx: fontSize, anchor: "start" },
        ]
      : [
          { dx: fontSize, anchor: "start" },
          { dx: -fontSize, anchor: "end" },
        ];
    const vertical = nearTop
      ? [fontSize * 1.9, -fontSize, fontSize * 3.2, -fontSize * 2.3]
      : [-fontSize, fontSize * 1.9, -fontSize * 2.3, fontSize * 3.2];
    const candidates = horizontal.flatMap((hPos) => vertical.map((dy) => ({ ...hPos, dy })));
    const scored = candidates.map((candidate) => {
      const textX = point.x + candidate.dx;
      const baseline = point.y + candidate.dy;
      const left = candidate.anchor === "end" ? textX - labelWidth : textX;
      const box = {
        left,
        top: baseline - fontSize * 1.1,
        right: left + labelWidth,
        bottom: baseline + fontSize * 0.25,
      };
      const outside =
        box.left < bounds.left || box.right > bounds.right || box.top < bounds.top || box.bottom > bounds.bottom
          ? 10_000
          : 0;
      const overlap = occupied.reduce((sum, other) => {
        const inset = fontSize / 3;
        const width = Math.max(0, Math.min(box.right, other.right + inset) - Math.max(box.left, other.left - inset));
        const height = Math.max(0, Math.min(box.bottom, other.bottom + inset) - Math.max(box.top, other.top - inset));
        return sum + width * height;
      }, 0);
      const pointHits = points.reduce((sum, other) => {
        if (other === point) return sum;
        const pad = fontSize * 0.55;
        const inside =
          other.x >= box.left - pad &&
          other.x <= box.right + pad &&
          other.y >= box.top - pad &&
          other.y <= box.bottom + pad;
        return sum + (inside ? 500 : 0);
      }, 0);
      return { ...candidate, textX, baseline, box, score: outside + overlap + pointHits };
    });
    scored.sort((left, right) => left.score - right.score);
    const choice = scored[0]!;
    occupied.push(choice.box);
    return {
      label: point.label,
      pointX: point.x,
      pointY: point.y,
      textX: choice.textX,
      baseline: choice.baseline,
      anchor: choice.anchor,
      box: choice.box,
    };
  });
}
