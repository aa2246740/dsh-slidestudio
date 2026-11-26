/** Descriptive geometry only; never an imported page or source XML. */
import { attrOf, childElements, childrenOf, descendantsOf, firstOf, localNameOf } from "./ooxml.mjs";

/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {{x:number,y:number,w:number,h:number}} Box */
/** @typedef {[number,number,number,number,number,number]} Matrix */
/** @typedef {{text:string,latin:string|null,ea:string|null,pt:number|null,bold:boolean,level?:number}} Run */
/** @typedef {{ph:{type:string|null,idx:string|null}|null,name:string|null,box:Box|null,text:string,embed:string|null,kind:string,sourceKind?:string,rot?:number,flip?:{h:boolean,v:boolean},group?:boolean,grayscale?:boolean,runs:Run[],table?:Table}} Shape */
/** @typedef {{text:string,rowSpan:number,colSpan:number,hMerge:boolean,vMerge:boolean}} Cell */
/** @typedef {{rows:Cell[][],columns:number}} Table */
const round = (/** @type {number} */ n) => Math.round(n * 10000) / 10000;
const identity = /** @type {Matrix} */ ([1, 0, 0, 1, 0, 0]);

/** @param {Node|null} el @param {string} name @param {number} [fallback] */
const number = (el, name, fallback = 0) => {
  const value = el ? attrOf(el, name) : null;
  return value !== null && Number.isFinite(Number(value)) ? Number(value) : fallback;
};
/** @param {Matrix} a @param {Matrix} b @returns {Matrix} */
function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
/** @param {Node} group @returns {Matrix} */
function groupMatrix(group) {
  const xf = firstOf(firstOf(group, "grpSpPr") ?? group, "xfrm");
  if (!xf) return identity;
  const off = firstOf(xf, "off"),
    ext = firstOf(xf, "ext");
  const chOff = firstOf(xf, "chOff"),
    chExt = firstOf(xf, "chExt");
  const x = number(off, "x"),
    y = number(off, "y");
  const w = number(ext, "cx", 1),
    h = number(ext, "cy", 1);
  const sx = w / (number(chExt, "cx", w) || 1),
    sy = h / (number(chExt, "cy", h) || 1);
  const rad = ((number(xf, "rot") / 60000) * Math.PI) / 180;
  const c = Math.cos(rad),
    s = Math.sin(rad);
  const fx = attrOf(xf, "flipH") === "1" ? -1 : 1;
  const fy = attrOf(xf, "flipV") === "1" ? -1 : 1;
  const rotate = /** @type {Matrix} */ ([c * fx, s * fx, -s * fy, c * fy, x + w / 2, y + h / 2]);
  return multiply(rotate, [sx, 0, 0, sy, -w / 2 - sx * number(chOff, "x"), -h / 2 - sy * number(chOff, "y")]);
}
/** @param {Node} node @returns {Matrix} */
export function ancestorGroupMatrix(node) {
  const groups = [];
  for (let parent = node.parentNode; parent; parent = parent.parentNode)
    if (localNameOf(parent) === "grpSp") groups.unshift(parent);
  return groups.reduce((matrix, group) => multiply(matrix, groupMatrix(group)), identity);
}
/** Transform all corners before taking bounds; cached text and shapes use the same host chain.
 * @param {Box} box @param {Matrix} [m] @returns {Box} */
export function transformBox({ x, y, w, h }, m = identity) {
  const points = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ];
  const xs = points.map(([px = 0, py = 0]) => m[0] * px + m[2] * py + m[4]);
  const ys = points.map(([px = 0, py = 0]) => m[1] * px + m[3] * py + m[5]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}
/** @param {Node} el @param {Matrix} m @param {number} width @param {number} height */
function shapeBox(el, m, width, height) {
  const xf = firstOf(firstOf(el, "spPr") ?? el, "xfrm");
  const off = xf && firstOf(xf, "off"),
    ext = xf && firstOf(xf, "ext");
  if (!off || !ext || !width || !height) return null;
  const box = transformBox(
    {
      x: number(off, "x"),
      y: number(off, "y"),
      w: number(ext, "cx"),
      h: number(ext, "cy"),
    },
    m,
  );
  return {
    x: round(box.x / width),
    y: round(box.y / height),
    w: round(box.w / width),
    h: round(box.h / height),
  };
}
/** @param {Node} body */
function bodyText(body) {
  return childrenOf(body, "p")
    .map((p) =>
      descendantsOf(p, "t")
        .map((t) => t.textContent ?? "")
        .join(""),
    )
    .filter(Boolean)
    .join("\n");
}
/** @param {Node} table @returns {Table} */
function tableOf(table) {
  const rows = childrenOf(table, "tr").map((row) =>
    childrenOf(row, "tc").map((cell) => ({
      text: bodyText(firstOf(cell, "txBody") ?? cell),
      rowSpan: number(cell, "rowSpan", 1),
      colSpan: number(cell, "gridSpan", 1),
      hMerge: attrOf(cell, "hMerge") === "1",
      vMerge: attrOf(cell, "vMerge") === "1",
    })),
  );
  return {
    rows,
    columns:
      childrenOf(firstOf(table, "tblGrid") ?? table, "gridCol").length || Math.max(0, ...rows.map((r) => r.length)),
  };
}
/**
 * A picture the template shows without its colour. One definition for the media scan (which
 * decides what gets a grey derivative) and for the kit (which decides what asks for one), so
 * the two can never disagree about a picture.
 * @param {Node} blip
 */
export const isDesaturatedBlip = (blip) =>
  descendantsOf(blip, "grayscl").length > 0 ||
  descendantsOf(blip, "duotone").length > 0 ||
  descendantsOf(blip, "saturation").some((node) => attrOf(node, "sat") === "0");
/** Run formatting resolves paragraph defaults here; layout/master fallback is added by the caller.
 * @param {Node|null} body @returns {Run[]} */
export function runsOf(body) {
  if (!body) return [];
  return childrenOf(body, "p").flatMap((p) => {
    const props = firstOf(p, "pPr");
    const def = props && firstOf(props, "defRPr");
    const level = number(props, "lvl", 0) + 1;
    const style = firstOf(body, "lstStyle");
    const levelProps = style && firstOf(style, `lvl${level}pPr`);
    const styleDefault = levelProps && firstOf(levelProps, "defRPr");
    return childElements(p)
      .filter((r) => ["r", "fld"].includes(localNameOf(r)))
      .map((r) => {
        const own = firstOf(r, "rPr");
        const defaults = [own, def, styleDefault].filter((n) => n !== null);
        /** @param {string} script */
        const face = (script) => defaults.map((n) => firstOf(n, script)).find((n) => n && attrOf(n, "typeface"));
        const latin = face("latin"),
          ea = face("ea");
        const size = defaults.find((n) => attrOf(n, "sz") !== null);
        return {
          level,
          text: descendantsOf(r, "t")
            .map((t) => t.textContent ?? "")
            .join(""),
          latin: latin ? attrOf(latin, "typeface") : null,
          ea: ea ? attrOf(ea, "typeface") : null,
          pt: size ? number(size, "sz") / 100 : null,
          bold: defaults.some((n) => attrOf(n, "b") === "1"),
        };
      });
  });
}
/** @param {Node} el @param {string} tag @param {Node|undefined} table @param {Node|null} body */
function sourceKindOf(el, tag, table, body) {
  if (table) return "table";
  if (descendantsOf(el, "chart").length) return "chart";
  if (tag === "pic") return "picture";
  if (body) return "text";
  if (tag === "cxnSp") return "line";
  return descendantsOf(el, "custGeom").length ? "custom" : "shape";
}
/** @param {Node|null} xf */
function transformOf(xf) {
  if (!xf) return {};
  const flipped = attrOf(xf, "flipH") || attrOf(xf, "flipV");
  return {
    ...(attrOf(xf, "rot") ? { rot: number(xf, "rot") / 60000 } : {}),
    ...(flipped ? { flip: { h: attrOf(xf, "flipH") === "1", v: attrOf(xf, "flipV") === "1" } } : {}),
  };
}
/**
 * @param {Node} el @param {string} tag @param {Matrix} matrix @param {boolean} grouped
 * @param {number} width @param {number} height @returns {Shape}
 */
function shapeOf(el, tag, matrix, grouped, width, height) {
  const body = firstOf(el, "txBody"),
    ph = descendantsOf(el, "ph")[0];
  const blip = descendantsOf(el, "blip")[0],
    table = descendantsOf(el, "tbl")[0];
  const xf = firstOf(firstOf(el, "spPr") ?? el, "xfrm");
  const sourceKind = sourceKindOf(el, tag, table, body);
  return {
    ph: ph ? { type: attrOf(ph, "type") ?? "body", idx: attrOf(ph, "idx") } : null,
    name: attrOf(descendantsOf(el, "cNvPr")[0] ?? el, "name"),
    box: shapeBox(el, matrix, width, height),
    text: body ? bodyText(body) : "",
    embed: blip ? attrOf(blip, "r:embed") : null,
    kind: grouped ? "group-child" : sourceKind,
    ...(grouped ? { sourceKind } : {}),
    runs: table ? descendantsOf(table, "txBody").flatMap(runsOf) : runsOf(body),
    ...(blip && isDesaturatedBlip(blip) ? { grayscale: true } : {}),
    ...(grouped ? { group: true } : {}),
    ...transformOf(xf),
    ...(table ? { table: tableOf(table) } : {}),
  };
}
/** @param {Node} root @param {number} width @param {number} height @returns {Shape[]} */
export function parseShapes(root, width, height) {
  const tree = firstOf(firstOf(root, "cSld") ?? root, "spTree");
  if (!tree) return [];
  /** @type {Shape[]} */ const shapes = [];
  /** @param {Node} parent @param {Matrix} matrix @param {boolean} grouped */
  function walk(parent, matrix, grouped) {
    for (const el of childElements(parent)) {
      const tag = localNameOf(el);
      if (tag === "grpSp") {
        walk(el, multiply(matrix, groupMatrix(el)), true);
        continue;
      }
      if (!["sp", "pic", "graphicFrame", "cxnSp"].includes(tag)) continue;
      shapes.push(shapeOf(el, tag, matrix, grouped, width, height));
    }
  }
  walk(tree, identity, false);
  return shapes;
}
/** @param {Shape[]} shapes @param {Shape[][]} parents */
export function inheritBoxes(shapes, parents) {
  /** @param {Shape} shape @param {number} from @returns {Box|null} */
  function resolveBox(shape, from) {
    if (shape.box || !shape.ph) return shape.box;
    // A boxless exact match still owns its inheritance chain, not a sibling's box.
    for (let i = from; i < parents.length; i++) {
      const exact = parents[i]?.find(
        (candidate) => candidate.ph && shape.ph?.idx !== null && candidate.ph.idx === shape.ph?.idx,
      );
      if (exact) return resolveBox(exact, i + 1);
    }
    const type = /title/i.test(shape.ph.type ?? "") ? "title" : shape.ph.type;
    for (let i = from; i < parents.length; i++) {
      for (const candidate of parents[i] ?? []) {
        if (!candidate.ph || (/title/i.test(candidate.ph.type ?? "") ? "title" : candidate.ph.type) !== type) continue;
        const box = resolveBox(candidate, i + 1);
        if (box) return box;
      }
    }
    return null;
  }
  for (const shape of shapes) {
    if (shape.box || !shape.ph) continue;
    const box = resolveBox(shape, 0);
    if (box) shape.box = { ...box };
  }
}
/** True geometry remains unchanged; only reuse slots are clipped.
 * @param {Box} box */
export function clampBox(box) {
  const x = Math.max(0, Math.min(1, box.x)),
    y = Math.max(0, Math.min(1, box.y));
  const w = Math.max(0, Math.min(1, box.x + box.w) - x),
    h = Math.max(0, Math.min(1, box.y + box.h) - y);
  const clipped = { x: round(x), y: round(y), w: round(w), h: round(h) };
  return {
    ...clipped,
    clamped: Object.keys(clipped).some(
      (key) => clipped[/** @type {keyof Box} */ (key)] !== box[/** @type {keyof Box} */ (key)],
    ),
  };
}
/** @param {Box} box @returns {[number,number,number,number]} */
export const boxArray = (box) => [box.x, box.y, box.w, box.h];
/** @param {Shape[]} shapes */
export function titleOf(shapes) {
  const placeholder = shapes.find((s) => s.ph && /title/i.test(s.ph.type ?? "") && s.text);
  const candidates = shapes.filter((s) => s.text && s.box && s.box.y < 0.12);
  candidates.sort(
    (a, b) =>
      Math.max(0, ...b.runs.map((r) => r.pt ?? 0)) - Math.max(0, ...a.runs.map((r) => r.pt ?? 0)) ||
      (a.box?.y ?? 0) - (b.box?.y ?? 0),
  );
  return (
    placeholder?.text ??
    candidates[0]?.text ??
    shapes
      .filter((s) => s.text)
      .sort((a, b) => Math.max(0, ...b.runs.map((r) => r.pt ?? 0)) - Math.max(0, ...a.runs.map((r) => r.pt ?? 0)))[0]
      ?.text ??
    null
  );
}
/** @param {Shape} shape */
export function geometryOf(shape) {
  const { box, embed, ph, runs, ...rest } = shape;
  return {
    ...rest,
    box: box ? boxArray(box) : null,
    placeholder: ph,
    ...(embed ? { mediaRelationship: embed } : {}),
    runs,
  };
}
