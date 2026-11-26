/**
 * Ledger facts written when a vision model looks at uploaded images: the
 * numbered overviews and the notes it records afterwards. They carry ids and
 * hashes only; the pixels and the caption text stay in the project files.
 */

export type MaterialOverviewTileFact = Readonly<{
  /** Number drawn on the mosaic: the position for all-images, the page for a PDF. */
  number: number;
  materialId: string;
  mediaId?: string;
  page?: number;
  /** Sha256 of the tile's source bytes, as verified against the material receipt. */
  sha256: string;
}>;

/** One composed mosaic returned by `view_material` (all images or one PDF's pages). */
export type MaterialOverviewFact = Readonly<{
  type: "material.overview-viewed";
  factId: string;
  at: string;
  contextEpochId: string;
  overviewKind: "all-images" | "pdf-pages";
  /** Sha256 of the mosaic JPEG the model received. */
  overviewSha256: string;
  width: number;
  height: number;
  materialIds: readonly string[];
  tiles: readonly MaterialOverviewTileFact[];
  /** True when more tiles existed than the mosaic shows. */
  truncated: boolean;
}>;

/** The model's recorded conclusions for one image, template photo or PDF page. */
export type MaterialNotesFact = Readonly<{
  type: "material.notes-recorded";
  factId: string;
  at: string;
  contextEpochId: string;
  materialId: string;
  mediaId?: string;
  page?: number;
  /** Sha256 of the canonical notes JSON stored in `_agent/material-notes.v1.json`. */
  notesSha256: string;
}>;

/** One uploaded image returned alone to a vision model (`view_material {materialId}`). */
export type MaterialImageViewedFact = Readonly<{
  type: "material.image-viewed";
  factId: string;
  at: string;
  contextEpochId: string;
  materialId: string;
  /** Sha256 of the material's original uploaded bytes (receipt-pinned). */
  materialSha256: string;
}>;
