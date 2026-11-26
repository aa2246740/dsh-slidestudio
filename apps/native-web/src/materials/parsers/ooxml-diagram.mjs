/** Bounded, descriptive SmartArt reader. No layout engine and no source XML in output. */
import { attrOf, descendantsOf, firstOf, resolvePartPath } from "./ooxml.mjs";
import { cachedDiagramShapes } from "./ooxml-diagram-shapes.mjs";
import { diagramBodyText, diagramXml } from "./ooxml-diagram-xml.mjs";

/** @typedef {import("./ooxml.mjs").DomNode} Node */
/** @typedef {import("./ooxml.mjs").PackageReader} Package */
/** @typedef {Map<string,import("./ooxml.mjs").PartRelationship>} Relationships */
/** @typedef {{code:string,message:string}} Warning */
/** @typedef {{x:number,y:number,w:number,h:number}} Box */
/** @typedef {{id:string,text:string,level:number,type:string,children:DiagramNode[]}} DiagramNode */
/** @typedef {{count:number,truncated:boolean}} DiagramBudget */
/** @typedef {{width?:number,height?:number,index?:number,theme?:import("./pptx-colors.mjs").Palette,map?:Record<string,string>,geometry?:boolean,transform?:import("./pptx-geometry.mjs").Matrix}} DiagramOptions */
const FAMILY_ZH = /** @type {Record<string,string>} */ ({
  process: "流程",
  cycle: "循环",
  hierarchy: "层级",
  list: "列表",
  matrix: "矩阵",
  pyramid: "金字塔",
  relationship: "关系",
  picture: "图片",
  other: "其他",
});

/** @param {Warning[]} warnings @param {string} code @param {string} message */
export function diagramWarning(warnings, code, message) {
  if (!warnings.some((warning) => warning.code === code && warning.message === message))
    warnings.push({ code, message });
}

/** File-wide counter shared across host pages.
 * @param {DiagramBudget} budget @param {Warning[]} warnings */
export function takeDiagram(budget, warnings) {
  if (budget.count < 50) {
    budget.count += 1;
    return true;
  }
  budget.truncated = true;
  diagramWarning(warnings, "smartart-truncated", "SmartArt 图示过多，只读取了前 50 个");
  return false;
}

/** Failures belong to this diagram, never to the other text on its host page.
 * @param {Package} pkg @param {string} part @param {Warning[]} warnings @param {string} expected */
function readPart(pkg, part, warnings, expected) {
  try {
    const text = pkg.text(part);
    if (text !== undefined) {
      const root = diagramXml(text, expected);
      if (!root) diagramWarning(warnings, "smartart-part", "SmartArt 部件损坏，已保留其他可读取内容");
      return root;
    }
  } catch {
    diagramWarning(warnings, "smartart-part", "SmartArt 部件损坏，已保留其他可读取内容");
    return null;
  }
  diagramWarning(warnings, "smartart-part", "SmartArt 缺少部件，已保留其他可读取内容");
  return null;
}

/** @param {Node|null} data @param {Node|null} layout */
function layoutOf(data, layout) {
  const props = data && descendantsOf(data, "prSet")[0];
  const uniqueId = (layout && attrOf(layout, "uniqueId")) ?? (props && attrOf(props, "loTypeId")) ?? "";
  const category =
    (layout &&
      descendantsOf(layout, "cat")
        .map((n) => attrOf(n, "type"))
        .find(Boolean)) ??
    (props && attrOf(props, "loCatId")) ??
    "";
  const hint = `${category} ${uniqueId}`.toLowerCase();
  const family = Object.keys(FAMILY_ZH).find((key) => key !== "other" && hint.includes(key)) ?? "other";
  return { uniqueId, family, category };
}

/** @typedef {Map<string,{el:Node,text:string,type:string}>} Points */
/** @typedef {Map<string,{id:string,order:number,position:number}[]>} Children */

const TREE_TEXT_BYTES = 8192;

/** Characters of `raw` that fit the shared byte budget. @param {string} raw @param {{bytes: number}} budget */
function fitText(raw, budget) {
  let text = "";
  for (const char of raw) {
    const size = Buffer.byteLength(char);
    if (budget.bytes + size > TREE_TEXT_BYTES) return { text, cut: true };
    text += char;
    budget.bytes += size;
  }
  return { text, cut: false };
}

/** The first 200 node/assistant points by model id, their text capped at 8 KB in total.
 * @param {Node[]} all @param {Warning[]} warnings @returns {Points} */
function collectPoints(all, warnings) {
  /** @type {Points} */ const points = new Map();
  const dataPoints = all.filter((p) => ["node", "asst"].includes(attrOf(p, "type") ?? "node"));
  if (dataPoints.length > 200) diagramWarning(warnings, "smartart-truncated", "SmartArt 节点过多，只读取了前 200 个");
  const budget = { bytes: 0 };
  for (const el of dataPoints.slice(0, 200)) {
    const id = attrOf(el, "modelId");
    if (!id || points.has(id)) continue;
    const { text, cut } = fitText(diagramBodyText(firstOf(el, "t")), budget);
    if (cut) diagramWarning(warnings, "smartart-truncated", "SmartArt 文字过长，已截断至 8 KB 以内");
    points.set(id, { el, text, type: attrOf(el, "type") ?? "node" });
  }
  return points;
}

/** parOf connections, ordered by srcOrd then document order.
 * @param {Node|null} data @param {Points} points */
function connectionsOf(data, points) {
  /** @type {Children} */ const children = new Map();
  const parentIds = new Set();
  for (const [position, cxn] of (data ? descendantsOf(data, "cxn") : []).entries()) {
    if ((attrOf(cxn, "type") ?? "parOf") !== "parOf") continue;
    const src = attrOf(cxn, "srcId") ?? "",
      id = attrOf(cxn, "destId") ?? "";
    if (!points.has(id)) continue;
    const list = children.get(src) ?? [];
    list.push({ id, order: Number(attrOf(cxn, "srcOrd")) || 0, position });
    children.set(src, list);
    if (points.has(src)) parentIds.add(id);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || a.position - b.position);
  return { children, parentIds };
}

/** Tree walker with cycle and depth guards; each point is emitted once.
 * @param {Points} points @param {Children} children @param {Warning[]} warnings */
function treeWalker(points, children, warnings) {
  const seen = new Set();
  /** @param {string} id @param {number} level @param {Set<string>} path @returns {DiagramNode|null} */
  function visit(id, level, path) {
    if (path.has(id)) {
      diagramWarning(warnings, "smartart-cycle", "SmartArt 层级存在循环，已停止重复读取");
      return null;
    }
    if (level >= 8) {
      diagramWarning(warnings, "smartart-truncated", "SmartArt 层级过深，只读取前 8 层");
      return null;
    }
    const point = points.get(id);
    if (!point || seen.has(id)) return null;
    seen.add(id);
    const next = new Set(path).add(id);
    return {
      id,
      text: point.text,
      type: point.type,
      level,
      children: (children.get(id) ?? []).flatMap((child) => {
        const node = visit(child.id, level + 1, next);
        return node ? [node] : [];
      }),
    };
  }
  return { visit, seen };
}

/** @param {Points} points @param {Children} children @param {Set<string>} parentIds */
function rootIds(points, children, parentIds) {
  const roots = [
    ...new Set([
      ...[...children].filter(([src]) => !points.has(src)).flatMap(([, list]) => list.map((entry) => entry.id)),
      ...[...points.keys()].filter((id) => !parentIds.has(id)),
    ]),
  ];
  return !roots.length && points.size ? [[...points.keys()][0] ?? ""] : roots;
}

/** Include bullets, indentation and separators in the 8 KB tree-text cap.
 * @param {DiagramNode[]} nodes @param {Warning[]} warnings */
function capTreeText(nodes, warnings) {
  /** @type {DiagramNode[]} */ const flat = [];
  /** @param {DiagramNode[]} list */
  const collect = (list) => {
    for (const node of list) {
      flat.push(node);
      collect(node.children);
    }
  };
  collect(nodes);
  const budget = { bytes: flat.reduce((sum, node) => sum + node.level * 2 + 3, 0) };
  for (const node of flat) {
    const { text } = fitText(node.text, budget);
    if (text !== node.text) diagramWarning(warnings, "smartart-truncated", "SmartArt 文字过长，已截断至 8 KB 以内");
    node.text = text;
  }
}

/** Tree text only, capped by UTF-8 bytes (not UTF-16 code units).
 * @param {Node|null} data @param {Warning[]} warnings */
function textTree(data, warnings) {
  const all = data ? descendantsOf(data, "pt") : [];
  const points = collectPoints(all, warnings);
  const { children, parentIds } = connectionsOf(data, points);
  const { visit, seen } = treeWalker(points, children, warnings);
  const nodes = rootIds(points, children, parentIds).flatMap((id) => {
    const node = visit(id, 0, new Set());
    return node ? [node] : [];
  });
  // A disconnected cycle must be diagnosed as well; do not emit a second copy.
  if ([...points.keys()].some((id) => !seen.has(id)) && !warnings.some((w) => w.code === "smartart-truncated")) {
    diagramWarning(warnings, "smartart-cycle", "SmartArt 存在未连接或循环节点，已按可读取层级保留文字");
    for (const id of points.keys()) {
      if (seen.has(id)) continue;
      const node = visit(id, 0, new Set());
      if (node) nodes.push(node);
    }
  }
  capTreeText(nodes, warnings);
  return { nodes, all };
}

/** @param {DiagramNode[]} nodes @returns {string} */
export function diagramTreeText(nodes) {
  return nodes
    .flatMap((node) => [
      `${"  ".repeat(node.level)}- ${node.text}`,
      ...(node.children.length ? [diagramTreeText(node.children)] : []),
    ])
    .join("\n");
}
/** @param {{layout:{family:string},nodes:DiagramNode[]}} diagram */
export function diagramText(diagram) {
  return `SmartArt（${FAMILY_ZH[diagram.layout.family] ?? "其他"}，${diagram.nodes.length} 项）：\n${diagramTreeText(diagram.nodes)}`;
}
/** @param {DiagramNode[]} nodes @returns {number} */
export function diagramChars(nodes) {
  return nodes.reduce((sum, node) => sum + Array.from(node.text).length + diagramChars(node.children), 0);
}

/** @param {Node} frame @returns {Box|null} */
export function diagramFrameBox(frame) {
  const xf = firstOf(frame, "xfrm");
  const off = xf && firstOf(xf, "off"),
    ext = xf && firstOf(xf, "ext");
  if (!off || !ext) return null;
  const box = {
    x: Number(attrOf(off, "x")),
    y: Number(attrOf(off, "y")),
    w: Number(attrOf(ext, "cx")),
    h: Number(attrOf(ext, "cy")),
  };
  return Object.values(box).every(Number.isFinite) ? box : null;
}

/** Shared PPTX/DOCX seam. The cache relId is resolved against the HOST, not data.xml.
 * @param {Package} pkg @param {string} hostPart @param {Relationships} hostRels
 * @param {Node} relIdsEl @param {Box|null} frameBoxEmu @param {DiagramOptions} [options] */
export function readDiagram(pkg, hostPart, hostRels, relIdsEl, frameBoxEmu, options = {}) {
  /** @type {Warning[]} */ const warnings = [];
  /** @param {string} attribute */
  const related = (attribute) => {
    const id = attrOf(relIdsEl, attribute);
    if (!id) return null;
    const rel = hostRels.get(id);
    if (!rel || rel.external) {
      diagramWarning(warnings, "smartart-part", "SmartArt 部件关系缺失或为外部链接，未读取该部件");
      return null;
    }
    const expected =
      /** @type {Record<string,string>} */ ({
        "r:dm": "dataModel",
        "r:lo": "layoutDef",
        "r:qs": "styleDef",
        "r:cs": "colorsDef",
      })[attribute] ?? "";
    return readPart(pkg, resolvePartPath(hostPart, rel.target), warnings, expected);
  };
  const data = related("r:dm"),
    layout = related("r:lo");
  const quickStyle = related("r:qs"),
    colors = related("r:cs");
  const tree = textTree(data, warnings);
  const ext = data && descendantsOf(data, "dataModelExt")[0];
  const drawingId = ext && attrOf(ext, "relId");
  let relation = drawingId ? hostRels.get(drawingId) : undefined;
  if (!relation || relation.external || relation.type !== "diagramDrawing") {
    const candidates = [...hostRels.values()].filter((r) => r.type === "diagramDrawing" && !r.external);
    relation = candidates[options.index ?? 0];
    if (relation)
      diagramWarning(warnings, "smartart-cache-fallback", "SmartArt 预览图形通过关系类型查找，已按图示顺序匹配");
  }
  if (drawingId && !relation)
    diagramWarning(warnings, "smartart-cache", "SmartArt 预览图形关系缺失或不可读取，只保留文字和层级");
  const drawing =
    relation && !relation.external
      ? readPart(pkg, resolvePartPath(hostPart, relation.target), warnings, "drawing")
      : null;
  let shapes;
  if (drawing && options.geometry !== false) {
    try {
      const cached = cachedDiagramShapes(pkg, hostPart, drawing, tree.all, frameBoxEmu, options, quickStyle, colors);
      shapes = cached.shapes;
      if (cached.truncated) diagramWarning(warnings, "smartart-truncated", "SmartArt 预览图形过多，只读取前 300 个");
      if (cached.unsupportedGeometry)
        diagramWarning(warnings, "smartart-geometry", "SmartArt 含暂不支持的自定义路径，已保留文字和其他图形");
    } catch {
      diagramWarning(warnings, "smartart-cache", "SmartArt 预览图形无法完整读取，已保留文字和层级");
    }
  }
  return {
    layout: layoutOf(data, layout),
    nodes: tree.nodes,
    cache: drawing ? "drawing" : "none",
    ...(shapes ? { shapes } : {}),
    warnings,
  };
}
