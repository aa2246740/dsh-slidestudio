import { escapeHtmlText } from "./rich-text-editor.js";

/** @import { RenderElement } from "@open-slidestudio/canvas-session" */
/** @typedef {{x: number, y: number, index: number}} LinePoint */

const SVG_TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;
const PAIR = /^([-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?),([-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)$/;
/** @type {Record<string, number>} */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
let nextPaintId = 0;

/** The path's command and number tokens, or null when anything else sits between them. @param {string} value */
function pathTokens(value) {
  /** @type {string[]} */
  const tokens = [];
  let offset = 0;
  for (const token of value.matchAll(SVG_TOKEN)) {
    if (!/^[\s,]*$/.test(value.slice(offset, token.index))) return null;
    tokens.push(token[0]);
    offset = token.index + token[0].length;
  }
  if (!/^\s*$/.test(value.slice(offset)) || !/^[Mm]$/.test(tokens[0] ?? "")) return null;
  return tokens;
}

/** Arc radii are nonnegative and both arc flags are 0 or 1. @param {number[]} values */
function validArcs(values) {
  for (let start = 0; start < values.length; start += 7) {
    const rx = values[start] ?? -1;
    const ry = values[start + 1] ?? -1;
    const flags = [values[start + 3] ?? -1, values[start + 4] ?? -1];
    if (rx < 0 || ry < 0 || !flags.every((flag) => flag === 0 || flag === 1)) return false;
  }
  return true;
}

/** @param {string} kind upper-case command @param {number[]} values its numbers */
function validCommand(kind, values) {
  const arity = ARITY[kind];
  if (arity === undefined) return false;
  if (arity === 0) return values.length === 0;
  if (values.length < arity || values.length % arity !== 0) return false;
  return kind !== "A" || validArcs(values);
}

/** A native PPTD path, normalised to space-separated tokens; null when it is not a well-formed SVG path. @param {string} value */
function svgPath(value) {
  const tokens = pathTokens(value);
  if (!tokens) return null;
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++] ?? "";
    /** @type {number[]} */
    const values = [];
    while (index < tokens.length && !/^[a-z]$/i.test(tokens[index] ?? "")) {
      const number = Number(tokens[index++]);
      if (!Number.isFinite(number)) return null;
      values.push(number);
    }
    if (!validCommand(command.toUpperCase(), values)) return null;
  }
  return tokens.join(" ");
}

/** @param {unknown} value @returns {LinePoint[]} */
function pointPairs(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .trim()
    .split(/\s+/)
    .flatMap((token, index) => {
      const pair = PAIR.exec(token);
      if (!pair) return [];
      const x = Number(pair[1]);
      const y = Number(pair[2]);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y, index }] : [];
    });
}

/** @param {LinePoint[]} points @param {string | undefined} curve @param {number} width @param {number} height */
function pairPath(points, curve, width, height) {
  const [first, second, third] = points;
  if (!first || !second) return `M 0 ${height / 2} L ${width} ${height / 2}`;
  const start = `M ${first.x} ${first.y}`;
  if (curve === "smooth" && third) {
    if (points.length === 3) return `${start} Q ${second.x} ${second.y} ${third.x} ${third.y}`;
    const last = points.at(-1);
    if (last) return `${start} C ${second.x} ${second.y} ${third.x} ${third.y} ${last.x} ${last.y}`;
  }
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
}

/** @param {string | null | undefined} kind @param {"start" | "end"} side
 * @param {string} id @param {string} color */
function marker(kind, side, id, color) {
  if (!kind) return "";
  const path =
    kind === "diamond"
      ? "M5 1 L9 5 L5 9 L1 5 Z"
      : kind === "oval"
        ? "M5 1 A4 4 0 1 1 4.9 1 Z"
        : kind === "stealth"
          ? "M1 1 L9 5 L1 9 L3 5 Z"
          : "M0 0 L10 5 L0 10 Z";
  return `<marker id="${id}-${side}" viewBox="0 0 10 10" refX="${side === "start" ? 1 : 9}" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="${path}" fill="${color}"/></marker>`;
}

/**
 *  The stroke colour, width and dash of a line. Unstyled-line default (rulings 100, 112): border.width is PPTD px, so 2 px paints the 19 050 EMU the export writes. The canvas render
 *  model supplies it; this fallback matches it for any caller that passes a bare element.
 * @param {RenderElement["border"]} border
 */
function lineStroke(border) {
  const stroke = border?.width;
  const style = border?.style || "solid";
  return {
    color: escapeHtmlText(border?.color || "#111111"),
    width: typeof stroke === "number" && Number.isFinite(stroke) && stroke >= 0 ? stroke : 2,
    dash: style === "dash" ? "12 8" : style === "dot" ? "2 6" : "",
  };
}

/** @param {RenderElement} element @param {number} width @param {number} height @param {string} color */
function lineLabel(element, width, height, color) {
  if (!element.lineLabel) return "";
  return `<text class="line-label" x="${width / 2}" y="${Math.max(12, height / 2 - 8)}" text-anchor="middle" font-size="10" font-style="italic" fill="${color}">${escapeHtmlText(element.lineLabel)}</text>`;
}

/** @param {RenderElement} element @param {LinePoint[]} points @param {number} width @param {number} height */
function linePath(element, points, width, height) {
  const raw = typeof element.linePoints === "string" ? element.linePoints.trim() : "";
  return /^[Mm]/.test(raw) ? svgPath(raw) : pairPath(points, element.lineCurve, width, height);
}

/** Native PPTD paths and editor-authored point pairs share one renderer.
 * Only point-pair handles expose indices understood by the editor's drag command.
 * @param {RenderElement} element
 * @param {{showHandles?: boolean}} [options]
 */
export function linePaintMarkup(element, { showHandles = false } = {}) {
  const [, , width, height] = element.bounds;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return "";
  const raw = typeof element.linePoints === "string" ? element.linePoints.trim() : "";
  const points = /^[Mm]/.test(raw) ? [] : pointPairs(raw);
  const d = linePath(element, points, width, height);
  if (d === null) return "";
  const { color, width: strokeWidth, dash } = lineStroke(element.border);
  const [start, end] = element.lineArrow || [null, null];
  // A native identity can appear in the canvas, rail and version preview at once. SVG fragment references must belong to this paint, not that identity.
  const id = `oss-line-${++nextPaintId}`;
  const join = element.lineCurve === "sharp" ? "miter" : "round";
  const handles = showHandles
    ? points
        .map(
          ({ x, y, index }) =>
            `<circle class="bez" data-i="${index}" cx="${x}" cy="${y}" r="6" fill="#fff" stroke="#3b82f6" stroke-width="2" />`,
        )
        .join("")
    : "";
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%"><defs>${marker(start, "start", id, color)}${marker(end, "end", id, color)}</defs><path d="${escapeHtmlText(d)}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="${join}" ${dash ? `stroke-dasharray="${dash}"` : ""} ${start ? `marker-start="url(#${id}-start)"` : ""} ${end ? `marker-end="url(#${id}-end)"` : ""} />${lineLabel(element, width, height, color)}${handles}</svg>`;
}
