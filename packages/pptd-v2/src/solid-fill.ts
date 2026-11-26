/**
 * The one rule for the solid colour a fill shows (M5-SCR-R3-001). The editor paints a fill through
 * `fillCss`, the exporter writes it through `fillToPptx`, and a chart takes the surface of a plain
 * panel from the same colour. Every one of them asks this module, so none can decide on its own.
 */
import { colorAlpha, toRgbHex } from "./official-color.js";
import type { Theme } from "./types.js";

/** The fill fields the solid rule reads: a stored fill, or a copy of one. */
type SolidFillLike =
  | {
      type?: string;
      color?: string;
      stops?: readonly { color?: string }[];
    }
  | undefined;

/**
 * The colour text a fill shows as one solid colour. A solid fill, or a fill with no type but a
 * colour, shows its colour. A gradient with exactly one stop shows that stop's colour, the paint
 * both sides write for it. A gradient with two or more stops, a picture, no fill, and an empty
 * colour show no solid colour. Resolve the result with `toRgbHex` or `toCssColor`.
 */
export function solidFillColor(fill: SolidFillLike): string | undefined {
  if (!fill) return undefined;
  let color: string | undefined;
  if (fill.type === "solid" || (!fill.type && typeof fill.color === "string")) {
    color = fill.color;
  } else if (fill.type === "gradient" && fill.stops?.length === 1) {
    color = fill.stops[0]?.color;
  }
  return color || undefined;
}

/**
 * The solid colour as `#RRGGBB`, when it is fully opaque. A plain panel gives a chart this surface
 * in both the editor and the export. A translucent colour, a picture, a gradient of two or more
 * stops, and no fill return undefined.
 */
export function opaqueSolidHex(fill: SolidFillLike, theme?: Theme): string | undefined {
  const color = solidFillColor(fill);
  if (color === undefined) return undefined;
  return (colorAlpha(color, theme) ?? 1) >= 0.995 ? toRgbHex(color, theme) : undefined;
}
