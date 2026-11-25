/**
 * One paint rule for M5 effects, shared by the editor (CSS) and the exporter (OOXML):
 * a colour with its own alpha, an extra opacity, and the shadow defaults.
 */
import { colorAlpha, toRgbHex } from "./theme.js";
import type { ElementShadow, Theme } from "./types.js";

/** `hex` is #RRGGBB. `alpha` is 0 to 1; 1 means opaque. */
export type PaintColor = { hex: string; alpha: number };

/** The shadow the editor and the exporter draw when `blur` or an offset is absent. */
export const SHADOW_DEFAULTS = { blur: 12, offsetX: 0, offsetY: 4, alpha: 0.25 } as const;

export type ResolvedElementShadow = {
  /** PPTD px. */
  blur: number;
  /** PPTD px. */
  offsetX: number;
  /** PPTD px. */
  offsetY: number;
  paint: PaintColor;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** #RRGGBB and alpha for a colour that may carry its own alpha, times an extra opacity. */
export function paintColor(color: string | undefined, theme?: Theme, opacity?: number): PaintColor {
  const own = colorAlpha(color, theme) ?? 1;
  return { hex: toRgbHex(color, theme), alpha: clamp01(own * clamp01(opacity ?? 1)) };
}

/** CSS colour for a paint: #RRGGBB when opaque, otherwise rgba() with three decimals. */
export function paintCss(paint: PaintColor): string {
  if (paint.alpha >= 0.995) return paint.hex;
  const r = parseInt(paint.hex.slice(1, 3), 16);
  const g = parseInt(paint.hex.slice(3, 5), 16);
  const b = parseInt(paint.hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(paint.alpha * 1000) / 1000})`;
}

/**
 * The drawn shadow for an element, or undefined when it has none. A colour with no
 * opacity keeps its own alpha. With no colour, the shadow is black at `opacity`, or 25 %.
 */
export function resolveElementShadow(
  shadow: ElementShadow | undefined,
  theme?: Theme,
): ResolvedElementShadow | undefined {
  if (!shadow) return undefined;
  const paint = shadow.color
    ? paintColor(shadow.color, theme, shadow.opacity)
    : { hex: "#000000", alpha: clamp01(shadow.opacity ?? SHADOW_DEFAULTS.alpha) };
  return {
    blur: shadow.blur ?? SHADOW_DEFAULTS.blur,
    offsetX: shadow.offsetX ?? SHADOW_DEFAULTS.offsetX,
    offsetY: shadow.offsetY ?? SHADOW_DEFAULTS.offsetY,
    paint,
  };
}
