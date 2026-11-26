/**
 * Ruling-line evidence for PDF table reconstruction (CAP-32): stroked,
 * axis-aligned path segments from a page's operator list, transformed by the
 * tracked graphics matrix into page space, then clustered into a grid.
 */
import { walkTransforms } from "./pdf-image-paints.mjs";

/** Ruling classification thresholds in PDF points. */
const RULE_THICKNESS = 2.5;
const RULE_MIN_LENGTH = 15;
/** Same baseline / same column clustering tolerance. */
export const ROW_TOLERANCE = 3;
export const COLUMN_TOLERANCE = 4;

/** pdf.js path segment codes inside a `constructPath` argument. */
const PATH_OP = Object.freeze({ moveTo: 0, lineTo: 1, curveTo: 2, quadratic: 3, closePath: 4 });
/** Only stroked paths can be ruling lines; fills are cell backgrounds. */
const RULE_PAINTS = new Set([
  "stroke",
  "closeStroke",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
]);

/** @typedef {{y: number, x0: number, x1: number}} HorizontalRule */
/** @typedef {{x: number, y0: number, y1: number}} VerticalRule */
/** @typedef {{horizontal: HorizontalRule[], vertical: VerticalRule[]}} RuleSegments */

/** @param {unknown} value @returns {value is number[]} */
function isMatrix(value) {
  return (
    Array.isArray(value) && value.length >= 6 && value.slice(0, 6).every((entry) => Number.isFinite(Number(entry)))
  );
}

/**
 * Cluster 1-D positions (sorted copy) into centers with a greedy pass, so the
 * result only depends on the input values, never on their original order.
 * @param {number[]} values @param {number} tolerance @returns {number[]}
 */
export function clusterPositions(values, tolerance) {
  const sorted = [...values].sort((left, right) => left - right);
  /** @type {{mean: number, count: number}[]} */
  const clusters = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last.mean <= tolerance) {
      last.mean = last.mean + (value - last.mean) / (last.count + 1);
      last.count += 1;
    } else {
      clusters.push({ mean: value, count: 1 });
    }
  }
  return clusters.map((cluster) => cluster.mean);
}

/**
 * Ruling segments from one page's operator list. Coordinates are transformed by
 * the tracked graphics matrix (q/Q/cm plus form-XObject placement) into page
 * space, matching the text-item coordinates.
 * @param {{fnArray: number[], argsArray: unknown[]}} operatorList
 * @param {Map<number, string>} namesByOperator
 * @returns {RuleSegments}
 */
export function ruleSegmentsFromOperatorList(operatorList, namesByOperator) {
  /** @type {RuleSegments} */
  const segments = { horizontal: [], vertical: [] };
  walkTransforms(
    operatorList,
    namesByOperator,
    (operation, args, matrix) => {
      if (operation === "constructPath") collectSegments(args, matrix, namesByOperator, segments);
    },
    // The form boundary always pairs with paintFormXObjectEnd's pop, even when the
    // form carries no placement matrix (pdf.js save()s around it).
    { forms: true, matrixOf: (args) => (isMatrix(args) ? args : isMatrix(args[0]) ? args[0] : undefined) },
  );
  return segments;
}

/**
 * @param {unknown[]} constructArgs @param {number[]} matrix
 * @param {Map<number, string>} namesByOperator @param {RuleSegments} out
 */
function collectSegments(constructArgs, matrix, namesByOperator, out) {
  if (!RULE_PAINTS.has(String(namesByOperator.get(Number(constructArgs[0]))))) return;
  const raw = constructArgs[1];
  if (!raw || typeof (/** @type {{length?: number}} */ (raw).length) !== "number") return;
  // Bundled pdf.js passes either one flat interleaved op/coord array or a list
  // of such path arrays. Normalize both to a list before walking.
  const list = Array.isArray(raw) ? raw : [raw];
  for (const entry of list) {
    const path = /** @type {{length?: number}} */ (entry);
    if (!path || typeof path.length !== "number") continue;
    walkPath(/** @type {ArrayLike<number>} */ (path), matrix, out);
  }
}

/**
 * Walk one interleaved [op, coords…] path array and emit axis-aligned rules.
 * @param {ArrayLike<number>} path @param {number[]} matrix @param {RuleSegments} out
 */
function walkPath(path, matrix, out) {
  const coords = path;
  let at = 0;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  while (at < coords.length) {
    const op = Number(coords[at]);
    at += 1;
    if (op === PATH_OP.moveTo || op === PATH_OP.lineTo) {
      const nextX = Number(coords[at]);
      const nextY = Number(coords[at + 1]);
      at += 2;
      if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;
      if (op === PATH_OP.moveTo) {
        x = nextX;
        y = nextY;
        startX = x;
        startY = y;
      } else {
        emitRule(out, x, y, nextX, nextY, matrix);
        x = nextX;
        y = nextY;
      }
    } else if (op === PATH_OP.curveTo) {
      at += 6;
    } else if (op === PATH_OP.quadratic) {
      at += 4;
    } else if (op === PATH_OP.closePath) {
      emitRule(out, x, y, startX, startY, matrix);
    } else {
      return;
    }
  }
}

/**
 * @param {RuleSegments} out @param {number} x1 @param {number} y1
 * @param {number} x2 @param {number} y2 @param {number[]} matrix
 */
function emitRule(out, x1, y1, x2, y2, matrix) {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;
  const ax = x1 * a + y1 * c + e;
  const ay = x1 * b + y1 * d + f;
  const bx = x2 * a + y2 * c + e;
  const by = x2 * b + y2 * d + f;
  if (![ax, ay, bx, by].every(Number.isFinite)) return;
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  if (dy <= RULE_THICKNESS && dx >= RULE_MIN_LENGTH) {
    out.horizontal.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
  } else if (dx <= RULE_THICKNESS && dy >= RULE_MIN_LENGTH) {
    out.vertical.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
  }
}

/**
 * Ruled grid line positions. Needs at least two row bands and two column bands,
 * so a lone box outline or underline never becomes a table.
 * @param {RuleSegments} segments @returns {{ys: number[], xs: number[]}|undefined}
 */
export function ruleGrid(segments) {
  const ys = clusterPositions(
    segments.horizontal.map((rule) => rule.y),
    ROW_TOLERANCE,
  );
  const xs = clusterPositions(
    segments.vertical.map((rule) => rule.x),
    COLUMN_TOLERANCE,
  );
  if (ys.length < 3 || xs.length < 3) return undefined;
  return {
    ys: [...ys].sort((left, right) => right - left),
    xs: [...xs].sort((left, right) => left - right),
  };
}
