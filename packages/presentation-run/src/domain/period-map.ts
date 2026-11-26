/**
 * `write_todo.periodMap` (CAP-17): which period last month's deck covers and which one the new deck
 * covers. The agent declares it; the Host checks only its shape, records it as a ledger fact and
 * uses it to read period labels, never to rewrite a page or to infer what data a page needs.
 */
import { extractPeriodLabels } from "./material-periods.js";
import { appendFact, factId, type RunLedgerV1, type RunToolContext } from "./run-ledger.js";

export type PeriodMap = Readonly<{ from: string; to: string }>;

export type PeriodMapFact = Readonly<{
  type: "plan.period-map-declared";
  factId: string;
  at: string;
  contextEpochId: string;
  commandId: string;
  periodMap: PeriodMap;
}>;

const KEYS = ["from", "to"] as const;
const FORMS_HINT = "可用写法：2026年8月、2026-08、2026年1-8月、2026年上半年、Q3";
const ISO_MONTH = /^(\d{4})[-/.](\d{1,2})$/;
const CHINESE_MONTHS = /^\d{4}年(\d{1,2})(?:-(\d{1,2}))?月末?$/;

function validMonth(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 12;
}

/** The label in the form `extractPeriodLabels` reads from a page, or undefined when unrecognized. */
function canonicalPeriod(raw: string): string | undefined {
  const iso = ISO_MONTH.exec(raw);
  if (iso) return validMonth(Number(iso[2])) ? `${iso[1]}年${Number(iso[2])}月` : undefined;
  const labels = extractPeriodLabels(raw);
  if (labels.length !== 1 || labels[0] !== raw) return undefined;
  const months = CHINESE_MONTHS.exec(raw);
  if (!months) return raw;
  const first = Number(months[1]);
  const last = months[2] === undefined ? first : Number(months[2]);
  return validMonth(first) && validMonth(last) && first <= last ? raw : undefined;
}

/** Validate the declared shape; throws a Chinese Error naming the field. */
export function parsePeriodMap(raw: unknown): PeriodMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      'periodMap 必须是对象：{from, to}，from 是上月稿里的期间，to 是本月要写的期间，例如 {"from":"2026年8月","to":"2026年9月"}',
    );
  }
  const record = raw as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !(KEYS as readonly string[]).includes(key));
  if (extra.length) throw new Error(`periodMap 只能有 from 和 to 两项，多出：${extra.join("、")}`);
  const labels = {} as Record<(typeof KEYS)[number], string>;
  for (const key of KEYS) {
    const value = typeof record[key] === "string" ? record[key].trim() : "";
    if (!value) {
      throw new Error(`periodMap.${key} 缺少期间，请写成「2026年8月」或「2026-08」这样的形式`);
    }
    const label = canonicalPeriod(value);
    if (!label) throw new Error(`periodMap.${key}「${value}」不是可识别的期间；${FORMS_HINT}`);
    labels[key] = label;
  }
  if (labels.from === labels.to) {
    throw new Error(`periodMap 的 from 和 to 不能是同一个期间（${labels.from}）`);
  }
  return { from: labels.from, to: labels.to };
}

/** The latest declaration; a plan that omits `periodMap` keeps it, so it spans context epochs. */
export function latestPeriodMap(ledger: RunLedgerV1 | undefined): PeriodMap | undefined {
  const fact = ledger?.facts
    .filter((entry): entry is PeriodMapFact => entry.type === "plan.period-map-declared")
    .at(-1);
  return fact?.periodMap;
}

export function recordPeriodMap(root: string, context: RunToolContext, periodMap: PeriodMap): void {
  const payload = {
    contextEpochId: context.contextEpochId,
    commandId: context.commandId,
    periodMap,
  };
  appendFact(root, {
    type: "plan.period-map-declared",
    factId: factId("plan.period-map-declared", payload),
    at: new Date().toISOString(),
    ...payload,
  });
}

/**
 * The labels a page or a source carries for the period comparison. A text that names no period
 * belongs to the period the map gives its side: the new deck's page to `to`, last month's source to
 * `from`. Without a map the labels stand as found.
 */
export function effectivePeriods(
  labels: readonly string[],
  map: PeriodMap | undefined,
  side: "page" | "source",
): readonly string[] {
  if (labels.length || !map) return labels;
  return [side === "page" ? map.to : map.from];
}
