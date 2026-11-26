import { inspectProjectCapabilities } from "../capabilities.js";
import {
  inspectRunLedger,
  readRunLedger,
  type PageEvidenceStatus,
  type RunLedgerV1,
  type TodoFact,
} from "./run-ledger.js";
import type { ToolExecution } from "./agent-tools.js";

const REVIEW_TOOLS = new Set(["render_page", "review_page", "review_pages", "write_todo"]);

export type ReviewProgress = Readonly<{
  pendingReview: readonly string[];
  next: string;
}>;

/**
 * Keep the page-plan order so the next review is stable across ledger reads. A page whose layout
 * changed is rendered again before any review is requested for it or for the others.
 */
export function buildReviewProgress(
  plannedPageIds: readonly string[],
  pages: readonly (Pick<PageEvidenceStatus, "pageId" | "visualReview"> & {
    chromeStale?: boolean;
  })[],
  visualReviewRequired: boolean,
): ReviewProgress {
  const reviewed = new Map(pages.map((page) => [page.pageId, page.visualReview]));
  const stale = new Set(pages.filter((page) => page.chromeStale).map((page) => page.pageId));
  const pendingReview = visualReviewRequired ? plannedPageIds.filter((pageId) => reviewed.get(pageId) !== "pass") : [];
  const renderFirst = plannedPageIds.find((pageId) => stale.has(pageId)) ?? [...stale][0];
  return {
    pendingReview,
    next: renderFirst
      ? `render_page ${renderFirst}`
      : pendingReview.length
        ? `review_page ${pendingReview[0]}`
        : "compose_deck",
  };
}

function plannedPageIds(ledger: RunLedgerV1 | undefined): string[] {
  const latestPlan = ledger?.facts.filter((fact): fact is TodoFact => fact.type === "todo.committed").at(-1);
  if (!latestPlan) return [];
  if (latestPlan.pagePlan?.length) return latestPlan.pagePlan.map((page) => page.pageId);
  return [...(latestPlan.pageIds ?? [])];
}

export function currentReviewProgress(root: string, env: NodeJS.ProcessEnv = process.env): ReviewProgress {
  const visionRequired = inspectProjectCapabilities(root, env).vision.mode !== "none";
  const ledger = readRunLedger(root);
  const status = inspectRunLedger(root, undefined, env, ledger);
  return buildReviewProgress(plannedPageIds(ledger), status.pages, visionRequired);
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined ? {} : { result: value };
}

/** Attach ledger-derived visual QA state to every model-facing render/review result. */
export function withReviewProgress(root: string, name: string, result: ToolExecution): ToolExecution {
  if (!REVIEW_TOOLS.has(name)) return result;
  const payload = objectPayload(result.payload);
  const progress = currentReviewProgress(root);
  return {
    ...result,
    payload: {
      ...payload,
      ...progress,
      ...(!result.ok && payload.next === "render_page" ? { next: payload.next } : {}),
    },
  };
}
