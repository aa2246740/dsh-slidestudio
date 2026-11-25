/**
 * Session state shared by the canvas session and its read-only projections.
 * Kept free of editing commands so render modules can depend on it without a cycle.
 */
import type { Page, PptdElement, PptdProject } from "@open-slidestudio/pptd-v2";

export type Selection =
  | { kind: "none" }
  | { kind: "page"; pageIndex: number }
  | { kind: "element"; pageIndex: number; elementId: string }
  | { kind: "multi"; pageIndex: number; elementIds: string[] };

/**
 * What the editor is editing: a page (the default), one layout, or the deck master.
 * Layout and master edits change the definition, and every using page follows on save.
 */
export type EditSurface = { kind: "page" } | { kind: "layout"; layoutId: string } | { kind: "master" };

/** The layout or master a change belonged to, named as it was when the change was made. */
export type LayoutEditMark = { scope: "layout" | "master"; id: string; name: string };

/** One undo or redo step: the whole-session snapshot and the layout it changed, if any. */
export type UndoEntry = { snapshot: string; layoutEdit?: LayoutEditMark };

export type CanvasSession = {
  project: PptdProject;
  pageIndex: number;
  selection: Selection;
  /** Oracle-backed control ids that may be invoked (OOP-29/30). */
  allowedControlIds: Set<string>;
  /** JSON document + view snapshots for undo (max 50). */
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** S1 chrome — UI only, not PPTD. */
  zoomPercent: number;
  pageRailOpen: boolean;
  notesOpen: boolean;
  presenting: boolean;
  /** In-memory copy buffer (Cmd+C / Cmd+V). Not persisted. */
  clipboard: PptdElement[];
  /** Layout-mode navigation. Not persisted: a reload opens the page surface. */
  surface: EditSurface;
};

export function pageCount(session: CanvasSession): number {
  return session.project.pages.length;
}

/** Dead-button ban: a control runs only when the session allows its oracle id. */
export function assertControl(session: CanvasSession, controlId: string): void {
  if (!session.allowedControlIds.has(controlId)) {
    throw new Error(`control not allowed (dead-button ban / missing oracle row): ${controlId}`);
  }
}

export function clampPageIndex(index: number | undefined, count: number): number {
  if (index == null || !Number.isInteger(index) || count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * The element body the editor is changing. On a page surface this is the current page. On a
 * layout or master surface it is that definition, which has the same `elements` and `background`
 * fields, so element commands work unchanged. Undefined when the surface names no such body.
 */
export function surfaceBody(session: CanvasSession): Page | undefined {
  const { surface, project } = session;
  if (surface.kind === "master") return project.presentation.masters?.[0];
  if (surface.kind === "layout") {
    return project.presentation.layouts?.find((layout) => layout.id === surface.layoutId);
  }
  return project.pages[session.pageIndex]?.page;
}

export function currentPage(session: CanvasSession): Page {
  const body = surfaceBody(session);
  if (body) return body;
  if (session.surface.kind === "master") throw new Error("this deck has no master");
  if (session.surface.kind === "layout") {
    throw new Error(`layout not found: ${session.surface.layoutId}`);
  }
  const count = session.project.pages.length;
  throw new Error(
    count === 0
      ? "project has no pages — add a page first"
      : `no page at index ${session.pageIndex} (project has ${count} pages)`,
  );
}
