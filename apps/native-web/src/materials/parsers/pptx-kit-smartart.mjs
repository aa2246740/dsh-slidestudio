/**
 * SmartArt with a drawing cache as template-kit parts: the diagram's own drawn shapes, empty text
 * boxes and connectors as PPTD elements, never the diagram data or any source text. The shapes
 * come from the M3 reader (`ooxml-diagram-shapes.mjs`), so every colour was already resolved by
 * the shared modifier function there and is copied, not recomputed.
 */
import { parseCustomPath } from "@open-slidestudio/pptd-v2";
import { presetOf } from "./pptx-kit-geometry.mjs";
import { dashStyleOf, round4, solidHex } from "./pptx-kit-paint.mjs";
import { KIT_PAGE_WIDTH_PX } from "./pptx-kit-shapes.mjs";

/** @typedef {NonNullable<ReturnType<typeof import("./pptx-slides.mjs").readSlide>>["smartArts"][number]} Diagram */
/** @typedef {NonNullable<Diagram["shapes"]>[number]} DrawnShape */
/** @typedef {Record<string, any>} KitElement */

/** More drawn shapes than this is a decorated infographic, not a reusable diagram. */
export const MAX_SMARTART_ELEMENTS = 120;
export const SMARTART_REASONS = {
  noCache: "缺少预览图形，只能读取文字，无法照原样复用",
  noShapes: "预览图形无法读取，只能读取文字，无法照原样复用",
  tooMany: `图形超过 ${MAX_SMARTART_ELEMENTS} 个，无法照原样复用`,
};
/** Families whose nodes the editor can pin and re-lay out; the others only share a group. */
const SLOT_LAYOUTS = new Set(["process", "cycle", "hierarchy"]);
const EMU_PER_PT = 12700;
const H_ALIGN = new Map([
  ["l", "left"],
  ["ctr", "center"],
  ["r", "right"],
  ["just", "justify"],
  ["dist", "justify"],
]);
const V_ALIGN = new Map([
  ["t", "top"],
  ["ctr", "middle"],
  ["b", "bottom"],
]);

/**
 * Each node needs its own drawn shape and text box. A process or cycle must show one node per
 * top-level data node, so an extra or missing shape means the drawing is not a plain node chain.
 * @param {Diagram} diagram @param {DrawnShape[]} nodes
 */
function hasSlots(diagram, nodes) {
  if (!SLOT_LAYOUTS.has(diagram.layout) || !nodes.length) return false;
  const ids = nodes.map((shape) => shape.nodeId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return false;
  if (!nodes.every((shape) => shape.box && shape.text?.box)) return false;
  return diagram.layout === "hierarchy" || nodes.length === diagram.nodes.length;
}

/**
 * A preset or custom path as PPTD fields. What cannot be read becomes a rectangle for a node, so
 * its slot survives, and is dropped for a connector or decoration, where a block would mislead.
 * @param {DrawnShape} shape @returns {{shape: KitElement|null, note?: string}}
 */
function geometryOf({ geom, role }) {
  if (geom && "preset" in geom) {
    const preset = presetOf(geom.preset ?? "", new Map(Object.entries(geom.adj ?? {})));
    if (!("unsupported" in preset)) return { shape: preset };
    const name = preset.unsupported.slice(0, 40) || "未命名";
    return { shape: { shapeName: "rect" }, note: `形状「${name}」不在可用形状库中，已改用矩形` };
  }
  const parsed = geom ? parseCustomPath(geom.path) : null;
  if (geom && parsed && "segments" in parsed && geom.viewBox.every((side) => side > 0)) {
    const path = parsed.segments.map((s) => [s.command, ...s.points].join(" ")).join(" ");
    return { shape: { shapeName: "custom", geometry: { viewBox: [...geom.viewBox], path } } };
  }
  return role === "node"
    ? { shape: { shapeName: "rect" }, note: "自定义形状数据无法解析，已改用矩形" }
    : { shape: null, note: "自定义形状数据无法解析，已跳过" };
}

/** @param {DrawnShape} shape */
function fillOf(shape) {
  if (shape.fill) return { type: "solid", color: solidHex(shape.fill) };
  const gradient = shape.gradients?.[0];
  const stops = (gradient?.stops ?? [])
    .map((stop) => ({
      position: round4(Math.max(0, Math.min(1, stop.position))),
      color: stop.hex,
      ...(stop.alpha < 1 ? { alpha: round4(stop.alpha) } : {}),
    }))
    .sort((a, b) => a.position - b.position);
  if (stops.length < 2) return stops[0] ? { type: "solid", color: stops[0].color } : undefined;
  const angle = Number.isFinite(gradient?.angle) ? (gradient?.angle ?? 0) : 0;
  return {
    type: "gradient",
    gradientType: "linear",
    stops,
    angle: round4(((angle % 360) + 360) % 360),
  };
}

/** The M3 reader stores `a:ln w` as EMU / 9525; the kit scales lengths to the 960 px page.
 * @param {DrawnShape} shape @param {number} slideWidth EMU */
function borderOf(shape, slideWidth) {
  const color = shape.line?.color;
  if (!shape.line || !color) return undefined;
  const width = round4((shape.line.width * 9525 * KIT_PAGE_WIDTH_PX) / slideWidth);
  const style = dashStyleOf(shape.line.dash);
  return { ...(style ? { style } : {}), ...(width > 0 ? { width } : {}), color: solidHex(color) };
}

/** Text style only: the box is empty, the Agent supplies the words.
 * @param {NonNullable<DrawnShape["text"]>} text @param {number} slideWidth EMU */
function textStyleOf(text, slideWidth) {
  const paragraph = text.paras.find((para) => para.runs.length);
  const run = paragraph?.runs[0];
  return {
    text: "",
    ...(run?.sz ? { fontSize: Math.round(((run.sz * EMU_PER_PT * KIT_PAGE_WIDTH_PX) / slideWidth) * 10) / 10 } : {}),
    ...(run?.b ? { bold: true } : {}),
    ...(run?.color ? { color: solidHex(run.color) } : {}),
    align: [H_ALIGN.get(paragraph?.algn ?? "") ?? "left", V_ALIGN.get(text.anchor ?? "") ?? "top"],
  };
}

const rounded = (/** @type {number[]} */ box) => box.map(round4);

/**
 * A drawn shape with neither paint nor outline is invisible; only its text box matters.
 * @param {DrawnShape} shape @param {number} width EMU @param {string} elementId the id the shape would take
 * @returns {{element?: KitElement, degradation?: {elementId?: string, reason: string}}}
 */
function paintedShapeOf(shape, width, elementId) {
  const fill = fillOf(shape);
  const border = borderOf(shape, width);
  if (!fill && !border) return {};
  const drawn = geometryOf(shape);
  const degradation = drawn.note ? { ...(drawn.shape ? { elementId } : {}), reason: drawn.note } : undefined;
  if (!drawn.shape) return { degradation };
  return {
    degradation,
    element: {
      elementType: "shape",
      ...drawn.shape,
      bounds: rounded(/** @type {number[]} */ (shape.box)),
      ...(shape.rot ? { rotation: round4(((shape.rot % 360) + 360) % 360) } : {}),
      ...(shape.flipH ? { flipH: true } : {}),
      ...(shape.flipV ? { flipV: true } : {}),
      ...(fill ? { fill } : {}),
      ...(border ? { border } : {}),
    },
  };
}

/**
 * @param {Diagram} diagram @param {number} slideWidth EMU
 * @returns {{elements: KitElement[], extra: object}|{skip: string}}
 */
export function smartArtParts(diagram, slideWidth) {
  const shapes = (diagram.shapes ?? []).filter((shape) => shape.box);
  if (diagram.cache !== "drawing") return { skip: SMARTART_REASONS.noCache };
  if (!shapes.length) return { skip: SMARTART_REASONS.noShapes };
  const width = slideWidth || 1;
  const nodes = shapes.filter((shape) => shape.role === "node");
  const slotted = hasSlots(diagram, nodes);
  const groupId = `smartart-${diagram.id}`;
  /** @param {"node"|"label"|"connector"} role @param {number} [index] */
  const meta = (role, index) =>
    slotted
      ? {
          smartArt: {
            id: diagram.id,
            layout: diagram.layout,
            role,
            ...(index === undefined ? {} : { index }),
            ...(role === "node" ? { pinned: true } : {}),
          },
        }
      : {};
  /** @type {KitElement[]} */ const elements = [];
  /** @type {{elementId?: string, reason: string}[]} */ const degradations = [];
  let connectors = 0;
  let slot = 0;
  for (const shape of shapes) {
    const index = shape.role === "node" ? slot++ : undefined;
    const role = shape.role === "node" || shape.role === "connector" ? shape.role : null;
    const painted = paintedShapeOf(shape, width, `e${elements.length + 1}`);
    if (painted.degradation) degradations.push(painted.degradation);
    if (painted.element) {
      if (role === "connector") connectors += 1;
      elements.push({
        ...painted.element,
        groupId,
        ...(role ? meta(role, index) : { layoutRole: "decoration" }),
      });
    }
    if (shape.role === "node" && shape.text?.box) {
      elements.push({
        elementType: "text",
        bounds: rounded(shape.text.box),
        content: textStyleOf(shape.text, width),
        groupId,
        ...meta("label", index),
      });
    }
  }
  if (elements.length > MAX_SMARTART_ELEMENTS) return { skip: SMARTART_REASONS.tooMany };
  if (!elements.length) return { skip: SMARTART_REASONS.noShapes };
  return {
    elements: elements.map((element, i) => ({ elementId: `e${i + 1}`, ...element })),
    extra: {
      smartArt: {
        id: diagram.id,
        layout: diagram.layout,
        slots: slotted ? nodes.length : 0,
        connectors,
      },
      ...(degradations.length ? { degradations } : {}),
    },
  };
}

/**
 * Every SmartArt of the template: a page-scope component when its drawing cache can be copied,
 * otherwise a skip entry the receipt shows with the reason.
 * @param {Diagram[]} diagrams @param {number} slideWidth EMU @param {Map<number, string>} kindOfSlide
 */
export function smartArtKit(diagrams, slideWidth, kindOfSlide) {
  /** @type {{id: string, archetype: string, slide: number, elements: KitElement[], extra: object}[]} */
  const parts = [];
  /** @type {{slide: number, smartArt: string, reason: string}[]} */ const skipped = [];
  for (const diagram of diagrams) {
    const archetype = kindOfSlide.get(diagram.slide);
    if (!archetype) continue;
    const result = smartArtParts(diagram, slideWidth);
    if ("skip" in result) {
      skipped.push({ slide: diagram.slide, smartArt: diagram.id, reason: result.skip });
      continue;
    }
    parts.push({
      id: `smartart.${diagram.id}`,
      archetype,
      slide: diagram.slide,
      elements: result.elements,
      extra: result.extra,
    });
  }
  return { parts, skipped };
}
