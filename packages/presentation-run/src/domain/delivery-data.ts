/**
 * The `data` section of `delivery-provenance.v1.json` (CAP-17): the plan's period map and the
 * template items it declared as having no new data. Both come from ledger facts the plan call
 * recorded after verification; a run without a period map writes an empty section, so projects
 * that never ran a monthly update keep their exact earlier shape.
 */
import { MISSING_ITEM_SUFFIX, latestMissingItems, missingItemEntry } from "./missing-items.js";
import { latestPeriodMap, type PeriodMap } from "./period-map.js";
import type { RunLedgerV1 } from "./run-ledger.js";

export type DeliveryData = Readonly<{
  periodMap?: PeriodMap;
  /** `第 7 页『专题汇报』：未提供本期数据`, one per declared item; present whenever a map is. */
  missingItems?: readonly string[];
}>;

export function deliveryData(ledger: RunLedgerV1): DeliveryData {
  const periodMap = latestPeriodMap(ledger);
  if (!periodMap) return {};
  return { periodMap, missingItems: latestMissingItems(ledger).map(missingItemEntry) };
}

/** The lines the model-facing compose summary spends on the data section; none without a map. */
export function dataSummaryTexts(data: DeliveryData): readonly string[] {
  if (!data.periodMap) return [];
  const items = (data.missingItems ?? []).map((entry) =>
    entry.endsWith(MISSING_ITEM_SUFFIX) ? entry.slice(0, -MISSING_ITEM_SUFFIX.length) : entry,
  );
  return [
    `期间：${data.periodMap.from} → ${data.periodMap.to}`,
    ...(items.length ? [`没有本期数据的项目：${items.join("、")}`] : []),
  ];
}
