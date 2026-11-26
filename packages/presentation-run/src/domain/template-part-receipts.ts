/**
 * A template part counts as read only when every one of its chunks was returned in the current
 * epoch and still re-hashes to its recorded receipt. Structured chart and table sources, and the
 * items a plan may name, are trusted only under that condition.
 */
import { readMaterialChunk } from "./material-content.js";
import type { VerifiedMaterial } from "./material-pack.js";
import type { MaterialChunkFact } from "./run-ledger.js";

export function partChunkReceiptsValid(
  material: VerifiedMaterial,
  facts: readonly MaterialChunkFact[],
  part: string,
): boolean {
  const partFacts = facts.filter(
    (fact) =>
      fact.part === part &&
      fact.rowStart === undefined &&
      fact.rowEnd === undefined &&
      Number.isSafeInteger(fact.chunkIndex),
  );
  const count = Math.max(0, ...partFacts.map((fact) => fact.chunkCount ?? 0));
  if (!count) return false;
  const factsByIndex = new Map<number, MaterialChunkFact[]>();
  for (const fact of partFacts) {
    const list = factsByIndex.get(fact.chunkIndex) ?? [];
    list.push(fact);
    factsByIndex.set(fact.chunkIndex, list);
  }
  for (let index = 0; index < count; index += 1) {
    const receipts = factsByIndex.get(index);
    if (!receipts?.length) return false;
    let read;
    try {
      read = readMaterialChunk({ material, part, offset: index });
    } catch {
      return false;
    }
    if (!receipts.some((fact) => fact.chunkSha256 === read.chunkSha256)) return false;
    if (read.chunkCount !== count) return false;
  }
  return true;
}
