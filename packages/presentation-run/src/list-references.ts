import { filterCatalog, loadReferenceCatalog } from "./catalog.js";
import { inspectRunLedger, readRunLedger } from "./domain/run-ledger.js";
import type { CommandReceipt } from "./types.js";

export function listReferences(
  repoRoot: string,
  projectRoot: string,
  contextEpochId: string,
  args: Record<string, unknown>,
): CommandReceipt {
  const catalog = loadReferenceCatalog(repoRoot);
  const directory = {
    ...catalog,
    sources: catalog.sources.map((row) => ({ ...row, family: row.family ?? "general" })),
  };
  const query = {
    family: typeof args.family === "string" ? args.family.trim() : undefined,
    kind: args.kind === "visual" || args.kind === "source" ? args.kind : undefined,
    tag: typeof args.tag === "string" ? args.tag.trim() : undefined,
  } as const;
  const filtered = filterCatalog(directory, query);
  const hasFilter = Boolean(query.family || query.kind || query.tag);
  const familyTotals: Record<string, number> = {};
  for (const row of [...directory.sources, ...directory.visuals]) {
    const family = row.family ?? "general";
    familyTotals[family] = (familyTotals[family] ?? 0) + 1;
  }
  const ledger = inspectRunLedger(projectRoot, contextEpochId);
  const requiredReferenceChunks =
    readRunLedger(projectRoot)?.sourcePack.requirements.flatMap((requirement) =>
      requirement.chunkIndexes.map((chunkIndex) => ({
        sourceId: requirement.sourceId,
        chunkIndex,
        reason: requirement.reason,
      })),
    ) ?? [];
  const prefix = ledger.initialized
    ? ledger.referencesComplete
      ? "All required source chunks are read."
      : "Read missingReferenceChunks before commit_design or write_todo."
    : "No strict source ledger is initialized.";
  const summary = `${filtered.sourceFiles} sources · ${filtered.visualFiles} visuals`;
  return {
    ok: true,
    name: "list_references",
    summary,
    detail: `${prefix}\n${summary}`,
    payload: {
      referencesComplete: ledger.initialized && ledger.referencesComplete,
      requiredReferenceChunks,
      missingReferenceChunks: ledger.missingReferenceChunks,
      next: ledger.initialized && !ledger.referencesComplete ? "read_reference" : undefined,
      sourceFiles: catalog.sourceFiles,
      visualFiles: catalog.visualFiles,
      listedSourceFiles: filtered.sourceFiles,
      listedVisualFiles: filtered.visualFiles,
      familyTotals,
      kindTotals: { source: catalog.sourceFiles, visual: catalog.visualFiles },
      ...(hasFilter
        ? {
            sources: [...filtered.sources, ...filtered.visuals].map((row) => ({
              sourceId: row.sourceId,
              kind: row.kind,
              chunks: row.chunks ?? [],
            })),
          }
        : { hint: "需要目录请带 family 或 kind 参数" }),
    },
  };
}
