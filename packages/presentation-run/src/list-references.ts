import { filterCatalog, loadReferenceCatalog, type CatalogSource } from "./catalog.js";
import {
  canonicalDesignSystemId,
  designSystemSelectionRows,
  loadDesignSystemCards,
  type DesignSystemCard,
} from "./design-system-cards.js";
import { inspectRunLedger, readRunLedger } from "./domain/run-ledger.js";
import type { CommandReceipt } from "./types.js";

export const LIST_REFERENCES_HINT = '需要目录请带 family 或 kind 参数；选风格请用 kind:"design" 查看去重后的风格卡';

/** Cards for the design systems the listed rows belong to, each canonical pack once. */
function cardsForRows(cards: readonly DesignSystemCard[], rows: readonly CatalogSource[]): DesignSystemCard[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = canonicalDesignSystemId(cards, row.kind === "visual" ? (row.designSystemId ?? "") : row.sourceId);
    if (id) ids.add(id);
  }
  return cards.filter((card) => ids.has(card.id));
}

function designQueryCards(
  cards: readonly DesignSystemCard[],
  query: { family?: string; tag?: string },
): DesignSystemCard[] {
  const family = query.family?.toLowerCase();
  const tag = query.tag?.toLowerCase();
  return cards.filter((card) => {
    if (family && card.id.split("/")[0] !== family) return false;
    if (tag && ![card.id, card.sourceId, ...card.aliases, card.card].join(" ").toLowerCase().includes(tag))
      return false;
    return true;
  });
}

type CatalogQuery = Readonly<{ family?: string; kind?: "source" | "visual"; tag?: string }>;

function parseQuery(args: Record<string, unknown>): CatalogQuery {
  return {
    family: typeof args.family === "string" ? args.family.trim() : undefined,
    kind: args.kind === "visual" || args.kind === "source" ? args.kind : undefined,
    tag: typeof args.tag === "string" ? args.tag.trim() : undefined,
  };
}

/** The filtered part of the payload: rows for a catalog query, cards for kind:"design". */
function listingPayload(
  repoRoot: string,
  designKind: boolean,
  query: CatalogQuery,
  filtered: ReturnType<typeof filterCatalog>,
): Record<string, unknown> {
  if (!designKind && !query.family && !query.kind && !query.tag) return { hint: LIST_REFERENCES_HINT };
  const cards = loadDesignSystemCards(repoRoot);
  const rows = [...filtered.sources, ...filtered.visuals];
  const selected = designKind ? designQueryCards(cards, query) : cardsForRows(cards, rows);
  return {
    ...(designKind
      ? {}
      : { sources: rows.map((row) => ({ sourceId: row.sourceId, kind: row.kind, chunks: row.chunks ?? [] })) }),
    ...(selected.length ? { designSystems: designSystemSelectionRows(selected) } : {}),
  };
}

function ledgerPrefix(ledger: ReturnType<typeof inspectRunLedger>): string {
  if (!ledger.initialized) return "No strict source ledger is initialized.";
  return ledger.referencesComplete
    ? "All required source chunks are read."
    : "Read missingReferenceChunks before commit_design or write_todo.";
}

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
  const designKind = args.kind === "design";
  const query = parseQuery(args);
  const filtered = designKind
    ? { sourceFiles: 0, visualFiles: 0, sources: [], visuals: [] }
    : filterCatalog(directory, query);
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
  const listing = listingPayload(repoRoot, designKind, query, filtered);
  const designCount = Array.isArray(listing.designSystems) ? listing.designSystems.length : 0;
  const summary = designKind
    ? `${designCount} design systems`
    : `${filtered.sourceFiles} sources · ${filtered.visualFiles} visuals`;
  return {
    ok: true,
    name: "list_references",
    summary,
    detail: `${ledgerPrefix(ledger)}\n${summary}`,
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
      ...listing,
    },
  };
}
