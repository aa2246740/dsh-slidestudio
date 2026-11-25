import crypto from "node:crypto";
import { PptdError } from "./errors.js";
import type {
  DeckLayout,
  DeckMaster,
  Fill,
  InheritedFrom,
  Page,
  PptdElement,
  PptdProject,
  Presentation,
} from "./types.js";

/**
 * Materialised inheritance. A page that uses a layout keeps read-only copies of the master and
 * layout elements in its own file, so every reader sees the page as drawn. `saveProject` is the
 * only writer and refreshes the copies from the layout, which stays the single source (ADR-0006).
 */

/** The layout a page uses. Undefined when the page has none, or when its id is dangling. */
function layoutOf(presentation: Presentation, page: Page): DeckLayout | undefined {
  if (page.layoutId === undefined) return undefined;
  return presentation.layouts?.find((layout) => layout.id === page.layoutId);
}

/** The master a layout names. Undefined when it names none, or when that master is missing. */
function masterOf(presentation: Presentation, layout: DeckLayout): DeckMaster | undefined {
  if (layout.masterId === undefined) return undefined;
  return presentation.masters?.find((master) => master.id === layout.masterId);
}

/** A copy of a definition element under a new id. The copy never aliases its source. */
function copyOf(source: PptdElement, elementId: string, inherited: InheritedFrom): PptdElement {
  const body: Record<string, unknown> = { ...structuredClone(source) };
  delete body.elementId;
  delete body.inherited;
  const copy: Record<string, unknown> = { elementId, inherited, ...body };
  return copy as PptdElement;
}

/** Master copies come first. They are hidden when the layout sets showMasterElements to false. */
function masterCopies(master: DeckMaster | undefined, layout: DeckLayout): PptdElement[] {
  if (!master || layout.showMasterElements === false) return [];
  return master.elements.map((element) =>
    copyOf(element, `mst-${master.id}-${element.elementId}`, {
      scope: "master",
      ownerId: master.id,
      elementId: element.elementId,
    }),
  );
}

function layoutCopies(layout: DeckLayout): PptdElement[] {
  return layout.elements.map((element) =>
    copyOf(element, `lyt-${layout.id}-${element.elementId}`, {
      scope: "layout",
      ownerId: layout.id,
      elementId: element.elementId,
    }),
  );
}

/** Every copy a page with this layout carries, in draw order: master, then layout. */
function chromeCopies(presentation: Presentation, layout: DeckLayout): PptdElement[] {
  return [...masterCopies(masterOf(presentation, layout), layout), ...layoutCopies(layout)];
}

/** The page's own elements: everything that is not a materialised copy. */
function ownElements(page: Page): PptdElement[] {
  return page.elements.filter((element) => element.inherited === undefined);
}

/** The background a page sets itself. A background that came from a layout or master is not its own. */
function ownBackground(page: Page): Fill | undefined {
  return page.backgroundInherited === true ? undefined : page.background;
}

/** The background a page takes when it sets none: the layout's, then the master's. White otherwise. */
export function inheritedBackground(presentation: Presentation, layout: DeckLayout): Fill | undefined {
  return layout.background ?? masterOf(presentation, layout)?.background;
}

function materializePage(presentation: Presentation, page: Page): void {
  const layout = layoutOf(presentation, page);
  page.elements = [...(layout ? chromeCopies(presentation, layout) : []), ...ownElements(page)];
  if (ownBackground(page)) return;
  const inherited = layout ? inheritedBackground(presentation, layout) : undefined;
  if (inherited) {
    page.background = inherited;
    page.backgroundInherited = true;
  } else {
    delete page.background;
    delete page.backgroundInherited;
  }
}

function carriesInheritance(page: Page): boolean {
  return (
    page.layoutId !== undefined ||
    page.backgroundInherited !== undefined ||
    page.elements.some((element) => element.inherited !== undefined)
  );
}

/**
 * Refreshes every page's copies and inherited background from its layout, in place, and returns
 * the same project. A deck with no masters, no layouts and no inherited marks is left alone, so
 * decks that predate layouts keep their exact bytes.
 */
export function materializeInheritance(project: PptdProject): PptdProject {
  const { presentation, pages } = project;
  const hasLayoutParts = (presentation.masters?.length ?? 0) > 0 || (presentation.layouts?.length ?? 0) > 0;
  if (!hasLayoutParts && !pages.some(({ page }) => carriesInheritance(page))) return project;
  for (const { page } of pages) materializePage(presentation, page);
  return project;
}

/** JSON with sorted object keys, so equal content always produces the same hash. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/**
 * The page's own content, with copies and the inherited background removed. Hash this for the
 * page's revision identity, so a layout edit does not make every using page a new revision.
 */
export function ownPageBody(page: Page): Page {
  const own: Page = { ...page, elements: ownElements(page) };
  if (page.backgroundInherited === true) {
    delete own.background;
    delete own.backgroundInherited;
  }
  return own;
}

/**
 * Fingerprint of the chrome a page shows: its master and layout copies, the background they
 * supply when the page sets none, and the page's position. Any change to them makes the page's
 * last render stale. "none" marks a page without a usable layout.
 */
export function chromeSha256(project: PptdProject, page: Page): string {
  const layout = layoutOf(project.presentation, page);
  if (!layout) return "none";
  const index = project.pages.findIndex((entry) => entry.page === page);
  if (index < 0) throw new PptdError("这一页不在项目的页面列表里，无法计算版式指纹");
  const chrome = {
    copies: chromeCopies(project.presentation, layout),
    background: ownBackground(page) ? undefined : inheritedBackground(project.presentation, layout),
    pageNumber: index + 1,
    pageCount: project.pages.length,
  };
  return crypto.createHash("sha256").update(canonicalJson(chrome)).digest("hex");
}

/** Makes a background the page's own. From then on it no longer follows its layout or master. */
export function setOwnPageBackground(page: Page, background: Fill): void {
  page.background = background;
  delete page.backgroundInherited;
}
