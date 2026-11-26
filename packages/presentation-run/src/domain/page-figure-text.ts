/**
 * The text of a written page that figure detection reads: notes plus every element's visible text,
 * table cells and chart data cells. Shared by the material-figure and computed-figure checks.
 */
import { stripHtmlToText } from "@open-slidestudio/pptd-v2";
import { stableSha256 } from "./hashing.js";

function cellText(cell: unknown): string {
  if (typeof cell === "string") return cell;
  if (!cell || typeof cell !== "object") return "";
  const text = (cell as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

function pushTableCells(rows: unknown, push: (value: string) => void): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const text = cellText(cell);
      if (text) push(text);
    }
  }
}

function pushChartCells(data: unknown, push: (value: string) => void): void {
  const rows = isRecord(data) ? data.rows : undefined;
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (typeof cell === "string" || typeof cell === "number") push(String(cell));
    }
  }
}

function pushElementFigureText(element: Record<string, unknown>, push: (value: string) => void): void {
  if (typeof element.text === "string") push(element.text);
  const content = isRecord(element.content) ? element.content : undefined;
  if (typeof content?.text === "string") push(content.text);
  const title = isRecord(element.title) ? element.title : undefined;
  if (typeof title?.text === "string") push(title.text);
  if (element.elementType === "table") pushTableCells(element.rows, push);
  if (element.elementType === "chart") pushChartCells(element.data, push);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Page text that participates in figure detection: notes plus every element's text content. */
export function pageTextForFigures(page: unknown): string {
  if (!page || typeof page !== "object") return "";
  const rec = page as Record<string, unknown>;
  const parts: string[] = [];
  // PPTD rich text is HTML: figure/period detection must see the visible plain
  // text only, so numbers split across spans join and numbers inside style
  // attributes or hex colours never match (C §7-A step 3).
  const push = (value: string): void => {
    const text = stripHtmlToText(value);
    if (text) parts.push(text);
  };
  if (typeof rec.notes === "string") push(rec.notes);
  if (!Array.isArray(rec.elements)) return parts.join("\n");
  for (const raw of rec.elements) {
    if (!raw || typeof raw !== "object") continue;
    pushElementFigureText(raw as Record<string, unknown>, push);
  }
  return parts.join("\n");
}

const NUMBER_TOKEN = /[-+]?\d[\d,]*(?:\.\d+)?%?/g;

/** The page's numbers as written, order-free: a sorted list so repeated values count. */
export function numberTokens(page: unknown): string[] {
  return (pageTextForFigures(page).match(NUMBER_TOKEN) ?? []).sort();
}

/** Identifies a page's number multiset, so a later edit can be compared with a revision whose body is gone. */
export function pageNumbersSha256(page: unknown): string {
  return stableSha256(numberTokens(page));
}
