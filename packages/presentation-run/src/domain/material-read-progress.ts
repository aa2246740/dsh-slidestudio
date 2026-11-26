import { readMaterialChunk, type MaterialRenderOptions } from "./material-content.js";
import type { MaterialReadResult, VerifiedMaterial } from "./material-pack.js";
import type { MaterialQueryFact, PageComputedFiguresFact } from "./material-query-ledger.js";
import type { MaterialUseFact } from "./material-use.js";
import type { MissingItemsFact } from "./missing-items.js";
import type { PageConflictsFact } from "./page-conflicts.js";
import type { PeriodMapFact } from "./period-map.js";
import type { MaterialImageViewedFact, MaterialNotesFact, MaterialOverviewFact } from "./material-view-facts.js";

export type MaterialChunkFact = Readonly<{
  type: "material.chunk-returned";
  factId: string;
  at: string;
  contextEpochId: string;
  materialId: string;
  /** Sha256 of the material's original uploaded bytes (receipt-pinned). */
  materialSha256: string;
  part?: string;
  chunkIndex: number;
  chunkSha256: string;
  chunkCount?: number;
  rowStart?: number;
  rowEnd?: number;
  rowTotal?: number;
}>;

/** A PDF page image returned to a vision model (`view_material {materialId, page}`). */
export type MaterialPageFact = Readonly<{
  type: "material.page-viewed";
  factId: string;
  at: string;
  contextEpochId: string;
  materialId: string;
  /** Sha256 of the material's original uploaded bytes (receipt-pinned). */
  materialSha256: string;
  page: number;
  /** Sha256 of the page JPEG bytes that were returned (matches derivative renderedPages). */
  pageSha256: string;
}>;

/** Every material read, view or computation fact the run ledger accepts. */
export type MaterialReadFact =
  | MaterialChunkFact
  | MaterialPageFact
  | MaterialOverviewFact
  | MaterialNotesFact
  | MaterialImageViewedFact
  | MaterialUseFact
  | MaterialQueryFact
  | PageComputedFiguresFact
  | PageConflictsFact
  | PeriodMapFact
  | MissingItemsFact;

/**
 * The read a receipt claims, re-derived from the current material: undefined
 * when the receipt belongs to another upload, part, table size or window, or
 * when its hash no longer matches what that exact window renders to today.
 */
export function verifiedChunkRead(
  material: VerifiedMaterial,
  current: MaterialReadResult,
  fact: MaterialChunkFact,
  options: MaterialRenderOptions = {},
): MaterialReadResult | undefined {
  if (
    fact.materialId !== current.materialId ||
    fact.materialSha256 !== current.materialSha256 ||
    fact.part !== current.part ||
    !Number.isSafeInteger(fact.chunkIndex) ||
    fact.chunkIndex < 0 ||
    (!current.rows && fact.chunkIndex >= current.chunkCount)
  )
    return undefined;
  if (
    current.rows &&
    (!Number.isSafeInteger(fact.rowStart) ||
      !Number.isSafeInteger(fact.rowEnd) ||
      fact.rowStart! < 1 ||
      fact.rowEnd! < fact.rowStart! ||
      fact.rowTotal !== current.rows.total ||
      fact.rowEnd! > current.rows.total)
  )
    return undefined;
  const expected = readMaterialChunk({
    material,
    part: current.part,
    offset: current.rows ? fact.rowStart! - 1 : fact.chunkIndex,
    ...(current.rows ? { limit: fact.rowEnd! - fact.rowStart! + 1 } : {}),
    ...options,
  });
  return expected.chunkSha256 === fact.chunkSha256 ? expected : undefined;
}

/** Display coverage spans epochs; authorization continues to use current-epoch receipts. */
export function materialReadProgress(
  material: VerifiedMaterial,
  current: MaterialReadResult,
  facts: readonly MaterialChunkFact[],
  options: MaterialRenderOptions = {},
): { read: MaterialReadResult; nextOffset: number } {
  const reads = new Map<string, MaterialReadResult>();
  const key = (read: MaterialReadResult) =>
    read.rows ? `${read.rows.startIndex}:${read.rows.endIndex}` : String(read.chunkIndex);
  for (const fact of facts) {
    const expected = verifiedChunkRead(material, current, fact, options);
    if (expected) reads.set(key(expected), expected);
  }
  if (current.chunkCount > 0) reads.set(key(current), current);
  if (current.rows) {
    const windows = [...reads.values()]
      .flatMap((read) => (read.rows ? [read.rows] : []))
      .sort((a, b) => a.startIndex - b.startIndex);
    let rowsRead = 0;
    let end = 0;
    let nextOffset = 0;
    for (const window of windows) {
      rowsRead += Math.max(0, window.endIndex - Math.max(end, window.startIndex - 1));
      end = Math.max(end, window.endIndex);
      if (window.startIndex <= nextOffset + 1) nextOffset = Math.max(nextOffset, window.endIndex);
    }
    return {
      read: {
        ...current,
        readChunks: new Set([...reads.values()].map((read) => read.chunkIndex)).size,
        rowsRead,
        allRead: rowsRead === current.rows.total,
      },
      nextOffset,
    };
  }
  let nextOffset = 0;
  while (reads.has(String(nextOffset))) nextOffset++;
  return {
    read: { ...current, readChunks: reads.size, allRead: reads.size === current.chunkCount },
    nextOffset,
  };
}
