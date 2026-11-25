/**
 * Stroke widths the exporter writes (ruling 112). The editor paints every stroke in PPTD px,
 * and the export slide is 10 inches wide, so 1 px = 9 525 EMU = 0.75 pt. pptxgenjs takes
 * points, so each px width converts once through cssPxToPt and the constants below name the
 * editor's px value they stand for.
 */

/** Converts a PPTD px length to points: 1 px = 0.75 pt = 9 525 EMU. */
export function cssPxToPt(px: number): number {
  return (px * 72) / 96;
}

/** Gridlines, axis lines, plot frame, table rules and waterfall connectors: 1 px. */
export const HAIRLINE_PT = cssPxToPt(1);
/** Line series polyline: 3 px (chart-paint.js). */
export const LINE_SERIES_PT = cssPxToPt(3);
/** Area series outline: 2 px (chart-paint.js). */
export const AREA_OUTLINE_PT = cssPxToPt(2);
/** Scatter marker ring: 2 px (chart-paint-special.js). */
export const MARKER_RING_PT = cssPxToPt(2);
