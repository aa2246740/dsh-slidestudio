/**
 * The numbers a written page states, each tied to the metric the page gives it (CAP-21,
 * VAL-DATA-009, M7-SCR-005). `statedNumbers` ties a number to the label inside its own clause. A page
 * also keeps labels outside the clause, where the flat page text loses them, so they are read from the
 * page itself and bound by these rules:
 *
 * - Table cell: its row header (the first cell of its row) and its column header (the cell of the
 *   first row in its column). A trailing unit in a header (`营收(万元)`) is dropped and a header that
 *   is only a number names nothing, so `Revenue | Q3` and `Q3 | 营收(万元)` give `Revenue Q3` and `Q3 营收`.
 * - Chart data cell: its category (the first cell of its row) and its column name (`data.cols`).
 * - Text, line by line: a line that names no metric of its own (`1502.25`) takes the line just above
 *   it in the same element when that line is a caption (a short label that states no figure).
 * - Text element that names no metric of its own (`1,502.25 万元`): the nearest caption element
 *   directly above it, or directly to its left on the same row, no further away than the taller of
 *   the two boxes. A caption set larger than the value is a heading and never its label, and a
 *   caption in another group is never its label. Ties go to the caption above, then to the earlier
 *   element. No shape or card geometry is read.
 *
 * A number whose own clause names a period but no metric (`Q2 1500`, `2026年Q3 1500`, `3月 1500`; the
 * forms conflict-periods.ts reads) borrows the metric of the label a rule gives it and keeps its own
 * period: it sits closest to what it counts, so its period wins over the label's, and the label's
 * period is used only when the number names none. Without any label it is that period of every
 * metric (key `|Q2`).
 *
 * What these rules leave unlabelled keeps `key: undefined`, which `pageStatesValue` counts for every
 * metric and period: only a number that has no label and no period anywhere in the page input is a
 * wildcard.
 */
import { stripHtmlToText } from "@open-slidestudio/pptd-v2";
import {
  captionKey,
  clausedNumbers,
  headerMetric,
  labelKey,
  namesNoMetric,
  periodBoundKey,
  type ClausedNumber,
  type StatedNumber,
} from "./figure-conflicts.js";

type Rec = Record<string, unknown>;
type Box = readonly [number, number, number, number];
type Placed = Readonly<{
  index: number;
  box: Box;
  groupId: string | undefined;
  fontSize: number | undefined;
}>;
type Caption = Placed & Readonly<{ key: string }>;

/** Slide pixels a caption box may overlap the value it sits above or beside. */
const EDGE_SLACK = 4;
/** A header that is only digits, separators or a percent sign names no metric. */
const NUMBERS_ONLY = /^[\d.,%\s]*$/;
/** Layout roles that carry page chrome, never the label of a figure. */
const CHROME_ROLES = new Set(["footer", "decoration"]);

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plain(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? stripHtmlToText(String(value)) : "";
}

/** Gives the numbers that name no metric of their own the metric of `key`, and their own period. */
function withKey(numbers: readonly ClausedNumber[], key: string | undefined): ClausedNumber[] {
  return numbers.map((number) =>
    number.key === undefined && key !== undefined ? { ...number, key: periodBoundKey(key, number.periods) } : number,
  );
}

/** What no rule bound keeps the period it names, if any, and otherwise names no metric at all. */
function settled({ value, key, periods }: ClausedNumber): StatedNumber {
  return { value, key: key ?? periodBoundKey(undefined, periods) };
}

/** The metric words of a header cell; empty for a bare number or a missing cell. */
function headerWords(cell: unknown): string {
  const { metric } = headerMetric(plain(isRecord(cell) ? cell.text : cell));
  return NUMBERS_ONLY.test(metric) ? "" : metric;
}

function gridKey(rowHeader: string, columnHeader: string): string | undefined {
  const label = [rowHeader, columnHeader].filter(Boolean).join(" ");
  return label ? labelKey(label) : undefined;
}

function tableNumbers(rows: readonly unknown[]): ClausedNumber[] {
  const grid = rows.filter(Array.isArray) as unknown[][];
  const header = grid[0] ?? [];
  return grid.flatMap((row, r) =>
    row.flatMap((cell, c) => {
      const text = plain(isRecord(cell) ? cell.text : cell);
      const key = gridKey(c > 0 ? headerWords(row[0]) : "", r > 0 ? headerWords(header[c]) : "");
      return withKey(clausedNumbers(text), key);
    }),
  );
}

function chartNumbers(data: Rec): ClausedNumber[] {
  const cols = Array.isArray(data.cols) ? data.cols : [];
  const rows = Array.isArray(data.rows) ? data.rows.filter(Array.isArray) : [];
  return (rows as unknown[][]).flatMap((row) =>
    row.flatMap((cell, c) =>
      withKey(clausedNumbers(plain(cell)), gridKey(c > 0 ? headerWords(row[0]) : "", headerWords(cols[c]))),
    ),
  );
}

function boxOf(value: unknown): Box | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const box = value.slice(0, 4);
  if (!box.every((part) => typeof part === "number" && Number.isFinite(part))) return undefined;
  const [x, y, width, height] = box as [number, number, number, number];
  return width > 0 && height > 0 ? [x, y, width, height] : undefined;
}

function placedOf(element: Rec, index: number): Placed | undefined {
  const box = boxOf(element.bounds);
  if (!box) return undefined;
  const content = isRecord(element.content) ? element.content : {};
  return {
    index,
    box,
    groupId: typeof element.groupId === "string" ? element.groupId : undefined,
    fontSize: typeof content.fontSize === "number" ? content.fontSize : undefined,
  };
}

/** The texts an element writes in its own right: the legacy `text` field and `content.text`. */
function ownTexts(element: Rec): string[] {
  const content = isRecord(element.content) ? element.content : {};
  return [element.text, content.text].filter((value): value is string => typeof value === "string");
}

function captionsOf(elements: readonly Rec[]): Caption[] {
  return elements.flatMap((element, index) => {
    const placed = placedOf(element, index);
    const role = typeof element.layoutRole === "string" ? element.layoutRole : "";
    if (!placed || element.hidden === true || CHROME_ROLES.has(role)) return [];
    return ownTexts(element).flatMap((raw) => {
      const key = captionKey(stripHtmlToText(raw));
      return key ? [{ ...placed, key }] : [];
    });
  });
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.min(endA, endB) - Math.max(startA, startB) > 0;
}

/** Distance from a caption to the value it is directly above or directly left of; undefined when it is neither. */
function captionDistance(caption: Box, value: Box): { gap: number; above: boolean } | undefined {
  const [cx, cy, cw, ch] = caption;
  const [vx, vy, vw, vh] = value;
  const limit = Math.max(ch, vh);
  const options: { gap: number; above: boolean }[] = [];
  if (overlaps(cx, cx + cw, vx, vx + vw) && cy + ch <= vy + EDGE_SLACK) {
    options.push({ gap: Math.max(0, vy - (cy + ch)), above: true });
  }
  if (overlaps(cy, cy + ch, vy, vy + vh) && cx + cw <= vx + EDGE_SLACK) {
    options.push({ gap: Math.max(0, vx - (cx + cw)), above: false });
  }
  const near = options.filter((option) => option.gap <= limit);
  return near.sort((a, b) => a.gap - b.gap || Number(b.above) - Number(a.above))[0];
}

function nearestCaption(value: Placed, captions: readonly Caption[]): string | undefined {
  let best: { key: string; gap: number; above: boolean } | undefined;
  for (const caption of captions) {
    if (caption.index === value.index) continue;
    if (caption.groupId !== undefined && value.groupId !== undefined && caption.groupId !== value.groupId) {
      continue;
    }
    if (caption.fontSize !== undefined && value.fontSize !== undefined && caption.fontSize > value.fontSize) {
      continue;
    }
    const distance = captionDistance(caption.box, value.box);
    if (!distance) continue;
    if (!best || distance.gap < best.gap || (distance.gap === best.gap && distance.above && !best.above)) {
      best = { key: caption.key, ...distance };
    }
  }
  return best?.key;
}

function textNumbers(raw: string, where: Placed | undefined, captions: readonly Caption[]): ClausedNumber[] {
  const text = stripHtmlToText(raw);
  const found: ClausedNumber[] = [];
  let above: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    found.push(...withKey(clausedNumbers(line), namesNoMetric(line) ? above : undefined));
    above = captionKey(line);
  }
  if (!where || !found.some((number) => number.key === undefined) || !namesNoMetric(text)) {
    return found;
  }
  return withKey(found, nearestCaption(where, captions));
}

/** Every number the page states (notes, text, table and chart cells), each with the metric it is tied to. */
export function pageStatedNumbers(page: unknown): readonly StatedNumber[] {
  if (!isRecord(page)) return [];
  const elements = Array.isArray(page.elements) ? page.elements.filter(isRecord) : [];
  const captions = captionsOf(elements);
  const found: ClausedNumber[] = [];
  if (typeof page.notes === "string") found.push(...clausedNumbers(stripHtmlToText(page.notes)));
  elements.forEach((element, index) => {
    const where = placedOf(element, index);
    for (const raw of ownTexts(element)) found.push(...textNumbers(raw, where, captions));
    if (isRecord(element.title) && typeof element.title.text === "string") {
      found.push(...clausedNumbers(stripHtmlToText(element.title.text)));
    }
    if (element.elementType === "table" && Array.isArray(element.rows)) {
      found.push(...tableNumbers(element.rows));
    }
    if (element.elementType === "chart" && isRecord(element.data)) {
      found.push(...chartNumbers(element.data));
    }
  });
  return found.map(settled);
}
