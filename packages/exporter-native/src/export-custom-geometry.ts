/**
 * Custom path export (VAL-PPTD-003). pptxgenjs writes a custom shape as a rectangle
 * placeholder at the shape bounds; this module then replaces that rectangle's
 * geometry with an `a:custGeom` built from the model path. The rewrite runs on the
 * package XML and is keyed by objectName, the same way gradient patches are applied.
 *
 * `a:path w/h` equal the viewBox and each model command becomes one DrawingML
 * command. DrawingML path points are integers, so a model with fractional values
 * is written at a power-of-ten scale that keeps w/h proportional to the viewBox.
 */
import { resolveCustomGeometry, type CustomPathSegment } from "@open-slidestudio/pptd-v2";
import { encodeXmlName } from "./export-fill.js";

/** Scale for fractional model values; integer models are written 1:1 (w/h equal the viewBox). */
const FRACTIONAL_SCALE = 1000;
/** ST_Coordinate limit: the largest path value DrawingML accepts. */
const DRAWINGML_COORDINATE_LIMIT = 27273042316900;

/** A stored custom path in the integer units DrawingML writes. */
export type ExportCustomPath = {
  viewBox: [number, number];
  segments: CustomPathSegment[];
  scale: number;
};

export type CustomGeometryPatch = {
  slideIndex: number;
  objectName: string;
  path: ExportCustomPath;
};

/**
 * The exportable form of a stored custom geometry, or the reason it cannot be written
 * as a custGeom. The caller degrades the shape to a rectangle on an issue.
 */
export function customPathForExport(geometry: unknown): ExportCustomPath | { issue: string } {
  const resolved = resolveCustomGeometry(geometry);
  if ("issue" in resolved) return resolved;
  const { viewBox, segments } = resolved;
  const values = [...viewBox, ...segments.flatMap((segment) => segment.points)];
  const scale = values.every((value) => Number.isInteger(value)) ? 1 : FRACTIONAL_SCALE;
  if (values.some((value) => Math.abs(Math.round(value * scale)) > DRAWINGML_COORDINATE_LIMIT)) {
    return { issue: "坐标超出 DrawingML 可表示的范围" };
  }
  return { viewBox, segments, scale };
}

/** The `a:custGeom` element for an exportable path. */
export function custGeomXml(path: ExportCustomPath): string {
  const { scale } = path;
  const at = (value: number) => String(Math.round(value * scale));
  const point = (x: number, y: number) => `<a:pt x="${at(x)}" y="${at(y)}"/>`;
  const commands = path.segments
    .map(({ command, points }) => {
      const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = points;
      switch (command) {
        case "M":
          return `<a:moveTo>${point(a, b)}</a:moveTo>`;
        case "L":
          return `<a:lnTo>${point(a, b)}</a:lnTo>`;
        case "C":
          return `<a:cubicBezTo>${point(a, b)}${point(c, d)}${point(e, f)}</a:cubicBezTo>`;
        case "Q":
          return `<a:quadBezTo>${point(a, b)}${point(c, d)}</a:quadBezTo>`;
        case "Z":
          return "<a:close/>";
      }
    })
    .join("");
  const width = Math.max(1, Math.round(path.viewBox[0] * scale));
  const height = Math.max(1, Math.round(path.viewBox[1] * scale));
  return (
    `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/>` +
    `<a:pathLst><a:path w="${width}" h="${height}">${commands}</a:path></a:pathLst></a:custGeom>`
  );
}

/** Replace the rectangle geometry of the named shape with the custom path. */
export function patchCustomGeometry(xml: string, patch: CustomGeometryPatch): string {
  const name = encodeXmlName(patch.objectName);
  const chunks = xml.split(/(?=<p:sp>)/);
  let found = false;
  const next = chunks.map((chunk) => {
    if (!chunk.startsWith("<p:sp>")) return chunk;
    const nv = chunk.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? "";
    if (!nv.includes(`name="${name}"`)) return chunk;
    const patched = chunk.replace(/<a:prstGeom prst="rect">[\s\S]*?<\/a:prstGeom>/, () => custGeomXml(patch.path));
    if (patched === chunk) {
      throw new Error(`custom path ${patch.objectName} has no rectangle geometry to replace`);
    }
    found = true;
    return patched;
  });
  if (!found) throw new Error(`custom path ${patch.objectName} missing from slide xml`);
  return next.join("");
}
