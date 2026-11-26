import { shapePathParts1 } from "./shape-path-part1.js";
import { shapePathParts2 } from "./shape-path-part2.js";
import { canonicalShapeName, SHAPE_BY_NAME } from "./shape-catalog.js";
import { ooxmlShapeGeometry, ooxmlShapePath, type ShapeGeometry } from "./ooxml-geom.js";
import { poly } from "./shape-path-draw.js";

export { adjUnit } from "./shape-path-draw.js";

const shapePathParts = [...shapePathParts1, ...shapePathParts2];

/**
 * SVG path in viewBox 0 0 100 100.
 * Prefers the ECMA-376 interpreter; falls back to the hand path table.
 */
export function shapePath(shapeName: string, adjustments?: number[]): string {
  shapeName = canonicalShapeName(shapeName);
  const info = SHAPE_BY_NAME.get(shapeName);
  const adj = adjustments?.length ? adjustments : info?.defaults;
  const oox = ooxmlShapePath(shapeName, adj);
  if (oox) return oox;
  for (const part of shapePathParts) {
    const drawn = part(shapeName, adj);
    if (drawn) return drawn;
  }
  return poly([
    [10, 18],
    [90, 18],
    [90, 82],
    [10, 82],
  ]);
}

export function shapeGeometry(shapeName: string, adjustments?: number[]): ShapeGeometry {
  shapeName = canonicalShapeName(shapeName);
  const info = SHAPE_BY_NAME.get(shapeName);
  const adj = adjustments?.length ? adjustments : info?.defaults;
  const oox = ooxmlShapeGeometry(shapeName, adj);
  if (oox) return oox;
  return { fill: shapePath(shapeName, adj), stroke: "", handles: [] };
}

export function shapeSvg(
  shapeName: string,
  opts: { fill?: string; stroke?: string; strokeWidth?: number; adjustments?: number[] } = {},
): string {
  const d = shapePath(shapeName, opts.adjustments);
  const fill = opts.fill ?? "#2563EB";
  const stroke = opts.stroke ?? "none";
  const sw = opts.strokeWidth ?? 0;
  return `<svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none"><path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" fill-rule="evenodd" vector-effect="non-scaling-stroke"/></svg>`;
}
