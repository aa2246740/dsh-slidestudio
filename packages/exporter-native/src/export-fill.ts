/**
 * PPTD fill to OOXML paint for the native exporter. Shapes, chart backgrounds
 * and icons all convert their fills here, so one mapping decides every exported
 * colour. Unmapped image fills degrade to a solid placeholder whose colour
 * follows the deck's `neutralChrome` flag.
 */
import type PptxGenJS from "pptxgenjs";
import {
  colorAlpha,
  elementFillPaint,
  solidFillPaint,
  toRgbHex,
  type Fill,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import type { Degradation } from "./export-pptd.js";

export type PptxGradientStop = {
  pos: number;
  color: string;
  alpha?: number;
};

export type PptxGradientFill = {
  type: "gradient";
  gradientType: "linear" | "radial";
  angle: number;
  stops: PptxGradientStop[];
  fallback: { color: string; transparency?: number };
};

export type PptxMappedFill =
  { type: "none" } | { type: "solid"; color: string; transparency?: number } | PptxGradientFill;

type LooseFill = {
  type?: string;
  color?: string;
  gradientType?: string;
  angle?: number;
  stops?: { color?: string; position?: number; alpha?: number }[];
};

function ooxmlStopPos(position: number | undefined, index: number, count: number): number {
  if (typeof position === "number" && Number.isFinite(position)) {
    if (position >= 0 && position <= 1) return Math.round(position * 100000);
    if (position > 1 && position <= 100000) return Math.round(position);
  }
  return Math.round((index / Math.max(1, count - 1)) * 100000);
}

export function encodeXmlName(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** An element's opacity as an alpha from 0 to 1: unset is opaque, and out-of-range values clamp. */
export function elementAlpha(opacity?: number): number {
  return opacity == null || Number.isNaN(opacity) ? 1 : Math.max(0, Math.min(1, opacity));
}

function mapGradientStops(
  stops: NonNullable<LooseFill["stops"]>,
  theme: PptdProject["presentation"]["theme"],
  opacity?: number,
): PptxGradientStop[] {
  const elementOpacity = elementAlpha(opacity);
  return stops.map((stop, index) => {
    const raw = String(stop.color ?? "#000000");
    // A stop's own alpha (0 to 1) multiplies the alpha of its colour, as the editor paints it.
    const stopOpacity = stop.alpha == null || Number.isNaN(stop.alpha) ? 1 : Math.max(0, Math.min(1, stop.alpha));
    const stopAlpha = (colorAlpha(raw, theme) ?? 1) * stopOpacity * elementOpacity;
    return {
      pos: ooxmlStopPos(stop.position, index, stops.length),
      color: toRgbHex(raw, theme).replace("#", ""),
      alpha: stopAlpha >= 0.995 ? undefined : Math.round(stopAlpha * 100000),
    };
  });
}

/**
 * The solid paint of a fill: the one the shared rule gives (`solidFillPaint`). A gradient of two or
 * more stops has none, so it takes its first stop, the degrade paint the export writes for it.
 */
function solidFromPaint(
  fill: Fill | undefined,
  theme: PptdProject["presentation"]["theme"],
  opacity: number | undefined,
  elementType: string,
): { color: string; transparency?: number } | undefined {
  const paint = solidFillPaint(fill, opacity, theme) ?? elementFillPaint(elementType, fill, opacity, theme);
  if (paint.type === "none") return undefined;
  return {
    color: paint.hex.replace("#", ""),
    transparency: paint.alpha < 0.995 ? Math.round((1 - paint.alpha) * 100) : undefined,
  };
}

export function fillToPptx(
  fill: Fill | undefined,
  theme: PptdProject["presentation"]["theme"],
  deg: Degradation[],
  slideIndex: number,
  elementId?: string,
  opacity?: number,
  elementType = "shape",
): PptxMappedFill {
  const loose = fill as LooseFill | undefined;
  if (loose?.type === "image") {
    deg.push({
      slideIndex,
      elementId,
      kind: "image-fill-as-solid",
      reason: "fill not fully mapped; solid placeholder",
    });
    return { type: "solid", color: theme?.neutralChrome ? "E5E5E5" : "E5E7EB" };
  }
  if (loose?.type === "gradient") {
    const stops = Array.isArray(loose.stops) ? loose.stops : [];
    if (elementType === "shape" && stops.length >= 2) {
      const mappedStops = mapGradientStops(stops, theme, opacity);
      const fallback = solidFromPaint(fill, theme, opacity, elementType) ?? {
        color: mappedStops[0]!.color,
      };
      return {
        type: "gradient",
        gradientType: loose.gradientType === "radial" ? "radial" : "linear",
        angle: typeof loose.angle === "number" && Number.isFinite(loose.angle) ? loose.angle : 0,
        stops: mappedStops,
        fallback,
      };
    }
    deg.push({
      slideIndex,
      elementId,
      kind: "gradient-as-solid",
      reason: "gradient collapsed to first stop; 8-digit alpha kept as transparency",
    });
  }
  const solid = solidFromPaint(fill, theme, opacity, elementType);
  if (!solid) return { type: "none" };
  return { type: "solid", ...solid };
}

export function pptxSolidFill(fill: PptxMappedFill): PptxGenJS.ShapeFillProps | undefined {
  if (fill.type === "none") return undefined;
  if (fill.type === "gradient") {
    return {
      type: "solid",
      color: fill.fallback.color,
      transparency: fill.fallback.transparency,
    };
  }
  return {
    type: "solid",
    color: fill.color,
    transparency: fill.transparency,
  };
}

export function pptxInk(fill: PptxMappedFill, fallback = "FFFFFF"): string {
  if (fill.type === "none") return fallback;
  if (fill.type === "gradient") return fill.fallback.color;
  return fill.color;
}

export function ooxmlGradientFill(fill: PptxGradientFill): string {
  const stops = fill.stops
    .map((stop) => {
      const color =
        stop.alpha == null
          ? `<a:srgbClr val="${stop.color}"/>`
          : `<a:srgbClr val="${stop.color}"><a:alpha val="${stop.alpha}"/></a:srgbClr>`;
      return `<a:gs pos="${stop.pos}">${color}</a:gs>`;
    })
    .join("");
  const shade =
    fill.gradientType === "radial"
      ? `<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>`
      : `<a:lin ang="${Math.round(fill.angle * 60000)}" scaled="1"/>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${shade}</a:gradFill>`;
}
