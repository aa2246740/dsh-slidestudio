/** Fill, border and shadow of a template decoration as PPTD fields; never source XML. */
import { attrOf, childElements, childrenOf, firstOf, localNameOf } from "./ooxml.mjs";
import { resolveColor } from "./pptx-colors.mjs";

/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {{theme: import("./pptx-colors.mjs").Palette, map: Record<string,string>, px: (emu: number) => number}} PaintContext */
/** @typedef {{hex: string, alpha: number}} Resolved */

export const round4 = (/** @type {number} */ n) => Math.round(n * 1e4) / 1e4 || 0;
const COLOR_TAGS = ["srgbClr", "schemeClr", "sysClr"];
const DASHES = new Map([
  ["dash", "dashed"],
  ["lgDash", "dashed"],
  ["sysDash", "dashed"],
  ["dot", "dotted"],
  ["sysDot", "dotted"],
  ["dashDot", "dash-dot"],
  ["lgDashDot", "dash-dot"],
  ["sysDashDot", "dash-dot"],
]);
const hex2 = (/** @type {number} */ n) =>
  Math.round(Math.max(0, Math.min(1, n)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

/** @param {Node} parent @param {PaintContext} ctx @returns {Resolved|null} */
function colorOf(parent, ctx) {
  const node = childElements(parent).find((child) => COLOR_TAGS.includes(localNameOf(child)));
  const color = node ? resolveColor(node, ctx.theme, ctx.map) : null;
  return color ? { hex: color.hex, alpha: color.alpha } : null;
}

/** Translucent colours use the PPTD `#RRGGBBAA` form. @param {Resolved} color */
export const solidHex = (color) => (color.alpha < 1 ? `${color.hex}${hex2(color.alpha)}` : color.hex);

/** @param {string|null|undefined} preset the `a:prstDash` value @returns {string|undefined} */
export const dashStyleOf = (preset) => DASHES.get(preset ?? "");

/** @param {Node} fill @param {PaintContext} ctx */
function gradientOf(fill, ctx) {
  const list = firstOf(fill, "gsLst");
  const stops = (list ? childrenOf(list, "gs") : []).flatMap((gs) => {
    const color = colorOf(gs, ctx);
    const position = Number(attrOf(gs, "pos"));
    if (!color || !Number.isFinite(position)) return [];
    return [
      {
        position: round4(Math.max(0, Math.min(1, position / 100000))),
        color: color.hex,
        ...(color.alpha < 1 ? { alpha: round4(color.alpha) } : {}),
      },
    ];
  });
  stops.sort((a, b) => a.position - b.position);
  if (stops.length < 2) return stops[0] ? { type: "solid", color: stops[0].color } : undefined;
  if (firstOf(fill, "path")) return { type: "gradient", gradientType: "radial", stops };
  const angle = Number(attrOf(firstOf(fill, "lin") ?? fill, "ang")) || 0;
  return {
    type: "gradient",
    gradientType: "linear",
    stops,
    angle: round4((((angle / 60000) % 360) + 360) % 360),
  };
}

/** @param {Node|null} style @param {string} ref @param {PaintContext} ctx */
function styleColor(style, ref, ctx) {
  const node = style && firstOf(style, ref);
  return node && Number(attrOf(node, "idx")) > 0 ? colorOf(node, ctx) : null;
}

/**
 * @param {Node} spPr @param {Node|null} style @param {PaintContext} ctx
 * @returns {{fill?: object, unsupported?: string}}
 */
export function fillOf(spPr, style, ctx) {
  const own = childElements(spPr).find((child) =>
    ["solidFill", "gradFill", "noFill", "pattFill", "grpFill"].includes(localNameOf(child)),
  );
  const tag = own ? localNameOf(own) : "";
  if (tag === "pattFill") return { unsupported: "图案填充暂不支持，已跳过" };
  if (tag === "noFill") return {};
  if (tag === "gradFill") {
    const fill = gradientOf(/** @type {Node} */ (own), ctx);
    return fill ? { fill } : {};
  }
  const color = tag === "solidFill" ? colorOf(/** @type {Node} */ (own), ctx) : null;
  const inherited = color ?? (tag ? null : styleColor(style, "fillRef", ctx));
  return inherited ? { fill: { type: "solid", color: solidHex(inherited) } } : {};
}

/** @param {Node} spPr @param {Node|null} style @param {PaintContext} ctx */
export function borderOf(spPr, style, ctx) {
  const ln = firstOf(spPr, "ln");
  if (ln && firstOf(ln, "noFill")) return undefined;
  const solid = ln && firstOf(ln, "solidFill");
  const color = (solid && colorOf(solid, ctx)) ?? (ln && solid ? null : styleColor(style, "lnRef", ctx));
  if (!color) return undefined;
  const width = Number(attrOf(ln ?? spPr, "w"));
  const dash = DASHES.get(attrOf(firstOf(ln ?? spPr, "prstDash") ?? spPr, "val") ?? "");
  return {
    ...(dash ? { style: dash } : {}),
    width: round4(ctx.px(Number.isFinite(width) && width > 0 ? width : 9525)),
    color: solidHex(color),
  };
}

/** @param {Node} spPr @param {PaintContext} ctx */
export function shadowOf(spPr, ctx) {
  const shadow = firstOf(firstOf(spPr, "effectLst") ?? spPr, "outerShdw");
  if (!shadow) return undefined;
  const dist = ctx.px(Number(attrOf(shadow, "dist")) || 0);
  const dir = (((Number(attrOf(shadow, "dir")) || 0) / 60000) * Math.PI) / 180;
  const color = colorOf(shadow, ctx);
  return {
    blur: round4(ctx.px(Number(attrOf(shadow, "blurRad")) || 0)),
    ...(color ? { color: color.hex } : {}),
    offsetX: round4(dist * Math.cos(dir)),
    offsetY: round4(dist * Math.sin(dir)),
    ...(color && color.alpha < 1 ? { opacity: round4(color.alpha) } : {}),
  };
}
