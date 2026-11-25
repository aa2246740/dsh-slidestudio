import type {
  ChartElement,
  Fill,
  IconElement,
  LineElement,
  PptdElement,
  ShapeElement,
  TableElement,
  TextElement,
} from "./types.js";
import { chartKindIssues } from "./chart-kind-rules.js";
import { typeIssue } from "./write-page-diagnostics.js";
import { imageClipIssues } from "./image-clip.js";
import { effectIssues } from "./effect-issues.js";

function emptyGradientIssue(candidate: Fill | string | undefined, path: string): string | undefined {
  if (typeof candidate !== "string" && candidate?.type === "gradient" && candidate.stops.length === 0) {
    return `${path}.stops must not be empty`;
  }
  return undefined;
}

function identityIssues(element: PptdElement, path: string, ids: Set<string>): string[] {
  const issues: string[] = [];
  if (!element.elementId.trim()) issues.push(`${path}.elementId must not be empty`);
  else if (ids.has(element.elementId)) issues.push(`${path}.elementId must be unique`);
  else ids.add(element.elementId);
  if (element.bounds.length !== 4) issues.push(`${path}.bounds must contain exactly 4 numbers`);
  else if (element.bounds[2] <= 0 || element.bounds[3] <= 0) {
    issues.push(`${path}.bounds width and height must be positive`);
  }
  return issues;
}

function textIssues(element: TextElement, path: string): string[] {
  if (element.content.align && element.content.align.length !== 2) {
    return [`${path}.content.align must contain exactly 2 strings`];
  }
  return [];
}

function lineIssues(element: LineElement, path: string): string[] {
  const issues: string[] = [];
  if (element.viewBox.length !== 2) issues.push(`${path}.viewBox must contain exactly 2 numbers`);
  if (element.arrow && element.arrow.length !== 2) {
    issues.push(`${path}.arrow must contain exactly 2 values`);
  }
  if (element.connects && element.connects.length !== 2) {
    issues.push(`${path}.connects must contain exactly 2 ids`);
  }
  return issues;
}

function tableCellIssues(cell: TableElement["rows"][number][number], path: string): string[] {
  const issues: string[] = [];
  if (cell.rowSpan !== undefined && cell.rowSpan < 1) {
    issues.push(`${path}.rowSpan must be at least 1`);
  }
  if (cell.colSpan !== undefined && cell.colSpan < 1) {
    issues.push(`${path}.colSpan must be at least 1`);
  }
  if (cell.align && cell.align.length !== 2) {
    issues.push(`${path}.align must contain exactly 2 strings`);
  }
  const fill = emptyGradientIssue(cell.fill, `${path}.fill`);
  if (fill) issues.push(fill);
  return issues;
}

function tableIssues(element: TableElement, path: string): string[] {
  const issues: string[] = [];
  if (element.columnWidths.length === 0) issues.push(`${path}.columnWidths must not be empty`);
  for (const [columnIndex, width] of element.columnWidths.entries()) {
    if (width <= 0) issues.push(`${path}.columnWidths[${columnIndex}] must be positive`);
  }
  if (element.rows.length === 0) issues.push(`${path}.rows must not be empty`);
  for (const [rowIndex, row] of element.rows.entries()) {
    if (row.length !== element.columnWidths.length) {
      issues.push(`${path}.rows[${rowIndex}] must match columnWidths length`);
    }
    for (const [cellIndex, cell] of row.entries()) {
      issues.push(...tableCellIssues(cell, `${path}.rows[${rowIndex}][${cellIndex}]`));
    }
  }
  if (element.rowHeights && element.rowHeights.length !== element.rows.length) {
    issues.push(`${path}.rowHeights must match rows length`);
  }
  for (const [rowIndex, height] of (element.rowHeights ?? []).entries()) {
    if (height <= 0) issues.push(`${path}.rowHeights[${rowIndex}] must be positive`);
  }
  return issues;
}

function chartSeriesIssues(element: ChartElement, path: string): string[] {
  const issues: string[] = [];
  for (const [seriesIndex, series] of element.series.entries()) {
    for (const [key, value] of Object.entries(series.encode ?? {})) {
      if (typeof value !== "string") {
        issues.push(typeIssue(`${path}.series[${seriesIndex}].encode.${key}`, "a string", value));
      }
    }
    const fill = emptyGradientIssue(series.fill, `${path}.series[${seriesIndex}].fill`);
    if (fill) issues.push(fill);
  }
  return issues;
}

function chartIssues(element: ChartElement, path: string): string[] {
  const issues: string[] = [];
  if (element.data.cols.length === 0) issues.push(`${path}.data.cols must not be empty`);
  if (element.data.rows.length === 0) issues.push(`${path}.data.rows must not be empty`);
  for (const [rowIndex, row] of element.data.rows.entries()) {
    if (row.length !== element.data.cols.length) {
      issues.push(`${path}.data.rows[${rowIndex}] must match data.cols length`);
    }
  }
  if (element.series.length === 0) issues.push(`${path}.series must not be empty`);
  issues.push(...chartKindIssues(element, path), ...chartSeriesIssues(element, path));
  const background = emptyGradientIssue(element.background, `${path}.background`);
  if (background) issues.push(background);
  return issues;
}

function elementSemanticIssues(element: PptdElement, path: string, ids: Set<string>): string[] {
  const issues = identityIssues(element, path, ids);
  if (element.elementType === "text") issues.push(...textIssues(element as TextElement, path));
  if (element.elementType === "line") issues.push(...lineIssues(element as LineElement, path));
  if (element.elementType === "table") issues.push(...tableIssues(element as TableElement, path));
  if (element.elementType === "chart") issues.push(...chartIssues(element as ChartElement, path));
  if (element.elementType === "shape") {
    const fill = emptyGradientIssue((element as ShapeElement).fill, `${path}.fill`);
    if (fill) issues.push(fill);
  }
  if (element.elementType === "icon") {
    const fill = emptyGradientIssue((element as IconElement).fill, `${path}.fill`);
    if (fill) issues.push(fill);
  }
  return issues;
}

/** Cross-field rules that the JSON schema cannot express for a complete page. */
export function semanticIssues(args: { id: string; background?: Fill; elements: PptdElement[] }): string[] {
  const issues: string[] = [];
  if (!args.id.trim()) issues.push("$.id must not be empty");
  if (args.elements.length === 0) issues.push("$.elements must not be empty");
  const background = emptyGradientIssue(args.background, "$.background");
  if (background) issues.push(background);
  issues.push(...imageClipIssues(args.elements));
  issues.push(...effectIssues({ background: args.background, elements: args.elements }));
  const ids = new Set<string>();
  for (const [index, element] of args.elements.entries()) {
    issues.push(...elementSemanticIssues(element, `$.elements[${index}]`, ids));
  }
  return issues;
}
