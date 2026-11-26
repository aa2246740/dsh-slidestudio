/**
 * Chinese refusals for M5 effect values: element shadows and gradient stop alpha on
 * every filled surface. The JSON schema cannot bound numbers, so the ranges live here.
 * Messages name the field; callers add the element or page prefix.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isUnitInterval = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Refusals for one shadow object, relative to the shadow (for example `shadow.blur …`). */
export function shadowIssues(shadow: unknown): string[] {
  if (!isRecord(shadow)) return [];
  const issues: string[] = [];
  if (
    shadow.blur !== undefined &&
    !(typeof shadow.blur === "number" && Number.isFinite(shadow.blur) && shadow.blur >= 0)
  ) {
    issues.push("shadow.blur 必须是大于等于 0 的数字");
  }
  if (shadow.opacity !== undefined && !isUnitInterval(shadow.opacity)) {
    issues.push("shadow.opacity 必须是 0 到 1 之间的数字");
  }
  for (const key of ["offsetX", "offsetY"] as const) {
    const value = shadow[key];
    if (value !== undefined && !(typeof value === "number" && Number.isFinite(value))) {
      issues.push(`shadow.${key} 必须是有限的数字`);
    }
  }
  return issues;
}

/** Refusals for the stop alpha of one fill, relative to the fill (for example `.stops[1].alpha …`). */
function fillAlphaIssues(fill: unknown): string[] {
  if (!isRecord(fill) || fill.type !== "gradient" || !Array.isArray(fill.stops)) return [];
  return fill.stops.flatMap((stop: unknown, index: number) =>
    isRecord(stop) && stop.alpha !== undefined && !isUnitInterval(stop.alpha)
      ? [`.stops[${index}].alpha 必须是 0 到 1 之间的数字`]
      : [],
  );
}

/** Stop-alpha refusals for one fill in a single-fill write, with the `$` root path. */
export function fillEffectIssues(fill: unknown): string[] {
  return fillAlphaIssues(fill).map((suffix) => `$${suffix}`);
}

/**
 * Every M5 effect refusal in a page: the page background, then each element's shadow
 * and the stop alpha of its fills (shape, icon, table cells, chart series and chart background).
 */
export function effectIssues(args: { background?: unknown; elements: unknown }): string[] {
  const issues = fillAlphaIssues(args.background).map((suffix) => `$.background${suffix}`);
  if (!Array.isArray(args.elements)) return issues;
  args.elements.forEach((item: unknown, index: number) => {
    if (!isRecord(item)) return;
    const where = `$.elements[${index}]（elementId "${String(item.elementId ?? "")}"）的`;
    for (const issue of shadowIssues(item.shadow)) issues.push(`${where} ${issue}`);
    const fills: [string, unknown][] = [];
    if (item.elementType === "shape" || item.elementType === "icon") {
      fills.push(["fill", item.fill]);
    }
    if (item.elementType === "table" && Array.isArray(item.rows)) {
      item.rows.forEach((row: unknown, rowIndex: number) => {
        if (!Array.isArray(row)) return;
        row.forEach((cell: unknown, cellIndex: number) => {
          if (isRecord(cell)) fills.push([`rows[${rowIndex}][${cellIndex}].fill`, cell.fill]);
        });
      });
    }
    if (item.elementType === "chart") {
      if (Array.isArray(item.series)) {
        item.series.forEach((series: unknown, seriesIndex: number) => {
          if (isRecord(series)) fills.push([`series[${seriesIndex}].fill`, series.fill]);
        });
      }
      fills.push(["background", item.background]);
    }
    for (const [label, fill] of fills) {
      for (const suffix of fillAlphaIssues(fill)) issues.push(`${where} ${label}${suffix}`);
    }
  });
  return issues;
}
