import { loadProject, type PptdProject } from "@open-slidestudio/pptd-v2";
import { persistPageKey } from "./page-identity.js";
import { drawnImageSrc } from "./page-image-srcs.js";

/** One layout that at least one page shows, with the pages and image files it carries. */
export type LayoutUsage = Readonly<{
  id: string;
  name: string;
  pages: readonly string[];
  media: readonly string[];
}>;

/** A layout entry in `_agent/delivery-provenance.v1.json` (masters-layouts §3.20). */
export type DeliveryLayout = LayoutUsage &
  Readonly<{
    scope: "layout";
    componentRefs: readonly string[];
  }>;

/**
 * Layouts used by at least one page, in deck order. Unused layouts are not delivered. `media`
 * lists the pictures the layout's chrome draws: its master's elements unless the layout hides
 * them, then its own. Picture backgrounds are not listed.
 */
export function layoutUsage(project: PptdProject): LayoutUsage[] {
  return (project.presentation.layouts ?? []).flatMap((layout) => {
    const pages = project.pages
      .filter(({ page }) => page.layoutId === layout.id)
      .map(({ path }) => persistPageKey(path));
    if (pages.length === 0) return [];
    const master = (project.presentation.masters ?? []).find((item) => item.id === layout.masterId);
    const inherited = layout.showMasterElements === false ? [] : (master?.elements ?? []);
    const media = [
      ...new Set([...inherited, ...layout.elements].map(drawnImageSrc).filter((src): src is string => Boolean(src))),
    ];
    return [{ id: layout.id, name: layout.name, pages, media }];
  });
}

/** Provenance entries for the deck's used layouts. A deck that cannot be read lists none. */
export function deliveryLayouts(root: string): DeliveryLayout[] {
  try {
    return layoutUsage(loadProject(root)).map((usage) => ({
      ...usage,
      scope: "layout",
      componentRefs: [],
    }));
  } catch {
    return [];
  }
}
