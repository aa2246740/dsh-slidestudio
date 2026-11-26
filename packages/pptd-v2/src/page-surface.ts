/**
 * The page surface: the one paint behind a page's content, decided once for the editor and the
 * export (ruling 131). The editor paints it (canvas-session `renderPageSurface`), and the exporter
 * reads the chart ink from it (export-pptd `pageSurfaceColor`). A page background inherited from a
 * layout or master is already on `page.background` after materialisation, so it follows the same
 * rule.
 */
import { findPageBackdrop } from "./page-backdrop.js";
import { solidFillColor } from "./solid-fill.js";
import type { Fill, Page } from "./types.js";

/**
 * The colour a picture page surface takes. Neither side samples a picture's pixels, so a picture
 * reads as dark: chart ink on it is light, as the editor has always painted it.
 */
export const PICTURE_SURFACE_COLOR = "#111111";

/** The surface paint, and where it comes from: a full-page plain rectangle or the page background. */
export type PageSurface = {
  fill: Fill;
  from: "backdrop" | "background";
};

type LooseFill = { type?: string; color?: string; src?: string; stops?: readonly unknown[] };

/** A fill that can paint a surface: one solid colour, or a gradient of two or more stops. */
function isSurfaceFill(fill: Fill | undefined): boolean {
  if (solidFillColor(fill) !== undefined) return true;
  const loose = fill as LooseFill | undefined;
  return loose?.type === "gradient" && (loose.stops?.length ?? 0) >= 2;
}

function isPictureFill(fill: Fill | undefined): boolean {
  const loose = fill as LooseFill | undefined;
  return loose?.type === "image" && Boolean(loose.src);
}

/**
 * A solid background is typed solid, so an untyped legacy colour reads the same as a solid fill. A
 * gradient keeps its own form, one stop or more.
 */
function backgroundSurface(background: Fill): Fill {
  if ((background as LooseFill).type === "gradient") return background;
  return { type: "solid", color: solidFillColor(background) ?? "" };
}

/**
 * The page surface, or undefined when the page shows white. A full-page plain rectangle whose fill
 * is a solid colour or a gradient of two or more stops is the surface (M5-SCR-R3-001). A picture
 * backdrop is not, so the page background shows. The page background is a picture (its surface is
 * `PICTURE_SURFACE_COLOR`), a solid colour, or a gradient of two or more stops.
 */
export function pageSurface(
  page: Pick<Page, "elements" | "background">,
  size: readonly [number, number],
): PageSurface | undefined {
  const backdrop = findPageBackdrop(page.elements, size);
  if (backdrop?.fill && isSurfaceFill(backdrop.fill)) {
    return { fill: backdrop.fill, from: "backdrop" };
  }
  const background = page.background;
  if (isPictureFill(background)) {
    return { fill: { type: "solid", color: PICTURE_SURFACE_COLOR }, from: "background" };
  }
  if (background && isSurfaceFill(background)) {
    return { fill: backgroundSurface(background), from: "background" };
  }
  return undefined;
}
