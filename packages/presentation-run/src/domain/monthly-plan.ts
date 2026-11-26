/**
 * The monthly-update part of a `write_todo` call (CAP-17): `periodMap` and `missingItems`. Both are
 * validated before the plan is recorded, so a refused call leaves the plan and the earlier
 * declarations untouched; an omitted field keeps the earlier declaration.
 */
import { latestMissingItems, recordMissingItems, resolveMissingItems, type MissingItem } from "./missing-items.js";
import { latestPeriodMap, parsePeriodMap, recordPeriodMap, type PeriodMap } from "./period-map.js";
import { readRunLedger, type RunToolContext } from "./run-ledger.js";

export type MonthlyPlan = Readonly<{
  /** Present only when this call carried the field. */
  declaredPeriodMap?: PeriodMap;
  declaredMissingItems?: readonly MissingItem[];
  /** What is in force after this call: the declaration, else the earlier one. */
  periodMap?: PeriodMap;
  missingItems: readonly MissingItem[];
}>;

export function resolveMonthlyPlan(root: string, context: RunToolContext, args: Record<string, unknown>): MonthlyPlan {
  const declaredPeriodMap =
    args.periodMap === undefined || args.periodMap === null ? undefined : parsePeriodMap(args.periodMap);
  const ledger = readRunLedger(root);
  const periodMap = declaredPeriodMap ?? latestPeriodMap(ledger);
  const declaredMissingItems = resolveMissingItems(root, context.contextEpochId, args.missingItems, periodMap);
  return {
    ...(declaredPeriodMap ? { declaredPeriodMap } : {}),
    ...(declaredMissingItems ? { declaredMissingItems } : {}),
    ...(periodMap ? { periodMap } : {}),
    missingItems: declaredMissingItems ?? latestMissingItems(ledger),
  };
}

/** Append the declarations once the plan itself is committed. */
export function recordMonthlyPlan(root: string, context: RunToolContext, plan: MonthlyPlan): void {
  if (plan.declaredPeriodMap) recordPeriodMap(root, context, plan.declaredPeriodMap);
  if (plan.declaredMissingItems) recordMissingItems(root, context, plan.declaredMissingItems);
}

/** The fields the model sees echoed in the plan result. */
export function monthlyPlanPayload(plan: MonthlyPlan): Record<string, unknown> {
  return {
    ...(plan.periodMap ? { periodMap: plan.periodMap } : {}),
    ...(plan.missingItems.length
      ? {
          missingItems: plan.missingItems.map((item) => ({
            materialId: item.materialId,
            page: item.sourcePage,
            kind: item.kind,
            title: item.title,
          })),
        }
      : {}),
  };
}
