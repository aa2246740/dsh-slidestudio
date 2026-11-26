/**
 * Shape fields of the render model and the shape-kind rule of setSelectedShapeName.
 * A custom path (shapeName "custom") draws its stored geometry. A stored geometry
 * that cannot be drawn paints as a rectangle, the same degradation the exporter
 * applies, so the canvas and the export show one shape.
 */
import {
  CUSTOM_SHAPE_NAME,
  DEFAULT_BORDER_WIDTH_PX,
  opaqueSolidHex,
  resolveCustomGeometry,
  resolveThemeColor,
  shapeDefaults,
  shapeGeometry,
  shapePath,
  type AdjustHandle,
  type ShapeElement,
  type Theme,
} from "@open-slidestudio/pptd-v2";
import { fillCss } from "./fill-css.js";

/** Refusal for a preset shape changed to custom: a custom path needs stored geometry. */
export const CUSTOM_KIND_NEEDS_GEOMETRY =
  "缺少 geometry：自定义路径必须带有 viewBox 与 path，不能把普通形状直接改为自定义";

export type ShapeRenderFields = {
  shapeName: string;
  adjustments?: number[];
  pathD: string;
  pathStroke?: string;
  viewBox?: [number, number];
  adjustHandles?: AdjustHandle[];
  fillCss?: string;
  /** The one opaque solid colour of the fill (`opaqueSolidHex`): the surface a plain panel gives a chart. */
  solidCss?: string;
  border?: ShapeElement["border"];
};

/** Shape fields for the render model: a preset, a custom path, or a rectangle for an undrawable custom path. */
export function shapeRenderFields(sh: ShapeElement, theme: Theme | undefined): ShapeRenderFields {
  if (sh.shapeName === CUSTOM_SHAPE_NAME) {
    const geometry = resolveCustomGeometry(sh.geometry);
    if (!("issue" in geometry)) {
      return {
        shapeName: sh.shapeName,
        pathD: geometry.path,
        viewBox: geometry.viewBox,
        fillCss: fillCss(sh.fill, theme),
        solidCss: opaqueSolidHex(sh.fill, theme),
        border: renderBorder(sh.border, theme),
      };
    }
    return presetFields({ ...sh, shapeName: "rect", adjustments: undefined }, theme);
  }
  return presetFields(sh, theme);
}

/**
 * A colour without a width paints at the export's default for every shape kind (ruling 112,
 * border.width is PPTD px), so the canvas and the export agree. A theme token such as `$primary`
 * resolves here as it does in the export, so the stroke the SVG paints is a colour.
 */
function renderBorder(border: ShapeElement["border"], theme: Theme | undefined): ShapeElement["border"] {
  if (!border?.color) return border;
  const color = resolveThemeColor(border.color, theme);
  return { ...border, color, width: border.width ?? DEFAULT_BORDER_WIDTH_PX };
}

function presetFields(sh: ShapeElement, theme: Theme | undefined): ShapeRenderFields {
  const geom = shapeGeometry(sh.shapeName, sh.adjustments);
  return {
    shapeName: sh.shapeName,
    adjustments: sh.adjustments,
    pathD: geom.fill || shapePath(sh.shapeName, sh.adjustments),
    pathStroke: geom.stroke || undefined,
    adjustHandles: geom.handles,
    fillCss: fillCss(sh.fill, theme),
    solidCss: opaqueSolidHex(sh.fill, theme),
    border: renderBorder(sh.border, theme),
  };
}

/** Refuses a switch to custom when the shape has no stored geometry. Call before recording undo. */
export function assertShapeKind(sh: ShapeElement, shapeName: string): void {
  if (shapeName === CUSTOM_SHAPE_NAME && sh.geometry == null) {
    throw new Error(CUSTOM_KIND_NEEDS_GEOMETRY);
  }
}

/** Sets the kind. A preset drops any stored geometry and takes its catalog adjustments. */
export function applyShapeKind(sh: ShapeElement, shapeName: string): void {
  sh.shapeName = shapeName;
  if (shapeName === CUSTOM_SHAPE_NAME) return;
  delete sh.geometry;
  const defs = shapeDefaults(shapeName);
  if (defs.length) sh.adjustments = defs;
}
