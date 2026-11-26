/**
 * Picture clips and shape image fills (VAL-PPTD-004, 005, 006). pptxgenjs writes every
 * picture as a rectangular `p:pic` and every shape with a solid placeholder fill, so
 * these patches rewrite the slide XML after pptxgenjs has written it:
 *
 * - a preset `cropShape` (ellipse, roundRect, ...) sets the picture's `a:prstGeom`;
 * - a custom `cropShape` turns the picture into a `p:sp` with `a:custGeom`, filled by
 *   a `a:blipFill` that keeps the picture's relationship and crop;
 * - a shape image fill is packaged through a temporary carrier picture, whose
 *   relationship the shape's `a:blipFill` then references. The carrier is removed. The
 *   element opacity is written as `a:alphaModFix` on that picture fill.
 *
 * Patches are keyed by objectName, the same way the other post-pass patches are.
 */
import fs from "node:fs";
import path from "node:path";
import type PptxGenJS from "pptxgenjs";
import {
  CUSTOM_SHAPE_NAME,
  type Fill,
  type ImageCrop,
  type ImageElement,
  type PptdProject,
  type ShapeElement,
} from "@open-slidestudio/pptd-v2";
import { custGeomXml, customPathForExport, type ExportCustomPath } from "./export-custom-geometry.js";
import { elementAlpha, encodeXmlName } from "./export-fill.js";
import { presetPrst } from "./export-preset-names.js";
import type { Degradation } from "./export-pptd.js";

/** Fractions of the source picture removed before it is drawn, as a DrawingML srcRect. */
export type SourceCrop = { l: number; t: number; r: number; b: number };

export type SlideImageClipPatch =
  | { kind: "preset"; slideIndex: number; objectName: string; prst: string }
  | { kind: "custom"; slideIndex: number; objectName: string; path: ExportCustomPath }
  | FillPatch;

type FillPatch = {
  kind: "fill";
  slideIndex: number;
  /** The shape that takes the picture as its fill. */
  objectName: string;
  /** The temporary picture pptxgenjs packaged the media through. */
  carrierName: string;
  tile: boolean;
  crop?: SourceCrop;
  /** The element opacity, 0 to 1. Below 1 it is written as `a:alphaModFix` on the picture. */
  alpha: number;
};

const clamp01 = (value: number | undefined) =>
  Math.max(0, Math.min(1, typeof value === "number" && Number.isFinite(value) ? value : 0));

/**
 * The patch for a picture's `cropShape`, or undefined when the picture stays a
 * rectangle. An undrawable clip is reported as `shape-as-rect`.
 */
export function pictureClipPatch(
  el: ImageElement,
  slideIndex: number,
  deg: Degradation[],
  nativeShapeTypes: Readonly<Record<string, string>>,
): SlideImageClipPatch | undefined {
  const clip = el.cropShape;
  if (!clip) return undefined;
  const target = { slideIndex, objectName: el.elementId };
  if (clip.shapeName === CUSTOM_SHAPE_NAME) {
    const custom = customPathForExport(clip.geometry);
    if ("issue" in custom) {
      deg.push({
        slideIndex,
        elementId: el.elementId,
        kind: "shape-as-rect",
        reason: `custom path exported as rect: ${custom.issue}`,
      });
      return undefined;
    }
    return { kind: "custom", ...target, path: custom };
  }
  const prst = presetPrst(clip.shapeName, nativeShapeTypes);
  if (!prst) {
    deg.push({
      slideIndex,
      elementId: el.elementId,
      kind: "shape-as-rect",
      reason: `preset ${clip.shapeName} exported as rect`,
    });
    return undefined;
  }
  return prst === "rect" ? undefined : { kind: "preset", ...target, prst };
}

/**
 * The fill pptxgenjs writes before a picture replaces it. An image fill is a neutral
 * placeholder here; every other fill passes through unchanged.
 */
export function shapeBaseFill(fill: Fill | undefined, theme: PptdProject["presentation"]["theme"]): Fill | undefined {
  if (fill?.type !== "image") return fill;
  return { type: "solid", color: theme?.neutralChrome ? "#E5E5E5" : "#E5E7EB" };
}

/**
 * Packages a shape's image fill through a carrier picture. A missing file keeps the
 * placeholder colour and is reported as a soft `image-fill-as-solid` degradation, as
 * before picture fills were exported (the write path refuses missing media instead).
 * Call it only for a shape that mapShape drew: the patch needs that shape's p:sp.
 */
export function shapeImageFillPatch(
  slide: PptxGenJS.Slide,
  el: ShapeElement,
  rootDir: string,
  slideIndex: number,
  deg: Degradation[],
): SlideImageClipPatch | undefined {
  const fill = el.fill;
  if (fill?.type !== "image") return undefined;
  const source = mediaSource(fill.src, rootDir);
  if (!source) {
    deg.push({
      slideIndex,
      elementId: el.elementId,
      kind: "image-fill-as-solid",
      reason: `fill image not found: ${fill.src}; solid placeholder`,
    });
    return undefined;
  }
  const carrierName = `${el.elementId}-image-fill`;
  // The carrier is removed again, so its own geometry is irrelevant.
  slide.addImage({ ...source, objectName: carrierName, x: 0, y: 0, w: 1, h: 1 });
  return {
    kind: "fill",
    slideIndex,
    objectName: el.elementId,
    carrierName,
    tile: fill.mode === "tile",
    crop: sourceCrop(fill.crop),
    alpha: elementAlpha(el.opacity),
  };
}

/** Apply one slide's patches in order. Run after srcRect patches so clipped pictures keep their crop. */
export function applyImageClipPatches(xml: string, patches: readonly SlideImageClipPatch[]): string {
  let next = xml;
  for (const patch of patches) {
    if (patch.kind === "preset") next = patchPresetPicture(next, patch);
    else if (patch.kind === "custom") next = customPicture(next, patch);
    else next = patchShapeImageFill(next, patch);
  }
  return next;
}

/** The pptxgenjs image option for a project picture, or undefined when the file is absent. */
function mediaSource(src: string, rootDir: string): { data: string } | { path: string } | undefined {
  if (src.startsWith("data:")) return { data: src };
  if (src.startsWith("http")) return { path: src };
  const local = path.join(rootDir, src);
  return fs.existsSync(local) ? { path: local } : undefined;
}

/** A srcRect from crop fractions. A crop that leaves nothing visible is dropped. */
function sourceCrop(crop: ImageCrop | undefined): SourceCrop | undefined {
  if (!crop) return undefined;
  const rect = {
    l: clamp01(crop.left),
    t: clamp01(crop.top),
    r: clamp01(crop.right),
    b: clamp01(crop.bottom),
  };
  if (rect.l + rect.r >= 1 || rect.t + rect.b >= 1) return undefined;
  if (!rect.l && !rect.t && !rect.r && !rect.b) return undefined;
  return rect;
}

function hasName(block: string, name: string): boolean {
  const cNvPr = block.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? "";
  return cNvPr.includes(` name="${name}"`);
}

/** Rewrite the single `p:pic` or `p:sp` whose cNvPr name is `objectName`. */
function editObject(xml: string, tag: "p:pic" | "p:sp", objectName: string, edit: (block: string) => string): string {
  const name = encodeXmlName(objectName);
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g");
  const target = [...xml.matchAll(pattern)].find((match) => hasName(match[0], name));
  if (!target || target.index === undefined) {
    throw new Error(`image object ${objectName} missing from slide xml`);
  }
  const block = target[0];
  return xml.slice(0, target.index) + edit(block) + xml.slice(target.index + block.length);
}

function patchPresetPicture(xml: string, patch: { objectName: string; prst: string }): string {
  return editObject(xml, "p:pic", patch.objectName, (block) => {
    const patched = block.replace(/<a:prstGeom prst="rect">/, `<a:prstGeom prst="${patch.prst}">`);
    if (patched === block) {
      throw new Error(`picture ${patch.objectName} has no rectangle geometry to clip`);
    }
    return patched;
  });
}

/** Rewrite a picture as a custom-geometry shape filled with the same picture. */
function customPicture(xml: string, patch: { objectName: string; path: ExportCustomPath }): string {
  const name = encodeXmlName(patch.objectName);
  return editObject(xml, "p:pic", patch.objectName, (block) => {
    const id = block.match(/<p:cNvPr\b[^>]*\bid="(\d+)"/)?.[1];
    const xfrm = block.match(/<a:xfrm\b[\s\S]*?<\/a:xfrm>/)?.[0];
    const blip = block.match(/<a:blip\b[^>]*\/>|<a:blip\b[^>]*>[\s\S]*?<\/a:blip>/)?.[0];
    if (!id || !xfrm || !blip) {
      throw new Error(`picture ${patch.objectName} has no geometry to clip`);
    }
    const srcRect = block.match(/<a:srcRect\b[^>]*\/>/)?.[0] ?? "";
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr>${xfrm}${custGeomXml(patch.path)}` +
      `<a:blipFill rotWithShape="1">${blip}${srcRect}<a:stretch><a:fillRect/></a:stretch></a:blipFill>` +
      `</p:spPr></p:sp>`
    );
  });
}

/** Remove the carrier picture and return the relationship it packaged the media under. */
function takeCarrierRelationship(xml: string, carrierName: string): { xml: string; embed: string } {
  const name = encodeXmlName(carrierName);
  const carrier = [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].find((match) => hasName(match[0], name));
  const embed = carrier?.[0].match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1];
  if (!carrier || !embed) throw new Error(`image fill carrier ${carrierName} missing from slide xml`);
  return { xml: xml.replace(carrier[0], () => ""), embed };
}

function shapeBlipFill(embed: string, patch: FillPatch): string {
  const crop = patch.crop;
  const srcRect = crop
    ? `<a:srcRect l="${Math.round(crop.l * 100000)}" t="${Math.round(crop.t * 100000)}" r="${Math.round(crop.r * 100000)}" b="${Math.round(crop.b * 100000)}"/>`
    : "";
  const mode = patch.tile
    ? `<a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/>`
    : `<a:stretch><a:fillRect/></a:stretch>`;
  const amount = Math.round(patch.alpha * 100000);
  const blip =
    amount < 100000
      ? `<a:blip r:embed="${embed}"><a:alphaModFix amt="${amount}"/></a:blip>`
      : `<a:blip r:embed="${embed}"/>`;
  return `<a:blipFill rotWithShape="1">${blip}${srcRect}${mode}</a:blipFill>`;
}

/** Replace the shape's placeholder fill, the one after its geometry, with the picture fill. */
function patchShapeImageFill(xml: string, patch: FillPatch): string {
  const carrier = takeCarrierRelationship(xml, patch.carrierName);
  const blipFill = shapeBlipFill(carrier.embed, patch);
  return editObject(carrier.xml, "p:sp", patch.objectName, (block) => {
    const patched = block.replace(
      /(<\/a:(?:prstGeom|custGeom)>)\s*(?:<a:solidFill>[\s\S]*?<\/a:solidFill>|<a:noFill\/>)/,
      (_match, geometryEnd: string) => `${geometryEnd}${blipFill}`,
    );
    if (patched === block) {
      throw new Error(`image fill ${patch.objectName} has no shape fill to replace`);
    }
    return patched;
  });
}
