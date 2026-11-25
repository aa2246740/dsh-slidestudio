import { toRgbHex } from "./theme.js";
import type { Theme } from "./types.js";

/**
 * Unstyled line default (ruling 100, M4-SCR-016). The canvas render model,
 * the render_page raster (the same paint) and the export read these values,
 * so an unstyled line has one colour and width everywhere. Explicit
 * `border.color` and `border.width` always win.
 */
export const UNSTYLED_LINE_COLOR = "#111111";
/**
 * Unstyled line width in PPTD px (ruling 112). The editor paints it at 2 px and the export
 * writes it as 19 050 EMU (1.5 pt), so the two surfaces show the same stroke.
 */
export const UNSTYLED_LINE_WIDTH = 2;

/** Theme primary when it is a valid colour, else UNSTYLED_LINE_COLOR. Never throws. */
export function unstyledLineColor(theme: Theme | undefined): string {
  try {
    return toRgbHex(theme?.colors?.primary, theme, UNSTYLED_LINE_COLOR);
  } catch {
    return UNSTYLED_LINE_COLOR;
  }
}

/**
 * The line border with the unstyled defaults filled in. The colour is the #RRGGBB the export
 * writes, so a theme token such as `$primary` paints in the editor too (M5-SCR-004). An empty or
 * unresolvable colour takes the unstyled colour, so the editor never paints an invalid value.
 */
export function resolvedLineBorder(
  border: { style?: string; width?: number; color?: string } | undefined,
  theme: Theme | undefined,
): { style?: string; width: number; color: string } {
  return {
    ...border,
    color: lineColor(border?.color, theme),
    width: border?.width ?? UNSTYLED_LINE_WIDTH,
  };
}

function lineColor(color: string | undefined, theme: Theme | undefined): string {
  if (color === undefined || color.trim() === "") return unstyledLineColor(theme);
  try {
    return toRgbHex(color, theme, UNSTYLED_LINE_COLOR);
  } catch {
    return unstyledLineColor(theme);
  }
}
