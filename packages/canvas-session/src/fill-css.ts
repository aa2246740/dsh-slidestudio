import {
  elementFillPaint,
  paintColor,
  paintCss,
  solidFillColor,
  toCssColor,
  type Fill,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";

/** A stop without `alpha` keeps the pre-M5 paint; with it, alpha multiplies the colour's own. */
function stopCss(stop: { color: string; alpha?: number }, theme: PptdProject["presentation"]["theme"]): string {
  return stop.alpha === undefined ? toCssColor(stop.color, theme) : paintCss(paintColor(stop.color, theme, stop.alpha));
}

/**
 * CSS paint for a PPTD fill: its solid colour, a gradient of two or more stops, the image
 * placeholder, or the element default. The solid colour is the one rule the export shares
 * (`solidFillColor` in pptd-v2), so a one-stop gradient paints the colour the export writes.
 */
export function fillCss(
  fill: Fill | undefined,
  theme: PptdProject["presentation"]["theme"],
  elementType = "shape",
): string | undefined {
  const loose = fill as unknown as
    | {
        type?: string;
        color?: string;
        src?: string;
        angle?: number;
        stops?: { position: number; color: string; alpha?: number }[];
      }
    | undefined;
  const solid = solidFillColor(loose);
  if (solid !== undefined) return toCssColor(solid, theme);
  if (loose?.type === "gradient" && loose.stops && loose.stops.length >= 2) {
    // PPTD follows the Kimi contract: 0° is left→right and angles increase
    // clockwise. CSS starts at bottom→top, so the same vector is +90°.
    const pptdAngle = loose.angle ?? 0;
    const cssAngle = (((pptdAngle + 90) % 360) + 360) % 360;
    const stops = loose.stops.map((s) => `${stopCss(s, theme)} ${Math.round(s.position * 100)}%`).join(", ");
    return `linear-gradient(${cssAngle}deg, ${stops})`;
  }
  if (loose?.type === "image" && loose.src) {
    // A picture fill paints through its own SVG pattern (imageFill). This colour is the
    // placeholder for a picture that cannot be drawn, the same one the exporter uses.
    return theme?.neutralChrome ? "#E5E5E5" : "#E5E7EB";
  }
  const paint = elementFillPaint(elementType, fill, undefined, theme);
  if (paint.type === "none") return undefined;
  return paint.hex;
}
