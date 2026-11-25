import type { ColorFallback } from "@open-slidestudio/pptd-v2";

/**
 * One `color-fallback` degradation per element, or per page background, whose stored colour the
 * exporter cannot resolve. The export writes the inherited or default colour instead, so the
 * reason names what was written. The kind is soft: it never makes a report fail.
 */
export function colorFallbackDegradations(fallbacks: readonly ColorFallback[]): Array<{
  slideIndex: number;
  elementId?: string;
  kind: string;
  reason: string;
}> {
  return fallbacks.map((fallback) => ({
    slideIndex: fallback.pageIndex,
    ...(fallback.elementId === undefined ? {} : { elementId: fallback.elementId }),
    kind: "color-fallback",
    reason: "stored colour cannot be resolved; exported with the inherited or default colour",
  }));
}
