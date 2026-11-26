/**
 *  Gradient series fills for chart SVG. A series whose `fill` is a PPTD gradient object paints as `url(#id)`, with the gradient definition injected into the chart's own SVG, so every
 *  painter return path carries its defs. Pure: no runtime imports.
 * @typedef {{type: "gradient", gradientType?: "linear" | "radial", angle?: number, stops: {position: number, color: string, alpha?: number}[]}} GradientFill
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** @param {unknown} fill @returns {fill is GradientFill} */
export function isGradientFill(fill) {
  return Boolean(fill) && typeof fill === "object" && /** @type {{type?: unknown}} */ (fill).type === "gradient";
}

/** @param {number} value */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** Drop stops that cannot be written safely and order the rest by position. @param {GradientFill} fill */
function gradientStops(fill) {
  const stops = Array.isArray(fill.stops) ? fill.stops : [];
  return stops
    .filter((stop) => stop && HEX_COLOR.test(String(stop.color ?? "").trim()) && Number.isFinite(Number(stop.position)))
    .map((stop) => ({
      offset: clamp01(Number(stop.position)),
      color: String(stop.color).trim(),
      alpha: Number.isFinite(Number(stop.alpha)) ? clamp01(Number(stop.alpha)) : 1,
    }))
    .sort((a, b) => a.offset - b.offset);
}

/** FNV-1a, enough to make ids stable and distinct per chart, series and gradient. @param {string} text */
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * @param {string} id @param {GradientFill} fill
 * @param {{offset: number, color: string, alpha: number}[]} stops
 */
function gradientDefinition(id, fill, stops) {
  const stopMarkup = stops
    .map(
      (stop) =>
        `<stop offset="${Math.round(stop.offset * 10000) / 100}%" stop-color="${stop.color}" stop-opacity="${stop.alpha}"/>`,
    )
    .join("");
  if (fill.gradientType === "radial") {
    return `<radialGradient id="${id}" cx="50%" cy="50%" r="50%">${stopMarkup}</radialGradient>`;
  }
  // Angle is clockwise in degrees, 0 running left to right, matching PPTX `a:lin ang`.
  const radians = ((Number(fill.angle) || 0) * Math.PI) / 180;
  const dx = Math.cos(radians) * 50;
  const dy = Math.sin(radians) * 50;
  const x1 = Math.round((50 - dx) * 100) / 100;
  const y1 = Math.round((50 - dy) * 100) / 100;
  const x2 = Math.round((50 + dx) * 100) / 100;
  const y2 = Math.round((50 + dy) * 100) / 100;
  return `<linearGradient id="${id}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">${stopMarkup}</linearGradient>`;
}

/**
 *  The gradient plan for one chart: the defs to inject and the paint each series index uses. A single gradient series paints every category, because its bars and slices share one fill.
 * @param {string | undefined} elementId
 * @param {unknown[] | undefined} series
 * @returns {{defs: string, paintFor: (index: number) => string | undefined}}
 */
export function chartFillPlan(elementId, series) {
  const list = Array.isArray(series) ? series : [];
  /** @type {string[]} */
  const defs = [];
  /** @type {(string | undefined)[]} */
  const urls = [];
  list.forEach((entry, index) => {
    const fill = /** @type {{fill?: unknown}} */ (entry || {}).fill;
    if (!isGradientFill(fill)) return;
    const stops = gradientStops(fill);
    if (!stops.length) return;
    const id = `chart-grad-${shortHash(`${elementId || "chart"}|${index}|${JSON.stringify(fill)}`)}`;
    defs.push(gradientDefinition(id, fill, stops));
    urls[index] = `url(#${id})`;
  });
  const solo = list.length === 1 ? urls[0] : undefined;
  return {
    defs: defs.join(""),
    paintFor: (index) => urls[index] ?? solo,
  };
}

/**
 *  Insert gradient defs right after the chart's opening `<svg ...>` tag. A function replacement keeps `$` characters in the defs from being read as replacement patterns.
 * @param {string} svg @param {string} defs
 */
export function injectChartDefs(svg, defs) {
  if (!defs) return svg;
  return svg.replace(/^<svg\b[^>]*>/, (open) => `${open}<defs>${defs}</defs>`);
}

/**
 *  Fill attributes for an area polygon. Solid colours keep their hex alpha suffix; a gradient url cannot take one, so it uses `fill-opacity` with the same visual weight.
 * @param {string} paint @param {string} alphaHex two hex digits, e.g. "55"
 */
export function areaFillAttributes(paint, alphaHex) {
  if (paint.startsWith("url(")) {
    const opacity = Math.round((parseInt(alphaHex, 16) / 255) * 100) / 100;
    return `fill="${paint}" fill-opacity="${opacity}"`;
  }
  return `fill="${paint}${alphaHex}"`;
}
