/**
 * Undo and redo over whole-session snapshots. A snapshot carries the surface and the layout or
 * master it named, so undo can tell which layout a change belonged to (the editor's hint).
 */
import type { PptdElement, PptdProject } from "@open-slidestudio/pptd-v2";
import {
  assertControl,
  clampPageIndex,
  surfaceBody,
  type CanvasSession,
  type EditSurface,
  type LayoutEditMark,
  type Selection,
  type UndoEntry,
} from "./session-model.js";

export type { LayoutEditMark } from "./session-model.js";

type CanvasSessionSnapshot = {
  rootDir: string;
  manifestPath: string;
  presentation: PptdProject["presentation"];
  pages: PptdProject["pages"];
  pageIndex?: number;
  selection?: Selection;
  surface?: EditSurface;
};

const PAGE_SURFACE: EditSurface = { kind: "page" };

/** The layout or master the session is editing right now, or undefined on a page surface. */
export function layoutEditMark(session: CanvasSession): LayoutEditMark | undefined {
  const { surface, project } = session;
  if (surface.kind === "layout") {
    const layout = project.presentation.layouts?.find((item) => item.id === surface.layoutId);
    return layout ? { scope: "layout", id: layout.id, name: layout.name } : undefined;
  }
  if (surface.kind === "master") {
    const master = project.presentation.masters?.[0];
    return master ? { scope: "master", id: master.id, name: master.name } : undefined;
  }
  return undefined;
}

function cloneSession(session: CanvasSession): string {
  const { project } = session;
  const snapshot: CanvasSessionSnapshot = {
    rootDir: project.rootDir,
    manifestPath: project.manifestPath,
    presentation: project.presentation,
    pages: project.pages,
    pageIndex: session.pageIndex,
    selection: session.selection,
    surface: session.surface,
  };
  return JSON.stringify(snapshot);
}

/** The current state as one stack step. The mark is kept beside the snapshot, never parsed back out. */
function entryOf(session: CanvasSession): UndoEntry {
  return { snapshot: cloneSession(session), layoutEdit: layoutEditMark(session) };
}

function normalizedSelection(elements: PptdElement[] | undefined, pageIndex: number, selection: Selection): Selection {
  if (selection.kind === "none") return selection;
  if (selection.pageIndex !== pageIndex) return { kind: "none" };
  if (!elements) return { kind: "none" };
  if (selection.kind === "page") return selection;
  if (selection.kind === "element") {
    return elements.some((element) => element.elementId === selection.elementId) ? selection : { kind: "none" };
  }
  const ids = [...new Set(selection.elementIds)].filter((id) => elements.some((element) => element.elementId === id));
  if (ids.length === 0) return { kind: "none" };
  if (ids.length === 1) {
    return { kind: "element", pageIndex, elementId: ids[0]! };
  }
  return { kind: "multi", pageIndex, elementIds: ids };
}

/**
 * Undo and redo keep the surface the user is looking at, so a layout edit undone from page mode
 * does not switch the editor into the layout. A surface whose layout no longer exists falls back
 * to the page. The selection survives only when the snapshot was taken on the same surface.
 */
function restoreSession(session: CanvasSession, snap: string): void {
  const data = JSON.parse(snap) as CanvasSessionSnapshot;
  const sameSurface = JSON.stringify(data.surface ?? PAGE_SURFACE) === JSON.stringify(session.surface);
  session.project.presentation = data.presentation;
  session.project.pages = data.pages;
  session.pageIndex = clampPageIndex(data.pageIndex, data.pages.length);
  if (surfaceBody(session) === undefined) session.surface = PAGE_SURFACE;
  const body = surfaceBody(session);
  session.selection = sameSurface
    ? normalizedSelection(body?.elements, session.pageIndex, data.selection ?? { kind: "none" })
    : { kind: "none" };
}

export function pushUndo(session: CanvasSession): void {
  session.undoStack.push(entryOf(session));
  if (session.undoStack.length > 50) session.undoStack.shift();
  session.redoStack = [];
}

export function undo(session: CanvasSession, controlId = "chrome.history.undo"): boolean {
  assertControl(session, controlId);
  const entry = session.undoStack.pop();
  if (!entry) return false;
  session.redoStack.push(entryOf(session));
  restoreSession(session, entry.snapshot);
  return true;
}

export function redo(session: CanvasSession, controlId = "chrome.history.redo"): boolean {
  assertControl(session, controlId);
  const entry = session.redoStack.pop();
  if (!entry) return false;
  session.undoStack.push(entryOf(session));
  restoreSession(session, entry.snapshot);
  return true;
}

/** The layout or master the next undo would revert, read from the stack without parsing a snapshot. */
export function undoLayoutMark(session: CanvasSession): LayoutEditMark | undefined {
  return session.undoStack.at(-1)?.layoutEdit;
}
