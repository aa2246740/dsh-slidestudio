import type { ChartElement } from "./types.js";
import { columnIndex, finiteNumber } from "./chart-columns.js";
import { niceScale, type ChartScale } from "./chart-layout.js";

export type WaterfallBar = {
  label: string;
  value: number;
  start: number;
  end: number;
  kind: "total" | "subtotal" | "increase" | "decrease";
};

export type WaterfallChartModel = {
  bars: WaterfallBar[];
  valueMin: number;
  valueMax: number;
  /** Shared nice axis (does not force zero). */
  scale: ChartScale;
};

type ChartSemanticInput = Pick<ChartElement, "data" | "series" | "grouping">;

function isTruthyTotal(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return /^(1|true|yes|y|total|subtotal|合计|小计)$/i.test(value.trim());
}

function nearlyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 0.000_001;
}

function looksLikeSubtotal(label: string): boolean {
  return /净额|净增|净减|小计|subtotal/i.test(label);
}

/**
 * Build one deterministic waterfall interpretation for both the editor and
 * PPTX writer. First/last rows are totals. Explicit `encode.isTotal` rows are
 * totals. A labelled subtotal whose value equals the preceding signed deltas
 * is displayed from the block base without changing the running balance.
 */
export function waterfallChartModel(input: ChartSemanticInput): WaterfallChartModel {
  const series = input.series[0];
  const categoryIndex = columnIndex(input, series?.encode?.x, 0);
  const valueIndex = columnIndex(input, series?.encode?.y, categoryIndex === 0 ? 1 : 0);
  const totalName = series?.encode?.isTotal;
  const totalIndex = totalName ? input.data.cols.indexOf(totalName) : -1;
  const rows = input.data.rows;
  const bars: WaterfallBar[] = [];
  let running = 0;
  let blockBase = 0;
  let blockDelta = 0;

  rows.forEach((row, index) => {
    const label = String(row[categoryIndex] ?? "");
    const value = finiteNumber(row[valueIndex]);
    const first = index === 0;
    const last = index === rows.length - 1;
    const explicitTotal = totalIndex >= 0 && isTruthyTotal(row[totalIndex]);
    const derivedSubtotal = !first && !last && looksLikeSubtotal(label) && nearlyEqual(value, blockDelta);

    if (first) {
      bars.push({ label, value, start: 0, end: value, kind: "total" });
      running = value;
      blockBase = running;
      blockDelta = 0;
      return;
    }

    if (last) {
      bars.push({ label, value, start: 0, end: value, kind: "total" });
      running = value;
      return;
    }

    if (derivedSubtotal) {
      bars.push({
        label,
        value,
        start: blockBase,
        end: blockBase + value,
        kind: "subtotal",
      });
      return;
    }

    if (explicitTotal) {
      bars.push({ label, value, start: 0, end: value, kind: "total" });
      running = value;
      blockBase = running;
      blockDelta = 0;
      return;
    }

    const start = running;
    running += value;
    blockDelta += value;
    bars.push({
      label,
      value,
      start,
      end: running,
      kind: value >= 0 ? "increase" : "decrease",
    });
  });

  // A waterfall's readable domain spans the floating deltas plus the total
  // endpoints — never the totals' internal zero-start anchors. A margin
  // bridge from 37.5 to 37.8 on a 0-based axis turns its ±1 steps into
  // unreadable slivers pinned at the top of the plot area. Total columns are
  // allowed to clip at the axis floor; they stay readable as anchors.
  const floats = bars.filter((bar) => bar.kind !== "total").flatMap((bar) => [bar.start, bar.end]);
  const ends = bars.filter((bar) => bar.kind === "total").map((bar) => bar.end);
  if (!floats.length && !ends.length) {
    return { bars, valueMin: 0, valueMax: 1, scale: niceScale([0, 1]) };
  }
  const scale = niceScale([...floats, ...ends]);
  return { bars, valueMin: scale.min, valueMax: scale.max, scale };
}

/** Build an XY model from `series[0].encode.x/y`, never from column order alone. */
