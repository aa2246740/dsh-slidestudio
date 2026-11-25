/**
 * Zero-width outlines (M5-SCR-004). pptxgenjs replaces a zero line width with 1 pt
 * (`options.line.width || 1`), so a width the user set to 0 px would export as a visible
 * 12 700 EMU stroke. The editor draws no stroke at width 0, and its arrowheads scale with the
 * stroke, so the export writes an explicit no-fill outline. That also drops the arrowheads.
 * The patch is keyed by objectName, like the other post-pass patches.
 */
import { encodeXmlName } from "./export-fill.js";

/** One line or shape whose outline must draw nothing. */
export type NoStrokePatch = { slideIndex: number; objectName: string };

const NO_OUTLINE = "<a:ln><a:noFill/></a:ln>";
const OUTLINE = /<a:ln\b[^>]*\/>|<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/;

/**
 * Replace the outline of each named p:sp with NO_OUTLINE. The search stays inside the shape's
 * own p:spPr, so an a:ln in a text run is never touched. A shape with no outline element gets
 * one before </p:spPr>, where CT_ShapeProperties orders it. Runs before the shadow patches,
 * which insert their effect list after the outline.
 */
export function applyNoStrokePatches(xml: string, patches: readonly NoStrokePatch[]): string {
  return patches.reduce((current, patch) => {
    const name = encodeXmlName(patch.objectName);
    let found = false;
    const next = current.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (block) => {
      if (found) return block;
      const cNvPr = block.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? "";
      if (!cNvPr.includes(`name="${name}"`)) return block;
      found = true;
      return block.replace(/<p:spPr>[\s\S]*?<\/p:spPr>/, (spPr) =>
        OUTLINE.test(spPr)
          ? spPr.replace(OUTLINE, () => NO_OUTLINE)
          : spPr.replace("</p:spPr>", () => `${NO_OUTLINE}</p:spPr>`),
      );
    });
    if (!found) throw new Error(`outline ${patch.objectName} missing from slide xml`);
    return next;
  }, xml);
}
