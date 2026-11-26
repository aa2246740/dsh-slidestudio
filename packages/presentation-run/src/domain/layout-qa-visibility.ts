/**
 * Which elements of a page visibly contribute to a diagram exhibit. A coloured border counts at
 * the width the canvas and the export draw (`drawnBorderWidth`), so a bordered cell is visible
 * without a stored width, and an explicit 0 width stays invisible.
 */
import type { ExhibitRole, LineElement, PptdElement, ShapeElement, TextElement } from "@open-slidestudio/pptd-v2";
import { colorAlpha, drawnBorderWidth } from "@open-slidestudio/pptd-v2";
import type { SkillPageInput } from "./skill-pages.js";

function roleElements(page: SkillPageInput, role: ExhibitRole): PptdElement[] {
  return page.elements.filter((element) => element.exhibitRole === role);
}

function colorIsVisible(color: string | undefined): boolean {
  return (colorAlpha(color) ?? 1) >= 0.2;
}

function diagramContributorIsVisible(element: PptdElement): boolean {
  const [, , width, height] = element.bounds;
  if (element.hidden || (element.opacity ?? 1) < 0.2) return false;
  if (Math.max(width, height) < 8) return false;
  if (element.elementType === "text") {
    const text = element as TextElement;
    return (
      text.content.text.trim().length > 0 && (text.content.fontSize ?? 18) >= 4 && colorIsVisible(text.content.color)
    );
  }
  if (element.elementType === "line") {
    return colorIsVisible((element as LineElement).border?.color);
  }
  if (element.elementType !== "shape") return false;
  const shape = element as ShapeElement;
  const borderVisible = drawnBorderWidth(shape.border) > 0 && colorIsVisible(shape.border?.color);
  if (borderVisible) return true;
  if (!shape.fill) {
    // Path-based shapes have a visible native default paint; CSS primitives
    // without an explicit fill or border are transparent.
    return !["rect", "roundRect", "ellipse"].includes(shape.shapeName);
  }
  if (shape.fill.type === "solid") return colorIsVisible(shape.fill.color);
  if (shape.fill.type === "gradient") {
    return shape.fill.stops.some((stop) => colorIsVisible(stop.color));
  }
  return (shape.fill.opacity ?? 1) >= 0.2;
}

export function visibleRoleElements(page: SkillPageInput, role: ExhibitRole): PptdElement[] {
  return roleElements(page, role).filter(diagramContributorIsVisible);
}
