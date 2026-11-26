/**
 * Stale-figure detection for a monthly update (CAP-17). Under a declared `periodMap`, a number a
 * page states is compared with every cached value of a receipt-verified template chart, one value
 * at a time: equal as cached, or equal at the precision the chart displays it (the same
 * exact-or-displayed rule chart attribution uses, so a value cached with many decimals still
 * matches the two decimals its `numFmt` shows). Table cells and slide text are matched by the
 * ordinary figure rule over the `tables` and `slides` parts. Nothing here blocks a write.
 */
import type { PeriodMap } from "./period-map.js";
import { displayedChartValuesMatch } from "./template-chart-number-format.js";
import { numericToken, type TemplateChartFigureMatch, type TemplateChartSource } from "./template-chart-provenance.js";

function significantDigits(token: string): number {
  return token.replace(/[-,%.]/g, "").replace(/^0+/, "").length;
}

function scalarMatch(token: string, cached: unknown, numFmt: string | undefined): "exact" | "displayed" | undefined {
  const source = numericToken(cached);
  if (source === undefined) return undefined;
  // A % written beside a plain chart value is still that value.
  const spellings = token.endsWith("%") ? [token, token.slice(0, -1)] : [token];
  for (const written of spellings) {
    if (numericToken(written) === source) return "exact";
    if (displayedChartValuesMatch([written], [source], numFmt)) return "displayed";
  }
  return undefined;
}

/**
 * The page numbers that equal a cached value of each source chart. A chart counts as quoted when
 * two distinct numbers hit it or one hit has at least four significant digits, as for text.
 */
export function matchTemplateChartTokens(
  tokens: readonly string[],
  sources: readonly TemplateChartSource[],
): readonly TemplateChartFigureMatch[] {
  const matches: TemplateChartFigureMatch[] = [];
  for (const source of sources) {
    const hits = new Map<string, "exact" | "displayed">();
    for (const token of tokens) {
      for (const series of source.series) {
        for (const cached of series.values) {
          const mode = scalarMatch(token, cached, series.numFmt);
          if (mode && hits.get(token) !== "exact") hits.set(token, mode);
        }
      }
    }
    const values = [...hits.keys()];
    if (!values.length) continue;
    if (values.length < 2 && significantDigits(values[0]!) < 4) continue;
    matches.push({
      sourcePage: source.sourcePage,
      chartId: source.chartId,
      sourceType: source.grouping || source.type,
      outputTypes: [],
      values,
      valueMatch: [...hits.values()].includes("displayed") ? "displayed" : "exact",
      sourcePeriods: source.sourcePeriods,
    });
  }
  return matches;
}

/** The correction a stale figure asks for: new-period data, or an honest missingItems declaration. */
export function periodUpdateHint(input: {
  name: string;
  page: number;
  values: readonly string[];
  sourcePeriods: readonly string[];
  periodMap: PeriodMap;
}): string {
  const source = input.page > 0 ? `第 ${input.page} 页` : "";
  return (
    `提示：本页的 ${input.values.join("、")} 与资料「${input.name}」${source}的上期数值完全一致` +
    `（期间 ${input.sourcePeriods.join("、")}），而本稿要更新到 ${input.periodMap.to}。` +
    `请换成 ${input.periodMap.to} 的新数据；确实没有本期数据时，请在 write_todo 的 missingItems 里声明该页的图表或表格` +
    "（page 和 title 取自 read_material 的 charts 或 tables 分段），并在交付说明里写明沿用了上期数。" +
    "这条提示不阻止保存。"
  );
}
