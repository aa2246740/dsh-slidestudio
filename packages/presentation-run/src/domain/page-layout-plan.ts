/**
 * The plan's layout check for write_page (masters-layouts §3.20). A plan item may name the layout its
 * page should use. A write that uses another layout, or none, gets a non-blocking hint: the plan is
 * the agent's intent, and the saved page is the truth, so the write is never refused for this.
 */
import { readCommittedPagePlan } from "./run-ledger.js";

export function layoutPlanHint(root: string, pageId: string, layoutId: string | undefined): string | undefined {
  const planned = readCommittedPagePlan(root).find((item) => item.pageId === pageId)?.layoutId;
  if (!planned || planned === layoutId) return undefined;
  const written = layoutId ? `版式「${layoutId}」` : "没有版式";
  return `计划中此页使用版式「${planned}」，本次写入的是${written}。请核对；这不会阻止保存。`;
}
