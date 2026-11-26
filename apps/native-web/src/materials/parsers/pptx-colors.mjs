import { attrOf, childElements, descendantsOf, firstOf, localNameOf, normalizeHex } from "./ooxml.mjs";
/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {{hex:string,alpha:number,scheme?:string,mods:{name:string,value:number}[]}} Color */
/** @typedef {{colors:Record<string,string|null>}} Palette */
const unit = (/** @type {number} */ n) => Math.max(0, Math.min(1, n));
/** @param {number[]} rgb */
function hslOf(rgb) {
  const [r = 0, g = 0, b = 0] = rgb,
    max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min,
    l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h / 6) % 1) + 1) % 1;
  return [h, s, l];
}
/** @param {number[]} hsl */
function rgbOf(hsl) {
  const [h = 0, s = 0, l = 0] = hsl,
    c = (1 - Math.abs(2 * l - 1)) * s,
    x = c * (1 - Math.abs(((h * 6) % 2) - 1)),
    m = l - c / 2;
  const bands = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  return (bands[Math.min(5, Math.floor(h * 6))] ?? [0, 0, 0]).map((n) => unit(n + m));
}
/** Master mapping, overridden by a layout/slide clrMapOvr when present.
 * @param {Node} root @param {Record<string,string>} [inherited] */
export function colorMapOf(root, inherited = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" }) {
  const map = descendantsOf(root, "overrideClrMapping")[0] ?? descendantsOf(root, "clrMap")[0];
  const out = { ...inherited };
  for (let i = 0; i < (map?.attributes?.length ?? 0); i++) {
    const attr = map?.attributes?.[i];
    if (attr?.nodeValue) out[attr.nodeName] = attr.nodeValue;
  }
  return out;
}
/** OOXML luminance/saturation operations are HSL, tint/shade are RGB.
 * Alpha is retained (not silently composited against an invented white page).
 * @param {Node} node @param {Palette} theme @param {Record<string,string>} [map]
 * @param {Color|null} [placeholder]
 * @returns {Color|null} */
export function resolveColor(node, theme, map = {}, placeholder = null) {
  const tag = localNameOf(node),
    scheme = tag === "schemeClr" ? attrOf(node, "val") : null;
  const base = scheme === "phClr" ? placeholder : null;
  const value = base
    ? base.hex
    : scheme
      ? theme.colors[map[scheme] ?? scheme]
      : attrOf(node, tag === "sysClr" ? "lastClr" : "val");
  const hex = normalizeHex(value);
  if (!hex) return null;
  let rgb = [1, 3, 5].map((n) => parseInt(hex.slice(n, n + 2), 16) / 255),
    alpha = base?.alpha ?? 1;
  const mods = childElements(node).map((el) => ({
    name: localNameOf(el),
    value: Number(attrOf(el, "val")),
  }));
  for (const mod of mods) {
    const v = mod.value / 100000;
    if (!Number.isFinite(v)) continue;
    if (mod.name === "alpha") alpha = unit(v);
    else if (mod.name === "alphaMod") alpha = unit(alpha * v);
    else if (mod.name === "alphaOff") alpha = unit(alpha + v);
    else rgb = applyRgbMod(rgb, mod.name, v);
  }
  const resolvedScheme = base ? base.scheme : scheme;
  return {
    hex: `#${rgb
      .map((c) =>
        Math.round(unit(c) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()}`,
    alpha,
    ...(resolvedScheme ? { scheme: resolvedScheme } : {}),
    mods: [...(base?.mods ?? []), ...mods],
  };
}
/** Tint/shade work on RGB; luminance and saturation mods go through HSL. Unknown mods are ignored.
 * @param {number[]} rgb @param {string} name @param {number} v @returns {number[]} */
function applyRgbMod(rgb, name, v) {
  if (name === "tint") return rgb.map((c) => c * v + 1 - v);
  if (name === "shade") return rgb.map((c) => c * v);
  const hsl = hslOf(rgb);
  if (name === "lumMod") hsl[2] = unit((hsl[2] ?? 0) * v);
  else if (name === "lumOff") hsl[2] = unit((hsl[2] ?? 0) + v);
  else if (name === "satMod") hsl[1] = unit((hsl[1] ?? 0) * v);
  else if (name === "satOff") hsl[1] = unit((hsl[1] ?? 0) + v);
  else return rgb;
  return rgbOf(hsl);
}
/** @param {Node} node @param {Palette} theme @param {Record<string,string>} map
 * @param {Color|null} placeholder */
function colorChild(node, theme, map, placeholder) {
  const color = childElements(node).find((n) => ["srgbClr", "schemeClr", "sysClr"].includes(localNameOf(n)));
  return color ? resolveColor(color, theme, map, placeholder) : null;
}
/** @param {Node} root @param {Palette} theme @param {Record<string,string>} map
 * @param {Color|null} [placeholder] */
export function gradientsOf(root, theme, map, placeholder = null) {
  const fills = localNameOf(root) === "gradFill" ? [root] : descendantsOf(root, "gradFill");
  return fills.map((fill) => ({
    stops: descendantsOf(fill, "gs").flatMap((gs) => {
      const color = colorChild(gs, theme, map, placeholder);
      return color ? [{ position: Number(attrOf(gs, "pos")) / 100000, ...color }] : [];
    }),
    angle: Number(attrOf(firstOf(fill, "lin") ?? fill, "ang")) / 60000,
  }));
}
/** @typedef {{hex:string,roles:Set<string>,weight:number}} ColorUse */
/** @param {Node} root @param {Palette} theme @param {Record<string,string>} map @param {Map<string,ColorUse>} uses @param {boolean} [chart] */
export function noteColors(root, theme, map, uses, chart = false) {
  /** @param {Node} node @param {string|null} role */
  function visit(node, role) {
    const name = localNameOf(node);
    if (["clrScheme", "outerShdw", "innerShdw"].includes(name)) return;
    if (["rPr", "defRPr", "endParaRPr"].includes(name)) role = "text";
    else if (name === "ln") role = "line";
    else if (["solidFill", "gradFill", "bgPr"].includes(name) && role !== "text" && role !== "line") role = "fill";
    if (["srgbClr", "schemeClr", "sysClr"].includes(name) && role) {
      const color = resolveColor(node, theme, map);
      if (color) {
        const use = uses.get(color.hex) ?? { hex: color.hex, roles: new Set(), weight: 0 };
        use.roles.add(chart ? "chart" : role);
        use.weight += color.alpha;
        uses.set(color.hex, use);
      }
    }
    for (const child of childElements(node)) visit(child, role);
  }
  visit(root, null);
}
/** @param {Map<string,ColorUse>} uses */
export function observedColors(uses) {
  return [...uses.values()]
    .sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex))
    .slice(0, 16)
    .map((use) => ({ ...use, roles: [...use.roles].sort() }));
}
