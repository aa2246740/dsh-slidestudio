import { normalizeChartInput } from "./domain/skill-pages.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function unwrapItem(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => unwrapItem(item, depth + 1));
  const rec = asRecord(value);
  if (!rec) return value;
  if (Object.keys(rec).length === 1 && "item" in rec) return unwrapItem(rec.item, depth + 1);
  return rec;
}

function isChartElement(raw: unknown): boolean {
  const rec = asRecord(unwrapItem(raw));
  if (!rec) return false;
  const type = String(rec.elementType ?? rec.type ?? "").toLowerCase();
  return type === "chart" || rec.chart != null || rec.chartType != null;
}

function chartHasPptdData(rec: Record<string, unknown>): boolean {
  const normalized = normalizeChartInput(rec);
  const data = asRecord(normalized.data);
  return Boolean(
    data && Array.isArray(data.cols) && Array.isArray(data.rows) && data.cols.length >= 2 && data.rows.length > 0,
  );
}

export type ChartGateResult =
  { readonly ok: true; readonly charts: number } | { readonly ok: false; readonly detail: string };

/**
 * OpenKimi PPTD charts are `data.cols` + `data.rows`. claim/dataRef/whyChart are
 * optional provenance, not a substitute for series data. A hollow chart must fail
 * closed instead of being silently dropped after write_page reports written.
 */
export function assertChartEvidence(args: Record<string, unknown>): ChartGateResult {
  const elements = unwrapItem(args.elements);
  const list = Array.isArray(elements) ? elements : [];
  const charts = list.filter(isChartElement);
  if (charts.length === 0) return { ok: true, charts: 0 };
  for (const [index, chart] of charts.entries()) {
    const rec = asRecord(unwrapItem(chart));
    if (!rec || !chartHasPptdData(rec)) {
      return {
        ok: false,
        detail: `chart ${index} missing PPTD data.cols/rows; host will not invent or drop a figure`,
      };
    }
  }
  return { ok: true, charts: charts.length };
}
