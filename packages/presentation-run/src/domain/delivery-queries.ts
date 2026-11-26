/**
 * Delivery provenance for computed numbers (`pages[].queries`, CAP-15): which `query_material`
 * results a page's numbers trace to, from `page.computed-figures` facts bound to the page's
 * current revision. Facts only; nothing is read from page bodies here.
 */
import type { PageComputedFiguresFact } from "./material-query-ledger.js";
import type { RunLedgerV1 } from "./run-ledger.js";

export type PageQueryProvenance = Readonly<{
  /** `material.query-computed:<resultSha256>`, one per result the page's numbers come from. */
  queries: readonly string[];
  /** Distinct numbers on the page that equal a computed cell; absent from the file when 0. */
  computedFigureCount: number;
}>;

export const QUERY_EVENT_PREFIX = "material.query-computed:";

/** Latest `page.computed-figures` fact per page; a later write supersedes an earlier one. */
export function computedFiguresByPage(ledger: RunLedgerV1): ReadonlyMap<string, PageComputedFiguresFact> {
  const byPage = new Map<string, PageComputedFiguresFact>();
  for (const fact of ledger.facts) {
    if (fact.type === "page.computed-figures") byPage.set(fact.pageId, fact);
  }
  return byPage;
}

export function pageQueryProvenance(
  fact: PageComputedFiguresFact | undefined,
  currentRevision: number | undefined,
): PageQueryProvenance {
  if (!fact || currentRevision === undefined || fact.revision !== currentRevision) {
    return { queries: [], computedFigureCount: 0 };
  }
  return {
    queries: [...new Set(fact.matches.map((match) => `${QUERY_EVENT_PREFIX}${match.resultSha256}`))],
    computedFigureCount: new Set(fact.matches.map((match) => match.value)).size,
  };
}

/** Materials a query read rows from; a table that was only queried still counts as used. */
export function queriedMaterialIds(ledger: RunLedgerV1): ReadonlySet<string> {
  return new Set(ledger.facts.flatMap((fact) => (fact.type === "material.query-computed" ? [fact.materialId] : [])));
}
