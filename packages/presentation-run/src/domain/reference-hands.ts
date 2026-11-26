import { inspectRunLedger, readRunLedger, recordReferenceChunk, type RunToolContext } from "./run-ledger.js";
import { readOpenKimiSourceChunk, verifyOpenKimiPack } from "./openkimi-source-pack.js";
import { resolveRepoRoot } from "../catalog.js";
import type { ToolExecution } from "./agent-tools.js";

/**
 * Reference-library hands (list_references, read_reference). Split out of domain-hands.ts to
 * keep that module under its budget.
 */
export function listReferencesResult(root: string, context: RunToolContext): ToolExecution {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const pack = verifyOpenKimiPack(resolveRepoRoot());
  const status = inspectRunLedger(root, context.contextEpochId);
  const missing = new Set(status.missingReferenceChunks.map((item) => `${item.sourceId}#${item.chunkIndex}`));
  const sources = ledger.sourcePack.requirements.map((requirement) => {
    const entry = pack.entriesById.get(requirement.sourceId);
    if (!entry) throw new Error(`required source is absent: ${requirement.sourceId}`);
    return {
      sourceId: requirement.sourceId,
      relativePath: entry.relativePath,
      reason: requirement.reason,
      byteLength: entry.byteLength,
      fileSha256: entry.sha256,
      chunks: requirement.chunkIndexes.map((chunkIndex) => ({
        chunkIndex,
        readInThisContext: !missing.has(`${requirement.sourceId}#${chunkIndex}`),
      })),
    };
  });
  const detail = sources
    .map(
      (source) =>
        `${source.sourceId} | ${source.reason} | ${source.byteLength} bytes | chunks ${source.chunks
          .map((chunk) => `${chunk.chunkIndex}${chunk.readInThisContext ? "✓" : ""}`)
          .join(",")}`,
    )
    .join("\n");
  return {
    name: "list_references",
    ok: true,
    summary: `${sources.length} required original files`,
    detail,
    payload: { referencesComplete: status.referencesComplete, sources },
  };
}

export function readReferenceResult(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
): ToolExecution {
  const sourceId = String(args.sourceId ?? "").trim();
  const chunkIndex = Number(args.chunkIndex);
  if (!sourceId || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("read_reference requires sourceId and a non-negative integer chunkIndex");
  }
  const pack = verifyOpenKimiPack(resolveRepoRoot());
  const chunk = readOpenKimiSourceChunk(pack, sourceId, chunkIndex);
  recordReferenceChunk(root, context, {
    sourceId: chunk.sourceId,
    fileSha256: chunk.fileSha256,
    chunkIndex: chunk.index,
    chunkSha256: chunk.sha256,
  });
  return {
    name: "read_reference",
    ok: true,
    summary: `${chunk.relativePath} #${chunk.index}`,
    detail: [
      `ORIGINAL SOURCE ${chunk.sourceId}`,
      `chunk ${chunk.index} bytes ${chunk.byteStart}-${chunk.byteEndExclusive} sha256 ${chunk.sha256}`,
      "text in payload.text",
    ].join("\n"),
    payload: {
      sourceId: chunk.sourceId,
      relativePath: chunk.relativePath,
      chunkIndex: chunk.index,
      byteStart: chunk.byteStart,
      byteEndExclusive: chunk.byteEndExclusive,
      chunkSha256: chunk.sha256,
      fileSha256: chunk.fileSha256,
      text: chunk.text,
    },
  };
}
