/**
 * The page surface the editor paints behind a slide, and the background a new chart takes from it
 * (M5-SCR-R3-001). The surface is decided by pptd-v2 `pageSurface`, the rule the exporter reads
 * too (ruling 131), so the editor and the export agree on the paint and on the chart ink it sets.
 */
import {
  findPageBackdrop,
  pageSurface,
  solidFillColor,
  toRgbHex,
  type Fill,
  type Page,
  type PageSurface,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { fillCss } from "./fill-css.js";

type Theme = PptdProject["presentation"]["theme"];
type PageSize = readonly [number, number];

/**
 * The CSS paint of a surface. A page background's solid colour is painted opaque, as the slide
 * always was; every other surface goes through `fillCss`, which keeps a translucent alpha.
 */
function surfaceCss(surface: PageSurface, theme: Theme): string {
  if (surface.from === "background" && surface.fill.type === "solid") {
    return toRgbHex(surface.fill.color, theme, "#ffffff");
  }
  return fillCss(surface.fill, theme) ?? "#ffffff";
}

/**
 * The page background and the backing it paints. The surface is `pageSurface`: a full-page plain
 * rectangle replaces the background when its fill is a solid colour or a gradient, and a picture
 * backdrop is no surface, so the page background shows. A picture page background also paints the
 * picture above the surface, which is the placeholder colour `#111111`.
 */
export function renderPageSurface(
  page: Page,
  size: PageSize,
  theme: Theme,
): { backgroundCss: string; backgroundImage?: string } {
  const bg = page.background as { type?: string; src?: string } | undefined;
  const backgroundImage = bg?.type === "image" && bg.src ? bg.src : undefined;
  const surface = pageSurface(page, size);
  return { backgroundCss: surface ? surfaceCss(surface, theme) : "#ffffff", backgroundImage };
}

/**
 * The background a manually inserted chart takes, so it sits on the surface behind it: the solid
 * colour of the full-page rectangle, else the page background's, else white. A gradient gives its
 * colour only with one stop, the colour the deck paints for it.
 */
export function insertedChartFill(page: Page, size: PageSize): Fill {
  const backdrop = findPageBackdrop(page.elements, size);
  const color = solidFillColor(backdrop?.fill) ?? solidFillColor(page.background) ?? "#FFFFFF";
  return { type: "solid", color };
}
