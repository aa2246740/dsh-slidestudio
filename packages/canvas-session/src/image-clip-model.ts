/**
 * Render-model fields for picture clips and picture-filled shapes. A clip is one CSS
 * `clip-path: path(...)` value in the element's own px box, built from the same
 * geometry the exporter writes (a custom path or a catalogue preset), so the canvas
 * and the export show one outline.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CUSTOM_SHAPE_NAME,
  probeImageSize,
  resolveCustomGeometry,
  shapeGeometry,
  shapePath,
  type ImageCrop,
  type ImageElement,
  type ImageFill,
  type ShapeDef,
  type ShapeElement,
} from "@open-slidestudio/pptd-v2";

export type ImageFillRender = {
  src: string;
  mode: "stretch" | "tile";
  crop?: ImageCrop;
  /** Repeat cell of a tiled fill in the shape's SVG units: the natural px size, scaled to the box. */
  tile?: [number, number];
};

type ArgKind = "X" | "Y" | "N";
/** Which axis each numeric argument of an SVG path command scales with. */
const ARG_KINDS: Record<string, readonly ArgKind[]> = {
  M: ["X", "Y"],
  L: ["X", "Y"],
  T: ["X", "Y"],
  H: ["X"],
  V: ["Y"],
  C: ["X", "Y", "X", "Y", "X", "Y"],
  S: ["X", "Y", "X", "Y"],
  Q: ["X", "Y", "X", "Y"],
  A: ["X", "Y", "N", "N", "N", "X", "Y"],
  Z: [],
};
const PATH_TOKEN = /[MLHVCSQTAZmlhvcsqtaz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g;

const format = (value: number): string => String(Math.round(value * 1000) / 1000);

/**
 * Scales SVG path data from its viewBox into px. Relative commands scale the same
 * way because every argument is a linear offset; arc radii follow their axis and
 * rotation and flags stay as written.
 */
export function scalePathData(d: string, sx: number, sy: number): string {
  const parts: string[] = [];
  let kinds: readonly ArgKind[] = [];
  let argIndex = 0;
  for (const token of d.match(PATH_TOKEN) ?? []) {
    if (/^[A-Za-z]$/.test(token)) {
      parts.push(token);
      kinds = ARG_KINDS[token.toUpperCase()] ?? [];
      argIndex = 0;
      continue;
    }
    const kind = kinds.length ? kinds[argIndex % kinds.length] : "N";
    argIndex += 1;
    const value = Number(token);
    const scaled = kind === "X" ? value * sx : kind === "Y" ? value * sy : value;
    parts.push(format(scaled));
  }
  return parts.join(" ");
}

/**
 * CSS clip-path for a picture clip, or undefined when there is none or a stored
 * custom path cannot be drawn (the picture then stays a plain rectangle, the same
 * degradation the exporter reports as shape-as-rect).
 */
export function pictureClipFields(im: ImageElement): { clipPath?: string } {
  const clip = im.cropShape;
  if (!clip) return {};
  const outline = clipOutline(clip);
  if (!outline) return {};
  const [width, height] = outline.box;
  const d = scalePathData(outline.path, im.bounds[2] / width, im.bounds[3] / height);
  return { clipPath: `path("${d}")` };
}

function clipOutline(clip: ShapeDef): { path: string; box: [number, number] } | undefined {
  if (clip.shapeName === CUSTOM_SHAPE_NAME) {
    const geometry = resolveCustomGeometry(clip.geometry);
    if ("issue" in geometry) return undefined;
    return { path: geometry.path, box: geometry.viewBox };
  }
  const preset = shapeGeometry(clip.shapeName, clip.adjustments).fill;
  return { path: preset || shapePath(clip.shapeName, clip.adjustments), box: [100, 100] };
}

/**
 * Render fields for a shape whose fill is a picture; empty for any other fill. `viewBox`
 * is the shape's SVG box (its custom path units, or 100 × 100 for a preset). A tiled
 * picture repeats at its natural px size, converted into those units, so the repeat
 * matches the export's `a:tile` at 100 %.
 */
export function shapeImageFillFields(
  sh: ShapeElement,
  rootDir: string,
  viewBox: [number, number] = [100, 100],
): { imageFill?: ImageFillRender } {
  if (sh.fill?.type !== "image" || !sh.fill.src) return {};
  const fill: ImageFill = sh.fill;
  const render: ImageFillRender = {
    src: fill.src,
    mode: fill.mode === "tile" ? "tile" : "stretch",
  };
  if (fill.crop) render.crop = fill.crop;
  if (render.mode === "tile") {
    const natural = naturalSize(rootDir, fill.src);
    const [, , width, height] = sh.bounds;
    if (natural && width > 0 && height > 0) {
      render.tile = [(natural[0] * viewBox[0]) / width, (natural[1] * viewBox[1]) / height];
    }
  }
  return { imageFill: render };
}

const sizeCache = new Map<string, { mtimeMs: number; size: [number, number] | undefined }>();

/** Natural size of a project picture under media/, cached by file stamp. */
function naturalSize(rootDir: string, src: string): [number, number] | undefined {
  const root = path.resolve(rootDir);
  const file = path.resolve(root, src);
  if (!src.startsWith("media/") || !file.startsWith(path.join(root, "media") + path.sep)) {
    return undefined;
  }
  try {
    const { mtimeMs } = fs.statSync(file);
    const cached = sizeCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.size;
    const dim = probeImageSize(fs.readFileSync(file));
    const size: [number, number] | undefined = dim ? [dim.w, dim.h] : undefined;
    sizeCache.set(file, { mtimeMs, size });
    return size;
  } catch {
    return undefined;
  }
}
