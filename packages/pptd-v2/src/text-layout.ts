/**
 * Shared, observable text semantics for native canvas, PPTX export, and
 * rendered layout checks. PPTD bounds are content boxes, not padded text-box
 * boxes.
 */
import type { LayoutRole, PptdElement } from "./types.js";

export const DEFAULT_TEXT_LINE_HEIGHT = 1.2;

export type TextLayoutContractV1 = Readonly<{
  version: "pptd-text-layout-v1";
  paragraphBreaks: "preserve";
  whiteSpace: "pre-wrap";
  contentInsetPx: 0;
  defaultLineHeight: typeof DEFAULT_TEXT_LINE_HEIGHT;
  /** Default footer reserve top for the canonical 960 × 540 PPTD canvas. */
  footerZoneTop: number;
}>;

export const TEXT_LAYOUT_CONTRACT_V1: TextLayoutContractV1 = Object.freeze({
  version: "pptd-text-layout-v1",
  paragraphBreaks: "preserve",
  whiteSpace: "pre-wrap",
  contentInsetPx: 0,
  defaultLineHeight: DEFAULT_TEXT_LINE_HEIGHT,
  footerZoneTop: 500,
});

/** Scale the canonical footer reserve for any PPTD slide height. */
export function footerZoneTopForSlide(slideHeight: number): number {
  if (!Number.isFinite(slideHeight) || slideHeight <= 0) {
    return TEXT_LAYOUT_CONTRACT_V1.footerZoneTop;
  }
  const reserve = 540 - TEXT_LAYOUT_CONTRACT_V1.footerZoneTop;
  return Math.max(0, slideHeight - (reserve / 540) * slideHeight);
}

const LEGACY_FOOTER_ID =
  /(?:^|[-_])(foot(?:er)?|page(?:num|number)?|source(?:s|note)?|guillemets|disc(?:laimer)?|legal|confidential)(?:[-_]|$)|页脚|页码|来源|免责声明/i;

/**
 * Preserve the explicit role first. For older OpenKimi PPTD, recognize only
 * clearly named text nodes that start inside the canonical footer reserve.
 * This keeps legacy page numbers and source notes without excusing body copy
 * that merely spills into the footer zone.
 */
export function effectiveLayoutRole(
  element: Pick<PptdElement, "elementId" | "elementType" | "bounds" | "layoutRole">,
): LayoutRole | undefined {
  if (element.layoutRole) return element.layoutRole;
  if (
    element.elementType === "text" &&
    element.bounds[1] >= TEXT_LAYOUT_CONTRACT_V1.footerZoneTop &&
    LEGACY_FOOTER_ID.test(element.elementId)
  ) {
    return "footer";
  }
  return undefined;
}
