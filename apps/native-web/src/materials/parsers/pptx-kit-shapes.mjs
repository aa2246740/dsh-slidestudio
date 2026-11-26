/**
 * One slide, layout or master read into PPTD decoration elements. Text, placeholders, tables,
 * charts and diagrams are not decorations and are never emitted; the output is JSON data only.
 */
import { attrOf, childElements, descendantsOf, firstOf, localNameOf, resolvePartPath } from "./ooxml.mjs";
import { isDesaturatedBlip } from "./pptx-geometry.mjs";
import { frameOf } from "./pptx-kit-frame.mjs";
import { customGeometryOf, presetGeometryOf } from "./pptx-kit-geometry.mjs";
import { borderOf, fillOf, round4, shadowOf } from "./pptx-kit-paint.mjs";

/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {Record<string, any>} KitElement */
/** @typedef {{reason: string}} Skip */

export const KIT_PAGE_WIDTH_PX = 960;
const MAX_ELEMENTS_PER_SOURCE = 40;
const LINE_PRESETS = new Set(["line", "straightConnector1"]);
const ARROWS = new Map([
  ["triangle", "arrow"],
  ["arrow", "arrow"],
  ["stealth", "stealth"],
  ["diamond", "diamond"],
  ["oval", "oval"],
]);
const REASON = {
  geometry: "自定义形状数据无法解析，已跳过",
  image: "图片无法读取，已跳过",
  desaturate: "图片去色处理失败，已跳过",
  connector: "弯折或曲线连接线暂不支持，已跳过",
  read: "装饰元素无法读取，已跳过",
  many: `装饰元素超过 ${MAX_ELEMENTS_PER_SOURCE} 个，其余已跳过`,
};
const number = (/** @type {Node|null} */ node, /** @type {string} */ name) => Number(node ? attrOf(node, name) : NaN);

/**
 * Frame in slide fractions. The ancestor groups place the frame by the PowerPoint group rule
 * (see pptx-kit-frame.mjs): a rotated group turns the child instead of widening its bounding box,
 * and a non-uniform scale never shears it.
 * @param {Node} el @param {Node|null} xfrm @param {{width: number, height: number}} slide
 */
function placementOf(el, xfrm, slide) {
  const off = xfrm && firstOf(xfrm, "off");
  const ext = xfrm && firstOf(xfrm, "ext");
  const [x, y, w, h] = [number(off, "x"), number(off, "y"), number(ext, "cx"), number(ext, "cy")];
  if (!xfrm || ![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0 || !slide.width) return null;
  const frame = frameOf(el, xfrm);
  if (!frame) return null;
  const rotation = ((round4(frame.rotation) % 360) + 360) % 360;
  return {
    extent: { w: frame.w, h: frame.h },
    bounds: [
      round4((frame.cx - frame.w / 2) / slide.width),
      round4((frame.cy - frame.h / 2) / slide.height),
      round4(frame.w / slide.width),
      round4(frame.h / slide.height),
    ],
    ...(rotation ? { rotation } : {}),
    ...(frame.flipH ? { flipH: true } : {}),
    ...(frame.flipV ? { flipV: true } : {}),
  };
}

/** @param {Node} el */
const hasText = (el) =>
  descendantsOf(el, "fld").length > 0 || descendantsOf(el, "t").some((node) => (node.textContent ?? "").trim());

/** A horizontal or vertical line keeps a 1-unit cross axis so the path has an extent. */
function lineOf(
  /** @type {any} */ place,
  /** @type {object} */ border,
  /** @type {Node|null} */ ln,
  /** @type {{width: number, height: number}} */ slide,
) {
  const width = place.bounds[2] * KIT_PAGE_WIDTH_PX;
  const height = (place.bounds[3] * KIT_PAGE_WIDTH_PX * slide.height) / slide.width;
  const [vw, vh] = [round4(Math.max(width, 1)), round4(Math.max(height, 1))];
  const [x0, x1] = place.flipH ? [vw, 0] : [0, vw];
  const [y0, y1] = place.flipV ? [vh, 0] : [0, vh];
  const flat = height < 1e-6;
  const thin = width < 1e-6;
  const points = `M ${thin ? vw / 2 : x0} ${flat ? vh / 2 : y0} L ${thin ? vw / 2 : x1} ${flat ? vh / 2 : y1}`;
  const endOf = (/** @type {string} */ name) => {
    const end = ln && firstOf(ln, name);
    return (end && ARROWS.get(attrOf(end, "type") ?? "")) || null;
  };
  const [head, tail] = [endOf("headEnd"), endOf("tailEnd")];
  return {
    elementType: "line",
    bounds: place.bounds,
    viewBox: [vw, vh],
    points,
    border,
    ...(place.rotation ? { rotation: place.rotation } : {}),
    ...(head || tail ? { arrow: [head, tail] } : {}),
    layoutRole: "decoration",
  };
}

/**
 * @param {{root: Node, part: string, rels: Map<string, {target: string, external: boolean}>,
 *   theme: import("./pptx-colors.mjs").Palette, map: Record<string,string>,
 *   width: number, height: number}} source
 * @returns {{elements: KitElement[], skipped: Skip[]}}
 */
export function readDecorations({ root, part, rels, theme, map, width, height }) {
  const tree = firstOf(firstOf(root, "cSld") ?? root, "spTree");
  /** @type {KitElement[]} */ const elements = [];
  /** @type {Skip[]} */ const skipped = [];
  const slide = { width, height };
  const paint = {
    theme,
    map,
    px: (/** @type {number} */ emu) => (emu * KIT_PAGE_WIDTH_PX) / (width || 1),
  };

  /** @param {Node} el @returns {KitElement|Skip|null} */
  function readOne(el) {
    const tag = localNameOf(el);
    const spPr = firstOf(el, "spPr");
    if (!spPr || !isDecorationCandidate(el)) return null;
    const place = placementOf(el, firstOf(spPr, "xfrm"), slide);
    if (!place) return null;
    const style = firstOf(el, "style");
    const custGeom = firstOf(spPr, "custGeom");
    const prstGeom = firstOf(spPr, "prstGeom");
    const prstName = prstGeom ? (attrOf(prstGeom, "prst") ?? "") : "";
    const blipFill = tag === "pic" ? firstOf(el, "blipFill") : firstOf(spPr, "blipFill");

    if (tag === "cxnSp" || LINE_PRESETS.has(prstName)) {
      if (!LINE_PRESETS.has(prstName)) return { reason: REASON.connector };
      const border = borderOf(spPr, style, paint);
      return border ? lineOf(place, border, firstOf(spPr, "ln"), slide) : null;
    }
    const clip = clipOf(custGeom, prstGeom, place);
    if (clip && "reason" in clip) return clip;
    if (blipFill) return imageOf(blipFill, place, clip && "shapeName" in clip ? clip : null, part, rels);
    if (!clip) return null;
    if ("unsupported" in clip) return { reason: `形状「${clip.unsupported}」暂不支持，已跳过` };
    return shapeDecorationOf(spPr, style, paint, clip, place);
  }

  /** @param {Node} parent */
  function walk(parent) {
    for (const el of childElements(parent)) {
      const tag = localNameOf(el);
      if (tag === "grpSp") walk(el);
      else if (tag === "sp" || tag === "pic" || tag === "cxnSp") {
        let found;
        try {
          found = readOne(el);
        } catch {
          found = { reason: REASON.read };
        }
        if (!found) continue;
        if ("reason" in found) skipped.push(/** @type {Skip} */ (found));
        else if (elements.length < MAX_ELEMENTS_PER_SOURCE) elements.push(found);
        else if (!skipped.some((item) => item.reason === REASON.many)) {
          skipped.push({ reason: REASON.many });
        }
      }
    }
  }
  if (tree) walk(tree);
  return { elements, skipped };
}

/** Placeholders, text-bearing and hidden shapes are content, not template decoration. @param {Node} el */
function isDecorationCandidate(el) {
  if (descendantsOf(el, "ph").length || hasText(el)) return false;
  return attrOf(descendantsOf(el, "cNvPr")[0] ?? el, "hidden") !== "1";
}

/**
 * Custom geometry wins over a preset; unreadable custom paths skip the shape.
 * @param {Node|null} custGeom @param {Node|null} prstGeom @param {any} place
 */
function clipOf(custGeom, prstGeom, place) {
  const custom = custGeom ? customGeometryOf(custGeom, place.extent) : null;
  if (custom && "issue" in custom) return { reason: REASON.geometry };
  if (custom) return { shapeName: "custom", geometry: custom.geometry };
  return prstGeom ? presetGeometryOf(prstGeom) : null;
}

/**
 * A filled or bordered decoration shape; bare geometry with neither is dropped.
 * @param {Node} spPr @param {Node|null} style
 * @param {{theme: import("./pptx-colors.mjs").Palette, map: Record<string,string>, px: (emu: number) => number}} paint
 * @param {object} clip @param {any} place
 * @returns {KitElement|Skip|null}
 */
function shapeDecorationOf(spPr, style, paint, clip, place) {
  const { fill, unsupported } = fillOf(spPr, style, paint);
  if (unsupported) return { reason: unsupported };
  const border = borderOf(spPr, style, paint);
  if (!fill && !border) return null;
  const shadow = shadowOf(spPr, paint);
  return /** @type {KitElement} */ ({
    elementType: "shape",
    ...clip,
    bounds: place.bounds,
    ...(place.rotation ? { rotation: place.rotation } : {}),
    ...(place.flipH ? { flipH: true } : {}),
    ...(place.flipV ? { flipV: true } : {}),
    ...(fill ? { fill } : {}),
    ...(border ? { border } : {}),
    ...(shadow ? { shadow } : {}),
    layoutRole: "decoration",
  });
}

/**
 * The picture is named by its media part until the kit knows which asset it becomes.
 * @param {Node} blipFill @param {any} place
 * @param {{shapeName: string, adjustments?: number[], geometry?: object}|null} clip
 * @param {string} part @param {Map<string, {target: string, external: boolean}>} rels
 * @returns {KitElement|Skip|null}
 */
function imageOf(blipFill, place, clip, part, rels) {
  const blip = firstOf(blipFill, "blip");
  const rid = blip ? attrOf(blip, "r:embed") : null;
  if (!blip || !rid) return null;
  const rel = rels.get(rid);
  if (!rel || rel.external) return { reason: REASON.image };
  const desaturated = isDesaturatedBlip(blip);
  const rect = firstOf(blipFill, "srcRect");
  const crop = Object.fromEntries(
    [
      ["left", "l"],
      ["top", "t"],
      ["right", "r"],
      ["bottom", "b"],
    ].flatMap(([side, attr]) => {
      const value = rect ? number(rect, attr ?? "") / 100000 : 0;
      return value && Number.isFinite(value) ? [[side, round4(value)]] : [];
    }),
  );
  const shape = clip && clip.shapeName !== "rect" ? clip : null;
  return {
    elementType: "image",
    mediaPart: resolvePartPath(part, rel.target),
    desaturated,
    bounds: place.bounds,
    ...(place.rotation ? { rotation: place.rotation } : {}),
    ...(place.flipH ? { flipH: true } : {}),
    ...(place.flipV ? { flipV: true } : {}),
    ...(Object.keys(crop).length ? { crop } : {}),
    ...(shape ? { cropShape: shape } : {}),
    layoutRole: "decoration",
  };
}

export { REASON as KIT_REASONS };
