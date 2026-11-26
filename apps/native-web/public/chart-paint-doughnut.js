import { escapeHtmlText } from "./rich-text-editor.js";

/**
 *  Doughnut chart markup: the pie geometry with an annular hole. Slices start at the top and run clockwise, sized by their share of the total. The inner radius is half the outer radius,
 *  matching the exporter's `c:holeSize val="50"`. Pure: the caller supplies geometry and sizes.
 */

/** Fraction of the outer radius left as the hole. */
export const DOUGHNUT_HOLE_RATIO = 0.5;

/** A share this close to 1 is the whole doughnut; float rounding can leave it just under 1. */
const WHOLE_SHARE = 1 - 1e-9;

/**
 * @param {{
 *  plot: {x: number, y: number, w: number, h: number}, categories: string[], values: number[], paints: string[], ink: string, showLabels: boolean, fonts: {dataLabel: number}, }} options
 * @returns {string} SVG markup without the outer `<svg>` element
 */
export function paintDoughnutSvg(options) {
  const { plot, categories, values, paints, ink, showLabels, fonts } = options;
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const outer = Math.min(plot.w, plot.h) / 2;
  const inner = outer * DOUGHNUT_HOLE_RATIO;
  const sum = values.reduce((total, value) => total + (value > 0 ? value : 0), 0);
  if (sum <= 0) return "";
  /** @param {number} angle @param {number} radius */
  const point = (angle, radius) => `${cx + Math.cos(angle) * radius} ${cy + Math.sin(angle) * radius}`;
  /** @param {number} start @param {number} end */
  const slicePath = (start, end) => {
    const large = end - start > Math.PI ? 1 : 0;
    return (
      `M ${point(start, outer)} A ${outer} ${outer} 0 ${large} 1 ${point(end, outer)} ` +
      `L ${point(end, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(start, inner)} Z`
    );
  };
  /** A category that holds the whole doughnut. An arc whose endpoints coincide has no direction,
   *  so each circle is drawn as two half arcs; the inner circle runs the other way, which leaves the hole unfilled under the default nonzero fill rule.
   * @param {number} start
   */
  const ringPath = (start) => {
    const middle = start + Math.PI;
    const end = start + Math.PI * 2;
    return (
      `M ${point(start, outer)} A ${outer} ${outer} 0 0 1 ${point(middle, outer)} ` +
      `A ${outer} ${outer} 0 0 1 ${point(end, outer)} Z ` +
      `M ${point(start, inner)} A ${inner} ${inner} 0 0 0 ${point(middle, inner)} ` +
      `A ${inner} ${inner} 0 0 0 ${point(end, inner)} Z`
    );
  };
  let start = -Math.PI / 2;
  /** @type {string[]} */
  const parts = [];
  values.forEach((value, index) => {
    if (!(value > 0)) return;
    const share = value / sum;
    const end = start + share * Math.PI * 2;
    const d = share >= WHOLE_SHARE ? ringPath(start) : slicePath(start, end);
    parts.push(`<path data-chart-slice="${index}" d="${d}" fill="${escapeHtmlText(paints[index] ?? "")}"></path>`);
    if (showLabels) {
      const mid = (start + end) / 2;
      const labelRadius = (outer + inner) / 2;
      const pct = Math.round((value / sum) * 100);
      const name = categories[index] ?? "";
      parts.push(
        `<text x="${cx + Math.cos(mid) * labelRadius}" y="${cy + Math.sin(mid) * labelRadius}" text-anchor="middle" font-size="${fonts.dataLabel}" fill="${escapeHtmlText(ink)}">${escapeHtmlText(`${name} ${pct}%`)}</text>`,
      );
    }
    start = end;
  });
  return parts.join("");
}
