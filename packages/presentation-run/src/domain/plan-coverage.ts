import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { pageCountFits, pageCountPlanHint, pageCountRequirementFromBrief } from "./page-count-requirement.js";
import { effectivePageCountRequirement } from "./conversation-requirements.js";
import { persistPageKey } from "./page-identity.js";
import type { LayoutReview } from "./layout-qa.js";
import type { PageRevisionFact, RunLedgerV1, TodoFact } from "./run-ledger.js";

type PlanPage = { pageId?: string; title?: string };
type Plan = readonly PlanPage[] | Pick<TodoFact, "pageIds" | "pagePlan">;
export type PlanCoverage = { missing: string[]; extra: string[] };

function plannedIds(todo: Plan): string[] {
  const pages = Array.isArray(todo)
    ? (todo as readonly PlanPage[]).map((page) => page.pageId ?? page.title ?? "")
    : ((todo as Pick<TodoFact, "pageIds" | "pagePlan">).pageIds ??
      (todo as Pick<TodoFact, "pageIds" | "pagePlan">).pagePlan?.map((page) => page.pageId) ??
      []);
  return [...new Set(pages.map(persistPageKey).filter(Boolean))];
}

function diskIds(root: string): string[] {
  if (!fs.existsSync(path.join(root, "deck.pptd"))) return [];
  return loadProject(root).pages.map((page) => persistPageKey(page.path));
}

/** Compare the agent's latest plan with disk SSOT; never reconcile either side. */
export function planCoverage(root: string, todo: Plan): PlanCoverage {
  const planned = plannedIds(todo);
  const current = diskIds(root);
  return {
    missing: planned.filter((id) => !current.includes(id)),
    extra: current.filter((id) => !planned.includes(id)),
  };
}

export function planCoverageBlockers(
  root: string,
  todo: Pick<TodoFact, "pageIds" | "pagePlan">,
  revisions: ReadonlyMap<string, PageRevisionFact>,
): string[] {
  try {
    const coverage = planCoverage(root, todo);
    const missing = [...new Set([...coverage.missing, ...plannedIds(todo).filter((id) => !revisions.has(id))])];
    return [
      ...(missing.length ? [`todo missing pages: ${missing.join(",")}`] : []),
      ...(coverage.extra.length ? [`pages not in todo: ${coverage.extra.join(",")}`] : []),
    ];
  } catch {
    return ["页面计划覆盖检查失败：无法读取磁盘文稿。"];
  }
}

export function planCoverageHint({ missing, extra }: PlanCoverage): string {
  return `计划中还没写的页面：${missing.join("、") || "无"}；已写但不在最新计划里的页面：${extra.join("、") || "无"}`;
}

export function planWriteFeedback(
  root: string | undefined,
  todo: readonly PlanPage[],
  brief: string,
  contextEpochId?: string,
) {
  const notInPlan = root ? planCoverage(root, todo).extra : [];
  const requirement = root
    ? effectivePageCountRequirement(root, brief, contextEpochId)
    : pageCountRequirementFromBrief(brief);
  const countHint = pageCountPlanHint(requirement, todo.length);
  // Approximate and unspecified totals stay informational; exact and explicit
  // ranges reject before the plan is committed.
  const countMismatch = pageCountFits(requirement, todo.length) ? undefined : countHint;
  const hints = [
    ...(notInPlan.length
      ? [`这些已写页面不在新计划中：${notInPlan.join("、")}。合稿前请把它们放回计划，或用 delete_pages 删除。`]
      : []),
    ...(countHint ? [countHint] : []),
  ];
  return { notInPlan, hints, ...(countMismatch ? { countMismatch } : {}) };
}

export function reviewPlanCoverage(root: string | undefined, todo: readonly PlanPage[], review: LayoutReview) {
  const coverage = root && todo.length ? planCoverage(root, todo) : { missing: [], extra: [] };
  const issues = [
    ...review.issues,
    ...coverage.missing.map((pageId) => ({
      pageId,
      code: "missing_planned_page",
      message: "计划中的页面尚未写入。",
    })),
    ...coverage.extra.map((pageId) => ({
      pageId,
      code: "page_not_in_plan",
      message: "已写页面不在最新计划中，请放回计划或用 delete_pages 删除。",
    })),
  ];
  return {
    ...review,
    ...coverage,
    ok: review.ok && !coverage.missing.length && !coverage.extra.length,
    issues,
    hint: coverage.missing.length || coverage.extra.length ? planCoverageHint(coverage) : "",
  };
}

/** Deleted pages retain historical facts, but no longer participate in current gates. */
export function currentDiskPageFacts(root: string, ledger: RunLedgerV1) {
  let current: Set<string> | undefined;
  try {
    if (fs.existsSync(path.join(root, "deck.pptd"))) current = new Set(diskIds(root));
  } catch {
    // Preserve evidence for diagnostics; the YAML gate separately refuses unreadable projects.
  }
  const facts = new Map<string, PageRevisionFact>();
  for (const fact of ledger.facts) {
    if (fact.type !== "page.revision-committed") continue;
    const pageId = persistPageKey(fact.pageId);
    if (!current || current.has(pageId)) facts.set(pageId, fact);
  }
  return facts;
}
