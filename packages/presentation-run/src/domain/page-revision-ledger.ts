/**
 * Page revision facts. A page's revision is identified by its own body (see pageRevisionSha256),
 * so copies of master and layout elements never make a page a new revision on their own.
 * run-ledger.ts re-exports these names for existing importers.
 */
import { persistPageKey } from "./layout-qa.js";
import { pageRevisionSha256 } from "./hashing.js";
import {
  appendFact,
  factId,
  nowIso,
  readRunLedger,
  type PageRevisionFact,
  type RunLedgerV1,
  type RunToolContext,
  type VisualReviewFact,
} from "./run-ledger.js";

export function latestPageFacts(ledger: RunLedgerV1): Map<string, PageRevisionFact> {
  const pages = new Map<string, PageRevisionFact>();
  for (const fact of ledger.facts) {
    if (fact.type === "page.revision-committed") pages.set(fact.pageId, fact);
  }
  return pages;
}

export function recordPageRevision(
  root: string,
  context: RunToolContext,
  pageId: string,
  page: unknown,
): PageRevisionFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const current = latestPageFacts(ledger).get(pageId);
  const pageSha256 = pageRevisionSha256(page, pageId);
  if (current?.pageSha256 === pageSha256) {
    const lastReview = [...ledger.facts]
      .reverse()
      .find(
        (fact): fact is VisualReviewFact =>
          fact.type === "page.visual-review-recorded" &&
          fact.pageId === pageId &&
          fact.revision === current.revision &&
          fact.pageSha256 === pageSha256,
      );
    if (lastReview?.verdict === "revise") {
      throw new Error(`${pageId} must change after a revise review`);
    }
    return current;
  }
  const payload = {
    contextEpochId: context.contextEpochId,
    pageId,
    revision: (current?.revision ?? 0) + 1,
    pageSha256,
  };
  const fact: PageRevisionFact = {
    type: "page.revision-committed",
    factId: factId("page.revision-committed", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}

export function currentPageRevision(root: string, pageId: string): PageRevisionFact | undefined {
  const ledger = readRunLedger(root);
  if (!ledger) return undefined;
  const pages = latestPageFacts(ledger);
  return pages.get(pageId) ?? pages.get(persistPageKey(pageId));
}
