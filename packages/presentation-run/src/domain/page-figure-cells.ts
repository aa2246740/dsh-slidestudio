/**
 * Page cells that hold one whole figure: chart values and table numbers. The
 * vision check reads such a cell as data, so its bare digit can state a read
 * percentage under a % header. Running text is not data (see vision-values.ts).
 */
import { stripHtmlToText } from "@open-slidestudio/pptd-v2";
import { isWholeFigure } from "./vision-values.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The whole-figure cells of a page's native charts and tables, as written. */
export function pageNumberCellsForFigures(page: unknown): string[] {
  const elements = isRecord(page) && Array.isArray(page.elements) ? page.elements : [];
  const cells: string[] = [];
  const keepRows = (rows: unknown): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const value = isRecord(cell) ? cell.text : cell;
        if (typeof value !== "string" && typeof value !== "number") continue;
        const text = stripHtmlToText(String(value));
        if (isWholeFigure(text)) cells.push(text);
      }
    }
  };
  for (const element of elements) {
    if (!isRecord(element)) continue;
    if (element.elementType === "table") keepRows(element.rows);
    if (element.elementType === "chart" && isRecord(element.data)) keepRows(element.data.rows);
  }
  return cells;
}
