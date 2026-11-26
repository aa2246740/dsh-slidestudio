/**
 * The export report the editor reads from the `X-Export-Report` header.
 * `degradations` stays a count for older readers; `degradationKinds` names each
 * degradation so the export panel can explain it per kind
 * (public/export-degradation-labels.js). Reason text, element ids and slide
 * indexes stay on the server: the header is public download metadata.
 * @param {{ok: boolean, slideCount: number, nativeCoverage?: unknown, degradations: {kind?: unknown}[], bytes: number, embeddedFonts?: unknown[], skippedFonts?: unknown[]}} report
 */
export function exportWireReport(report) {
  const degradations = Array.isArray(report.degradations) ? report.degradations : [];
  return {
    ok: report.ok,
    slideCount: report.slideCount,
    coverage: report.nativeCoverage,
    degradations: degradations.length,
    degradationKinds: degradations.map((item) => ({ kind: String(item?.kind ?? "") })),
    bytes: report.bytes,
    ...(report.embeddedFonts ? { embeddedFonts: report.embeddedFonts } : {}),
    ...(report.skippedFonts ? { skippedFonts: report.skippedFonts } : {}),
  };
}

/**
 * Report for a raster export (whole-deck PDF or one-page PNG). Visual exports
 * are page screenshots, so they carry no per-element degradations.
 * @param {{slideCount: number, bytes: number, kind?: string, layoutOk?: boolean | null}} input
 */
export function rasterWireReport({ slideCount, bytes, kind, layoutOk }) {
  return {
    ok: true,
    slideCount,
    bytes,
    degradations: 0,
    degradationKinds: [],
    ...(kind === undefined ? {} : { kind }),
    ...(layoutOk === undefined ? {} : { layoutOk }),
  };
}
