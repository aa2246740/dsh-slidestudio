/**
 * Sidecar entry for the numbered image mosaic behind
 * `view_material {materialId:"all-images"}` and the PDF page overview.
 *
 * The composer lives in `@open-slidestudio/slides-tools` so the sidecar and
 * the host always agree on size, numbering and sha256. It loads the optional
 * image codec lazily and throws `ImageCodecUnavailableError` when none is
 * installed.
 */
export { composeImageOverview, overviewGrid, IMAGE_OVERVIEW_SCHEMA } from "@open-slidestudio/slides-tools";
export {
  IMAGE_OVERVIEW_MAX_EDGE,
  IMAGE_OVERVIEW_MAX_TILES,
  IMAGE_OVERVIEW_PDF_MAX_PAGES,
} from "@open-slidestudio/slides-tools/internal/image-overview";
