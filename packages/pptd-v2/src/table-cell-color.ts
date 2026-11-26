/**
 * Table cell colours as the export writes them. The exporter and the editor's render model read a
 * cell's own text colour and solid fill through these functions, so a `$token` resolves to one
 * #RRGGBB on both surfaces. A stored token that cannot resolve never reaches them: the colour
 * fallback (color-fallback.ts) has already dropped it, so the cell takes the default.
 */
import { toRgbHex } from "./official-color.js";
import { solidFillColor } from "./solid-fill.js";
import type { Fill, Theme } from "./types.js";

/** Text colour of a cell with no colour of its own. */
const TABLE_TEXT_DEFAULT = "#1A1917";
/** Fill of a header cell (row 0) with no solid fill of its own. */
export const TABLE_HEADER_FILL = "#F3F4F6";
/** Fill of a body cell with no solid fill of its own. */
export const TABLE_BODY_FILL = "#FFFFFF";

/** #RRGGBB text colour of a cell: its own colour resolved through the theme, else the default. */
export function tableCellTextHex(color: string | undefined, theme: Theme | undefined): string {
  return toRgbHex(color ?? TABLE_TEXT_DEFAULT, theme);
}

/**
 * #RRGGBB of a cell's solid fill, or undefined when the cell has no solid fill. The solid colour is
 * the shared one (`solidFillColor`): a solid fill, or a gradient of exactly one stop.
 */
export function tableCellSolidHex(fill: Fill | undefined, theme: Theme | undefined): string | undefined {
  const solid = solidFillColor(fill);
  return solid === undefined ? undefined : toRgbHex(solid, theme);
}
