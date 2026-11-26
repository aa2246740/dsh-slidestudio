/**
 * Expansion of one template-kit component into native PPTD elements (architecture §3.21).
 * Kit bounds are slide fractions relative to the slide; the written bounds are 960×540 px. The
 * component's own `box` is the reference frame: a target `bounds` maps that frame onto the target
 * rectangle, so every element keeps its proportional place (and may still overhang the frame, as it
 * did in the template). Paint, custom geometry, gradients and shadows are copied unchanged.
 */
import type { KitComponent, KitElement } from "./template-kit.js";

const SLIDE_WIDTH = 960;
const SLIDE_HEIGHT = 540;
/** A kit line can have a zero extent on one axis; a written element needs a drawable one. */
const MIN_EXTENT_PX = 1;

export type ComponentTarget = readonly [number, number, number, number];

export type ExpandedElement = Record<string, unknown> & { elementId: string };

export type ExpandOptions = Readonly<{
  /** Target rectangle in slide px; absent keeps the component where the template had it. */
  bounds?: ComponentTarget;
  /** Elements already on the page or layout, so a second use of a component keeps unique ids. */
  usedIds: ReadonlySet<string>;
  /** Project media path for a kit image file; throws when the image cannot be provided. */
  mediaFor(file: string): string;
}>;

const round = (value: number): number => Number(value.toFixed(2));

/** `body.header` → `body-header`: element ids are plain, and a kit id carries dots. */
function idStem(componentId: string): string {
  return (
    componentId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "c"
  );
}

function uniqueStem(componentId: string, used: ReadonlySet<string>): string {
  const stem = `tpl-${idStem(componentId)}`;
  const taken = (candidate: string) => [...used].some((id) => id.startsWith(`${candidate}-`));
  if (!taken(stem)) return stem;
  for (let n = 2; n < 100; n += 1) if (!taken(`${stem}-${n}`)) return `${stem}-${n}`;
  return `${stem}-${used.size}`;
}

function frame(entry: KitComponent, target: ComponentTarget | undefined) {
  const [bx, by, bw, bh] = entry.box;
  const [tx, ty, tw, th] = target ?? [bx * SLIDE_WIDTH, by * SLIDE_HEIGHT, bw * SLIDE_WIDTH, bh * SLIDE_HEIGHT];
  // A zero-extent frame cannot be scaled; the element keeps its slide-fraction size.
  const scaleX = bw > 0 ? tw / bw : SLIDE_WIDTH;
  const scaleY = bh > 0 ? th / bh : SLIDE_HEIGHT;
  return {
    place(bounds: KitElement["bounds"]): [number, number, number, number] {
      const [x, y, w, h] = bounds;
      const width = w * scaleX;
      const height = h * scaleY;
      const left = tx + (bw > 0 ? (x - bx) * scaleX : x * SLIDE_WIDTH - bx * SLIDE_WIDTH);
      const top = ty + (bh > 0 ? (y - by) * scaleY : y * SLIDE_HEIGHT - by * SLIDE_HEIGHT);
      const drawW = Math.max(width, MIN_EXTENT_PX);
      const drawH = Math.max(height, MIN_EXTENT_PX);
      return [round(left - (drawW - width) / 2), round(top - (drawH - height) / 2), round(drawW), round(drawH)];
    },
  };
}

/** `tpl-…` as written here, or as a layout or master copy on a page (`lyt-<layout>-tpl-…`, `mst-<master>-tpl-…`). */
const EXPANDED_ELEMENT_ID = /^(?:(?:lyt|mst)-.+?-)?tpl-/;

/**
 * Whether an element is one that `expandTemplateComponent` wrote, or the page's copy of one. Such
 * an element keeps the bleed it had in the template, which the slide clips, so geometry checks
 * must not call it a defect.
 */
export function isExpandedTemplateElement(element: { elementId: string; layoutRole?: unknown }): boolean {
  return element.layoutRole === "decoration" && EXPANDED_ELEMENT_ID.test(element.elementId);
}

/**
 * A diagram id and a group id are page-wide names the kit copied from the template. Left as they
 * are, a second use of the same component would join the first one's diagram or group, and the
 * editor (which pairs a SmartArt node with its label by `smartArt.id` and index) would move both.
 * The first source name of an expansion becomes `base`, any further one `base-2`, `base-3`, ...
 */
function renamer(base: string): (source: string) => string {
  const renamed = new Map<string, string>();
  return (source) => {
    let next = renamed.get(source);
    if (next === undefined) {
      next = renamed.size ? `${base}-${renamed.size + 1}` : base;
      renamed.set(source, next);
    }
    return next;
  };
}

/** The component's elements as standard PPTD elements, in the template's paint order. */
export function expandTemplateComponent(entry: KitComponent, options: ExpandOptions): ExpandedElement[] {
  const place = frame(entry, options.bounds).place;
  const stem = uniqueStem(entry.id, options.usedIds);
  // The stem is unique among the ids already on the page, so each expansion names its own diagram.
  const diagramId = renamer(stem);
  const groupId = renamer(`${stem}-g`);
  return entry.elements.map((element) => {
    const { elementId, bounds, ...rest } = structuredClone(element) as KitElement;
    const expanded: ExpandedElement = {
      ...rest,
      elementId: `${stem}-${elementId}`,
      bounds: place(bounds),
      layoutRole: "decoration",
    };
    const meta = expanded.smartArt;
    if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      const { id } = meta as { id?: unknown };
      if (typeof id === "string") expanded.smartArt = { ...meta, id: diagramId(id) };
    }
    if (typeof expanded.groupId === "string") expanded.groupId = groupId(expanded.groupId);
    if (element.elementType === "image") expanded.src = options.mediaFor(String(element.src));
    return expanded;
  });
}
