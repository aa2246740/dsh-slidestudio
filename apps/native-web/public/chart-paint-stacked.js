import { chartRuntime } from "./chart-paint-layout.js";
import { escapeHtmlText } from "./rich-text-editor.js";

/**
 *  Stacked and percent-stacked bar markup, plus line-kind series in a stacked combo. Positive segments stack away from zero (up or right), negative ones the other way. A percent-stacked
 *  category takes each segment's signed share of the category's absolute total, so a category without negatives fills the whole plot extent and a negative share reaches below zero. Pure: the caller supplies plot geometry and text sizes.
 * @typedef {{name: string, values: number[], kind: string}} StackedSeries
 */

const FOCUS_STROKE = `stroke="#2f86f0" stroke-width="2"`;
/** Segments shorter than this carry no data label, so labels do not overlap their neighbours. */
const MIN_LABEL_EXTENT = 9;

/** Stack segments for one category. Returns value-space spans, each with its label text.
 * @param {StackedSeries[]} bars @param {number} category @param {"stacked" | "percentStacked"} grouping
 * @param {(value: number) => string} valueText
 */
function categorySegments(bars, category, grouping, valueText) {
  if (grouping === "percentStacked") {
    const total = bars.reduce((sum, series) => sum + Math.abs(series.values[category] || 0), 0);
    if (total <= 0) return [];
    let positive = 0;
    let negative = 0;
    return bars.map((series, seriesIndex) => {
      const share = (series.values[category] || 0) / total;
      let from;
      let to;
      if (share >= 0) {
        from = positive;
        positive += share;
        to = positive;
      } else {
        from = negative;
        negative += share;
        to = negative;
      }
      return { seriesIndex, from, to, label: chartRuntime().percentText(share), value: share };
    });
  }
  let positive = 0;
  let negative = 0;
  return bars.map((series, seriesIndex) => {
    const value = series.values[category] || 0;
    let from;
    let to;
    if (value >= 0) {
      from = positive;
      positive += value;
      to = positive;
    } else {
      from = negative;
      negative += value;
      to = negative;
    }
    return { seriesIndex, from, to, label: valueText(value), value };
  });
}

/**
 *  Segment rectangles and labels for the bar series that stack into one column (or row) per category. `slot(category)` gives where a band starts and how long it is along the category
 *  axis; `along(value)` maps a value onto the value axis. The bar is `thickness` wide, centred in its band. Pure, like `paintStackedBarsSvg`.
 * @param {{
 *  horizontal: boolean, grouping: "stacked" | "percentStacked", count: number, bars: StackedSeries[], along: (value: number) => number, slot: (category: number) => {start: number, size: number}, thickness: number, focusRow?: number,
 *  showLabels: boolean, dataLabelPx: number, ink: string, valueText: (value: number) => string, paint: (seriesIndex: number, categoryIndex: number) => string, }} options
 * @returns {string} SVG markup for the segments, without the outer `<svg>` element
 */
export function stackedSegmentsSvg(options) {
  const { horizontal, grouping, count, bars, along, slot, thickness } = options;
  const { showLabels, dataLabelPx, ink, valueText, paint } = options;
  const focusRow = options.focusRow ?? -1;
  return Array.from({ length: count }, (_, category) => {
    const band = slot(category);
    const across = band.start + (band.size - thickness) / 2;
    const highlight = focusRow === category ? ` ${FOCUS_STROKE}` : "";
    return categorySegments(bars, category, grouping, valueText)
      .map((segment) => {
        const low = along(Math.min(segment.from, segment.to));
        const high = along(Math.max(segment.from, segment.to));
        const extent = Math.max(0, Math.abs(high - low));
        if (extent <= 0) return "";
        const fill = escapeHtmlText(paint(segment.seriesIndex, category));
        const geometry = horizontal
          ? { x: low, y: across, width: extent, height: thickness }
          : { x: across, y: high, width: thickness, height: extent };
        const rect = `<rect data-chart-segment data-category="${category}" data-series="${segment.seriesIndex}" x="${geometry.x}" y="${geometry.y}" width="${geometry.width}" height="${geometry.height}" fill="${fill}"${highlight}></rect>`;
        const shown = showLabels && segment.value !== 0 && extent >= MIN_LABEL_EXTENT;
        if (!shown) return rect;
        const text = `<text x="${geometry.x + geometry.width / 2}" y="${geometry.y + geometry.height / 2 + 3}" text-anchor="middle" font-size="${dataLabelPx}" fill="${escapeHtmlText(ink)}">${escapeHtmlText(segment.label)}</text>`;
        return rect + text;
      })
      .join("");
  }).join("");
}

/**
 * @param {{
 *  plot: {x: number, y: number, w: number, h: number}, orientation: "vertical" | "horizontal", grouping: "stacked" | "percentStacked", categories: string[], series: StackedSeries[],
 *  scale: {min: number, max: number, ticks: number[], tickDecimals: number}, focusRow: number, showLabels: boolean, ink: string, gridColor: string, fonts: {tick: number, category: number, dataLabel: number},
 *  formatTick: (value: number) => string, valueText: (value: number) => string, categoryY: number, paint: (seriesIndex: number, categoryIndex: number) => string, }} options
 * @returns {string} SVG markup without the outer `<svg>` element
 */
export function paintStackedBarsSvg(options) {
  const { plot, orientation, grouping, categories, series, scale, focusRow, showLabels, ink } = options;
  const { gridColor, fonts, formatTick, valueText, categoryY, paint } = options;
  const horizontal = orientation === "horizontal";
  const range = Math.max(1e-9, scale.max - scale.min);
  /** @param {number} value */
  const along = (value) =>
    horizontal
      ? plot.x + ((value - scale.min) / range) * plot.w
      : plot.y + plot.h - ((value - scale.min) / range) * plot.h;
  const bars = series.filter((item) => item.kind === "bar");
  const lines = grouping === "stacked" && !horizontal ? series.filter((item) => item.kind !== "bar") : [];
  const count = Math.max(1, categories.length);
  // Same spacing as the clustered painter, with the bar taking two thirds of each band.
  const gap = horizontal ? 7 : 10;
  const band = horizontal ? (plot.h - gap * (count - 1)) / count : (plot.w - gap * (count - 1)) / count;
  const thickness = band / 1.5;
  /** @param {number} category */
  const bandStart = (category) => (horizontal ? plot.y + category * (band + gap) : plot.x + category * (band + gap));
  /** @param {number} category */
  const bandCenter = (category) => bandStart(category) + band / 2;

  const grid = scale.ticks
    .map((tick) => {
      const position = along(tick);
      const label = escapeHtmlText(formatTick(tick));
      return horizontal
        ? `<line x1="${position}" y1="${plot.y}" x2="${position}" y2="${plot.y + plot.h}" stroke="${escapeHtmlText(gridColor)}" stroke-width="1"/><text x="${position}" y="${categoryY}" text-anchor="middle" font-size="${fonts.tick}" fill="${escapeHtmlText(ink)}">${label}</text>`
        : `<line x1="${plot.x}" y1="${position}" x2="${plot.x + plot.w}" y2="${position}" stroke="${escapeHtmlText(gridColor)}" stroke-width="1"/><text x="${plot.x - 6}" y="${position + 3}" text-anchor="end" font-size="${fonts.tick}" fill="${escapeHtmlText(ink)}">${label}</text>`;
    })
    .join("");

  const segmentMarkup = stackedSegmentsSvg({
    horizontal,
    grouping,
    count: categories.length,
    bars,
    along,
    slot: (category) => ({ start: bandStart(category), size: band }),
    thickness,
    focusRow,
    showLabels,
    dataLabelPx: fonts.dataLabel,
    ink,
    valueText,
    paint,
  });

  // Line-kind series in a stacked combo share the bar scale, plotted at each category centre.
  const lineMarkup = lines
    .map((line, offset) => {
      const seriesIndex = series.indexOf(line);
      const color = escapeHtmlText(paint(seriesIndex, 0));
      const points = line.values.map((value, category) => ({
        x: bandCenter(category),
        y: along(value),
        value,
      }));
      const list = points.map((point) => `${point.x},${point.y}`).join(" ");
      const dots = points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3" fill="${color}"/>`).join("");
      const labels = showLabels
        ? points
            .map(
              (point) =>
                `<text x="${point.x}" y="${Math.max(plot.y + 11, point.y - 7)}" text-anchor="middle" font-size="${fonts.dataLabel}" fill="${escapeHtmlText(ink)}">${escapeHtmlText(valueText(point.value))}</text>`,
            )
            .join("")
        : "";
      return `<polyline data-chart-line="${offset}" points="${list}" fill="none" stroke="${color}" stroke-width="3"></polyline>${dots}${labels}`;
    })
    .join("");

  const categoryLabels = categories
    .map((category, index) =>
      horizontal
        ? `<text x="${plot.x - 7}" y="${bandCenter(index) + 3}" text-anchor="end" font-size="${fonts.category}" fill="${escapeHtmlText(ink)}">${escapeHtmlText(category)}</text>`
        : `<text x="${bandCenter(index)}" y="${categoryY}" text-anchor="middle" font-size="${fonts.category}" fill="${escapeHtmlText(ink)}">${escapeHtmlText(category)}</text>`,
    )
    .join("");
  return `${grid}${segmentMarkup}${lineMarkup}${categoryLabels}`;
}
