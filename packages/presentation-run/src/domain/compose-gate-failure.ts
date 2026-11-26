import type { CommandReceipt } from "../types.js";
import { boundComposeRefusal, compactComposeBlockers } from "./compose-refusal.js";
import { inspectRunLedger, readRunLedger, type StructuralReviewFact, type TodoFact } from "./run-ledger.js";

/** The compose_deck refusal with short per-page reasons. Moved out of run.ts for its budget. */
export function composeGateFailure(name: string, projectRoot: string): CommandReceipt | undefined {
  const status = inspectRunLedger(projectRoot);
  if (!status.initialized || status.composeReady) return undefined;
  const ledger = readRunLedger(projectRoot);
  const currentPageHashes = Object.fromEntries(status.pages.map((page) => [page.pageId, page.pageSha256]));
  const structuralIssues =
    status.structuralReview === "fail"
      ? (ledger?.facts
          .filter(
            (fact): fact is StructuralReviewFact =>
              fact.type === "deck.structural-review-recorded" && fact.ok === false,
          )
          .reverse()
          .find(
            (fact) =>
              Object.keys(currentPageHashes).length === Object.keys(fact.pageRevisions).length &&
              Object.entries(currentPageHashes).every(([pageId, sha]) => fact.pageRevisions[pageId] === sha),
          )?.issues ?? [])
      : [];
  const blockers = [...status.composeBlockers, ...structuralIssues];
  const hasBlocker = (needle: string) => blockers.some((blocker) => blocker.includes(needle));
  const failedLayoutPageIds = status.pages
    .filter((page) => page.layout === "fail" && hasBlocker(`${page.pageId}: rendered layout`))
    .map((page) => page.pageId);
  const missingRasterPageIds = status.pages
    .filter((page) => page.layout !== "fail" && hasBlocker(`${page.pageId}: rendered layout`))
    .map((page) => page.pageId);
  const staleLayoutPageIds = status.pages
    .filter((page) => page.chromeStale && hasBlocker(`${page.pageId}: 版式已变更`))
    .map((page) => page.pageId);
  const unresolvedLayout = blockers.some((blocker) => /: 版式 .+ 不存在/.test(blocker));
  const missingImagePageIds = status.pages
    .filter((page) => hasBlocker(`${page.pageId}: image content not emitted`))
    .map((page) => page.pageId);
  const missingVisualReviewPageIds = status.pages
    .filter((page) => page.visualReview === "missing" && hasBlocker(`${page.pageId}: visual review`))
    .map((page) => page.pageId);
  const failedVisualReviewPageIds = status.pages
    .filter((page) => page.visualReview === "revise" && hasBlocker(`${page.pageId}: visual review`))
    .map((page) => page.pageId);
  const latestTodo = readRunLedger(projectRoot)
    ?.facts.filter((fact): fact is TodoFact => fact.type === "todo.committed")
    .at(-1);
  const plannedPageIds = latestTodo?.pagePlan?.length
    ? latestTodo.pagePlan.map((page) => page.pageId)
    : [...(latestTodo?.pageIds ?? [])];
  const compact = compactComposeBlockers(blockers, [...plannedPageIds, ...status.pages.map((page) => page.pageId)]);
  const next = status.missingReferenceChunks.length
    ? "read_reference"
    : status.todoCount === 0
      ? "write_todo"
      : failedLayoutPageIds.length ||
          failedVisualReviewPageIds.length ||
          status.structuralReview === "fail" ||
          unresolvedLayout
        ? "write_page"
        : missingRasterPageIds.length || missingImagePageIds.length || staleLayoutPageIds.length
          ? "render_page"
          : missingVisualReviewPageIds.length
            ? "review_page"
            : status.structuralReview !== "pass"
              ? "review_pages"
              : "resolve_reported_blockers";
  return boundComposeRefusal({
    ok: false,
    name,
    summary: "compose gate rejected",
    detail: `compose_deck is not ready. Next: ${next}. See blockingPages and blockingIssues for short reasons.`,
    payload: {
      error: "compose_not_ready",
      next,
      recoveryHint: "Fix listed pages, refresh render/review evidence, then retry compose_deck.",
      missingReferenceChunks: status.missingReferenceChunks,
      blockingPages: compact.blockingPages,
      blockingIssues: compact.blockingIssues.slice(0, 8),
      structuralReview: status.structuralReview,
    },
  });
}
