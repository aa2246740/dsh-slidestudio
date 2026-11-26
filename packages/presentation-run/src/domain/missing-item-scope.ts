/**
 * Which stale figures a `missingItems` declaration answers for. A declaration names one chart or
 * one table, so it quiets exactly the figures that trace to that item. Another chart or table on
 * the same template page that a page still copies an old value from is hinted as before.
 *
 * A chart figure traces to its chart by id. A figure found in the slide and table text traces to
 * the tables of that page whose cells state it, and counts as answered only when every such table
 * is declared; a figure no table states (free slide text) is answered by no declaration.
 */
import type { MaterialFigureMatch } from "./material-figures.js";
import type { MissingItem } from "./missing-items.js";
import { extractStrongNumbers } from "./strong-numbers.js";
import { readTemplateItems } from "./template-items.js";

type TableFigures = Readonly<{
  key: string;
  materialId: string;
  page: number;
  numbers: ReadonlySet<string>;
}>;

const itemKey = (materialId: string, kind: string, itemId: string): string => `${materialId}|${kind}|${itemId}`;

export function declaredMissingMatcher(
  root: string,
  contextEpochId: string,
  declared: readonly MissingItem[],
): (match: MaterialFigureMatch) => boolean {
  if (!declared.length) return () => false;
  const declaredKeys = new Set(declared.map((item) => itemKey(item.materialId, item.kind, item.itemId)));
  let tables: readonly TableFigures[] | undefined;
  const tablesStating = (match: MaterialFigureMatch): readonly TableFigures[] => {
    tables ??= readTemplateItems(root, contextEpochId).flatMap((item) =>
      item.kind === "table"
        ? [
            {
              key: itemKey(item.materialId, item.kind, item.itemId),
              materialId: item.materialId,
              page: item.sourcePage,
              numbers: new Set(extractStrongNumbers(item.cellText ?? "")),
            },
          ]
        : [],
    );
    return tables.filter(
      (table) =>
        table.materialId === match.materialId && table.page === match.sourcePage && table.numbers.has(match.value),
    );
  };
  return (match) => {
    if (match.chart) {
      return declaredKeys.has(itemKey(match.materialId, "chart", match.chart.sourceChartId));
    }
    const holders = tablesStating(match);
    return holders.length > 0 && holders.every((table) => declaredKeys.has(table.key));
  };
}
