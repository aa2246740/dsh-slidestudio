/**
 * write_todo as a domain hand: the page plan is recorded only after every reference is read.
 * Moved out of domain-hands.ts unchanged so that file stays within its module budget.
 */
import { withProjectWriteLock } from "@open-slidestudio/pptd-v2";
import { planWriteFeedback } from "./plan-coverage.js";
import { loggedToolExecution } from "./logged-tool-execution.js";
import { parseCanonicalPagePlan } from "./page-plan.js";
import { monthlyPlanPayload, recordMonthlyPlan, resolveMonthlyPlan } from "./monthly-plan.js";
import { planMaterialsPayload, recordPlanMaterialUse, resolvePlanMaterials } from "./material-use.js";
import { recordTodo, requireReferencesComplete, type RunToolContext } from "./run-ledger.js";
import { editorAuthorityLostReceipt, editorTurnAuthorityLost } from "./editor-turn-authority.js";
import type { ToolExecution } from "./agent-tools.js";

export function writeTodoResult(
  root: string,
  context: RunToolContext,
  args: Record<string, unknown>,
  brief: string,
): ToolExecution {
  const name = "write_todo";
  return withProjectWriteLock(root, () => {
    // An accepted editor turn whose lease lapsed while this call waited for the lock keeps its plan.
    if (editorTurnAuthorityLost(root)) return editorAuthorityLostReceipt(name);
    requireReferencesComplete(root, context.contextEpochId);
    const items = parseCanonicalPagePlan(args.items);
    const feedback = planWriteFeedback(root, items, brief, context.contextEpochId);
    if (feedback.countMismatch) {
      return loggedToolExecution(root, name, args, {
        name,
        ok: false,
        summary: "page count mismatch",
        detail: feedback.countMismatch,
        payload: {
          error: "page_count_mismatch",
          plannedCount: items.length,
          next: "write_todo",
        },
      });
    }
    const images = resolvePlanMaterials(root, items, args.materialUse);
    const monthly = resolveMonthlyPlan(root, context, args);
    const hints = [...feedback.hints, ...images.hints];
    const committed = recordTodo(root, context, items);
    recordPlanMaterialUse(root, context, images);
    recordMonthlyPlan(root, context, monthly);
    return loggedToolExecution(root, name, args, {
      name,
      ok: true,
      summary: `${committed.length} pages planned`,
      detail: [committed.map((page) => `${page.pageId}: ${page.title}`).join("\n"), ...hints].join("\n"),
      payload: {
        items: committed,
        plannedPageIds: committed.map((page) => page.pageId),
        ...feedback,
        hints,
        ...planMaterialsPayload(images),
        ...monthlyPlanPayload(monthly),
      },
    });
  });
}
