import type { RenderElement } from "@open-slidestudio/canvas-session";

/**
 * A picture fill as the painter draws it. The editor resolves the project file to a
 * loadable URL (`href`) first; tile is the repeat cell in the shape's SVG units (the
 * natural px size, scaled to the box by the render model). The painter validates raw
 * input first (`imageFillInput`), so a crop that reaches it has all four sides.
 */
export type ShapePaintImageFill = {
  href?: string;
  mode?: "stretch" | "tile";
  crop?: { left: number; top: number; right: number; bottom: number };
  tile?: [number, number];
};

export type ShapePaintInput = Partial<
  Pick<RenderElement, "pathD" | "pathStroke" | "fillCss" | "border" | "viewBox" | "shadow">
> & { imageFill?: ShapePaintImageFill };

declare global {
  function shapePaintMarkup(element: unknown): string | null;
}
