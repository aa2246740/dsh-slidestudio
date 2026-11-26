/**
 * M5 effects for the native exporter. An element shadow becomes the `a:effectLst` of its shape
 * or picture (`a:outerShdw`), and a gradient page background becomes `p:bg/p:bgPr/a:gradFill`.
 * Both are patches on the package XML, applied in postProcessPptx after the geometry and clip
 * patches. Lengths are PPTD px at 9 525 EMU each (ruling 112); the shadow direction is in
 * 60 000ths of a degree, clockwise from the +x axis.
 */
import {
  resolveElementShadow,
  solidFillColor,
  toRgbHex,
  type Fill,
  type PptdElement,
  type PptdProject,
  type ResolvedElementShadow,
} from "@open-slidestudio/pptd-v2";
import { encodeXmlName, fillToPptx, ooxmlGradientFill, type PptxGradientFill } from "./export-fill.js";
import type { Degradation } from "./export-pptd.js";

const EMU_PER_PX = 9525;
const DEGREE_UNITS = 60000;
const FULL_TURN_UNITS = 360 * DEGREE_UNITS;

type Theme = PptdProject["presentation"]["theme"];

/** The effect list one shape or picture gets, keyed by its objectName. */
export type ShadowPatch = { slideIndex: number; objectName: string; effectList: string };

/** The gradient background of one slide, replacing the solid `p:bg` pptxgenjs wrote. */
export type BackgroundPatch = { slideIndex: number; fill: PptxGradientFill };

/** `a:effectLst` holding one `a:outerShdw`; full opacity writes the colour without an alpha child. */
function effectListXml(shadow: ResolvedElementShadow): string {
  const { blur, offsetX, offsetY, paint } = shadow;
  const dist = Math.round(Math.hypot(offsetX, offsetY) * EMU_PER_PX);
  const degrees = (Math.atan2(offsetY, offsetX) * 180) / Math.PI;
  const dir = Math.round((((degrees % 360) + 360) % 360) * DEGREE_UNITS) % FULL_TURN_UNITS;
  const hex = paint.hex.slice(1);
  const colour =
    paint.alpha < 0.995
      ? `<a:srgbClr val="${hex}"><a:alpha val="${Math.round(paint.alpha * 100000)}"/></a:srgbClr>`
      : `<a:srgbClr val="${hex}"/>`;
  return (
    `<a:effectLst><a:outerShdw blurRad="${Math.round(blur * EMU_PER_PX)}" dist="${dist}" ` +
    `dir="${dir}" rotWithShape="1">${colour}</a:outerShdw></a:effectLst>`
  );
}

/**
 * The shadow patch for a shape or picture. Other element types have no shadow in the export
 * and record a soft `shadow-not-exported` degradation; the editor still draws them.
 */
export function shadowPatchFor(
  el: PptdElement,
  slideIndex: number,
  theme: Theme,
  deg: Degradation[],
): ShadowPatch | undefined {
  if (!el.shadow) return undefined;
  if (el.elementType !== "shape" && el.elementType !== "image") {
    deg.push({
      slideIndex,
      elementId: el.elementId,
      kind: "shadow-not-exported",
      reason: `${el.elementType} shadow is shown in the editor only`,
    });
    return undefined;
  }
  const resolved = resolveElementShadow(el.shadow, theme);
  if (!resolved) return undefined;
  return { slideIndex, objectName: el.elementId, effectList: effectListXml(resolved) };
}

/**
 * Insert each effect list before `</p:spPr>` of the named shape or picture. The effect list
 * follows the fill and the outline, as CT_ShapeProperties orders it. A name that is not in the
 * slide is skipped: its shape was not drawn, and that case already has its own degradation.
 */
export function applyShadowPatches(xml: string, patches: ShadowPatch[]): string {
  return patches.reduce((current, patch) => {
    const name = encodeXmlName(patch.objectName);
    return current
      .split(/(?=<p:sp>|<p:pic>)/)
      .map((chunk) => {
        if (!/^<p:(sp|pic)>/.test(chunk)) return chunk;
        const nv = chunk.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? "";
        if (!nv.includes(`name="${name}"`)) return chunk;
        return chunk.replace("</p:spPr>", () => `${patch.effectList}</p:spPr>`);
      })
      .join("");
  }, xml);
}

/**
 * The page background for a gradient page: the gradient patch when it has two or more stops,
 * otherwise its solid colour (`solidFillColor`, the one stop's colour), recorded as a collapse.
 * `color` is the solid fallback pptxgenjs writes first, so the `p:bg` element exists for the patch
 * to replace.
 */
export function pageBackgroundFill(
  bg: Fill,
  theme: Theme,
  deg: Degradation[],
  slideIndex: number,
): { color: string; gradient?: PptxGradientFill } {
  const stops = (bg as { stops?: { color?: string }[] }).stops ?? [];
  if (stops.length >= 2) {
    const mapped = fillToPptx(bg, theme, deg, slideIndex, undefined, undefined, "shape");
    if (mapped.type === "gradient") return { color: mapped.fallback.color, gradient: mapped };
  }
  deg.push({
    slideIndex,
    kind: "gradient-as-solid",
    reason: "page gradient collapsed to first stop",
  });
  const solid = solidFillColor(bg) ?? stops[0]?.color ?? "#FFFFFF";
  return { color: toRgbHex(solid, theme).replace("#", "") };
}

/** Replace the slide's solid `p:bg` with the gradient background element. */
export function patchPageBackground(xml: string, fill: PptxGradientFill): string {
  if (!/<p:bg>[\s\S]*?<\/p:bg>/.test(xml)) {
    throw new Error("page background missing from slide xml");
  }
  return xml.replace(/<p:bg>[\s\S]*?<\/p:bg>/, () => `<p:bg><p:bgPr>${ooxmlGradientFill(fill)}</p:bgPr></p:bg>`);
}
