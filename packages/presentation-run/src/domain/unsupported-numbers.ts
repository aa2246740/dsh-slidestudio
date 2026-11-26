/**
 * Chart and table numbers on a page that claims its data comes from the materials, but that no read
 * file segment and no `query_material` result of this epoch holds. A model that copies numbers from
 * memory writes plausible values near the real cells; the check names them in a non-blocking hint so
 * the Agent can copy the real ones, leave the point blank, or relabel the page as illustrative.
 */
import type { MaterialFigureReading } from "./material-figures.js";
import { figureTokens } from "./material-query-figures.js";

const MAX_EXAMPLES = 5;

function roundedKey(value: number, decimals: number): string {
  const scale = 10 ** decimals;
  return (Math.round(Math.abs(value) * scale) / scale).toFixed(decimals);
}

/** The numbers the read files state, as magnitudes: segment text, then template chart cache values. */
function fileMagnitudes(readings: readonly MaterialFigureReading[]): readonly number[] {
  const magnitudes: number[] = [];
  const addText = (text: string): void => {
    for (const token of figureTokens(text)) magnitudes.push(token.magnitude);
  };
  for (const reading of readings) {
    for (const page of reading.pages) addText(page.text);
    for (const chart of reading.templateCharts ?? []) {
      for (const series of chart.series) {
        for (const cell of series.values) {
          if (typeof cell === "number" && Number.isFinite(cell)) magnitudes.push(Math.abs(cell));
        }
      }
    }
  }
  return magnitudes;
}

/**
 * The whole-figure cells (`pageNumberCellsForFigures`) whose number is in no read file segment and
 * is not a computed cell. Matching follows the precision the page shows: 89.6 states 89.64. Years,
 * small counts and 100% are not figures (the M2 rules of `figureTokens`). Without any reading or
 * computed cell there is nothing to compare with, so nothing is reported.
 */
export function unsupportedPageNumbers(input: {
  pageNumbers: readonly string[];
  readings: readonly MaterialFigureReading[];
  computedCells: number;
  isComputed: (value: string) => boolean;
}): readonly string[] {
  const files = fileMagnitudes(input.readings);
  if (!files.length && !input.computedCells) return [];
  const byDecimals = new Map<number, ReadonlySet<string>>();
  const filesAt = (decimals: number): ReadonlySet<string> => {
    let keys = byDecimals.get(decimals);
    if (!keys) {
      keys = new Set(files.map((value) => roundedKey(value, decimals)));
      byDecimals.set(decimals, keys);
    }
    return keys;
  };
  const found: string[] = [];
  for (const cell of input.pageNumbers) {
    for (const token of figureTokens(cell)) {
      if (found.includes(token.raw)) continue;
      if (filesAt(token.decimals).has(roundedKey(token.magnitude, token.decimals))) continue;
      if (input.isComputed(token.raw)) continue;
      found.push(token.raw);
    }
  }
  return found;
}

/** Non-blocking hint naming up to five of the numbers; undefined when there are none. */
export function unsupportedNumbersHint(values: readonly string[]): string | undefined {
  if (!values.length) return undefined;
  const examples = values.slice(0, MAX_EXAMPLES).join("、");
  return (
    `提示：本页图表和表格里有 ${values.length} 个数值没有出现在已读资料或计算结果里（例如 ${examples}）。` +
    "标为来自资料的数据要照抄资料，或用 query_material 算出来；确实没有数据的位置请留空并写明「暂无本期数据」，" +
    "示意数据请把本页的来源改标为示意。这条提示不阻止保存。"
  );
}
