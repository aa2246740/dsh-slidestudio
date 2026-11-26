/** Geometry of a template decoration: custGeom evaluated to a PPTD path, or a catalogue preset. */
import { isSupportedShapeName, ooxmlCustomGeometry, shapeDefaults } from "@open-slidestudio/pptd-v2";
import { attrOf, childElements, childrenOf, firstOf, localNameOf } from "./ooxml.mjs";

/** @typedef {import("./ooxml.mjs").DomNode} Node */

const guidesOf = (/** @type {Node|null} */ list) =>
  list
    ? childrenOf(list, "gd").map((gd) => ({
        name: attrOf(gd, "name") ?? "",
        fmla: attrOf(gd, "fmla") ?? "",
      }))
    : [];

/** @param {Node} pt */
const point = (pt) => ({ x: attrOf(pt, "x") ?? "", y: attrOf(pt, "y") ?? "" });

/** @param {Node} part @returns {import("@open-slidestudio/pptd-v2").OoxmlCustomGeometry["paths"][number]["cmds"]|null} */
function commandsOf(part) {
  /** @type {any[]} */
  const cmds = [];
  for (const cmd of childElements(part)) {
    const pts = childrenOf(cmd, "pt").map(point);
    const kind = localNameOf(cmd);
    if (kind === "close") cmds.push({ k: "Z" });
    else if (kind === "arcTo") {
      cmds.push({
        k: "A",
        wr: attrOf(cmd, "wR") ?? "",
        hr: attrOf(cmd, "hR") ?? "",
        st: attrOf(cmd, "stAng") ?? "",
        sw: attrOf(cmd, "swAng") ?? "",
      });
    } else if ((kind === "moveTo" || kind === "lnTo") && pts.length === 1) {
      cmds.push({ k: kind === "moveTo" ? "M" : "L", ...pts[0] });
    } else if (kind === "cubicBezTo" && pts.length === 3) {
      cmds.push({
        k: "C",
        x1: pts[0]?.x,
        y1: pts[0]?.y,
        x2: pts[1]?.x,
        y2: pts[1]?.y,
        ...pts[2],
      });
    } else if (kind === "quadBezTo" && pts.length === 2) {
      cmds.push({ k: "Q", x1: pts[0]?.x, y1: pts[0]?.y, ...pts[1] });
    } else return null;
  }
  return /** @type {any} */ (cmds);
}

/**
 * @param {Node} custGeom @param {{w: number, h: number}} extent EMU
 * @returns {{geometry: {viewBox: [number, number], path: string}}|{issue: string}}
 */
export function customGeometryOf(custGeom, extent) {
  const list = firstOf(custGeom, "pathLst");
  const paths = [];
  for (const part of list ? childrenOf(list, "path") : []) {
    const cmds = commandsOf(part);
    if (!cmds) return { issue: "路径指令无法识别" };
    const w = Number(attrOf(part, "w") ?? 0);
    const h = Number(attrOf(part, "h") ?? 0);
    paths.push({
      w: Number.isFinite(w) ? w : 0,
      h: Number.isFinite(h) ? h : 0,
      ...(attrOf(part, "fill") ? { fill: /** @type {string} */ (attrOf(part, "fill")) } : {}),
      cmds,
    });
  }
  const result = ooxmlCustomGeometry(extent, {
    avLst: guidesOf(firstOf(custGeom, "avLst")),
    gdLst: guidesOf(firstOf(custGeom, "gdLst")),
    paths,
  });
  return "issue" in result ? result : { geometry: result };
}

/**
 * A preset by its OOXML name; adjustments are written only when they differ from the catalogue.
 * @param {string} name @param {Map<string, string|number|undefined>} given values by guide name
 * @returns {{shapeName: string, adjustments?: number[]}|{unsupported: string}}
 */
export function presetOf(name, given) {
  if (!isSupportedShapeName(name)) return { unsupported: name };
  const defaults = shapeDefaults(name);
  const adjustments = defaults.map((value, index) => {
    const raw = given.get(defaults.length === 1 ? "adj" : `adj${index + 1}`);
    return raw === undefined ? value : Number(raw);
  });
  const changed = adjustments.some((value, index) => value !== defaults[index]);
  return { shapeName: name, ...(changed ? { adjustments } : {}) };
}

/** @param {Node} prstGeom */
export function presetGeometryOf(prstGeom) {
  return presetOf(
    attrOf(prstGeom, "prst") ?? "",
    new Map(
      childrenOf(firstOf(prstGeom, "avLst") ?? prstGeom, "gd").map((gd) => [
        attrOf(gd, "name") ?? "",
        /^val\s+(-?\d+)$/.exec(attrOf(gd, "fmla") ?? "")?.[1],
      ]),
    ),
  );
}
