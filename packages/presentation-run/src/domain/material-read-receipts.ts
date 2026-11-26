/**
 * Matching between a required material part and the `material.chunk-returned`
 * facts `read_material` leaves in the run ledger. A receipt counts only when
 * the material identity (id + original-bytes sha256), the part, the chunk
 * index and the rendered chunk sha256 all still match the current material.
 * A re-uploaded or changed file therefore never reuses an old read.
 *
 * A table part is read as row windows of the caller's choosing, so it is
 * covered by the union of the windows actually read, not by one fixed window.
 */
import { isTableWindowPart, readMaterialChunk, type MaterialRenderOptions } from "./material-content.js";
import type { VerifiedMaterial } from "./material-pack.js";
import { readableTableRows } from "./material-table-window.js";
import { verifiedChunkRead, type MaterialChunkFact } from "./material-read-progress.js";
import type { RunLedgerV1 } from "./run-ledger.js";

export type MissingMaterialChunk = Readonly<{
  sourceId: string;
  materialId: string;
  chunkIndex: number;
  part?: string;
  /** For a table part: the 1-based data rows no current receipt covers. */
  rows?: Readonly<{ start: number; end: number }>;
}>;

function currentChunkFacts(
  material: VerifiedMaterial,
  ledger: RunLedgerV1 | undefined,
  contextEpochId: string,
): MaterialChunkFact[] {
  return (ledger?.facts ?? []).filter(
    (fact): fact is MaterialChunkFact =>
      fact.type === "material.chunk-returned" &&
      fact.contextEpochId === contextEpochId &&
      fact.materialId === material.id &&
      fact.materialSha256 === material.sha256,
  );
}

function missingTableRows(
  material: VerifiedMaterial,
  part: string,
  facts: readonly MaterialChunkFact[],
  options: MaterialRenderOptions,
): MissingMaterialChunk[] | undefined {
  const probe = readMaterialChunk({ material, part, offset: 0, limit: 1, ...options });
  const total = Math.min(probe.rows?.total ?? 0, readableTableRows(material, probe.part));
  // An empty table has no row to window; the one default read is its receipt.
  if (total < 1) return undefined;
  // A receipt written before windows carried row bounds can only have read the default window.
  const defaultWindow = readMaterialChunk({ material, part, ...options });
  const windows = facts
    .map((fact) =>
      fact.rowStart === undefined && fact.rowEnd === undefined
        ? fact.part === defaultWindow.part && fact.chunkSha256 === defaultWindow.chunkSha256
          ? defaultWindow.rows
          : undefined
        : verifiedChunkRead(material, probe, fact, options)?.rows,
    )
    .flatMap((rows) => (rows ? [rows] : []))
    .sort((a, b) => a.startIndex - b.startIndex);
  const missing: MissingMaterialChunk[] = [];
  let covered = 0;
  const gap = (end: number) => {
    if (end > covered)
      missing.push({
        sourceId: `material:${material.id}`,
        materialId: material.id,
        chunkIndex: 0,
        part: probe.part,
        rows: { start: covered + 1, end },
      });
  };
  for (const window of windows) {
    gap(window.startIndex - 1);
    covered = Math.max(covered, window.endIndex);
  }
  gap(total);
  return missing;
}

export function missingChunksForPart(
  material: VerifiedMaterial,
  part: string,
  count: number,
  ledger: RunLedgerV1 | undefined,
  contextEpochId: string,
  options: MaterialRenderOptions,
): MissingMaterialChunk[] {
  const facts = currentChunkFacts(material, ledger, contextEpochId);
  if (isTableWindowPart(material, part)) {
    const rows = missingTableRows(material, part, facts, options);
    if (rows) return rows;
  }
  const missing: MissingMaterialChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 1) {
    const expected = readMaterialChunk({ material, part, offset: chunkIndex, ...options });
    const read = facts.some(
      (fact) =>
        fact.part === expected.part && fact.chunkIndex === chunkIndex && fact.chunkSha256 === expected.chunkSha256,
    );
    if (!read)
      missing.push({
        sourceId: `material:${material.id}`,
        materialId: material.id,
        chunkIndex,
        ...(part === "design" ? {} : { part }),
      });
  }
  return missing;
}
