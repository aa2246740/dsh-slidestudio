/**
 * Canvas session over PPTD SSOT.
 * Dead-button ban: only controls listed in allowedControlIds may run.
 */
import fs from "node:fs";
import path from "node:path";
import {
  loadProject,
  saveProject,
  canonicalFillIssues,
  canonicalTextStylePatchIssues,
  parseRichText,
  readableColor,
  serializeRichText,
  applyRangeStyle,
  type RangeStylePatch,
  type Bounds,
  type Fill,
  type PptdElement,
  type PptdProject,
  type TextElement,
  type ShapeElement,
  type ImageElement,
  type ChartElement,
  type TableElement,
  type IconElement,
  type LineElement,
  type ArrowType,
  type Animation,
  type ImageCrop,
  type ShapeDef,
  type ElementShadow,
  type SmartArtMeta,
  type SmartArtLayout,
  shapeDefaults,
  probeImageSize,
  setOwnPageBackground,
  type Page,
} from "@open-slidestudio/pptd-v2";
import { assertWritableColor, assertWritableFill, assertWritableThemeColor } from "./color-write.js";
import { wholeTokenRange } from "./field-range.js";
import { assertShadowValid } from "./shadow-model.js";
import { connectorPairs, defaultSmartArtLabels, nodePositions } from "./smartart-geometry.js";
import { applyShapeKind, assertShapeKind } from "./shape-model.js";
import { insertedChartFill } from "./page-surface.js";
import { assertControl, clampPageIndex, currentPage, type CanvasSession, type Selection } from "./session-model.js";
import { pushUndo, undo, redo } from "./undo-stack.js";
import { assertNoGraphicsOnLayout, assertPageSurface } from "./layout-surface.js";

export { currentPage, pageCount, type CanvasSession, type EditSurface, type Selection } from "./session-model.js";
export { redo, undo, undoLayoutMark, type LayoutEditMark } from "./undo-stack.js";
export {
  applyPageLayout,
  createLayout,
  deleteLayout,
  enterLayout,
  enterMaster,
  exitLayout,
  insertPageNumber,
  layoutPanel,
  renameLayout,
  selectLayoutSurface,
  type LayoutPanel,
  type LayoutTarget,
} from "./layout-surface.js";
export { renderAllPages, renderModel, type RenderElement } from "./render-model.js";

export type OpenSessionOpts = {
  allowedControlIds?: string[];
  /** Initial page; clamped to `[0, pageCount)`. */
  pageIndex?: number;
  /** Override; default open when the deck has more than one page. */
  pageRailOpen?: boolean;
};

export function openSession(source: string, opts: OpenSessionOpts = {}): CanvasSession {
  const project = loadProject(source);
  return {
    project,
    pageIndex: clampPageIndex(opts.pageIndex, project.pages.length),
    selection: { kind: "none" },
    allowedControlIds: new Set(opts.allowedControlIds ?? []),
    undoStack: [],
    redoStack: [],
    zoomPercent: 100,
    pageRailOpen: opts.pageRailOpen ?? project.pages.length > 1,
    notesOpen: false,
    clipboard: [],
    presenting: false,
    surface: { kind: "page" },
  };
}

export function goToPage(session: CanvasSession, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= session.project.pages.length) {
    throw new Error(`page index out of range: ${index}`);
  }
  // Leaving the layout surface: a page change always returns to page mode.
  session.surface = { kind: "page" };
  session.pageIndex = index;
  session.selection = { kind: "none" };
}

/** A master or layout copy is drawn on the page but never picked there; it is edited in its layout. */
const INHERITED_NOT_SELECTABLE = "版式和母版的元素只能在版式中修改，不能在页面上选中";

export function selectElement(session: CanvasSession, elementId: string, skipGroup = false): PptdElement {
  const page = currentPage(session);
  const el = page.elements.find((e) => e.elementId === elementId);
  if (!el) throw new Error(`element not found: ${elementId}`);
  if (el.inherited !== undefined) throw new Error(INHERITED_NOT_SELECTABLE);
  const gid = (el as { groupId?: string }).groupId;
  if (gid && !skipGroup) {
    // A layout's group may be named like the page's; its copies are never part of the selection.
    const ids = page.elements
      .filter((e) => e.inherited === undefined && (e as { groupId?: string }).groupId === gid)
      .map((e) => e.elementId);
    if (ids.length > 1) {
      session.selection = { kind: "multi", pageIndex: session.pageIndex, elementIds: ids };
      return el;
    }
  }
  session.selection = {
    kind: "element",
    pageIndex: session.pageIndex,
    elementId,
  };
  return el;
}

function selectedElement(session: CanvasSession): PptdElement {
  const els = selectedElements(session);
  if (els.length !== 1) throw new Error("no element selected");
  return els[0]!;
}

/** Selected element for a mutating command: rejects locked elements. */
function mutableElement(session: CanvasSession): PptdElement {
  const el = selectedElement(session);
  assertUnlocked([el]);
  return el;
}

/** Read-only single selected element, or null. Used by server rebuild. */
export function getSelectedElement(session: CanvasSession): PptdElement | null {
  const els = selectedElements(session);
  return els.length === 1 ? els[0]! : null;
}

/** The selected elements every command works on. A master or layout copy is never one of them. */
function selectedElements(session: CanvasSession): PptdElement[] {
  const sel = session.selection;
  const page = currentPage(session);
  if (sel.kind === "element" && sel.pageIndex === session.pageIndex) {
    const el = page.elements.find((e) => e.elementId === sel.elementId);
    return el && el.inherited === undefined ? [el] : [];
  }
  if (sel.kind === "multi" && sel.pageIndex === session.pageIndex) {
    return sel.elementIds
      .map((id) => page.elements.find((e) => e.elementId === id))
      .filter((e): e is PptdElement => e !== undefined && e.inherited === undefined);
  }
  return [];
}

export function clearSelection(session: CanvasSession): void {
  session.selection = { kind: "none" };
}

/** S3: Tab / Shift+Tab cycle through selectable elements (hidden and layout copies skipped). */
export function tabSelect(session: CanvasSession, controlId: string, dir: 1 | -1): void {
  assertControl(session, controlId);
  const page = currentPage(session);
  const pickable = page.elements.filter((e) => !(e as { hidden?: boolean }).hidden && e.inherited === undefined);
  if (!pickable.length) return;
  const cur = selectedElements(session)[0];
  if (!cur) {
    selectElement(session, pickable[0]!.elementId, true);
    return;
  }
  const idx = pickable.findIndex((e) => e.elementId === cur.elementId);
  if (idx < 0) {
    selectElement(session, pickable[0]!.elementId, true);
    return;
  }
  const nextIdx = idx + dir;
  if (nextIdx < 0 || nextIdx >= pickable.length) {
    session.selection = { kind: "none" };
    return;
  }
  selectElement(session, pickable[nextIdx]!.elementId, true);
}

export function selectMany(session: CanvasSession, elementIds: string[]): void {
  const page = currentPage(session);
  const ids = elementIds.filter((id) => page.elements.some((e) => e.elementId === id && e.inherited === undefined));
  if (ids.length === 0) {
    session.selection = { kind: "none" };
    return;
  }
  if (ids.length === 1) {
    session.selection = {
      kind: "element",
      pageIndex: session.pageIndex,
      elementId: ids[0]!,
    };
    return;
  }
  session.selection = {
    kind: "multi",
    pageIndex: session.pageIndex,
    elementIds: ids,
  };
}

/** Text content edit — requires oracle control id, e.g. element.text.content.set */
export function setSelectedText(session: CanvasSession, controlId: string, text: string): void {
  assertControl(session, controlId);
  if (typeof text !== "string") {
    throw new TypeError("text must be a string");
  }
  const el = mutableElement(session);
  if (el.elementType !== "text") {
    throw new Error("selected element is not text");
  }
  pushUndo(session);
  // Store canonical LF — CRLF from a paste would otherwise persist into the
  // .page file and resurface as a stray \r on every future parse.
  (el as TextElement).content.text = text.replace(/\r\n?/g, "\n");
}

/**
 * Replace selected text HTML after a parse→serialize whitelist sanitizer.
 * Control: element.text.content.set
 */
export function setSelectedRichText(session: CanvasSession, controlId: string, html: string): void {
  assertControl(session, controlId);
  if (typeof html !== "string") {
    throw new TypeError("rich text must be a string");
  }
  const el = mutableElement(session);
  if (el.elementType !== "text") {
    throw new Error("selected element is not text");
  }
  const runs = parseRichText(html);
  for (const run of runs) assertWritableColor(run.color, session.project.presentation.theme);
  pushUndo(session);
  (el as TextElement).content.text = serializeRichText(runs);
}

/**
 * Apply a style patch to a plain-text offset range inside the selected text.
 * Always writes runs HTML — does not fall back to content.bold.
 */
export function setSelectedTextRangeStyle(
  session: CanvasSession,
  controlId: string,
  start: number,
  end: number,
  patch: RangeStylePatch,
): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "text") {
    throw new Error("selected element is not text");
  }
  assertWritableColor(patch.color, session.project.presentation.theme);
  pushUndo(session);
  const content = (el as TextElement).content;
  const stored = parseRichText(content.text ?? "");
  const [from, to] =
    content.field === "pageNumber" ? wholeTokenRange(stored.map((run) => run.text).join(""), start, end) : [start, end];
  content.text = serializeRichText(applyRangeStyle(stored, from, to, patch));
}

export type { RangeStylePatch };

/** Toggle bold on selected text — element.text.toolbar.bold.toggle */
export function setSelectedBold(session: CanvasSession, controlId: string, bold: boolean): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "text") {
    throw new Error("selected element is not text");
  }
  pushUndo(session);
  (el as TextElement).content.bold = bold;
}

/** Move / resize selected element — element.bounds.set */
export function setSelectedBounds(
  session: CanvasSession,
  controlId: string,
  bounds: Bounds,
  anchorElementId?: string,
): void {
  assertControl(session, controlId);
  if (bounds.length !== 4 || bounds.some((n) => typeof n !== "number" || Number.isNaN(n))) {
    throw new Error("bounds must be [x,y,w,h] numbers");
  }
  const targets = selectedElements(session);
  if (!targets.length) throw new Error("no element selected");
  assertUnlocked(targets);
  pushUndo(session);
  if (targets.length === 1) {
    const moved = targets[0]!;
    const dx = bounds[0] - moved.bounds[0];
    const dy = bounds[1] - moved.bounds[1];
    moved.bounds = [...bounds] as Bounds;
    moveSmartArtCompanions(session, moved, dx, dy, new Set([moved.elementId]));
    retargetConnectors(session);
    return;
  }
  // The caller names the element it dragged. Falling back to a size match is
  // only a legacy heuristic: two selected elements may share a size, and then
  // the first match would move the group by the wrong delta.
  const anchor =
    (anchorElementId ? targets.find((e) => e.elementId === anchorElementId) : undefined) ??
    targets.find((e) => e.bounds[2] === bounds[2] && e.bounds[3] === bounds[3]) ??
    targets[0]!;
  const dx = bounds[0] - anchor.bounds[0];
  const dy = bounds[1] - anchor.bounds[1];
  if (bounds[2] === anchor.bounds[2] && bounds[3] === anchor.bounds[3]) {
    const already = new Set(targets.map((e) => e.elementId));
    for (const el of targets) {
      el.bounds = [el.bounds[0] + dx, el.bounds[1] + dy, el.bounds[2], el.bounds[3]];
      moveSmartArtCompanions(session, el, dx, dy, already);
    }
    retargetConnectors(session);
    return;
  }
  anchor.bounds = [...bounds] as Bounds;
  retargetConnectors(session);
}

export function persist(session: CanvasSession): void {
  saveProject(session.project);
}

const ZOOM_MIN = 25;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

export function setZoomPercent(session: CanvasSession, controlId: string, percent: number): void {
  assertControl(session, controlId);
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    throw new Error("zoom percent must be a finite number");
  }
  session.zoomPercent = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent)));
}

export function zoomBy(session: CanvasSession, controlId: string, direction: "in" | "out"): void {
  const next = session.zoomPercent + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP);
  setZoomPercent(session, controlId, next);
}

export function setPageRailOpen(session: CanvasSession, controlId: string, open: boolean): void {
  assertControl(session, controlId);
  session.pageRailOpen = open;
}

export function setNotesOpen(session: CanvasSession, controlId: string, open: boolean): void {
  assertControl(session, controlId);
  session.notesOpen = open;
}

export function setPresenting(session: CanvasSession, controlId: string, on: boolean): void {
  assertControl(session, controlId);
  session.presenting = on;
}

function uniquePagePath(session: CanvasSession, hint: string): string {
  const used = new Set(session.project.pages.map((p) => p.path));
  if (!used.has(hint)) return hint;
  for (let i = 1; i < 500; i++) {
    const candidate = hint.replace(/\.page$/i, `_${i}.page`);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("could not allocate page path");
}

export function addBlankPage(session: CanvasSession, controlId: string): void {
  assertControl(session, controlId);
  assertPageSurface(session, "新增页面");
  const layoutId = session.project.pages[session.pageIndex]?.page.layoutId;
  pushUndo(session);
  const n = session.project.pages.length + 1;
  const path = uniquePagePath(session, `pages/${String(n).padStart(2, "0")}_blank.page`);
  // A page that uses a layout takes the layout's background, so it sets none of its own.
  const page: Page =
    layoutId === undefined
      ? { pageType: "content", background: { type: "solid", color: "#FFFFFF" }, elements: [] }
      : { pageType: "content", layoutId, elements: [] };
  session.project.pages.push({ path, page });
  session.project.presentation.pages.push(path);
  session.pageIndex = session.project.pages.length - 1;
  session.selection = { kind: "none" };
}

export function deletePage(session: CanvasSession, controlId: string, index = session.pageIndex): void {
  assertControl(session, controlId);
  assertPageSurface(session, "删除页面");
  if (session.project.pages.length <= 1) {
    throw new Error("cannot delete the last page");
  }
  if (!Number.isInteger(index) || index < 0 || index >= session.project.pages.length) {
    throw new Error(`page index out of range: ${index}`);
  }
  pushUndo(session);
  session.project.pages.splice(index, 1);
  session.project.presentation.pages.splice(index, 1);
  session.pageIndex = Math.min(index, session.project.pages.length - 1);
  session.selection = { kind: "none" };
}

export function duplicatePage(session: CanvasSession, controlId: string, index = session.pageIndex): void {
  assertControl(session, controlId);
  assertPageSurface(session, "复制页面");
  const src = session.project.pages[index];
  if (!src) throw new Error(`page index out of range: ${index}`);
  pushUndo(session);
  const path = uniquePagePath(session, src.path.replace(/\.page$/i, "_copy.page"));
  const page = JSON.parse(JSON.stringify(src.page)) as typeof src.page;
  session.project.pages.splice(index + 1, 0, { path, page });
  session.project.presentation.pages.splice(index + 1, 0, path);
  session.pageIndex = index + 1;
  session.selection = { kind: "none" };
}

export function reorderPages(session: CanvasSession, controlId: string, fromIndex: number, toIndex: number): void {
  assertControl(session, controlId);
  assertPageSurface(session, "调整页面顺序");
  const last = session.project.pages.length - 1;
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex > last ||
    toIndex > last ||
    fromIndex === toIndex
  ) {
    throw new Error(`invalid reorder: ${fromIndex} → ${toIndex}`);
  }
  pushUndo(session);
  const [movedPage] = session.project.pages.splice(fromIndex, 1);
  const [movedPath] = session.project.presentation.pages.splice(fromIndex, 1);
  session.project.pages.splice(toIndex, 0, movedPage!);
  session.project.presentation.pages.splice(toIndex, 0, movedPath!);
  session.pageIndex = toIndex;
  session.selection = { kind: "none" };
}

function nextElementId(session: CanvasSession, prefix: string): string {
  const used = new Set(currentPage(session).elements.map((e) => e.elementId));
  return freshId(used, prefix);
}

function freshId(used: Set<string>, prefix: string): string {
  for (let i = 1; i < 10000; i++) {
    const id = `${prefix}-${i}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error("could not allocate element id");
}

/**
 * Deep-copy elements for duplicate/paste: every copy gets a fresh page-unique
 * elementId, and identity-bearing references are remapped so the copies never
 * join the source's structures — groupId per source group, smartArt.id per
 * source diagram, and line `connects` only when both endpoints were copied
 * (a dangling connection to an uncopied element is dropped, not kept).
 */
function cloneElementsForInsert(
  page: { elements: PptdElement[] },
  elements: PptdElement[],
): { copies: PptdElement[]; idMap: Map<string, string> } {
  const usedIds = new Set(page.elements.map((e) => e.elementId));
  const usedGroups = new Set(
    page.elements
      .map((e) => (e as { groupId?: string }).groupId)
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  const usedSmartArt = new Set(
    page.elements.map((e) => e.smartArt?.id).filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  const idMap = new Map<string, string>();
  for (const el of elements) {
    idMap.set(el.elementId, freshId(usedIds, el.elementType));
  }
  const groupMap = new Map<string, string>();
  const smartArtMap = new Map<string, string>();
  const copies = elements.map((el) => {
    const copy = JSON.parse(JSON.stringify(el)) as PptdElement;
    copy.elementId = idMap.get(el.elementId)!;
    const rec = copy as { groupId?: string };
    if (typeof rec.groupId === "string" && rec.groupId) {
      let mapped = groupMap.get(rec.groupId);
      if (!mapped) {
        mapped = freshId(usedGroups, "group");
        groupMap.set(rec.groupId, mapped);
      }
      rec.groupId = mapped;
    }
    if (copy.smartArt?.id) {
      let mapped = smartArtMap.get(copy.smartArt.id);
      if (!mapped) {
        mapped = freshId(usedSmartArt, "smartart");
        smartArtMap.set(copy.smartArt.id, mapped);
      }
      copy.smartArt = { ...copy.smartArt, id: mapped };
    }
    if (copy.elementType === "line") {
      const line = copy as LineElement;
      if (Array.isArray(line.connects)) {
        const a = idMap.get(line.connects[0]);
        const b = idMap.get(line.connects[1]);
        if (a && b) line.connects = [a, b];
        else delete line.connects;
      }
    }
    const [x, y, w, h] = copy.bounds;
    copy.bounds = [x + 24, y + 24, w, h];
    return copy;
  });
  return { copies, idMap };
}

const SLIDE_W = 960;
const SLIDE_H = 540;
const CASCADE_STEP = 24;
const CASCADE_ORIGIN = 80;

function slideSize(session: CanvasSession): [number, number] {
  const size = session.project.presentation.size;
  const w = Array.isArray(size) && Number.isFinite(size[0]) ? size[0] : SLIDE_W;
  const h = Array.isArray(size) && Number.isFinite(size[1]) ? size[1] : SLIDE_H;
  return [w, h];
}

/** Keep `[x,y,w,h]` overlapping `[0,0,cw,ch]` — never fully outside the slide. */
function clampRectToSlide(x: number, y: number, w: number, h: number, cw: number, ch: number): Bounds {
  const maxX = Math.max(0, cw - Math.min(w, cw));
  const maxY = Math.max(0, ch - Math.min(h, ch));
  const nx = Number.isFinite(x) ? Math.min(Math.max(0, x), maxX) : 0;
  const ny = Number.isFinite(y) ? Math.min(Math.max(0, y), maxY) : 0;
  return [nx, ny, w, h];
}

/**
 * Cascade insert origin: +24px per insert, wrap to a new column at the slide edge.
 * `n` is the 0-based insert slot (typically `page.elements.length`).
 */
function cascadeInsert(session: CanvasSession, n: number, boxW = 320, boxH = 80): Bounds {
  const [cw, ch] = slideSize(session);
  const slot = Number.isInteger(n) && n > 0 ? n : 0;
  const maxX = Math.max(0, cw - boxW);
  const maxY = Math.max(0, ch - boxH);
  const rows = Math.max(
    1,
    Math.min(
      Math.floor(Math.max(0, maxY - CASCADE_ORIGIN) / CASCADE_STEP) + 1,
      Math.floor(Math.max(0, maxX - CASCADE_ORIGIN) / CASCADE_STEP) + 1,
    ),
  );
  const maxCols = Math.max(1, Math.floor(Math.max(0, maxX - CASCADE_ORIGIN) / CASCADE_STEP) + 1);
  const col = Math.floor(slot / rows) % maxCols;
  const row = slot % rows;
  const x = CASCADE_ORIGIN + col * CASCADE_STEP + row * CASCADE_STEP;
  const y = CASCADE_ORIGIN + row * CASCADE_STEP;
  return clampRectToSlide(x, y, boxW, boxH, cw, ch);
}

export const MAX_INSERT_TEXT_LENGTH = 20_000;

export function insertText(session: CanvasSession, controlId: string, initialText: unknown = "双击编辑文本"): string {
  assertControl(session, controlId);
  if (typeof initialText !== "string") {
    throw new TypeError("insert text must be a string");
  }
  if (initialText.length > MAX_INSERT_TEXT_LENGTH) {
    throw new RangeError(`insert text exceeds ${MAX_INSERT_TEXT_LENGTH} characters`);
  }
  pushUndo(session);
  const id = nextElementId(session, "text");
  const page = currentPage(session);
  const el: TextElement = {
    elementId: id,
    elementType: "text",
    bounds: cascadeInsert(session, page.elements.length),
    content: { text: initialText, fontSize: 24, color: "#111111" },
  };
  page.elements.push(el);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: id };
  return id;
}

export function insertShape(session: CanvasSession, controlId: string, shapeName = "roundRect"): string {
  assertControl(session, controlId);
  pushUndo(session);
  const id = nextElementId(session, "shape");
  const page = currentPage(session);
  const el: ShapeElement = {
    elementId: id,
    elementType: "shape",
    shapeName,
    adjustments: shapeDefaults(shapeName),
    bounds: cascadeInsert(session, page.elements.length, 240, 120),
    fill: { type: "solid", color: "#2563EB" },
  };
  page.elements.push(el);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: id };
  return id;
}

const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function insertImage(session: CanvasSession, controlId: string, src?: string): string {
  assertControl(session, controlId);
  pushUndo(session);
  let rel = src;
  if (!rel) {
    const mediaDir = path.join(session.project.rootDir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const file = path.join(mediaDir, "insert-placeholder.png");
    if (!fs.existsSync(file)) fs.writeFileSync(file, PLACEHOLDER_PNG);
    rel = "media/insert-placeholder.png";
  }
  const id = nextElementId(session, "image");
  let bounds: Bounds = [80, 80, 360, 200];
  if (src) {
    const dim = readPictureSize(path.join(session.project.rootDir, rel));
    if (dim) {
      const maxW = 640;
      const scale = Math.min(1, maxW / dim[0]);
      bounds = [80, 80, Math.round(dim[0] * scale), Math.round(dim[1] * scale)];
    }
  }
  const el: ImageElement = {
    elementId: id,
    elementType: "image",
    bounds,
    src: rel,
    fit: { mode: "contain" },
  };
  currentPage(session).elements.push(el);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: id };
  return id;
}

/** Natural size of a picture file read from its bytes; undefined when it is missing or not an image. */
function readPictureSize(file: string): [number, number] | undefined {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  const dim = probeImageSize(bytes);
  return dim ? [dim.w, dim.h] : undefined;
}

function parseRebuildLabels(prompt?: string): { labels: string[]; ocr: boolean } {
  const raw = (prompt ?? "")
    .split(/[,，、;；/\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1 && s.length <= 48);
  if (raw.length >= 2) return { labels: raw.slice(0, 6), ocr: true };
  return { labels: ["输入", "处理", "输出", "反馈"], ocr: false };
}

function layoutConnector(line: LineElement, a: PptdElement, b: PptdElement): void {
  const [ax, ay] = [a.bounds[0] + a.bounds[2] / 2, a.bounds[1] + a.bounds[3] / 2];
  const [bx, by] = [b.bounds[0] + b.bounds[2] / 2, b.bounds[1] + b.bounds[3] / 2];
  const dx = bx - ax;
  const dy = by - ay;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / distance;
  const uy = dy / distance;
  const edgeDistance = (bounds: Bounds): number => {
    const tx = Math.abs(ux) > 1e-6 ? bounds[2] / 2 / Math.abs(ux) : Number.POSITIVE_INFINITY;
    const ty = Math.abs(uy) > 1e-6 ? bounds[3] / 2 / Math.abs(uy) : Number.POSITIVE_INFINITY;
    return Math.min(tx, ty);
  };
  let startInset = edgeDistance(a.bounds);
  let endInset = edgeDistance(b.bounds);
  const insetTotal = startInset + endInset;
  if (insetTotal >= distance - 2) {
    const scale = Math.max(0, distance - 2) / Math.max(1, insetTotal);
    startInset *= scale;
    endInset *= scale;
  }
  const sx = ax + ux * startInset;
  const sy = ay + uy * startInset;
  const ex = bx - ux * endInset;
  const ey = by - uy * endInset;
  const pad = 4;
  const x = Math.min(sx, ex) - pad;
  const y = Math.min(sy, ey) - pad;
  const w = Math.max(8, Math.abs(ex - sx) + pad * 2);
  const h = Math.max(8, Math.abs(ey - sy) + pad * 2);
  line.bounds = [x, y, w, h];
  line.viewBox = [w, h];
  line.points = `${sx - x},${sy - y} ${ex - x},${ey - y}`;
}

function retargetConnectors(session: CanvasSession): void {
  const page = currentPage(session);
  const byId = new Map(page.elements.map((e) => [e.elementId, e]));
  for (const el of page.elements) {
    if (el.elementType !== "line" || (el as { locked?: boolean }).locked) continue;
    const pair = (el as LineElement).connects;
    if (!pair) continue;
    const a = byId.get(pair[0]);
    const b = byId.get(pair[1]);
    if (a && b) layoutConnector(el as LineElement, a, b);
  }
}

function smartArtOf(el: PptdElement): SmartArtMeta | undefined {
  return (el as { smartArt?: SmartArtMeta }).smartArt;
}

/** Theme colours copied into new elements, read as #RRGGBB (an older theme may store six digits without #). */
function themeAccent(session: CanvasSession): { accent: string; ink: string; paper: string } {
  const theme = session.project.presentation.theme?.colors ?? {};
  return {
    accent: readableColor(String(theme.primary || "#2563EB")),
    ink: readableColor(String(theme.text || "#111111")),
    paper: "#FFFFFF",
  };
}

function smartArtNodes(
  page: { elements: PptdElement[] },
  id: string,
): { node: ShapeElement; label: TextElement; index: number }[] {
  const nodes = page.elements.filter(
    (e) => e.elementType === "shape" && smartArtOf(e)?.id === id && smartArtOf(e)?.role === "node",
  ) as ShapeElement[];
  const labels = page.elements.filter(
    (e) => e.elementType === "text" && smartArtOf(e)?.id === id && smartArtOf(e)?.role === "label",
  ) as TextElement[];
  return nodes
    .map((node) => {
      const index = smartArtOf(node)?.index ?? 0;
      const label = labels.find((l) => smartArtOf(l)?.index === index);
      return label ? { node, label, index } : null;
    })
    .filter((x): x is { node: ShapeElement; label: TextElement; index: number } => Boolean(x))
    .sort((a, b) => a.index - b.index);
}

function makeSmartArtNode(
  session: CanvasSession,
  id: string,
  layout: SmartArtLayout,
  index: number,
  text: string,
  bounds: Bounds,
): { node: ShapeElement; label: TextElement } {
  const { accent, ink, paper } = themeAccent(session);
  const sid = nextElementId(session, "shape");
  const tid = nextElementId(session, "text");
  const node: ShapeElement = {
    elementId: sid,
    elementType: "shape",
    bounds,
    shapeName: "roundRect",
    fill: { type: "solid", color: index === 0 ? accent : "#F3F4F6" },
    border: { style: "solid", width: 1.5, color: accent },
    smartArt: { id, layout, role: "node", index },
  };
  const label: TextElement = {
    elementId: tid,
    elementType: "text",
    bounds: [bounds[0] + 10, bounds[1] + 18, bounds[2] - 20, bounds[3] - 36],
    content: {
      text,
      fontSize: 14,
      bold: true,
      align: ["center", "middle"],
      color: index === 0 ? paper : ink,
    },
    smartArt: { id, layout, role: "label", index },
  };
  return { node, label };
}

function relayoutSmartArt(session: CanvasSession, id: string, layout?: SmartArtLayout): void {
  const page = currentPage(session);
  const pairs = smartArtNodes(page, id);
  if (!pairs.length) return;
  const currentLayout = layout || smartArtOf(pairs[0]!.node)?.layout || "process";
  const pinned = pairs.find((p) => p.node.smartArt?.pinned);
  const anchor: [number, number] = pinned
    ? [pinned.node.bounds[0], pinned.node.bounds[1]]
    : [Math.min(...pairs.map((p) => p.node.bounds[0])), Math.min(...pairs.map((p) => p.node.bounds[1]))];
  const boxes = nodePositions(currentLayout, pairs.length, anchor);
  const { accent } = themeAccent(session);
  page.elements = page.elements.filter((e) => !(smartArtOf(e)?.id === id && smartArtOf(e)?.role === "connector"));
  pairs.forEach((p, i) => {
    const wasPinned = Boolean(p.node.smartArt?.pinned);
    const box = wasPinned ? p.node.bounds : boxes[i]!;
    p.node.bounds = box;
    p.node.smartArt = { id, layout: currentLayout, role: "node", index: i, pinned: wasPinned };
    p.label.bounds = [box[0] + 10, box[1] + 18, box[2] - 20, box[3] - 36];
    p.label.smartArt = { id, layout: currentLayout, role: "label", index: i };
    p.label.content.align = ["center", "middle"];
  });
  for (const [a, b] of connectorPairs(currentLayout, pairs.length)) {
    const lid = nextElementId(session, "line");
    const line: LineElement = {
      elementId: lid,
      elementType: "line",
      bounds: [0, 0, 8, 8],
      viewBox: [8, 8],
      points: "0,4 8,4",
      border: { style: "solid", width: 2, color: accent },
      curve: currentLayout === "cycle" ? "smooth" : "round",
      arrow: [null, "arrow"],
      connects: [pairs[a]!.node.elementId, pairs[b]!.node.elementId],
      smartArt: { id, layout: currentLayout, role: "connector" },
    };
    page.elements.push(line);
  }
  retargetConnectors(session);
}

function moveSmartArtCompanions(
  session: CanvasSession,
  moved: PptdElement,
  dx: number,
  dy: number,
  already: Set<string>,
): void {
  const meta = smartArtOf(moved);
  if (!meta || (!dx && !dy)) return;
  if (meta.role !== "node" && meta.role !== "label") return;
  const want = meta.role === "node" ? "label" : "node";
  for (const el of currentPage(session).elements) {
    if (already.has(el.elementId)) continue;
    const m = smartArtOf(el);
    if (m?.id === meta.id && m.role === want && m.index === meta.index) {
      el.bounds = [el.bounds[0] + dx, el.bounds[1] + dy, el.bounds[2], el.bounds[3]];
      already.add(el.elementId);
    }
  }
  if (moved.elementType === "shape") {
    (moved as { smartArt?: SmartArtMeta & { pinned?: boolean } }).smartArt = {
      ...meta,
      pinned: true,
    };
  }
}

/** AC-11: turn selected image into independently selectable text/shape/line nodes. */
export function rebuildSelectedImage(
  session: CanvasSession,
  controlId: string,
  prompt?: string,
): { labels: string[]; created: string[] } {
  assertControl(session, controlId);
  const img = mutableElement(session);
  if (img.elementType !== "image") throw new Error("selected element is not image");
  pushUndo(session);
  const page = currentPage(session);
  const [x, y, w, h] = img.bounds;
  const theme = session.project.presentation.theme?.colors ?? {};
  const accent = readableColor(theme.primary || "#2563EB");
  const ink = readableColor(theme.text || "#111111");
  const { labels, ocr } = parseRebuildLabels(prompt);
  const created: string[] = [];

  img.bounds = [x + Math.max(0, w - 88), y + 8, 80, 44];
  img.opacity = 0.85;

  const titleId = nextElementId(session, "text");
  page.elements.push({
    elementId: titleId,
    elementType: "text",
    bounds: [x + 16, y + 8, Math.max(120, w - 120), 28],
    content: {
      text: "结构重建",
      fontSize: 18,
      bold: true,
      color: ink,
    },
  } as TextElement);
  created.push(titleId);

  if (!ocr) {
    const capId = nextElementId(session, "text");
    page.elements.push({
      elementId: capId,
      elementType: "text",
      bounds: [x + 16, y + 36, Math.max(160, w - 120), 18],
      content: {
        text: "未做 OCR，请改节点文案",
        fontSize: 11,
        color: "#6B7280",
      },
    } as TextElement);
    created.push(capId);
  }

  const nodes = labels;
  const count = Math.max(2, nodes.length);
  const gap = 14;
  const cardH = Math.min(72, Math.max(48, h - 90));
  const cardW = Math.max(72, Math.floor((w - 32 - gap * (count - 1)) / count));
  const cardY = y + h - cardH - 12;
  const shapeIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const cx = x + 16 + i * (cardW + gap);
    const sid = nextElementId(session, "shape");
    page.elements.push({
      elementId: sid,
      elementType: "shape",
      bounds: [cx, cardY, cardW, cardH],
      shapeName: "roundRect",
      fill: { type: "solid", color: i % 2 === 0 ? String(accent) : "#F3F4F6" },
    } as ShapeElement);
    created.push(sid);
    shapeIds.push(sid);
    const tid = nextElementId(session, "text");
    page.elements.push({
      elementId: tid,
      elementType: "text",
      bounds: [cx + 8, cardY + cardH / 2 - 12, cardW - 16, 24],
      content: {
        text: nodes[i] ?? `节点 ${i + 1}`,
        fontSize: 13,
        bold: true,
        align: ["center", "middle"],
        color: i % 2 === 0 ? "#FFFFFF" : ink,
      },
    } as TextElement);
    created.push(tid);
    if (i > 0) {
      const lid = nextElementId(session, "line");
      const line: LineElement = {
        elementId: lid,
        elementType: "line",
        bounds: [0, 0, 8, 8],
        viewBox: [8, 8],
        points: "0,4 8,4",
        border: { style: "solid", width: 2, color: String(accent) },
        arrow: [null, "arrow"],
        connects: [shapeIds[i - 1]!, sid],
      };
      page.elements.push(line);
      created.push(lid);
    }
  }
  retargetConnectors(session);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: created[0]! };
  return { labels: ocr ? labels : nodes, created };
}

export const MIN_INSERT_TABLE_SIZE = 1;
export const MAX_INSERT_TABLE_SIZE = 6;

function assertInsertTableSize(value: number, label: "rows" | "columns"): void {
  if (!Number.isInteger(value)) throw new Error(`insert table ${label} must be an integer`);
  if (value < MIN_INSERT_TABLE_SIZE || value > MAX_INSERT_TABLE_SIZE) {
    throw new Error(`insert table ${label} must be between ${MIN_INSERT_TABLE_SIZE} and ${MAX_INSERT_TABLE_SIZE}`);
  }
}

export function insertTable(session: CanvasSession, controlId: string, rows = 2, columns = 2): string {
  assertControl(session, controlId);
  assertNoGraphicsOnLayout(session);
  // Validate the complete request before adding an undo snapshot or changing
  // selection/project state. The insert is one atomic canvas mutation.
  assertInsertTableSize(rows, "rows");
  assertInsertTableSize(columns, "columns");
  pushUndo(session);
  const id = nextElementId(session, "table");
  const headerFill: Fill = { type: "solid", color: "#F3F4F6" };
  const tableRows: TableElement["rows"] = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: columns }, (_, columnIndex) =>
      rowIndex === 0
        ? {
            text: `列 ${String.fromCharCode("A".charCodeAt(0) + columnIndex)}`,
            bold: true,
            fill: { ...headerFill },
          }
        : { text: "—" },
    ),
  );
  const el: TableElement = {
    elementId: id,
    elementType: "table",
    bounds: [80, 200, 640, 160],
    columnWidths: Array.from({ length: columns }, () => 1 / columns),
    rows: tableRows,
  };
  currentPage(session).elements.push(el);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: id };
  return id;
}

export function insertChart(session: CanvasSession, controlId: string): string {
  assertControl(session, controlId);
  assertNoGraphicsOnLayout(session);
  pushUndo(session);
  const id = nextElementId(session, "chart");
  const el: ChartElement = {
    elementId: id,
    elementType: "chart",
    bounds: [80, 140, 640, 280],
    background: insertedChartFill(currentPage(session), session.project.presentation.size),
    title: "示例数据",
    data: {
      cols: ["类目", "数值"],
      rows: [
        ["A", 3],
        ["B", 5],
        ["C", 2],
      ],
    },
    series: [{ type: "bar", name: "数值", encode: { x: "类目", y: "数值" } }],
    legend: true,
  };
  currentPage(session).elements.push(el);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: id };
  return id;
}

export function insertLine(session: CanvasSession, controlId: string): string {
  assertControl(session, controlId);
  pushUndo(session);
  const id = nextElementId(session, "line");
  const el: LineElement = {
    elementId: id,
    elementType: "line",
    bounds: [80, 200, 400, 8],
    viewBox: [400, 8],
    points: "0,4 130,4 270,4 400,4",
    border: { style: "solid", width: 3, color: "#111111" },
    arrow: [null, null],
  };
  currentPage(session).elements.push(el);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: id };
  return id;
}

export function insertIcon(session: CanvasSession, controlId: string, iconName = "fas:star"): string {
  assertControl(session, controlId);
  pushUndo(session);
  const id = nextElementId(session, "icon");
  const el: IconElement = {
    elementId: id,
    elementType: "icon",
    bounds: [120, 160, 64, 64],
    iconName,
    fill: { type: "solid", color: "#F59E0B" },
  };
  currentPage(session).elements.push(el);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: id };
  return id;
}

/** AC-07: insert SmartArt as independently selectable nodes + connectors. */
export function insertSmartArt(
  session: CanvasSession,
  controlId: string,
  layout: SmartArtLayout = "process",
  labels?: string[],
): string {
  assertControl(session, controlId);
  assertNoGraphicsOnLayout(session);
  pushUndo(session);
  const id = `sa${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const texts = (labels?.length ? labels : defaultSmartArtLabels(layout)).slice(0, 8);
  const page = currentPage(session);
  const baseBoxes = nodePositions(layout, texts.length, [80, 180]);
  const maxX = Math.max(...baseBoxes.map((b) => b[0] + b[2]));
  const maxY = Math.max(...baseBoxes.map((b) => b[1] + b[3]));
  let ox = 80;
  let oy = 180;
  for (let shift = 0; shift < 8; shift++) {
    const hit = page.elements.some((e) => {
      const [x, y, w, h] = e.bounds;
      return x < ox + maxX && x + w > ox && y < oy + maxY && y + h > oy;
    });
    if (!hit) break;
    ox += 40;
    oy += 40;
  }
  const boxes = baseBoxes.map((b) => [b[0] + (ox - 80), b[1] + (oy - 180), b[2], b[3]] as Bounds);
  let first = "";
  texts.forEach((text, i) => {
    const { node, label } = makeSmartArtNode(session, id, layout, i, text, boxes[i]!);
    page.elements.push(node, label);
    if (!first) first = node.elementId;
  });
  const anchor: [number, number] = [ox, oy];
  const afterBoxes = nodePositions(layout, texts.length, anchor);
  const pairs = smartArtNodes(page, id);
  page.elements = page.elements.filter((e) => !(smartArtOf(e)?.id === id && smartArtOf(e)?.role === "connector"));
  pairs.forEach((p, i) => {
    const box = afterBoxes[i]!;
    p.node.bounds = box;
    p.node.smartArt = { id, layout, role: "node", index: i };
    p.label.bounds = [box[0] + 10, box[1] + 18, box[2] - 20, box[3] - 36];
    p.label.smartArt = { id, layout, role: "label", index: i };
  });
  const { accent } = themeAccent(session);
  for (const [a, b] of connectorPairs(layout, pairs.length)) {
    const lid = nextElementId(session, "line");
    const line: LineElement = {
      elementId: lid,
      elementType: "line",
      bounds: [0, 0, 8, 8],
      viewBox: [8, 8],
      points: "0,4 8,4",
      border: { style: "solid", width: 2, color: accent },
      curve: layout === "cycle" ? "smooth" : "round",
      arrow: [null, "arrow"],
      connects: [pairs[a]!.node.elementId, pairs[b]!.node.elementId],
      smartArt: { id, layout, role: "connector" },
    };
    page.elements.push(line);
  }
  retargetConnectors(session);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: first };
  return id;
}

export function addSmartArtNode(session: CanvasSession, controlId: string, label?: string): string {
  assertControl(session, controlId);
  const el = mutableElement(session);
  const meta = smartArtOf(el);
  if (!meta) throw new Error("selected element is not SmartArt");
  pushUndo(session);
  const page = currentPage(session);
  const nodes = smartArtNodes(page, meta.id);
  const index = nodes.length;
  const { node, label: textEl } = makeSmartArtNode(
    session,
    meta.id,
    meta.layout,
    index,
    label || `节点 ${index + 1}`,
    [80, 180, 168, 72],
  );
  page.elements.push(node, textEl);
  relayoutSmartArt(session, meta.id, meta.layout);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: node.elementId };
  return node.elementId;
}

export function deleteSmartArtNode(session: CanvasSession, controlId: string): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  const meta = smartArtOf(el);
  if (!meta) throw new Error("selected element is not SmartArt");
  const page = currentPage(session);
  const nodes = smartArtNodes(page, meta.id);
  if (nodes.length <= 2) throw new Error("SmartArt needs at least two nodes");
  const index = meta.role === "connector" ? nodes[nodes.length - 1]!.index : (meta.index ?? 0);
  pushUndo(session);
  page.elements = page.elements.filter((e) => {
    const m = smartArtOf(e);
    if (!m || m.id !== meta.id) return true;
    if (m.role === "connector") return false;
    return m.index !== index;
  });
  const left = smartArtNodes(page, meta.id);
  left.forEach((p, i) => {
    p.node.smartArt = { id: meta.id, layout: meta.layout, role: "node", index: i };
    p.label.smartArt = { id: meta.id, layout: meta.layout, role: "label", index: i };
  });
  relayoutSmartArt(session, meta.id, meta.layout);
  session.selection = {
    kind: "element",
    pageIndex: session.pageIndex,
    elementId: left[0]!.node.elementId,
  };
}

export function setSmartArtLayout(session: CanvasSession, controlId: string, layout: SmartArtLayout): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  const meta = smartArtOf(el);
  if (!meta) throw new Error("selected element is not SmartArt");
  if (layout !== "process" && layout !== "cycle" && layout !== "hierarchy") {
    throw new Error(`unknown SmartArt layout: ${layout}`);
  }
  pushUndo(session);
  relayoutSmartArt(session, meta.id, layout);
}

function assertUnlocked(els: PptdElement[]): void {
  if (els.some((e) => (e as { locked?: boolean }).locked)) {
    throw new Error("selected element is locked");
  }
}

export function setSelectedLocked(session: CanvasSession, controlId: string, locked: boolean): void {
  assertControl(session, controlId);
  const els = selectedElements(session);
  if (!els.length) throw new Error("no element selected");
  pushUndo(session);
  for (const el of els) (el as { locked?: boolean }).locked = locked;
}

export function setSelectedHidden(session: CanvasSession, controlId: string, hidden: boolean): void {
  assertControl(session, controlId);
  const els = selectedElements(session);
  if (!els.length) throw new Error("no element selected");
  pushUndo(session);
  for (const el of els) (el as { hidden?: boolean }).hidden = hidden;
}

export function setSelectedShadow(session: CanvasSession, controlId: string, shadow: ElementShadow | null): void {
  assertControl(session, controlId);
  const els = selectedElements(session);
  if (!els.length) throw new Error("no element selected");
  assertUnlocked(els);
  if (shadow) {
    assertShadowValid(shadow);
    assertWritableColor(shadow.color, session.project.presentation.theme);
  }
  pushUndo(session);
  for (const el of els) {
    if (shadow) (el as { shadow?: ElementShadow }).shadow = { ...shadow };
    else delete (el as { shadow?: ElementShadow }).shadow;
  }
}

export function groupSelected(session: CanvasSession, controlId: string): string {
  assertControl(session, controlId);
  const els = selectedElements(session);
  if (els.length < 2) throw new Error("group needs at least two elements");
  assertUnlocked(els);
  pushUndo(session);
  const groupId = `g${Date.now().toString(36)}`;
  for (const el of els) (el as { groupId?: string }).groupId = groupId;
  selectMany(
    session,
    els.map((e) => e.elementId),
  );
  return groupId;
}

export function ungroupSelected(session: CanvasSession, controlId: string): void {
  assertControl(session, controlId);
  const els = selectedElements(session);
  if (!els.length) throw new Error("no element selected");
  assertUnlocked(els);
  pushUndo(session);
  const ids = new Set(els.map((e) => (e as { groupId?: string }).groupId).filter(Boolean));
  for (const el of currentPage(session).elements) {
    if (el.inherited === undefined && ids.has((el as { groupId?: string }).groupId)) {
      delete (el as { groupId?: string }).groupId;
    }
  }
}

export function deleteSelected(session: CanvasSession, controlId: string): void {
  assertControl(session, controlId);
  const chosen = selectedElements(session);
  assertUnlocked(chosen);
  const ids = new Set(chosen.map((e) => e.elementId));
  if (!ids.size) throw new Error("no element selected");
  pushUndo(session);
  const page = currentPage(session);
  // Cascade: a connector attached to a deleted element goes too, and
  // animations targeting deleted elements are removed.
  for (const el of page.elements) {
    if (el.elementType !== "line" || ids.has(el.elementId)) continue;
    const connects = (el as LineElement).connects;
    if (connects && (ids.has(connects[0]) || ids.has(connects[1]))) {
      ids.add(el.elementId);
    }
  }
  page.elements = page.elements.filter((e) => !ids.has(e.elementId));
  if (Array.isArray(page.animations)) {
    page.animations = page.animations.filter((a) => !ids.has(a.elementId));
  }
  session.selection = { kind: "none" };
}

export function duplicateSelected(session: CanvasSession, controlId: string): void {
  assertControl(session, controlId);
  const src = selectedElements(session);
  if (!src.length) throw new Error("no element selected");
  assertUnlocked(src);
  pushUndo(session);
  const page = currentPage(session);
  const { copies, idMap } = cloneElementsForInsert(page, src);
  page.elements.push(...copies);
  // Copied elements keep their animations, retargeted at the fresh ids.
  if (Array.isArray(page.animations) && page.animations.length) {
    for (const anim of page.animations) {
      const mapped = idMap.get(anim.elementId);
      if (mapped) page.animations.push({ ...anim, elementId: mapped });
    }
  }
  selectMany(
    session,
    copies.map((c) => c.elementId),
  );
}

export function copySelected(session: CanvasSession): number {
  const src = selectedElements(session);
  session.clipboard = src.map((el) => JSON.parse(JSON.stringify(el)) as PptdElement);
  return session.clipboard.length;
}

export function pasteClipboard(session: CanvasSession, controlId: string): void {
  assertControl(session, controlId);
  if (!session.clipboard.length) throw new Error("clipboard empty");
  assertNoGraphicsOnLayout(session, session.clipboard);
  pushUndo(session);
  const page = currentPage(session);
  const { copies, idMap } = cloneElementsForInsert(page, session.clipboard);
  page.elements.push(...copies);
  if (Array.isArray(page.animations) && page.animations.length) {
    for (const anim of page.animations) {
      const mapped = idMap.get(anim.elementId);
      if (mapped) page.animations.push({ ...anim, elementId: mapped });
    }
  }
  selectMany(
    session,
    copies.map((c) => c.elementId),
  );
}

export function arrangeSelected(
  session: CanvasSession,
  controlId: string,
  dir: "forward" | "backward" | "front" | "back",
): void {
  assertControl(session, controlId);
  const selEls = selectedElements(session);
  if (!selEls.length) throw new Error("no element selected");
  assertUnlocked(selEls);
  const ids = selEls.map((e) => e.elementId);
  pushUndo(session);
  const page = currentPage(session);
  const moving = page.elements.filter((e) => ids.includes(e.elementId));
  const rest = page.elements.filter((e) => !ids.includes(e.elementId));
  if (dir === "front") page.elements = [...rest, ...moving];
  else if (dir === "back") page.elements = [...moving, ...rest];
  else if (dir === "forward") {
    // One z step: each selected element swaps with the unselected element
    // directly above it. A sparse selection climbs exactly one slot.
    const sel = new Set(ids);
    const arr = page.elements;
    for (let i = arr.length - 2; i >= 0; i -= 1) {
      if (sel.has(arr[i]!.elementId) && !sel.has(arr[i + 1]!.elementId)) {
        const t = arr[i]!;
        arr[i] = arr[i + 1]!;
        arr[i + 1] = t;
      }
    }
  } else {
    const sel = new Set(ids);
    const arr = page.elements;
    for (let i = 1; i < arr.length; i += 1) {
      if (sel.has(arr[i]!.elementId) && !sel.has(arr[i - 1]!.elementId)) {
        const t = arr[i]!;
        arr[i] = arr[i - 1]!;
        arr[i - 1] = t;
      }
    }
  }
}

export function alignSelected(
  session: CanvasSession,
  controlId: string,
  edge: "left" | "center" | "right" | "top" | "middle" | "bottom",
): void {
  assertControl(session, controlId);
  const els = selectedElements(session);
  if (!els.length) throw new Error("no element selected");
  assertUnlocked(els);
  pushUndo(session);
  const xs = els.map((e) => e.bounds[0]);
  const ys = els.map((e) => e.bounds[1]);
  const rs = els.map((e) => e.bounds[0] + e.bounds[2]);
  const bs = els.map((e) => e.bounds[1] + e.bounds[3]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...rs);
  const maxY = Math.max(...bs);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  for (const el of els) {
    const [x, y, w, h] = el.bounds;
    if (edge === "left") el.bounds = [minX, y, w, h];
    else if (edge === "right") el.bounds = [maxX - w, y, w, h];
    else if (edge === "center") el.bounds = [midX - w / 2, y, w, h];
    else if (edge === "top") el.bounds = [x, minY, w, h];
    else if (edge === "bottom") el.bounds = [x, maxY - h, w, h];
    else el.bounds = [x, midY - h / 2, w, h];
  }
}

export function distributeSelected(session: CanvasSession, controlId: string, axis: "h" | "v"): void {
  assertControl(session, controlId);
  const els = [...selectedElements(session)];
  if (els.length < 3) throw new Error("distribute needs 3+ elements");
  assertUnlocked(els);
  pushUndo(session);
  if (axis === "h") {
    els.sort((a, b) => a.bounds[0] - b.bounds[0]);
    const first = els[0]!;
    const last = els[els.length - 1]!;
    const span = last.bounds[0] + last.bounds[2] - first.bounds[0];
    const used = els.reduce((s, e) => s + e.bounds[2], 0);
    const gap = (span - used) / (els.length - 1);
    let x = first.bounds[0];
    for (const el of els) {
      el.bounds = [x, el.bounds[1], el.bounds[2], el.bounds[3]];
      x += el.bounds[2] + gap;
    }
  } else {
    els.sort((a, b) => a.bounds[1] - b.bounds[1]);
    const first = els[0]!;
    const last = els[els.length - 1]!;
    const span = last.bounds[1] + last.bounds[3] - first.bounds[1];
    const used = els.reduce((s, e) => s + e.bounds[3], 0);
    const gap = (span - used) / (els.length - 1);
    let y = first.bounds[1];
    for (const el of els) {
      el.bounds = [el.bounds[0], y, el.bounds[2], el.bounds[3]];
      y += el.bounds[3] + gap;
    }
  }
}

export function flipSelected(session: CanvasSession, controlId: string, axis: "h" | "v"): void {
  assertControl(session, controlId);
  const els = selectedElements(session);
  if (!els.length) throw new Error("no element selected");
  assertUnlocked(els);
  pushUndo(session);
  for (const el of els) {
    const rec = el as { flipH?: boolean; flipV?: boolean };
    if (axis === "h") rec.flipH = !rec.flipH;
    else rec.flipV = !rec.flipV;
  }
}

export function setSelectedRotation(session: CanvasSession, controlId: string, degrees: number): void {
  assertControl(session, controlId);
  if (typeof degrees !== "number" || !Number.isFinite(degrees)) {
    throw new Error("rotation degrees must be a finite number");
  }
  const els = selectedElements(session);
  if (!els.length) throw new Error("no element selected");
  assertUnlocked(els);
  pushUndo(session);
  for (const el of els) el.rotation = ((degrees % 360) + 360) % 360;
}

export function setSelectedOpacity(session: CanvasSession, controlId: string, opacity: number): void {
  assertControl(session, controlId);
  if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
    throw new Error("opacity must be a finite number");
  }
  const els = selectedElements(session);
  if (!els.length) throw new Error("no element selected");
  assertUnlocked(els);
  pushUndo(session);
  const o = Math.min(1, Math.max(0, opacity));
  for (const el of els) el.opacity = o;
}

export type TextStylePatch = Omit<Partial<TextElement["content"]>, "list" | "href"> & {
  list?: TextElement["content"]["list"] | null;
  href?: string | null;
};

const SAFE_TEXT_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function assertSafeTextHref(href: unknown): void {
  if (href === null || href === undefined) return;
  if (typeof href !== "string") throw new Error("text link href must be a string or null");
  const value = href.trim();
  if (!value) return;
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("text link href contains unsafe control characters");
  }
  let protocol: string;
  try {
    protocol = new URL(value, "https://slidestudio.invalid/").protocol.toLowerCase();
  } catch {
    throw new Error("text link href is malformed");
  }
  if (!SAFE_TEXT_LINK_PROTOCOLS.has(protocol)) {
    throw new Error(`unsafe text link protocol: ${protocol}`);
  }
}

export function setSelectedTextStyle(session: CanvasSession, controlId: string, patch: TextStylePatch): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "text") throw new Error("selected element is not text");
  if (Object.prototype.hasOwnProperty.call(patch, "href")) assertSafeTextHref(patch.href);
  const issues = canonicalTextStylePatchIssues(patch);
  if (issues.length) throw new Error(`invalid text style patch: ${issues.join("; ")}`);
  assertWritableColor(patch.color, session.project.presentation.theme);
  assertWritableColor(patch.backgroundColor, session.project.presentation.theme);
  pushUndo(session);
  const content = (el as TextElement).content as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete content[key];
    else content[key] = value;
  }
}

export function setSelectedFill(session: CanvasSession, controlId: string, colorOrFill: string | Fill): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  const fill: Fill = typeof colorOrFill === "string" ? { type: "solid", color: colorOrFill } : colorOrFill;
  const fillIssues = canonicalFillIssues(fill);
  if (fillIssues.length) throw new Error(`invalid fill: ${fillIssues.join("; ")}`);
  assertWritableFill(fill, session.project.presentation.theme);
  pushUndo(session);
  if (el.elementType === "shape") (el as ShapeElement).fill = fill;
  else if (el.elementType === "icon") (el as IconElement).fill = fill;
  else throw new Error("selected element has no fill");
}

export function setSelectedShapeName(session: CanvasSession, controlId: string, shapeName: string): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "shape") throw new Error("selected element is not shape");
  assertShapeKind(el as ShapeElement, shapeName);
  pushUndo(session);
  applyShapeKind(el as ShapeElement, shapeName);
}

export function setSelectedAdjustments(session: CanvasSession, controlId: string, adjustments: number[]): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "shape") throw new Error("selected element is not shape");
  pushUndo(session);
  (el as ShapeElement).adjustments = adjustments;
}

export function setSelectedBorder(
  session: CanvasSession,
  controlId: string,
  border: { style?: string; width?: number; color?: string },
): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "shape" && el.elementType !== "line") {
    throw new Error("selected element has no border");
  }
  assertWritableColor(border.color, session.project.presentation.theme);
  pushUndo(session);
  const cur = (el as ShapeElement | LineElement).border ?? {};
  (el as ShapeElement | LineElement).border = { ...cur, ...border };
}

export function setImageSrc(session: CanvasSession, controlId: string, src: string): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "image") throw new Error("selected element is not image");
  pushUndo(session);
  (el as ImageElement).src = src;
}

export function setIconName(session: CanvasSession, controlId: string, iconName: string): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "icon") throw new Error("selected element is not icon");
  pushUndo(session);
  (el as IconElement).iconName = iconName;
}

export function setLineArrow(
  session: CanvasSession,
  controlId: string,
  arrow: [ArrowType | null, ArrowType | null],
): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "line") throw new Error("selected element is not line");
  pushUndo(session);
  (el as LineElement).arrow = arrow;
}

export function setImageCrop(session: CanvasSession, controlId: string, crop: ImageCrop): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "image") throw new Error("selected element is not image");
  pushUndo(session);
  (el as ImageElement).crop = crop;
}

export function setImageCropShape(session: CanvasSession, controlId: string, cropShape: ShapeDef | undefined): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "image") throw new Error("selected element is not image");
  pushUndo(session);
  (el as ImageElement).cropShape = cropShape;
}

export function setLineCurve(session: CanvasSession, controlId: string, curve: "sharp" | "round" | "smooth"): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "line") throw new Error("selected element is not line");
  pushUndo(session);
  (el as LineElement).curve = curve;
}

/** AC-07: SmartArt edge label (frame 14 italic captions). */
export function setLineLabel(session: CanvasSession, controlId: string, label: string | null): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "line") throw new Error("selected element is not line");
  pushUndo(session);
  if (label) (el as LineElement).label = label;
  else delete (el as LineElement).label;
}

export function setLinePoints(session: CanvasSession, controlId: string, points: string): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "line") throw new Error("selected element is not line");
  pushUndo(session);
  (el as LineElement).points = points;
}

export function setImageFit(session: CanvasSession, controlId: string, mode: "fill" | "contain" | "cover"): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "image") throw new Error("selected element is not image");
  pushUndo(session);
  (el as ImageElement).fit = { mode };
}

export function setTableCellText(
  session: CanvasSession,
  controlId: string,
  row: number,
  col: number,
  text: string,
): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "table") throw new Error("selected element is not table");
  const table = el as TableElement;
  const cell = table.rows[row]?.[col];
  if (!cell) throw new Error(`no cell ${row},${col}`);
  pushUndo(session);
  cell.text = text;
}

export function setTableCellAlign(
  session: CanvasSession,
  controlId: string,
  row: number,
  col: number,
  align: [string, string],
): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "table") throw new Error("selected element is not table");
  const cell = (el as TableElement).rows[row]?.[col];
  if (!cell) throw new Error(`no cell ${row},${col}`);
  pushUndo(session);
  cell.align = align;
}

export function addTableRow(session: CanvasSession, controlId: string, after = -1): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "table") throw new Error("selected element is not table");
  const table = el as TableElement;
  const cols = table.rows[0]?.length ?? 1;
  const at = after >= 0 && after < table.rows.length ? after + 1 : table.rows.length;
  pushUndo(session);
  // A row inserted inside a merged region extends the covering span.
  for (let r = 0; r < table.rows.length; r += 1) {
    for (const cell of table.rows[r] ?? []) {
      const rs = Math.max(1, Number(cell?.rowSpan) || 1);
      if (rs > 1 && r < at && r + rs - 1 >= at) cell.rowSpan = rs + 1;
    }
  }
  const row = Array.from({ length: cols }, () => ({ text: "" }));
  table.rows.splice(at, 0, row);
  if (Array.isArray(table.rowHeights) && table.rowHeights.length) {
    const h = table.rowHeights[Math.max(0, Math.min(at - 1, table.rowHeights.length - 1))] ?? 1;
    table.rowHeights.splice(Math.min(at, table.rowHeights.length), 0, h);
  }
}

export function addTableCol(session: CanvasSession, controlId: string, after = -1): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "table") throw new Error("selected element is not table");
  pushUndo(session);
  const table = el as TableElement;
  const n = table.columnWidths.length;
  const idx = after >= 0 && after < n ? after + 1 : n;
  const nextW = 1 / (n + 1);
  table.columnWidths = table.columnWidths.map((w) => w * (n / (n + 1)));
  table.columnWidths.splice(idx, 0, nextW);
  for (const row of table.rows) {
    // A column inserted inside a merged region extends the covering span.
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (!cell) continue;
      const cs = Math.max(1, Number(cell.colSpan) || 1);
      if (cs > 1 && c < idx && c + cs - 1 >= idx) cell.colSpan = cs + 1;
    }
    row.splice(idx, 0, { text: "" });
  }
}

export function deleteTableRow(session: CanvasSession, controlId: string, row = -1): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "table") throw new Error("selected element is not table");
  const table = el as TableElement;
  if (table.rows.length <= 1) throw new Error("cannot delete the last row");
  const idx = row < 0 ? table.rows.length - 1 : row;
  if (idx >= table.rows.length) throw new Error(`no row ${idx}`);
  pushUndo(session);
  // Shrink spans covering idx; a span ORIGINATING at idx re-anchors to the
  // row below so the merged region survives the deletion.
  for (let r = 0; r < table.rows.length; r += 1) {
    for (let c = 0; c < (table.rows[r]?.length ?? 0); c += 1) {
      const cell = table.rows[r]![c]!;
      const rs = Math.max(1, Number(cell.rowSpan) || 1);
      if (rs <= 1) continue;
      if (r === idx) {
        const below = table.rows[idx + 1]?.[c];
        if (below) {
          below.rowSpan = rs - 1;
          if (cell.colSpan) below.colSpan = cell.colSpan;
          if (cell.text && !below.text) below.text = cell.text;
        }
        delete cell.rowSpan;
        delete cell.colSpan;
      } else if (r < idx && r + rs - 1 >= idx) {
        cell.rowSpan = rs - 1;
      }
    }
  }
  table.rows.splice(idx, 1);
  if (Array.isArray(table.rowHeights) && idx < table.rowHeights.length) {
    table.rowHeights.splice(idx, 1);
  }
}

export function deleteTableCol(session: CanvasSession, controlId: string, col = -1): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "table") throw new Error("selected element is not table");
  const table = el as TableElement;
  const n = table.rows[0]?.length ?? 0;
  if (n <= 1) throw new Error("cannot delete the last column");
  const idx = col < 0 ? n - 1 : col;
  if (idx >= n) throw new Error(`no column ${idx}`);
  pushUndo(session);
  for (const row of table.rows) {
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c]!;
      const cs = Math.max(1, Number(cell.colSpan) || 1);
      if (cs <= 1) continue;
      if (c === idx) {
        const right = row[idx + 1];
        if (right) {
          right.colSpan = cs - 1;
          if (cell.rowSpan) right.rowSpan = cell.rowSpan;
          if (cell.text && !right.text) right.text = cell.text;
        }
        delete cell.colSpan;
        delete cell.rowSpan;
      } else if (c < idx && c + cs - 1 >= idx) {
        cell.colSpan = cs - 1;
      }
    }
    row.splice(idx, 1);
  }
  table.columnWidths.splice(idx, 1);
  const sum = table.columnWidths.reduce((a, b) => a + b, 0) || 1;
  table.columnWidths = table.columnWidths.map((w) => w / sum);
}

export function mergeTableCells(
  session: CanvasSession,
  controlId: string,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "table") throw new Error("selected element is not table");
  const table = el as TableElement;
  const top = Math.min(r1, r2);
  const left = Math.min(c1, c2);
  const bottom = Math.max(r1, r2);
  const right = Math.max(c1, c2);
  const cell = table.rows[top]?.[left];
  if (!cell) throw new Error("merge origin missing");
  if (!table.rows[bottom]?.[right]) throw new Error("merge range is outside the table");
  if (top === bottom && left === right) throw new Error("merge needs at least two cells");

  const containedOrigins: { row: number; col: number }[] = [];
  for (let row = 0; row < table.rows.length; row += 1) {
    for (let col = 0; col < (table.rows[row]?.length ?? 0); col += 1) {
      const existing = table.rows[row]![col]!;
      const rowSpan = Math.max(1, Number(existing.rowSpan) || 1);
      const colSpan = Math.max(1, Number(existing.colSpan) || 1);
      if (rowSpan === 1 && colSpan === 1) continue;
      const existingBottom = row + rowSpan - 1;
      const existingRight = col + colSpan - 1;
      const intersects =
        Math.max(top, row) <= Math.min(bottom, existingBottom) && Math.max(left, col) <= Math.min(right, existingRight);
      if (!intersects) continue;
      const fullyContained = row >= top && col >= left && existingBottom <= bottom && existingRight <= right;
      if (!fullyContained) {
        throw new Error(`merge range partially overlaps merged cell ${row},${col}`);
      }
      containedOrigins.push({ row, col });
    }
  }

  pushUndo(session);
  for (const origin of containedOrigins) {
    const existing = table.rows[origin.row]![origin.col]!;
    delete existing.rowSpan;
    delete existing.colSpan;
  }
  cell.rowSpan = bottom - top + 1;
  cell.colSpan = right - left + 1;
}

export function setTableCellFill(
  session: CanvasSession,
  controlId: string,
  row: number,
  col: number,
  color: string,
): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "table") throw new Error("selected element is not table");
  const cell = (el as TableElement).rows[row]?.[col];
  if (!cell) throw new Error(`no cell ${row},${col}`);
  assertWritableColor(color, session.project.presentation.theme);
  pushUndo(session);
  cell.fill = { type: "solid", color };
}

export function setChartData(session: CanvasSession, controlId: string, data: ChartElement["data"]): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "chart") throw new Error("selected element is not chart");
  pushUndo(session);
  (el as ChartElement).data = data;
}

export function setChartType(session: CanvasSession, controlId: string, type: string): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "chart") throw new Error("selected element is not chart");
  pushUndo(session);
  const chart = el as ChartElement;
  if (!chart.series[0]) chart.series = [{ type, name: "数值" }];
  else chart.series[0].type = type;
}

export function setChartTitle(session: CanvasSession, controlId: string, title: string): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "chart") throw new Error("selected element is not chart");
  pushUndo(session);
  (el as ChartElement).title = title;
}

export function setChartLegend(session: CanvasSession, controlId: string, legend: boolean): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "chart") throw new Error("selected element is not chart");
  pushUndo(session);
  const current = (el as ChartElement).legend;
  // Preserve an authored legend position: only flip `show`.
  (el as ChartElement).legend =
    current && typeof current === "object" ? { ...(current as Record<string, unknown>), show: legend } : legend;
}

export function setChartSeriesFill(session: CanvasSession, controlId: string, index: number, color: string): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "chart") throw new Error("selected element is not chart");
  const chart = el as ChartElement;
  const pie = (chart.series[0]?.type ?? "bar").toLowerCase() === "pie";
  // Bounds-checked: an out-of-range index would leave a sparse array on disk.
  const count = pie ? chart.data.rows.length : chart.series.length;
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`chart series index out of range: ${index} (have ${count})`);
  }
  assertWritableColor(color, session.project.presentation.theme);
  pushUndo(session);
  if (pie) {
    const colors = chart.colors ? [...chart.colors] : Array.from({ length: count }, () => "#2563EB");
    while (colors.length < count) colors.push("#2563EB");
    colors[index] = color;
    chart.colors = colors;
    return;
  }
  chart.series[index]!.fill = color;
}

export function setChartLabels(session: CanvasSession, controlId: string, labels: boolean): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "chart") throw new Error("selected element is not chart");
  pushUndo(session);
  (el as ChartElement).labels = labels;
}

export function setChartAxis(
  session: CanvasSession,
  controlId: string,
  axis: { x?: string; y?: string; secondaryY?: string },
): void {
  assertControl(session, controlId);
  const el = mutableElement(session);
  if (el.elementType !== "chart") throw new Error("selected element is not chart");
  pushUndo(session);
  const chart = el as ChartElement;
  chart.axis = { ...(chart.axis ?? {}), ...axis };
}

export function setPageBackground(session: CanvasSession, controlId: string, colorOrFill: string | Fill): void {
  assertControl(session, controlId);
  const fill: Fill = typeof colorOrFill === "string" ? { type: "solid", color: colorOrFill } : colorOrFill;
  assertWritableFill(fill, session.project.presentation.theme);
  pushUndo(session);
  // A page's background becomes its own, so a later layout refresh does not overwrite it.
  if (session.surface.kind === "page") setOwnPageBackground(currentPage(session), fill);
  else currentPage(session).background = fill;
}

export function setThemeColor(session: CanvasSession, controlId: string, key: string, color: string): void {
  assertControl(session, controlId);
  const token = key.replace(/^\$/, "").trim();
  if (!token) throw new Error("theme color key required");
  assertWritableThemeColor(token, color);
  pushUndo(session);
  const theme = session.project.presentation.theme ?? (session.project.presentation.theme = {});
  theme.colors = { ...(theme.colors ?? {}), [token]: color };
}

export function setPageNotes(session: CanvasSession, controlId: string, notes: string): void {
  setPageNotesAt(session, controlId, session.pageIndex, notes);
}

export function setPageNotesAt(session: CanvasSession, controlId: string, pageIndex: number, notes: string): void {
  assertControl(session, controlId);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= session.project.pages.length) {
    throw new Error(`page index out of range: ${pageIndex}`);
  }
  assertPageSurface(session, "编辑备注");
  pushUndo(session);
  session.project.pages[pageIndex]!.page.notes = notes;
}

export function setElementAnimation(session: CanvasSession, controlId: string, kind: string): void {
  assertControl(session, controlId);
  assertPageSurface(session, "设置动画");
  const el = mutableElement(session);
  pushUndo(session);
  const page = currentPage(session);
  const list = Array.isArray(page.animations) ? [...page.animations] : [];
  const next = list.filter((a) => {
    const rec = a as { elementId?: string };
    return rec.elementId !== el.elementId;
  });
  if (kind && kind !== "none") {
    const rec: Animation = {
      elementId: el.elementId,
      effect: kind === "fade" ? "fade-in" : kind,
      trigger: "onClick",
    };
    next.push(rec);
  }
  page.animations = next;
}

export function setPageAnimations(session: CanvasSession, controlId: string, animations: Animation[]): void {
  assertControl(session, controlId);
  assertPageSurface(session, "设置动画");
  pushUndo(session);
  currentPage(session).animations = animations;
}

const REFINE_COLORS: Record<string, string> = {
  红: "#DC2626",
  蓝: "#2563EB",
  绿: "#059669",
  橙: "#F59E0B",
  黑: "#111111",
  白: "#FFFFFF",
  紫: "#7C3AED",
  黄: "#EAB308",
};

function largestText(session: CanvasSession): TextElement | undefined {
  const page = currentPage(session);
  if (session.selection.kind === "element") {
    const sid = session.selection.elementId;
    const hit = page.elements.find((e) => e.elementId === sid);
    if (hit?.elementType === "text") return hit as TextElement;
  }
  const texts = page.elements.filter((e) => e.elementType === "text") as TextElement[];
  return texts.sort((a, b) => b.bounds[2] * b.bounds[3] - a.bounds[2] * a.bounds[3])[0];
}

/** Deterministic NL refine on the current page. Writes PPTD fields, not notes-only. */
export function applyNaturalRefine(
  session: CanvasSession,
  controlId: string,
  instruction: string,
): { applied: string[] } {
  assertControl(session, controlId);
  const text = instruction.trim();
  if (!text) throw new Error("empty refine");
  pushUndo(session);
  const applied: string[] = [];
  const page = currentPage(session);

  const swap = text.match(/把[「"'“]?(.+?)[」"'”]?改[成为][「"'“]?(.+?)[」"'”]?\s*$/);
  if (swap) {
    const from = swap[1]!;
    const to = swap[2]!;
    for (const el of page.elements) {
      if (el.elementType !== "text") continue;
      const rec = el as TextElement;
      if (rec.content.text.includes(from)) {
        rec.content.text = rec.content.text.split(from).join(to);
        applied.push(`replace:${from}→${to}`);
      }
    }
  }

  const title = text.match(/标题.{0,8}(?:改成|改为|设为)[「"'“]?(.+?)[」"'”]?\s*$/);
  if (title) {
    const rec = largestText(session);
    if (rec) {
      rec.content.text = title[1]!;
      applied.push("set-title");
    }
  }

  for (const [name, hex] of Object.entries(REFINE_COLORS)) {
    if (text.includes("背景") && text.includes(name)) {
      page.background = { type: "solid", color: hex };
      applied.push(`background:${name}`);
    }
    if (
      !text.includes("背景") &&
      (text.includes("字") || text.includes("文字") || text.includes("标题")) &&
      text.includes(name)
    ) {
      const rec = largestText(session);
      if (rec) {
        rec.content.color = hex;
        applied.push(`text-color:${name}`);
      }
    }
    if ((text.includes("填充") || text.includes("形状")) && text.includes(name)) {
      const sid = session.selection.kind === "element" ? session.selection.elementId : "";
      const sel = sid
        ? page.elements.find((e) => e.elementId === sid)
        : page.elements.find((e) => e.elementType === "shape");
      if (sel && (sel.elementType === "shape" || sel.elementType === "icon")) {
        (sel as ShapeElement).fill = { type: "solid", color: hex };
        applied.push(`fill:${name}`);
      }
    }
  }

  if (/加粗/.test(text)) {
    const rec = largestText(session);
    if (rec) {
      rec.content.bold = true;
      applied.push("bold");
    }
  }

  const scale = /放大/.test(text) ? 1.12 : /缩小/.test(text) ? 0.88 : 0;
  if (scale) {
    const id = session.selection.kind === "element" ? session.selection.elementId : largestText(session)?.elementId;
    const el = page.elements.find((e) => e.elementId === id);
    if (el) {
      el.bounds = [
        el.bounds[0],
        el.bounds[1],
        Math.max(24, Math.round(el.bounds[2] * scale)),
        Math.max(16, Math.round(el.bounds[3] * scale)),
      ];
      if (el.elementType === "text") {
        const rec = el as TextElement;
        rec.content.fontSize = Math.max(10, Math.round((rec.content.fontSize ?? 18) * scale));
      }
      applied.push(scale > 1 ? "scale-up" : "scale-down");
    }
  }

  if (/淡入|飞入/.test(text)) {
    const id = session.selection.kind === "element" ? session.selection.elementId : largestText(session)?.elementId;
    if (id) {
      const list = Array.isArray(page.animations) ? page.animations.filter((a) => a.elementId !== id) : [];
      list.push({
        elementId: id,
        effect: /飞入/.test(text) ? "fly-in" : "fade-in",
        trigger: "onClick",
      });
      page.animations = list;
      applied.push(/飞入/.test(text) ? "fly-in" : "fade-in");
    }
  }

  if (applied.length === 0) {
    const rec = largestText(session);
    if (rec && text.length <= 80) {
      rec.content.text = text;
      applied.push("set-text");
    } else if (rec) {
      rec.content.text = `${rec.content.text}\n${text}`;
      applied.push("append-text");
    }
  }
  if (applied.length === 0) throw new Error("refine did not match a page edit");
  return { applied };
}
