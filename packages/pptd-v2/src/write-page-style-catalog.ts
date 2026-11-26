import { record } from "./write-page-diagnostics.js";

type MoveRule = {
  source: string;
  destination: readonly string[];
  solidFill?: true;
};

const TEXT_MOVES: readonly MoveRule[] = ["align", "fontSize", "color", "bold", "text", "backgroundColor"].map(
  (source) => ({ source, destination: ["content", source] }),
);
const BACKGROUND_MOVES: readonly MoveRule[] = [{ source: "backgroundColor", destination: ["fill"], solidFill: true }];
const CONTENT_ELEMENT_MOVES = ["elementId", "elementType", "layoutRole"] as const;
const CONTENT_ELEMENT_MOVE_SET: ReadonlySet<string> = new Set(CONTENT_ELEMENT_MOVES);
const TABLE_CELL_HINTS: Readonly<Record<string, string>> = {
  fontSize:
    "table cells have no fontSize field; use a text element with content.fontSize or keep the cell text unstyled",
};

/** Only these placements have a single, lossless interpretation. */
function rules(kind: unknown): readonly MoveRule[] {
  if (kind === "text") return TEXT_MOVES;
  if (kind === "shape" || kind === "table-cell") return BACKGROUND_MOVES;
  return [];
}

function moveStyles(candidate: Record<string, unknown>, kind: unknown, path: string): string[] {
  const notes: string[] = [];
  for (const rule of rules(kind)) {
    if (!Object.hasOwn(candidate, rule.source)) continue;
    const [first, second] = rule.destination;
    if (!first) continue;
    let target = candidate;
    if (second) {
      if (Object.hasOwn(candidate, first) && !record(candidate[first])) continue;
      target = record(candidate[first]) ?? {};
    }
    const key = second ?? first;
    // Even identical duplicate values stay untouched: never choose a winner.
    if (Object.hasOwn(target, key)) continue;
    const value = candidate[rule.source];
    target[key] = rule.solidFill ? { type: "solid", color: value } : value;
    if (second) candidate[first] = target;
    delete candidate[rule.source];
    notes.push(`${path}.${rule.source} -> ${path}.${rule.destination.join(".")}`);
  }
  return notes;
}

function moveContentElementFields(element: Record<string, unknown>, path: string): string[] {
  const content = record(element.content);
  if (!content) return [];
  const notes: string[] = [];
  for (const key of CONTENT_ELEMENT_MOVES) {
    if (!Object.hasOwn(content, key) || Object.hasOwn(element, key)) continue;
    element[key] = content[key];
    delete content[key];
    notes.push(`${path}.content.${key} -> ${path}.${key}`);
  }
  return notes;
}

export function normalizeMisplacedStyles(args: Record<string, unknown>): string[] {
  if (!Array.isArray(args.elements)) return [];
  const notes: string[] = [];
  for (const [index, value] of args.elements.entries()) {
    const element = record(value);
    if (!element) continue;
    const path = `$.elements[${index}]`;
    notes.push(...moveContentElementFields(element, path));
    notes.push(...moveStyles(element, element.elementType, path));
    if (element.elementType !== "table" || !Array.isArray(element.rows)) continue;
    for (const [rowIndex, row] of element.rows.entries()) {
      if (!Array.isArray(row)) continue;
      for (const [cellIndex, value] of row.entries()) {
        const cell = record(value);
        if (cell) notes.push(...moveStyles(cell, "table-cell", `${path}.rows[${rowIndex}][${cellIndex}]`));
      }
    }
  }
  return notes;
}

export function misplacedStyleIssue(candidate: Record<string, unknown>, key: string, path: string): string {
  if (key === "content" && path.startsWith("$.elements[") && candidate.elementType !== "text") {
    return `${path}.content is not allowed; content belongs to text elements (use elementType "text" with content.text)`;
  }
  if (path.endsWith(".content") && CONTENT_ELEMENT_MOVE_SET.has(key)) {
    const elementPath = path.slice(0, -".content".length);
    return `${path}.${key} is not allowed; move to ${elementPath}.${key} (element fields belong on the owning element)`;
  }
  const isTableCell = /\.rows\[\d+\]\[\d+\]$/.test(path);
  if (isTableCell && TABLE_CELL_HINTS[key]) {
    return `${path}.${key} is not allowed; ${TABLE_CELL_HINTS[key]}`;
  }
  const kind = isTableCell ? "table-cell" : candidate.elementType;
  const rule = rules(kind).find((rule) => rule.source === key);
  const hint = rule
    ? `; move to ${path}.${rule.destination.join(".")}${rule.solidFill ? ' as {type:"solid",color}' : ""} (destination must be absent; resolve conflicting values explicitly)`
    : "";
  return `${path}.${key} is not allowed${hint}`;
}
