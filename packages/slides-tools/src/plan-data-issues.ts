/**
 * The kernel checks tool arguments against the parameter schema and words its refusals in English.
 * A malformed `periodMap`, `missingItems` or `userColors` gets the domain's Chinese message instead, so the
 * rejection a model sees names the field and the fix whichever layer catches it first.
 */
import { parseMissingItemRequests, parsePeriodMap, parseUserColors } from "@open-slidestudio/presentation-run";

const FIELD_CHECKS: Readonly<Record<string, (value: unknown) => unknown>> = {
  periodMap: parsePeriodMap,
  missingItems: parseMissingItemRequests,
  userColors: parseUserColors,
};

const FALLBACKS: Readonly<Record<string, string>> = {
  periodMap: "periodMap 的格式不对：写成 {from, to}，例如 {from:'2026年8月', to:'2026年9月'}",
  missingItems: "missingItems 的格式不对：每项写成 {page, title}，page 是模板的来源页码（整数）",
  userColors: "userColors 的格式不对：写成 [{hex:'#1F4E9A', reason:'用户要求主色换成蓝色'}]，hex 是 #RRGGBB",
};

/** Replace every schema issue about a plan-data field with one Chinese reason. */
export function localizePlanDataIssues(issues: readonly string[], args: unknown): string[] {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const reported = new Set<string>();
  const out: string[] = [];
  for (const issue of issues) {
    const field = /^"(periodMap|missingItems|userColors)(?=["[.])/.exec(issue)?.[1];
    if (!field || !record) {
      out.push(issue);
      continue;
    }
    if (reported.has(field)) continue;
    reported.add(field);
    try {
      FIELD_CHECKS[field]!(record[field]);
      out.push(FALLBACKS[field]!);
    } catch (error) {
      out.push(error instanceof Error ? error.message : FALLBACKS[field]!);
    }
  }
  return out;
}
