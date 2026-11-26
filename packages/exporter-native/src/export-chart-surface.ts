/**
 * The surface a chart's ink is chosen against in the export (ruling 121, M5-SCR-002, M5-SCR-R3-001).
 * The editor and the exporter share one rule: `chartSurfaceColor` in pptd-v2 reads each panel's
 * `opaqueSolidHex`, the solid colour `solidFillColor` gives its fill. This module only turns each
 * element into those candidates, so the two sides cannot drift.
 */
import {
  chartSurfaceColor,
  elementFillPaint,
  isPlainRectShape,
  opaqueSolidHex,
  type ChartElement,
  type ChartSurfaceCandidate,
  type Fill,
  type PptdElement,
  type PptdProject,
  type ShapeElement,
} from "@open-slidestudio/pptd-v2";
import { shapeBaseFill } from "./export-image-clip.js";

type Theme = PptdProject["presentation"]["theme"];

/**
 * The paint a chart background shows as one solid colour. A picture takes its placeholder colour,
 * which is the colour the export writes for it, and a gradient its first stop.
 */
function solidPaint(fill: Fill | undefined, theme: Theme): { hex: string; alpha: number } | undefined {
  const picture = fill as { type?: string; src?: string } | undefined;
  const base = picture?.type === "image" && picture.src ? shapeBaseFill(fill, theme) : fill;
  const paint = elementFillPaint("shape", base, undefined, theme);
  return paint.type === "solid" ? paint : undefined;
}

function surfaceCandidate(element: PptdElement, theme: Theme): ChartSurfaceCandidate {
  const plainRect = isPlainRectShape(element);
  return {
    bounds: element.bounds,
    plainRect,
    hidden: (element as { hidden?: boolean }).hidden === true,
    solidCss: plainRect ? opaqueSolidHex((element as ShapeElement).fill, theme) : undefined,
  };
}

/**
 * The colour behind a chart in the export: its own background, else the topmost opaque plain
 * panel under it, else `pageSurface`. `page` lists the page's elements in paint order.
 */
export function exportedChartSurface(
  page: readonly PptdElement[],
  chart: ChartElement,
  pageSurface: string,
  theme: Theme,
): string {
  const index = page.indexOf(chart);
  return chartSurfaceColor({
    bounds: chart.bounds,
    below: index > 0 ? page.slice(0, index).map((element) => surfaceCandidate(element, theme)) : [],
    chartCss: solidPaint(chart.background as Fill | undefined, theme)?.hex,
    pageCss: pageSurface,
  });
}
