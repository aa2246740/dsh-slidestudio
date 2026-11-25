/**
 * Layout mode for the canvas session (masters-layouts design §5). A layout or the master is edited
 * as its own surface. Each layout command is one undo step, and pages that use the layout follow on
 * save, because `materializeInheritance` rebuilds their copies from the definition.
 */
import {
  MAX_LAYOUTS,
  inheritedBackground,
  materializeInheritance,
  type DeckLayout,
  type DeckMaster,
  type Page,
  type PptdElement,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import { pushUndo, undoLayoutMark, type LayoutEditMark } from "./undo-stack.js";
import { assertControl, currentPage, surfaceBody, type CanvasSession, type EditSurface } from "./session-model.js";

/** A layout or master as the layout panel lists it. */
export type LayoutPanelRow = { id: string; name: string; useCount: number };

export type LayoutPanel = {
  surface: EditSurface & { name?: string; useCount?: number };
  master?: { id: string; name: string };
  layouts: LayoutPanelRow[];
  /** The layout the current page uses. Undefined means 无版式. */
  pageLayoutId?: string;
  /** The layout or master the next undo would revert, so a page-mode undo can say which one. */
  undoMark?: LayoutEditMark;
};

/** Where a double-click on a copy leads: the layout or master it came from. */
export type LayoutTarget = { kind: "layout"; layoutId: string } | { kind: "master" };

const NAME_MAX = 24;
const NAME_FORBIDDEN = /[<>&"']/;

/** Chinese refusal for every layout command that needs a page surface. */
export function assertPageSurface(session: CanvasSession, action: string): void {
  if (session.surface.kind !== "page") {
    throw new Error(`请先点击「完成」退出版式编辑，再${action}`);
  }
}

/** Charts, tables and SmartArt cannot live on a layout or the master (`elements` = what is added). */
export function assertNoGraphicsOnLayout(session: CanvasSession, elements?: PptdElement[]): void {
  if (session.surface.kind === "page") return;
  const graphic =
    elements === undefined ||
    elements.some(
      (el) =>
        el.elementType === "chart" ||
        el.elementType === "table" ||
        (el as { smartArt?: unknown }).smartArt !== undefined,
    );
  if (graphic) throw new Error("版式里不能放图表、表格或 SmartArt");
}

function cleanLayoutName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("版式名称不能为空");
  if ([...trimmed].length > NAME_MAX) throw new Error(`版式名称最多 ${NAME_MAX} 个字`);
  if (NAME_FORBIDDEN.test(trimmed)) throw new Error("版式名称不能包含 < > & \" '");
  return trimmed;
}

function layouts(session: CanvasSession): DeckLayout[] {
  return session.project.presentation.layouts ?? [];
}

function layoutById(session: CanvasSession, layoutId: string): DeckLayout {
  const layout = layouts(session).find((item) => item.id === layoutId);
  if (!layout) throw new Error(`未找到版式：${layoutId}`);
  return layout;
}

function masterOf(session: CanvasSession): DeckMaster | undefined {
  return session.project.presentation.masters?.[0];
}

/** Pages whose layoutId names this layout. */
export function layoutUseCount(session: CanvasSession, layoutId: string): number {
  return session.project.pages.filter(({ page }) => page.layoutId === layoutId).length;
}

/** Makes the surface the editor's focus and selects `elementId` there when it exists. */
function switchSurface(session: CanvasSession, surface: EditSurface, elementId?: string): void {
  session.surface = surface;
  session.selection = { kind: "none" };
  if (elementId === undefined) return;
  const exists = surfaceBody(session)?.elements.some((el) => el.elementId === elementId);
  if (exists) session.selection = { kind: "element", pageIndex: session.pageIndex, elementId };
}

export function enterLayout(session: CanvasSession, controlId: string, layoutId: string, elementId?: string): void {
  assertControl(session, controlId);
  layoutById(session, layoutId);
  switchSurface(session, { kind: "layout", layoutId }, elementId);
}

export function enterMaster(session: CanvasSession, controlId: string, elementId?: string): void {
  assertControl(session, controlId);
  if (!masterOf(session)) throw new Error("this deck has no master");
  switchSurface(session, { kind: "master" }, elementId);
}

export function exitLayout(session: CanvasSession, controlId: string): void {
  assertControl(session, controlId);
  switchSurface(session, { kind: "page" });
}

/** The 母版/版式 list: switches to the chosen layout or the master. */
export function selectLayoutSurface(session: CanvasSession, controlId: string, target: LayoutTarget): void {
  if (target.kind === "master") enterMaster(session, controlId);
  else enterLayout(session, controlId, target.layoutId);
}

function freshLayoutId(used: DeckLayout[]): string {
  const ids = new Set(used.map((layout) => layout.id));
  for (let n = 2; n < 1000; n++) {
    const candidate = `layout-${n}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error("could not allocate a layout id");
}

function freshDefaultName(used: DeckLayout[]): string {
  const names = new Set(used.map((layout) => layout.name));
  for (let n = used.length + 1; n < 1000; n++) {
    const candidate = `新版式 ${n}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error("could not allocate a layout name");
}

/** Creates an empty layout that uses the deck master, and opens it for editing. */
export function createLayout(session: CanvasSession, controlId: string, name?: string): string {
  assertControl(session, controlId);
  const label = cleanLayoutName(name ?? freshDefaultName(layouts(session)));
  if (layouts(session).length >= MAX_LAYOUTS) {
    throw new Error(`一个文稿最多 ${MAX_LAYOUTS} 个版式`);
  }
  pushUndo(session);
  const master = masterOf(session);
  const id = freshLayoutId(layouts(session));
  const layout: DeckLayout = {
    id,
    name: label,
    ...(master ? { masterId: master.id } : {}),
    elements: [],
  };
  session.project.presentation.layouts = [...layouts(session), layout];
  switchSurface(session, { kind: "layout", layoutId: id });
  materializeInheritance(session.project);
  return id;
}

export function renameLayout(session: CanvasSession, controlId: string, layoutId: string, name: string): void {
  assertControl(session, controlId);
  const layout = layoutById(session, layoutId);
  const label = cleanLayoutName(name);
  if (label === layout.name) return;
  pushUndo(session);
  layout.name = label;
}

/**
 * Deletes a layout. A layout in use needs `confirmed`: its pages lose the layout's content and
 * keep their own. The editor asks first; the server refuses an unconfirmed delete as well.
 */
export function deleteLayout(session: CanvasSession, controlId: string, layoutId: string, confirmed = false): void {
  assertControl(session, controlId);
  const layout = layoutById(session, layoutId);
  const used = layoutUseCount(session, layoutId);
  if (used > 0 && !confirmed) {
    throw new Error(`版式『${layout.name}』正在使用，删除后 ${used} 页会失去版式内容，请确认后删除`);
  }
  pushUndo(session);
  const remaining = layouts(session).filter((item) => item.id !== layoutId);
  if (remaining.length > 0) session.project.presentation.layouts = remaining;
  else delete session.project.presentation.layouts;
  for (const { page } of session.project.pages) {
    if (page.layoutId === layoutId) delete page.layoutId;
    page.elements = page.elements.filter(
      (el) => !(el.inherited?.scope === "layout" && el.inherited.ownerId === layoutId),
    );
  }
  if (session.surface.kind === "layout" && session.surface.layoutId === layoutId) {
    switchSurface(session, { kind: "page" });
  }
  materializeInheritance(session.project);
}

/** The 版式 dropdown: `null` is 「无版式」, which removes the copies and keeps the page's own content. */
export function applyPageLayout(session: CanvasSession, controlId: string, layoutId: string | null): void {
  assertControl(session, controlId);
  assertPageSurface(session, "切换版式");
  if (layoutId !== null) layoutById(session, layoutId);
  const page = currentPage(session);
  if ((page.layoutId ?? null) === layoutId) return;
  pushUndo(session);
  if (layoutId === null) delete page.layoutId;
  else page.layoutId = layoutId;
  materializeInheritance(session.project);
}

/** Inserts a text box that shows the page number: the page's own number, or ‹#› on a layout. */
export function insertPageNumber(session: CanvasSession, controlId: string): string {
  assertControl(session, controlId);
  const body = currentPage(session);
  pushUndo(session);
  const used = new Set(body.elements.map((el) => el.elementId));
  let n = 1;
  while (used.has(`pagenumber-${n}`)) n++;
  const id = `pagenumber-${n}`;
  const el: TextElement = {
    elementId: id,
    elementType: "text",
    bounds: [880, 506, 60, 22],
    content: { text: "{page}", field: "pageNumber", fontSize: 10 },
  };
  body.elements.push(el);
  session.selection = { kind: "element", pageIndex: session.pageIndex, elementId: id };
  return id;
}

/**
 * The body a surface paints. A layout with no background of its own shows the one its pages take
 * (the master's, else white), so it is edited on the colour they show. The layout is not changed.
 */
export function paintedBody(session: CanvasSession): Page {
  const body = currentPage(session);
  if (session.surface.kind !== "layout" || body.background) return body;
  const layout = layoutById(session, session.surface.layoutId);
  const background = inheritedBackground(session.project.presentation, layout);
  return background ? { ...body, background } : body;
}

/**
 * Copies of the master's elements on a layout surface, drawn beneath the layout. They are
 * view-only: they are never stored, and they carry the same copy marker as on a page.
 */
export function layoutViewCopies(session: CanvasSession): PptdElement[] {
  if (session.surface.kind !== "layout") return [];
  const layout = layoutById(session, session.surface.layoutId);
  const master = layout.masterId ? masterOf(session) : undefined;
  if (!master || master.id !== layout.masterId || layout.showMasterElements === false) return [];
  return master.elements.map((el) => ({
    ...structuredClone(el),
    elementId: `mst-${master.id}-${el.elementId}`,
    inherited: { scope: "master", ownerId: master.id, elementId: el.elementId },
  }));
}

/** The layout panel the editor lists: the master, each layout with its use count, and the page's layout. */
export function layoutPanel(session: CanvasSession): LayoutPanel {
  const rows = layouts(session).map((layout) => ({
    id: layout.id,
    name: layout.name,
    useCount: layoutUseCount(session, layout.id),
  }));
  const master = masterOf(session);
  const { surface } = session;
  let current: LayoutPanel["surface"] = { kind: "page" };
  if (surface.kind === "layout") {
    const row = rows.find((item) => item.id === surface.layoutId);
    current = {
      kind: "layout",
      layoutId: surface.layoutId,
      name: row?.name,
      useCount: row?.useCount,
    };
  } else if (surface.kind === "master" && master) {
    current = { kind: "master", name: master.name };
  }
  const pageLayoutId = session.project.pages[session.pageIndex]?.page.layoutId;
  const undoMark = undoLayoutMark(session);
  return {
    surface: current,
    ...(master ? { master: { id: master.id, name: master.name } } : {}),
    layouts: rows,
    ...(pageLayoutId !== undefined ? { pageLayoutId } : {}),
    ...(undoMark ? { undoMark } : {}),
  };
}
