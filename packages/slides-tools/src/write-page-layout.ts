/**
 * Layout rules for write_page, read_page and edit_elements (masters-layouts §3.20). A page saved with
 * a layout carries read-only copies of the master and layout elements, and read_page reports them as
 * a summary. None of that is written back: the Host strips the copies and the echoed summary before
 * validation, and drops own elements that copy the page's own layout. Other reserved ids are refused
 * by the domain.
 */
import { loadProject, type Page, type PptdElement, type Presentation } from "@open-slidestudio/pptd-v2";

type Json = Record<string, unknown>;

function isCopy(element: unknown): boolean {
  return typeof element === "object" && element !== null && (element as { inherited?: unknown }).inherited != null;
}

/** Removes materialised copies and the read-only inheritedSummary echo from write_page arguments. */
export function withoutLayoutCopies(args: Json): Json {
  const next: Json = { ...args };
  delete next.inheritedSummary;
  if (Array.isArray(next.elements)) {
    next.elements = next.elements.filter((element) => !isCopy(element));
  }
  return next;
}

/** Copy-id prefixes of the page's own layout: its layout copies and the master copies it shows. */
function ownCopyPrefixes(presentation: Presentation, layoutId: string): string[] {
  const layout = presentation.layouts?.find((item) => item.id === layoutId);
  if (!layout) return [];
  const master =
    layout.masterId === undefined ? undefined : presentation.masters?.find((item) => item.id === layout.masterId);
  const prefixes = [`lyt-${layout.id}-`];
  if (master && layout.showMasterElements !== false) prefixes.push(`mst-${master.id}-`);
  return prefixes;
}

/**
 * Drops own elements whose ids are copy ids of the page's own layout. An echoed copy without its
 * `inherited` mark is not refused: the page inherits those elements anyway.
 */
export function dropOwnLayoutCopyIds(projectRoot: string, args: Json): void {
  const layoutId = typeof args.layoutId === "string" ? args.layoutId.trim() : "";
  if (!layoutId || !Array.isArray(args.elements)) return;
  let prefixes: string[];
  try {
    prefixes = ownCopyPrefixes(loadProject(projectRoot).presentation, layoutId);
  } catch {
    // An unreadable project is reported by the write itself; nothing is dropped here.
    return;
  }
  if (!prefixes.length) return;
  args.elements = args.elements.filter((element) => {
    const id = (element as { elementId?: unknown } | null)?.elementId;
    return !(typeof id === "string" && prefixes.some((prefix) => id.startsWith(prefix)));
  });
}

/** The read-only summary of the copies a page shows (read_page): ids, types and bounds, no bodies. */
export function inheritedSummaryOf(page: Page): Json[] {
  return page.elements
    .filter((element) => element.inherited !== undefined)
    .map((element) => ({
      elementId: element.elementId,
      elementType: element.elementType,
      bounds: element.bounds,
      ...(element.layoutRole !== undefined ? { layoutRole: element.layoutRole } : {}),
    }));
}

/**
 * The Chinese refusal for an edit that names a copy. It points at the owner the user can change in
 * the editor (编辑版式), not at write_layout: edit_elements runs only in element turns, which
 * withhold write_layout, so naming that tool would send the model to a tool it cannot call.
 */
export function inheritedReadonlyDetail(presentation: Presentation, element: PptdElement): string {
  const from = element.inherited;
  const isMaster = from?.scope === "master";
  const scope = isMaster ? "母版" : "版式";
  const owners: readonly { id: string; name: string }[] =
    (isMaster ? presentation.masters : presentation.layouts) ?? [];
  const name = owners.find((item) => item.id === from?.ownerId)?.name ?? from?.ownerId ?? "";
  return `该元素来自${scope}『${name}』，不能在页面上直接修改；请在「编辑版式」里修改该${scope}`;
}
