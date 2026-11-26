/** Cached SmartArt paint/geometry, described as data rather than copied OOXML. */
import {
  attrOf,
  childElements,
  childrenOf,
  descendantsOf,
  firstOf,
  localNameOf,
  normalizeHex,
  parseRels,
  resolvePartPath,
} from "./ooxml.mjs";
import { resolveColor, gradientsOf } from "./pptx-colors.mjs";
import { diagramBodyText, diagramXml } from "./ooxml-diagram-xml.mjs";
import { transformBox } from "./pptx-geometry.mjs";

/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {import("./pptx-colors.mjs").Palette} Palette */
/** @typedef {import("./pptx-colors.mjs").Color} Color */
/** @typedef {import("./ooxml-diagram.mjs").Box} Box */
/** @typedef {import("./ooxml-diagram.mjs").DiagramOptions} Options */
/** @param {Node|null|undefined} el @param {string} name @param {number} [fallback] */
const num = (el, name, fallback = 0) => {
  const raw = el && attrOf(el, name);
  return raw !== null && raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : fallback;
};
/** @param {Node|null|undefined} root @param {string} name */
const child = (root, name) => (root ? firstOf(root, name) : null);

/** @param {Node|null} node @param {Palette} theme @param {Record<string,string>} map
 * @param {Color|null} [placeholder] @returns {Color|null} */
function colorOf(node, theme, map, placeholder = null) {
  const clr = node && childElements(node).find((n) => ["srgbClr", "schemeClr", "sysClr"].includes(localNameOf(n)));
  return clr ? resolveColor(clr, theme, map, placeholder) : null;
}

/** Find the host's theme via layout/master relationships, never a guessed theme1.xml.
 * @param {import("./ooxml.mjs").PackageReader} pkg @param {string} part
 * @param {Set<string>} [seen] @returns {Node|null} */
function themeRoot(pkg, part, seen = new Set()) {
  if (seen.has(part) || seen.size >= 5) return null;
  seen.add(part);
  const rels = [...parseRels(pkg, part).values()].filter((rel) => !rel.external);
  for (const rel of rels.filter((r) => ["theme", "slideLayout", "slideMaster"].includes(r.type))) {
    const target = resolvePartPath(part, rel.target);
    if (rel.type !== "theme") {
      const found = themeRoot(pkg, target, seen);
      if (found) return found;
    } else {
      const text = pkg.text(target);
      if (text !== undefined) return diagramXml(text, "theme");
    }
  }
  return null;
}

/** @param {Node|null} root @returns {Palette} */
function paletteOf(root) {
  /** @type {Record<string,string|null>} */ const colors = {};
  const scheme = root && descendantsOf(root, "clrScheme")[0];
  if (scheme)
    for (const entry of childElements(scheme)) {
      const color = childElements(entry)[0];
      if (color) colors[localNameOf(entry)] = normalizeHex(attrOf(color, "lastClr") ?? attrOf(color, "val"));
    }
  return { colors };
}

/** @param {Node|null} xf @param {Box|null} frame @param {Options} options */
function boxOf(xf, frame, options) {
  const off = child(xf, "off"),
    ext = child(xf, "ext");
  if (!off || !ext) return null;
  const width = options.width || 1,
    height = options.height || 1;
  const box = transformBox(
    {
      x: num(off, "x") + (frame?.x ?? 0),
      y: num(off, "y") + (frame?.y ?? 0),
      w: num(ext, "cx"),
      h: num(ext, "cy"),
    },
    options.transform,
  );
  return [box.x / width, box.y / height, box.w / width, box.h / height];
}

/** @param {Node|null} root @param {string} label */
function styleLabel(root, label) {
  return root ? (descendantsOf(root, "styleLbl").find((el) => attrOf(el, "name") === label) ?? null) : null;
}

/** @param {Node|null} props @param {Node|null} style @param {Node|null} themeRootNode
 * @param {Palette} theme @param {Record<string,string>} map
 * @returns {{fill:Color|null,gradients?:ReturnType<typeof gradientsOf>}} */
function shapePaint(props, style, themeRootNode, theme, map) {
  if (child(props, "noFill")) return { fill: null };
  const explicit = colorOf(child(props, "solidFill"), theme, map);
  if (explicit) return { fill: explicit };
  const gradient = child(props, "gradFill");
  if (gradient) return { fill: null, gradients: gradientsOf(gradient, theme, map) };
  const ref = child(style, "fillRef");
  const referenceColor = colorOf(ref, theme, map);
  const list = themeRootNode && descendantsOf(themeRootNode, "fillStyleLst")[0];
  const fill = list ? childElements(list)[num(ref, "idx") - 1] : null;
  if (!fill) return { fill: referenceColor };
  return localNameOf(fill) === "gradFill"
    ? { fill: null, gradients: gradientsOf(fill, theme, map, referenceColor) }
    : { fill: colorOf(fill, theme, map, referenceColor) };
}

/** @param {Node|null} body @param {Color|null} fallback @param {Palette} theme @param {Record<string,string>} map */
function paragraphs(body, fallback, theme, map) {
  if (!body) return [];
  return childrenOf(body, "p").map((p) => {
    const pp = child(p, "pPr"),
      def = child(pp, "defRPr");
    return {
      lvl: num(pp, "lvl"),
      algn: pp ? attrOf(pp, "algn") : null,
      runs: childElements(p)
        .filter((r) => ["r", "fld", "br"].includes(localNameOf(r)))
        .map((r) => {
          const own = child(r, "rPr");
          /** @param {string} key */
          const value = (key) => (own && attrOf(own, key)) ?? (def && attrOf(def, key));
          const latin = child(own, "latin") ?? child(def, "latin");
          const ea = child(own, "ea") ?? child(def, "ea");
          return {
            text:
              localNameOf(r) === "br"
                ? "\n"
                : descendantsOf(r, "t")
                    .map((t) => t.textContent ?? "")
                    .join(""),
            sz: value("sz") === null ? null : Number(value("sz")) / 100,
            b: value("b") === "1",
            i: value("i") === "1",
            latin: latin ? attrOf(latin, "typeface") : null,
            ea: ea ? attrOf(ea, "typeface") : null,
            color:
              colorOf(child(own, "solidFill"), theme, map) ?? colorOf(child(def, "solidFill"), theme, map) ?? fallback,
          };
        }),
    };
  });
}

/** Numeric custom paths are retained in the product's absolute M/L/C/Q/Z syntax.
 * Unsupported formulas are not silently converted into arbitrary geometry.
 * @param {Node} geom */
function customPath(geom) {
  const paths = descendantsOf(geom, "path");
  const first = paths[0];
  if (!first) return null;
  const viewBox = [num(first, "w"), num(first, "h")];
  const commands = [];
  for (const path of paths)
    for (const command of childElements(path)) {
      const tag = localNameOf(command);
      if (tag === "close") {
        commands.push("Z");
        continue;
      }
      const prefix = /** @type {Record<string,string>} */ ({
        moveTo: "M",
        lnTo: "L",
        cubicBezTo: "C",
        quadBezTo: "Q",
      })[tag];
      if (!prefix) return null;
      const coordinates = childrenOf(command, "pt").flatMap((pt) => [attrOf(pt, "x"), attrOf(pt, "y")]);
      if (coordinates.some((value) => value === null || !Number.isFinite(Number(value)))) return null;
      commands.push(`${prefix}${coordinates.join(" ")}`);
    }
  const path = commands.join(" ");
  return commands.length <= 256 && Buffer.byteLength(path) <= 4096 ? { path, viewBox } : null;
}

/** @param {Node|null} props */
function geometry(props) {
  const preset = child(props, "prstGeom");
  if (preset)
    return {
      preset: attrOf(preset, "prst"),
      adj: Object.fromEntries(
        descendantsOf(preset, "gd").flatMap((gd) => {
          const literal = /^val (-?\d+(?:\.\d+)?)$/.exec(attrOf(gd, "fmla") ?? "");
          return literal ? [[attrOf(gd, "name") ?? "", Number(literal[1])]] : [];
        }),
      ),
    };
  const custom = child(props, "custGeom");
  return custom ? customPath(custom) : null;
}

/**
 * The data point a drawn shape shows: its presentation's associated point, the presentation
 * point itself, else the data node with the same text.
 * @param {Node|undefined} presentation @param {Map<string|null, Node>} byId @param {Node[]} data
 * @param {string} text
 */
function diagramPointOf(presentation, byId, data, text) {
  const association = presentation && child(presentation, "prSet");
  const associated = association && attrOf(association, "presAssocID");
  const linked = [associated ? byId.get(associated) : undefined, presentation].find(
    (point) => point && ["node", "asst", "sibTrans", "parTrans"].includes(attrOf(point, "type") ?? "node"),
  );
  const node =
    linked ??
    data.find((p) => {
      const t = child(p, "t");
      return text && t && diagramBodyText(t) === text;
    });
  return { node, association };
}

/** @param {Node|undefined} node @returns {"node"|"connector"|"decoration"} */
function diagramRoleOf(node) {
  const type = node ? (attrOf(node, "type") ?? "node") : "";
  if (["node", "asst"].includes(type)) return "node";
  return ["sibTrans", "parTrans"].includes(type) ? "connector" : "decoration";
}

/** @param {import("./ooxml.mjs").PackageReader} pkg @param {string} hostPart
 * @param {Node} drawing @param {Node[]} points @param {Box|null} frame
 * @param {Options} options @param {Node|null} quickStyle @param {Node|null} colors */
export function cachedDiagramShapes(pkg, hostPart, drawing, points, frame, options, quickStyle, colors) {
  const root = themeRoot(pkg, hostPart),
    theme = options.theme ?? paletteOf(root),
    map = options.map ?? {};
  const byId = new Map(points.map((point) => [attrOf(point, "modelId"), point]));
  const data = points.filter((p) => ["node", "asst"].includes(attrOf(p, "type") ?? "node")).slice(0, 200);
  const sources = descendantsOf(drawing, "sp");
  let unsupportedGeometry = false;
  const shapes = sources.slice(0, 300).map((shape) => {
    const modelId = attrOf(shape, "modelId");
    const body = child(shape, "txBody");
    const { node, association } = diagramPointOf(byId.get(modelId), byId, data, diagramBodyText(body));
    const role = diagramRoleOf(node);
    const label = (association && attrOf(association, "presStyleLbl")) ?? "node";
    const props = child(shape, "spPr"),
      xf = child(props, "xfrm");
    const style = child(shape, "style") ?? child(styleLabel(quickStyle, label), "style");
    const colorLabel = styleLabel(colors, label);
    const paint = shapePaint(props, style, root, theme, map);
    const fill =
      child(props, "noFill") || paint.gradients
        ? null
        : (paint.fill ?? colorOf(child(colorLabel, "fillClrLst"), theme, map));
    const line = child(props, "ln");
    const geom = geometry(props);
    if (!geom && child(props, "custGeom")) unsupportedGeometry = true;
    const fontColor =
      colorOf(child(style, "fontRef"), theme, map) ?? colorOf(child(colorLabel, "txFillClrLst"), theme, map);
    const textTransform = child(shape, "txXfrm");
    return {
      role,
      nodeId: node ? attrOf(node, "modelId") : null,
      modelId,
      box: boxOf(xf, frame, options),
      rot: num(xf, "rot") / 60000,
      flipH: xf ? attrOf(xf, "flipH") === "1" : false,
      flipV: xf ? attrOf(xf, "flipV") === "1" : false,
      geom,
      fill,
      ...(paint.gradients ? { gradients: paint.gradients } : {}),
      line: line
        ? {
            // a:ln w is EMU; the imported width is PPTD px like every border.width (ruling 112).
            width: num(line, "w") / 9525,
            color: colorOf(child(line, "solidFill"), theme, map),
            dash: attrOf(child(line, "prstDash") ?? line, "val"),
          }
        : null,
      ...(body
        ? {
            text: {
              box: boxOf(textTransform ?? xf, frame, options),
              anchor: attrOf(child(body, "bodyPr") ?? body, "anchor"),
              paras: paragraphs(body, fontColor, theme, map),
            },
          }
        : {}),
    };
  });
  return { shapes, truncated: sources.length > 300, unsupportedGeometry };
}
