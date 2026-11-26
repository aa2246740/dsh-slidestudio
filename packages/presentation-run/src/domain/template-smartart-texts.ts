/**
 * SmartArt component `texts` (architecture §3.21, legacy-smartart-design §B/§D): the model
 * rewrites a SmartArt component's node texts when it expands the reference. A same-count write
 * fills the labels in reading order; a process component may grow or shrink to N nodes, re-laid
 * out on the straight line between the original first and last node centres at equal spacing,
 * with the arrows centred in the gaps. Cycle and hierarchy keep their node count. Validation
 * counts the component's drawable node slots (ruling166: never the data-node count). A texts
 * rebuild drops the diagram's groupId: the nodes are ordinary shapes, each selectable and movable
 * on its own (DECISIONS #47). Geometry is 960×540 px rounded to two decimals, inside the 1 px
 * contract tolerances.
 */
import type { ExpandedElement } from "./template-component-expand.js";
import type { KitComponent } from "./template-kit.js";

type Bounds = [number, number, number, number];
type Json = Record<string, unknown>;

export type SmartArtTextsPlan = Readonly<{
  /** fill keeps the node count; relayout lays out texts.length nodes (process only). */
  kind: "fill" | "relayout";
  /** One paragraph list per node, in reading order. */
  texts: readonly (readonly string[])[];
}>;

export type SmartArtTextsVerdict =
  Readonly<{ ok: true; plan: SmartArtTextsPlan }> | Readonly<{ ok: false; detail: string }>;

type SmartArtMeta = Readonly<{
  id: string;
  layout: string;
  role: "node" | "label" | "connector";
  index?: number;
  pinned?: boolean;
}>;

const metaOf = (element: Json): SmartArtMeta | undefined => {
  const meta = element.smartArt;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  return meta as SmartArtMeta;
};

const byIndex = (a: Json, b: Json): number => (metaOf(a)?.index ?? 0) - (metaOf(b)?.index ?? 0);

/**
 * Validates `texts` against the component and normalizes every entry to a paragraph list. The
 * refusal details are model-facing Chinese, matching the component-reference refusal style.
 */
export function planSmartArtTexts(component: KitComponent, raw: unknown): SmartArtTextsVerdict {
  const meta = component.smartArt as { slots?: unknown; layout?: unknown } | undefined;
  const slots = typeof meta?.slots === "number" && Number.isInteger(meta.slots) ? meta.slots : 0;
  const layout = typeof meta?.layout === "string" ? meta.layout : "";
  if (!slots || !layout) {
    return {
      ok: false,
      detail: `组件 ${component.id} 的图形和节点对应不齐，不能用 texts 改写；请把节点文字写成普通 text 元素。`,
    };
  }
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some(
      (entry) =>
        typeof entry !== "string" &&
        !(Array.isArray(entry) && entry.length > 0 && entry.every((paragraph) => typeof paragraph === "string")),
    )
  ) {
    return {
      ok: false,
      detail: `组件 ${component.id} 的 texts 必须每个节点一项：一项是节点文字，或它的几段（第一段是主文）。`,
    };
  }
  const texts = raw.map((entry) => (typeof entry === "string" ? [entry] : [...(entry as string[])]));
  if (layout === "process" && slots >= 2) {
    return { ok: true, plan: { kind: texts.length === slots ? "fill" : "relayout", texts } };
  }
  if (texts.length !== slots) {
    return {
      ok: false,
      detail:
        layout === "process"
          ? `组件 ${component.id} 的图形和节点对应不齐，不能用 texts 改写；请把节点文字写成普通 text 元素。`
          : `组件 ${component.id} 有 ${slots} 个节点，texts 需要 ${slots} 项（流程类组件可以增减节点）。`,
    };
  }
  return { ok: true, plan: { kind: "fill", texts } };
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Paragraph list → label HTML: the first paragraph is lvl 0, the rest lvl 1 with a bullet. */
function labelText(paragraphs: readonly string[]): string {
  return paragraphs
    .map((paragraph, index) =>
      index === 0 ? `<p>${escapeHtml(paragraph)}</p>` : `<p data-lvl="1">• ${escapeHtml(paragraph)}</p>`,
    )
    .join("\n");
}

const round = (value: number): number => Number(value.toFixed(2));

const boundsOf = (element: Json): Bounds => {
  const [x = 0, y = 0, w = 0, h = 0] = element.bounds as readonly number[];
  return [x, y, w, h];
};

const centreOf = (bounds: Bounds): readonly [number, number] => [bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2];

/** A texts rebuild is a set of ordinary shapes; the diagram's shared groupId goes away. */
function ungroup(element: ExpandedElement): ExpandedElement {
  if (element.groupId === undefined) return { ...element };
  const { groupId: _dropped, ...rest } = element;
  return rest as ExpandedElement;
}

/** Fills same-count labels and drops the group; geometry stays exactly the template's. */
function fillLabels(elements: readonly ExpandedElement[], plan: SmartArtTextsPlan): ExpandedElement[] {
  const textByIndex = new Map(plan.texts.map((paragraphs, index) => [index, paragraphs]));
  return elements.map((element) => {
    const next = ungroup(element);
    const meta = metaOf(next);
    if (meta?.role === "label" && meta.index !== undefined) {
      const paragraphs = textByIndex.get(meta.index);
      if (paragraphs) {
        next.content = { ...((next.content as Json) ?? {}), text: labelText(paragraphs) };
      }
    }
    return next;
  });
}

/**
 * Applies a validated plan to the component's freshly expanded elements: fills the label texts,
 * re-lays a resized process out on the original axis, and strips the diagram groupId. The input
 * array and its elements are not mutated. New node/label/connector ids join `usedIds`.
 */
export function applySmartArtTexts(
  elements: readonly ExpandedElement[],
  component: KitComponent,
  plan: SmartArtTextsPlan,
  usedIds: Set<string>,
): ExpandedElement[] {
  const nodes = elements.filter((element) => metaOf(element)?.role === "node").sort(byIndex);
  const labels = elements.filter((element) => metaOf(element)?.role === "label").sort(byIndex);
  const connectors = elements.filter((element) => metaOf(element)?.role === "connector");
  if (plan.kind === "fill" || nodes.length < 2 || !labels.length) {
    return fillLabels(elements, plan);
  }

  const count = plan.texts.length;
  const first = centreOf(boundsOf(nodes[0]!));
  const last = centreOf(boundsOf(nodes[nodes.length - 1]!));
  const spanX = last[0] - first[0];
  const spanY = last[1] - first[1];
  const span = Math.hypot(spanX, spanY);
  const axis: readonly [number, number] = span > 0 ? [spanX / span, spanY / span] : [1, 0];
  const step = count > 1 ? span / (count - 1) : 0;
  // Uniform shrink so the new count fits the original span without overlap; never grow.
  const scale = count > 1 ? Math.min(1, (nodes.length - 1) / (count - 1)) : 1;
  const position = (k: number): readonly [number, number] => [
    first[0] + axis[0] * step * k,
    first[1] + axis[1] * step * k,
  ];

  const stem = nodes[0]!.elementId.slice(0, nodes[0]!.elementId.lastIndexOf("-"));
  let clones = 0;
  const freshId = (): string => {
    let candidate = "";
    do {
      clones += 1;
      candidate = `${stem}-x${clones}`;
    } while (usedIds.has(candidate));
    usedIds.add(candidate);
    return candidate;
  };
  const scaled = (source: ExpandedElement, cx: number, cy: number): Bounds => {
    const [, , w, h] = boundsOf(source);
    const width = w * scale;
    const height = h * scale;
    return [round(cx - width / 2), round(cy - height / 2), round(width), round(height)];
  };

  const outNodes = plan.texts.map((_, k) => {
    const source = nodes[Math.min(k, nodes.length - 1)]!;
    const [cx, cy] = position(k);
    return {
      ...ungroup(source),
      elementId: k < nodes.length ? source.elementId : freshId(),
      bounds: scaled(source, cx, cy),
      smartArt: { ...metaOf(source), index: k, pinned: true },
    };
  });

  const outLabels = plan.texts.map((paragraphs, k) => {
    const source = labels[Math.min(k, labels.length - 1)]!;
    const sourceNode = nodes[Math.min(k, nodes.length - 1)]!;
    const [cx, cy] = position(k);
    const offsetX = (centreOf(boundsOf(source))[0] - centreOf(boundsOf(sourceNode))[0]) * scale;
    const offsetY = (centreOf(boundsOf(source))[1] - centreOf(boundsOf(sourceNode))[1]) * scale;
    const content: Json = {
      ...((source.content as Json) ?? {}),
      text: labelText(paragraphs),
    };
    if (typeof content.fontSize === "number") content.fontSize = round(content.fontSize * scale);
    return {
      ...ungroup(source),
      elementId: k < labels.length ? source.elementId : freshId(),
      bounds: scaled(source, cx + offsetX, cy + offsetY),
      content,
      smartArt: { ...metaOf(source), index: k },
    };
  });

  const extentOnAxis = (bounds: Bounds): number => (Math.abs(bounds[2] * axis[0]) + Math.abs(bounds[3] * axis[1])) / 2;
  const outConnectors = Array.from({ length: Math.max(0, count - 1) }, (_, k): ExpandedElement | undefined => {
    const source = connectors[Math.min(k, connectors.length - 1)];
    if (!source) return undefined;
    const [ax, ay] = position(k);
    const [bx, by] = position(k + 1);
    const edgeA = extentOnAxis(outNodes[k]!.bounds as Bounds);
    const edgeB = extentOnAxis(outNodes[k + 1]!.bounds as Bounds);
    const midX = (ax + axis[0] * edgeA + (bx - axis[0] * edgeB)) / 2;
    const midY = (ay + axis[1] * edgeA + (by - axis[1] * edgeB)) / 2;
    return {
      ...ungroup(source),
      elementId: k < connectors.length ? source.elementId : freshId(),
      bounds: scaled(source, midX, midY),
      smartArt: { ...metaOf(source) },
    };
  }).filter((element): element is ExpandedElement => element !== undefined);

  const decorations = elements.filter((element) => metaOf(element) === undefined).map(ungroup);
  return [...decorations, ...outNodes, ...outLabels, ...outConnectors];
}
