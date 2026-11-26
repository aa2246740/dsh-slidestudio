/**
 * Template kit: the decorations of a PPTX template (shapes, lines, desaturated photos, layout and
 * master chrome) as PPTD element components grouped by page archetype. The kit is JSON data
 * only; `template-kit.json` carries hashes of image bytes, never the bytes or any source XML.
 */
import { createHash } from "node:crypto";
import { colorMapOf } from "./pptx-colors.mjs";
import { attrOf, parseRels } from "./ooxml.mjs";
import { clampBox } from "./pptx-geometry.mjs";
import { KIT_REASONS, KIT_PAGE_WIDTH_PX, readDecorations } from "./pptx-kit-shapes.mjs";
import { smartArtKit } from "./pptx-kit-smartart.mjs";
import {
  kitBytes,
  kitPointer,
  TEMPLATE_KIT_MAX_BYTES,
  TEMPLATE_KIT_SCHEMA,
  TEMPLATE_KIT_VERSION,
} from "./pptx-kit-record.mjs";

export { readDecorations };
export { TEMPLATE_KIT_MAX_BYTES, TEMPLATE_KIT_VERSION } from "./pptx-kit-record.mjs";
/** An element that appears identically on this many slides belongs to the layout, not a page. */
const LAYOUT_SCOPE_SLIDES = 3;
const MAX_SKIPPED_ENTRIES = 100;

/** @typedef {Record<string, any>} KitElement */
/** @typedef {{id: string, archetype: string, role: "decoration"|"smartart", scopeHint: "layout"|"page",
 *   source: string, slides: number[], box: number[], clamped?: true, elements: KitElement[],
 *   smartArt?: object, degradations?: {elementId?: string, reason: string}[]}} KitComponent */
/** @typedef {{file: string, kind: "derived"|"original", sha256: string, bytes?: number,
 *   ops?: string[], detail?: string, sourceSha256?: string}} KitAsset */
/** @typedef {{slide?: number, source?: string, smartArt?: string, reason: string, count?: number}} KitSkip */
/** @typedef {{kind: string, slides: number[], components: string[]}} KitArchetype */
/** @typedef {{schema: string, version: number, units: object, archetypes: KitArchetype[],
 *   components: KitComponent[], assets: KitAsset[],
 *   receipt: {counts: Record<string, number>, skipped: KitSkip[], truncated?: {kept: number, dropped: number}}}} TemplateKit */

const sha256Of = (/** @type {Uint8Array} */ bytes) => createHash("sha256").update(bytes).digest("hex");
const groupOf = (/** @type {string} */ kind) => (kind.startsWith("body-") ? "body" : kind);

/**
 * Decoration extraction runs per slide while the slide is open; images are still named by their
 * media part. This is called once the photos are known.
 * @param {{pkg: import("./ooxml.mjs").PackageReader, width: number, height: number,
 *   slides: {index: number, elements: KitElement[], skipped: {reason: string}[]}[],
 *   contexts: Map<string, {root: any, master: any, theme: any, map: Record<string,string>}>,
 *   layoutUses: Map<string, {master: string, slides: number[]}>,
 *   archetypes: {kind: string, slides: number[]}[],
 *   smartArts?: Parameters<typeof smartArtKit>[0],
 *   photos: {file: string, processed?: {file: string, ops: string[], sha256: string}}[],
 *   chromePhotos?: {file: string, processed?: {file: string, ops: string[], sha256: string}}[],
 *   photoAssets: {file: string, content: string}[]}} input `chromePhotos` are the desaturated
 *   pictures that are not template photos (layout, master and logo images).
 * @param {{maxBytes?: number}} [options]
 */
function buildTemplateKit(input, { maxBytes = TEMPLATE_KIT_MAX_BYTES } = {}) {
  const { pkg, width, height, contexts, layoutUses, archetypes } = input;
  const { kindOfSlide, slidesOfKind } = indexArchetypes(archetypes);
  const kinds = [...slidesOfKind.keys()];
  const assets = assetRegistry(pkg, [...input.photos, ...(input.chromePhotos ?? [])], input.photoAssets);
  /** @type {{slide?: number, source?: string, smartArt?: string, reason: string}[]} */ const rawSkips = [];

  /** @param {KitElement[]} elements @param {"slide"|"layout"} role @param {{slide?: number, source?: string}} where */
  const resolve = (elements, role, where) => {
    /** @type {KitElement[]} */ const out = [];
    for (const element of elements) {
      if (element.elementType !== "image") {
        out.push(element);
        continue;
      }
      const { elementType, mediaPart, desaturated, ...rest } = element;
      const found = assets.srcFor(mediaPart, desaturated, role);
      if (found && "src" in found) out.push({ elementType, src: found.src, ...rest });
      else if (found) rawSkips.push({ ...where, reason: found.reason });
    }
    return out;
  };

  /** @type {KitComponent[]} */ const layoutComponents = [];
  const ids = new Map();
  /**
   * The one allocator for every component id of the kit. Archetypes of a group share a prefix
   * (`body-table` and `body-text` are both `body.`), so a counter kept per archetype would hand
   * the same id to two components and a reference could only ever reach the first. `counted`
   * ids always carry their number; the others only from the second use on.
   * @param {string} base @param {boolean} [counted]
   */
  const uniqueId = (base, counted = false) => {
    const n = (ids.get(base) ?? 0) + 1;
    ids.set(base, n);
    return counted || n > 1 ? `${base}-${n}` : base;
  };

  /** @param {string} part @param {number[]} using @param {any} source @param {"layout"|"master"} from */
  const chrome = (part, using, source, from) => {
    const read = readDecorations({
      root: source.root,
      part,
      rels: parseRels(pkg, part),
      theme: source.theme,
      map: source.map,
      width,
      height,
    });
    const where = { source: from };
    rawSkips.push(...read.skipped.map((item) => ({ ...where, ...item })));
    const elements = resolve(read.elements, "layout", where);
    const kind = chromeKind(using, kindOfSlide);
    if (!elements.length || !kind) return;
    const box = unionBox(elements);
    const slot = box.y + box.h / 2 < 0.5 ? "header" : box.h < 0.5 ? "footer" : "frame";
    layoutComponents.push(
      component({
        id: uniqueId(`${groupOf(kind)}.${from === "master" ? "master-" : ""}${slot}`),
        archetype: kind,
        scope: "layout",
        source: from,
        slides: using,
        elements,
      }),
    );
  };
  /** @type {Map<string, {root: any, theme: any, map: Record<string,string>, slides: Set<number>}>} */
  const masters = new Map();
  for (const [layoutPart, use] of layoutUses) {
    const context = contexts.get(layoutPart);
    if (!context || !use.slides.length) continue;
    chrome(layoutPart, use.slides, context, "layout");
    if (attrOf(context.root, "showMasterSp") !== "0") {
      const entry = masters.get(use.master) ?? {
        root: context.master,
        theme: context.theme,
        map: colorMapOf(context.master),
        slides: new Set(),
      };
      for (const slide of use.slides) entry.slides.add(slide);
      masters.set(use.master, entry);
    }
  }
  for (const [part, entry] of masters) {
    chrome(
      part,
      [...entry.slides].sort((a, b) => a - b),
      entry,
      "master",
    );
  }

  /** @type {Map<number, {key: string, element: KitElement}[]>} */ const slideItems = new Map();
  /** @type {Map<string, number[]>} */ const presence = new Map();
  for (const slide of input.slides) {
    rawSkips.push(...slide.skipped.map((item) => ({ slide: slide.index, ...item })));
    const seen = new Map();
    const items = resolve(slide.elements, "slide", { slide: slide.index }).map((element) => {
      const body = JSON.stringify(element);
      const occurrence = seen.get(body) ?? 0;
      seen.set(body, occurrence + 1);
      const key = `${body}#${occurrence}`;
      presence.set(key, [...(presence.get(key) ?? []), slide.index]);
      return { key, element };
    });
    slideItems.set(slide.index, items);
  }

  /** @type {KitComponent[]} */ const slideComponents = [];
  for (const kind of kinds) {
    const group = groupOf(kind);
    const split = splitKind(kind, slidesOfKind.get(kind) ?? [], slideItems, presence, kindOfSlide);
    const pages = split.pages.map(({ slide, elements }) =>
      component({
        id: uniqueId(`${group}.page-${slide}`),
        archetype: kind,
        scope: "page",
        source: "slide",
        slides: [slide],
        elements,
      }),
    );
    for (const bucket of split.buckets) {
      slideComponents.push(
        component({
          id: uniqueId(`${group}.deco`, true),
          archetype: kind,
          scope: "layout",
          source: "slide",
          slides: bucket.slides,
          elements: bucket.elements,
        }),
      );
    }
    slideComponents.push(...pages);
  }

  const diagrams = smartArtKit(input.smartArts ?? [], width, kindOfSlide);
  rawSkips.push(...diagrams.skipped);
  const smartArtComponents = diagrams.parts.map((part) =>
    component({
      id: part.id,
      archetype: part.archetype,
      scope: "page",
      source: "slide",
      slides: [part.slide],
      elements: part.elements,
      role: "smartart",
      extra: part.extra,
    }),
  );

  const components = [...layoutComponents, ...slideComponents, ...smartArtComponents];
  const full = assemble(kinds, slidesOfKind, components, assets.all(), skipsOf(rawSkips));
  const capped = capTemplateKit(full, maxBytes);
  return { kit: capped.kit, truncated: capped.truncated, pointer: kitPointer(capped.kit) };
}

/** @param {{kind: string, slides: number[]}[]} archetypes */
function indexArchetypes(archetypes) {
  /** @type {Map<number, string>} */ const kindOfSlide = new Map();
  /** @type {Map<string, number[]>} */ const slidesOfKind = new Map();
  for (const archetype of archetypes) {
    const list = slidesOfKind.get(archetype.kind) ?? [];
    for (const slide of archetype.slides) {
      kindOfSlide.set(slide, archetype.kind);
      list.push(slide);
    }
    slidesOfKind.set(archetype.kind, list);
  }
  return { kindOfSlide, slidesOfKind };
}

/**
 * Elements repeated on enough slides of one archetype become a shared layout bucket per exact
 * slide set; the rest stay on their own page.
 * @param {string} kind @param {number[]} slides
 * @param {Map<number, {key: string, element: KitElement}[]>} slideItems
 * @param {Map<string, number[]>} presence @param {Map<number, string>} kindOfSlide
 */
function splitKind(kind, slides, slideItems, presence, kindOfSlide) {
  /** @type {Map<string, {slides: number[], elements: KitElement[], keys: Set<string>}>} */
  const shared = new Map();
  /** @type {{slide: number, elements: KitElement[]}[]} */ const pages = [];
  for (const slide of slides) {
    const pageElements = [];
    for (const { key, element } of slideItems.get(slide) ?? []) {
      const on = presence.get(key) ?? [];
      if (on.length < LAYOUT_SCOPE_SLIDES) {
        pageElements.push(element);
        continue;
      }
      const here = on.filter((index) => kindOfSlide.get(index) === kind);
      const bucketKey = here.join(",");
      const bucket = shared.get(bucketKey) ?? { slides: here, elements: [], keys: new Set() };
      if (!bucket.keys.has(key)) {
        bucket.keys.add(key);
        bucket.elements.push(element);
      }
      shared.set(bucketKey, bucket);
    }
    if (pageElements.length) pages.push({ slide, elements: pageElements });
  }
  return { pages, buckets: [...shared.values()] };
}

/** The archetype a layout's chrome is filed under: the busiest body kind, else the busiest kind.
 * @param {number[]} using @param {Map<number, string>} kindOfSlide @returns {string|undefined} */
function chromeKind(using, kindOfSlide) {
  /** @type {Map<string, number>} */ const counts = new Map();
  for (const slide of using) {
    const kind = kindOfSlide.get(slide);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return ranked.find(([kind]) => kind.startsWith("body-"))?.[0] ?? ranked[0]?.[0];
}

/** @param {KitElement[]} elements */
function unionBox(elements) {
  const left = Math.min(...elements.map((e) => e.bounds[0]));
  const top = Math.min(...elements.map((e) => e.bounds[1]));
  const right = Math.max(...elements.map((e) => e.bounds[0] + e.bounds[2]));
  const bottom = Math.max(...elements.map((e) => e.bounds[1] + e.bounds[3]));
  const round = (/** @type {number} */ n) => Math.round(n * 1e4) / 1e4;
  return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
}

/** @param {{id: string, archetype: string, scope: "layout"|"page", source: string, slides: number[],
 *   elements: KitElement[], role?: "decoration"|"smartart", extra?: object}} part
 * @returns {KitComponent} */
function component({ id, archetype, scope, source, slides, elements, role = "decoration", extra }) {
  const box = clampBox(unionBox(elements));
  return {
    id,
    archetype,
    role,
    scopeHint: scope,
    source,
    slides,
    box: [box.x, box.y, box.w, box.h],
    ...(box.clamped ? { clamped: /** @type {const} */ (true) } : {}),
    ...extra,
    elements: elements.map((element, index) => ({ elementId: `e${index + 1}`, ...element })),
  };
}

/** Same (slide, SmartArt, reason) triples collapse to one entry with a count.
 * @param {{slide?: number, source?: string, smartArt?: string, reason: string}[]} raw @returns {KitSkip[]} */
function skipsOf(raw) {
  /** @type {Map<string, KitSkip>} */ const merged = new Map();
  for (const item of raw) {
    const key = `${item.slide ?? item.source}|${item.smartArt ?? ""}|${item.reason}`;
    const known = merged.get(key);
    if (known) known.count = (known.count ?? 1) + 1;
    else merged.set(key, { ...item });
  }
  const all = [...merged.values()];
  if (all.length <= MAX_SKIPPED_ENTRIES) return all;
  const rest = all.slice(MAX_SKIPPED_ENTRIES - 1);
  return [
    ...all.slice(0, MAX_SKIPPED_ENTRIES - 1),
    { reason: "其余同类情况已省略", count: rest.reduce((n, item) => n + (item.count ?? 1), 0) },
  ];
}

/**
 * @param {string[]} kinds @param {Map<string, number[]>} slidesOfKind
 * @param {KitComponent[]} components @param {KitAsset[]} assets @param {KitSkip[]} skipped
 * @returns {TemplateKit}
 */
function assemble(kinds, slidesOfKind, components, assets, skipped) {
  const used = new Set(
    components.flatMap((c) => c.elements.flatMap((e) => (typeof e.src === "string" ? [e.src] : []))),
  );
  return {
    schema: TEMPLATE_KIT_SCHEMA,
    version: TEMPLATE_KIT_VERSION,
    units: { bounds: "slide-fraction", length: "px", pageWidth: KIT_PAGE_WIDTH_PX },
    archetypes: kinds.map((kind) => ({
      kind,
      slides: [...(slidesOfKind.get(kind) ?? [])].sort((a, b) => a - b),
      components: components.filter((c) => c.archetype === kind).map((c) => c.id),
    })),
    components,
    assets: assets.filter((asset) => used.has(asset.file)).sort((a, b) => a.file.localeCompare(b.file)),
    receipt: {
      counts: Object.fromEntries(kinds.map((kind) => [kind, components.filter((c) => c.archetype === kind).length])),
      skipped,
    },
  };
}

/**
 * Keeps the longest component prefix whose serialized kit fits; the receipt says how many were
 * dropped and the assets and counts follow the kept components.
 * @param {TemplateKit} kit @param {number} maxBytes
 * @returns {{kit: TemplateKit, truncated: boolean}}
 */
export function capTemplateKit(kit, maxBytes) {
  if (kitBytes(kit).length <= maxBytes) return { kit, truncated: false };
  const kinds = kit.archetypes.map((entry) => entry.kind);
  const slidesOfKind = new Map(kit.archetypes.map((entry) => [entry.kind, entry.slides]));
  /** @param {number} keep */
  const prefix = (keep) => {
    const next = assemble(kinds, slidesOfKind, kit.components.slice(0, keep), kit.assets, kit.receipt.skipped);
    next.receipt.truncated = { kept: keep, dropped: kit.components.length - keep };
    return next;
  };
  let [low, high] = [0, kit.components.length - 1];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (kitBytes(prefix(middle)).length <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { kit: prefix(low), truncated: true };
}

/** Image assets by the file name a component element uses as `src`.
 * @param {import("./ooxml.mjs").PackageReader} pkg
 * @param {{file: string, processed?: {file: string, ops: string[], sha256: string}}[]} photos
 * @param {{file: string, content: string}[]} photoAssets */
function assetRegistry(pkg, photos, photoAssets) {
  /** @type {Map<string, KitAsset>} */ const registry = new Map();
  /** @type {Map<string, {n: number, processed: {file: string, ops: string[], sha256: string}}>} */
  const grey = new Map();
  for (const photo of photos) {
    if (photo.processed) grey.set(photo.file, { n: grey.size + 1, processed: photo.processed });
  }
  return {
    all: () => [...registry.values()],
    /** @param {string} part @param {boolean} desaturated @param {"slide"|"layout"} role
     * @returns {{src: string}|{reason: string}|null} */
    srcFor(part, desaturated, role) {
      const derived = desaturated ? grey.get(part) : undefined;
      if (derived) {
        const src = `media/tpl-photo-${derived.n}-gray.png`;
        if (!registry.has(src)) {
          const stored = photoAssets.find((asset) => asset.file === derived.processed.file);
          const original = pkg.read(part);
          registry.set(src, {
            file: src,
            kind: "derived",
            ops: derived.processed.ops,
            detail: derived.processed.file,
            sha256: derived.processed.sha256,
            ...(stored ? { bytes: Buffer.byteLength(stored.content, "base64") } : {}),
            ...(original ? { sourceSha256: sha256Of(original) } : {}),
          });
        }
        return { src };
      }
      // A picture the template shows desaturated never falls back to its colour original.
      if (desaturated) return { reason: KIT_REASONS.desaturate };
      if (role === "slide") return null;
      const bytes = pkg.read(part);
      if (!bytes) return { reason: KIT_REASONS.image };
      const src = `media/${part.replace(/^ppt\/media\//, "").replaceAll("/", "_")}`;
      if (!registry.has(src)) {
        registry.set(src, {
          file: src,
          kind: "original",
          sha256: sha256Of(bytes),
          bytes: bytes.length,
        });
      }
      return { src };
    },
  };
}

/** The chip line: how many reusable components, by archetype group, and how many were skipped.
 * @param {TemplateKit} kit @returns {string|null} */
function kitChipLine(kit) {
  const { counts, skipped } = kit.receipt;
  const sum = (/** @type {(kind: string) => boolean} */ pick) =>
    Object.entries(counts).reduce((n, [kind, count]) => n + (pick(kind) ? count : 0), 0);
  // A SmartArt without a preview already has its own 「只能读取文字」 chip line from the reader.
  const unreadable = skipped.reduce((n, item) => n + (item.smartArt ? 0 : (item.count ?? 1)), 0);
  if (!kit.components.length && !unreadable) return null;
  const parts = [
    ["封面", sum((kind) => kind === "cover")],
    ["目录", sum((kind) => kind === "toc")],
    ["章节页", sum((kind) => kind === "section")],
    ["正文", sum((kind) => kind.startsWith("body-"))],
    ["结尾", sum((kind) => kind === "closing")],
  ].map(([name, n]) => `${name} ${n}`);
  return `可复用装饰组件 ${kit.components.length} 个（${parts.join("、")}）${
    unreadable ? `，另有 ${unreadable} 项无法读取，已跳过` : ""
  }`;
}

/** @param {TemplateKit} kit */
function kitTruncationWarning(kit) {
  const cut = kit.receipt.truncated;
  return cut
    ? {
        code: "kit-truncated",
        message: `模板组件过多，只保留了前 ${cut.kept} 个，其余 ${cut.dropped} 个未收录`,
      }
    : null;
}

/**
 * What the parser adds to its result: the derivative pointer and embedded kit, the chip copy,
 * and the truncation warning when the kit was cut to its size cap.
 * @param {Parameters<typeof buildTemplateKit>[0]} input @param {{maxBytes?: number}} [options]
 */
export function templateKitOutput(input, options) {
  const { kit, truncated, pointer } = buildTemplateKit(input, options);
  const warning = kitTruncationWarning(kit);
  const line = kitChipLine(kit);
  return {
    payload: { kit: pointer, templateKit: kit },
    copy: [...(line ? [line] : []), ...(warning ? [warning.message] : [])],
    warnings: warning ? [warning] : [],
    truncated,
  };
}
