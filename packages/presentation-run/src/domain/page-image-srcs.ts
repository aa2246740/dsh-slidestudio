/**
 * Every picture source a page draws, for layout QA's missing_media check: the
 * background picture, each picture element, and each picture-filled shape. Sources
 * come in page order, and an empty src is skipped. A master or layout copy is not the
 * page's own media; its picture is judged once where the layout is written.
 */
import type { ImageElement, PptdElement, ShapeElement } from "@open-slidestudio/pptd-v2";
import { ownElements } from "./layout-gates.js";
import type { SkillPageInput } from "./skill-pages.js";

export function pageImageSrcs(page: SkillPageInput): string[] {
  const srcs: string[] = [];
  if (page.background?.type === "image" && page.background.src) {
    srcs.push(page.background.src);
  }
  for (const el of ownElements(page.elements)) {
    const src = drawnImageSrc(el);
    if (src) srcs.push(src);
  }
  return srcs;
}

/** The media a picture element or a picture-filled shape draws. */
export function drawnImageSrc(el: PptdElement): string | undefined {
  if (el.elementType === "image") return (el as ImageElement).src;
  if (el.elementType !== "shape") return undefined;
  const fill = (el as ShapeElement).fill;
  return fill?.type === "image" ? fill.src : undefined;
}
