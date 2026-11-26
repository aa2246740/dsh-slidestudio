import { escapeHtmlText } from "./rich-text-editor.js";

/**
 *  Radar (spider) chart markup. Categories are spokes from the top, clockwise; each series is a closed polygon whose vertex radius follows the shared value scale. Pure: the caller
 *  supplies the plot rectangle, scale and text sizes, so the geometry is testable.
 * @typedef {{name: string, values: number[], paint: string}} RadarSeries
 * @typedef {{min: number, max: number, ticks: number[], tickDecimals: number}} RadarScale
 */

/** Space kept outside the outer ring for category labels. */
export const RADAR_LABEL_RESERVE = 18;

/** @param {{x: number, y: number, w: number, h: number}} plot */
export function radarGeometry(plot) {
  return {
    cx: plot.x + plot.w / 2,
    cy: plot.y + plot.h / 2,
    radius: Math.max(0, Math.min(plot.w, plot.h) / 2 - RADAR_LABEL_RESERVE),
  };
}

/**
 *  Point for one category index at one value. Angle -PI/2 is the top; increasing index moves clockwise because SVG's y axis points down.
 * @param {{cx: number, cy: number, radius: number}} geometry
 * @param {RadarScale} scale
 * @param {number} index @param {number} count @param {number} value
 */
function radarPoint(geometry, scale, index, count, value) {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
  const range = Math.max(1e-9, scale.max - scale.min);
  const r = (geometry.radius * (value - scale.min)) / range;
  return { x: geometry.cx + r * Math.cos(angle), y: geometry.cy + r * Math.sin(angle), angle };
}

/**
 * @param {{
 *  plot: {x: number, y: number, w: number, h: number}, categories: string[], series: RadarSeries[], scale: RadarScale, ink: string, gridColor: string, showLabels: boolean, fonts: {tick: number, category: number, dataLabel: number},
 *  formatTick: (value: number) => string, valueText: (value: number) => string, }} options
 * @returns {string} SVG markup without the outer `<svg>` element
 */
export function paintRadarSvg(options) {
  const { plot, categories, series, scale, ink, gridColor, showLabels, fonts } = options;
  const geometry = radarGeometry(plot);
  const { cx, cy, radius } = geometry;
  const count = categories.length;
  /** @param {number} value */
  const ringRadius = (value) => (radius * (value - scale.min)) / Math.max(1e-9, scale.max - scale.min);
  const grid = scale.ticks
    .map((tick) => {
      const ring = Array.from({ length: count }, (_, index) => {
        const point = radarPoint(geometry, scale, index, count, tick);
        return `${point.x},${point.y}`;
      }).join(" ");
      const labelY = cy - ringRadius(tick);
      return (
        `<polygon data-chart-grid points="${ring}" fill="none" stroke="${escapeHtmlText(gridColor)}" stroke-width="1"></polygon>` +
        `<text x="${cx + 4}" y="${labelY - 2}" text-anchor="start" font-size="${fonts.tick}" fill="${escapeHtmlText(ink)}">${escapeHtmlText(options.formatTick(tick))}</text>`
      );
    })
    .join("");
  const spokes = categories
    .map((_, index) => {
      const outer = radarPoint(geometry, scale, index, count, scale.max);
      return `<line data-chart-spoke x1="${cx}" y1="${cy}" x2="${outer.x}" y2="${outer.y}" stroke="${escapeHtmlText(gridColor)}" stroke-width="1"></line>`;
    })
    .join("");
  const categoryLabels = categories
    .map((category, index) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
      const x = cx + (radius + 12) * Math.cos(angle);
      const y = cy + (radius + 12) * Math.sin(angle);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
      const baseline = sin > 0.5 ? y + 10 : sin < -0.5 ? y - 2 : y + 4;
      return `<text x="${x}" y="${baseline}" text-anchor="${anchor}" font-size="${fonts.category}" fill="${escapeHtmlText(ink)}">${escapeHtmlText(category)}</text>`;
    })
    .join("");
  const polygons = series
    .map((row, seriesIndex) => {
      const points = row.values
        .slice(0, count)
        .map((value, index) => {
          const point = radarPoint(geometry, scale, index, count, value);
          return `${point.x},${point.y}`;
        })
        .join(" ");
      const paint = escapeHtmlText(row.paint);
      const labels = showLabels
        ? row.values
            .slice(0, count)
            .map((value, index) => {
              const point = radarPoint(geometry, scale, index, count, value);
              const nudge = 8;
              return `<text x="${point.x + Math.cos(point.angle) * nudge}" y="${point.y + Math.sin(point.angle) * nudge + 3}" text-anchor="middle" font-size="${fonts.dataLabel}" fill="${escapeHtmlText(ink)}">${escapeHtmlText(options.valueText(value))}</text>`;
            })
            .join("")
        : "";
      return (
        `<polygon data-chart-series="${seriesIndex}" points="${points}" fill="${paint}" fill-opacity="0.2" stroke="${paint}" stroke-width="2"></polygon>` +
        labels
      );
    })
    .join("");
  return `${grid}${spokes}${polygons}${categoryLabels}`;
}
