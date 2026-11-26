/**
 * Where one shape sits on the slide once its ancestor groups are applied, by the rule PowerPoint
 * and LibreOffice draw groups with (mission research/drawingml-group-child-transform.md). It
 * matches LibreOffice oox and Apache POI; PowerPoint itself was not verified directly. Shapes
 * are never sheared: a group maps the child's unrotated centre per axis, and the child keeps its
 * own turn about that centre with a box scaled on whichever axes the turn leaves along the group's.
 */
import { attrOf, firstOf, localNameOf } from "./ooxml.mjs";

/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {{x: number, y: number, w: number, h: number, rot: number, flipH: boolean, flipV: boolean}} Box */
/** A rendered box: centre and size on the slide (EMU), clockwise turn in degrees, flips in its own frame.
 * @typedef {{cx: number, cy: number, w: number, h: number, rot: number, flipH: boolean, flipV: boolean}} Frame */
/** @typedef {{frame: Frame, chOff: {x: number, y: number}, chExt: {w: number, h: number}}} Host */

const number = (/** @type {Node|null} */ node, /** @type {string} */ name) => Number(node ? attrOf(node, name) : NaN);

/** PowerPoint scales a child turned within a quarter of the vertical by the swapped axes. */
const swapsAxes = (/** @type {number} */ degrees) => {
  const turn = ((degrees % 360) + 360) % 360;
  return (turn >= 45 && turn < 135) || (turn >= 225 && turn < 315);
};

/** @param {Node} xfrm @returns {Box|null} */
function boxOf(xfrm) {
  const off = firstOf(xfrm, "off");
  const ext = firstOf(xfrm, "ext");
  const [x, y, w, h] = [number(off, "x"), number(off, "y"), number(ext, "cx"), number(ext, "cy")];
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return {
    x,
    y,
    w,
    h,
    rot: (Number(attrOf(xfrm, "rot")) || 0) / 60000,
    flipH: attrOf(xfrm, "flipH") === "1",
    flipV: attrOf(xfrm, "flipV") === "1",
  };
}

/** A group without a usable transform places its children as they are. @param {Node} group */
function groupOf(group) {
  const xfrm = firstOf(firstOf(group, "grpSpPr") ?? group, "xfrm");
  const box = xfrm && boxOf(xfrm);
  if (!xfrm || !box) return null;
  const [chOff, chExt] = [firstOf(xfrm, "chOff"), firstOf(xfrm, "chExt")];
  return {
    box,
    // A zero or missing child extent means the group does not scale (MS-OI29500).
    chOff: { x: number(chOff, "x") || 0, y: number(chOff, "y") || 0 },
    chExt: { w: number(chExt, "cx") || 0, h: number(chExt, "cy") || 0 },
  };
}

/** @param {Box} box @returns {Frame} */
const upright = ({ x, y, w, h, rot, flipH, flipV }) => ({
  cx: x + w / 2,
  cy: y + h / 2,
  w,
  h,
  rot,
  flipH,
  flipV,
});

/**
 * Group flips mirror the group's frame about its centre before its turn, so exactly one of them
 * reverses the child's turn; flips of nested groups multiply.
 * @param {Host} host @param {Box} child @returns {Frame}
 */
function placeIn({ frame, chOff, chExt }, child) {
  const scaleX = chExt.w ? frame.w / chExt.w : 1;
  const scaleY = chExt.h ? frame.h / chExt.h : 1;
  const localX = ((child.x + child.w / 2 - chOff.x) * scaleX - frame.w / 2) * (frame.flipH ? -1 : 1);
  const localY = ((child.y + child.h / 2 - chOff.y) * scaleY - frame.h / 2) * (frame.flipV ? -1 : 1);
  const radians = (frame.rot * Math.PI) / 180;
  const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
  const swapped = swapsAxes(child.rot);
  return {
    cx: frame.cx + cos * localX - sin * localY,
    cy: frame.cy + sin * localX + cos * localY,
    w: child.w * (swapped ? scaleY : scaleX),
    h: child.h * (swapped ? scaleX : scaleY),
    rot: frame.rot + (frame.flipH !== frame.flipV ? -child.rot : child.rot),
    flipH: frame.flipH !== child.flipH,
    flipV: frame.flipV !== child.flipV,
  };
}

/**
 * The shape's frame on the slide. Both flips are one half turn without flips, so at most one
 * flip is left and `rotation` is the clockwise turn in degrees, not yet reduced to a full circle.
 * @param {Node} el @param {Node} xfrm
 * @returns {{cx: number, cy: number, w: number, h: number, rotation: number, flipH: boolean, flipV: boolean}|null}
 */
export function frameOf(el, xfrm) {
  const leaf = boxOf(xfrm);
  if (!leaf) return null;
  /** @type {Node[]} */ const groups = [];
  for (let parent = el.parentNode; parent; parent = parent.parentNode) {
    if (localNameOf(parent) === "grpSp") groups.unshift(parent);
  }
  /** @type {Host|null} */ let host = null;
  for (const node of groups) {
    const group = groupOf(node);
    if (!group) continue;
    host = {
      frame: host ? placeIn(host, group.box) : upright(group.box),
      chOff: group.chOff,
      chExt: group.chExt,
    };
  }
  const { cx, cy, w, h, rot, flipH, flipV } = host ? placeIn(host, leaf) : upright(leaf);
  const both = flipH && flipV;
  return {
    cx,
    cy,
    w,
    h,
    rotation: both ? rot + 180 : rot,
    flipH: flipH && !both,
    flipV: flipV && !both,
  };
}
