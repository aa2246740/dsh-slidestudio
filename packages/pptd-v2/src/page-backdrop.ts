/**
 * The page backdrop shared by the editor and the exporter (M5-SCR-001). A shape that covers
 * the whole slide stands in for the page surface only when it is a plain rectangle. Custom
 * geometry and every other preset paint their own area, so a full-page triangle leaves the
 * rest of the page at the page background.
 */
import { CUSTOM_SHAPE_NAME } from "./custom-geometry.js";
import { canonicalShapeName } from "./shape-catalog.js";
import type { PptdElement, ShapeElement } from "./types.js";

/** The first full-slide plain rectangle in a page, or undefined when none covers the slide. */
export function findPageBackdrop(
  elements: readonly PptdElement[],
  size: readonly [number, number],
): ShapeElement | undefined {
  return elements.find((element): element is ShapeElement => isPageBackdrop(element, size));
}

/**
 * A plain preset rectangle: a shape that is neither a custom path nor stored geometry nor another
 * preset. Only this shape can stand in for a surface, the page backdrop or the surface under a chart.
 */
export function isPlainRectShape(element: PptdElement): element is ShapeElement {
  if (element.elementType !== "shape") return false;
  const shape = element as ShapeElement;
  if (shape.shapeName === CUSTOM_SHAPE_NAME || shape.geometry != null) return false;
  return canonicalShapeName(shape.shapeName ?? "rect") === "rect";
}

function isPageBackdrop(element: PptdElement, size: readonly [number, number]): boolean {
  if (!isPlainRectShape(element)) return false;
  const [x, y, width, height] = element.bounds;
  return x <= 0 && y <= 0 && width >= size[0] && height >= size[1];
}
