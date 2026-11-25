/**
 * Native chart settings for the kinds M5 adds to the categorical path: radar, doughnut,
 * stacked and percent-stacked bars, and gradient series fills. Each one follows what the
 * editor paints (`chart-paint-radar.js`, `chart-paint-doughnut.js`, `chart-paint-stacked.js`,
 * `chart-paint-gradient.js`), so one model drives both surfaces.
 */
import type PptxGenJS from "pptxgenjs";
import type { CategoricalKind, ChartGrouping, PptdProject } from "@open-slidestudio/pptd-v2";
import type { ChartExportModel } from "./chart-map.js";
import { encodeXmlName, fillToPptx, ooxmlGradientFill } from "./export-fill.js";
import { cssPxToPt, HAIRLINE_PT } from "./stroke-units.js";

/** Radar series outline: 2 px, the editor's polygon stroke. */
export const RADAR_OUTLINE_PT = cssPxToPt(2);
/** Radar polygon fill opacity in percent: the editor paints each polygon at 0.2. */
export const RADAR_FILL_PERCENT = 20;
/** Doughnut hole as a percent of the outer radius: the editor's inner radius is half of it. */
export const DOUGHNUT_HOLE_SIZE = 50;
/**
 * Pie and doughnut slice labels show the share of the total, as the editor's "name pct%" labels
 * do. The percent format keeps the share from printing as a value.
 */
export const SLICE_LABEL_FORMAT_CODE = "0%";

/** A series painted with a gradient: its `a:gradFill` XML and the kind that decides its paint targets. */
export type ChartSeriesFill = {
  name: string;
  kind: CategoricalKind;
  gradientXml: string;
};

/** Stacked segments are centred on their own span. Clustered bars sit inside their end. */
export function barLabelPosition(grouping: ChartGrouping): "ctr" | "inEnd" {
  return grouping === "clustered" ? "inEnd" : "ctr";
}

/**
 * pptxgenjs options a chart kind needs beyond the shared categorical options. The caller
 * merges these last, so they win over the defaults for the kind.
 */
export function chartKindOptions(mapped: ChartExportModel, gridColor: string): Partial<PptxGenJS.IChartOpts> {
  if (mapped.pptxType === "radar") {
    return {
      radarStyle: "filled",
      chartColorsOpacity: RADAR_FILL_PERCENT,
      lineSize: RADAR_OUTLINE_PT,
      lineDataSymbol: "none",
      catGridLine: { color: gridColor, size: HAIRLINE_PT },
    };
  }
  if (mapped.pptxType === "pie" || mapped.pptxType === "doughnut") {
    // Name and percentage, as the editor labels slices, unless the element hides its labels
    // (`mapped.showValue` carries that setting). The value field stays off. pptxgenjs also writes
    // category and percent flags of its own, so the chart XML patch clears them when labels are off.
    const sliceLabels = {
      showLabel: mapped.showValue,
      showPercent: mapped.showValue,
      showValue: false,
      dataLabelFormatCode: SLICE_LABEL_FORMAT_CODE,
    };
    return mapped.pptxType === "doughnut"
      ? { ...sliceLabels, holeSize: DOUGHNUT_HOLE_SIZE }
      : { ...sliceLabels, dataLabelPosition: "ctr" };
  }
  if (mapped.pptxType !== "bar" || mapped.grouping === "clustered") return {};
  return {
    barGrouping: mapped.grouping,
    barOverlapPct: 100,
    dataLabelPosition: barLabelPosition(mapped.grouping),
    // Percent-stacked values are shares of the category total, so the axis reads 0 to 100 percent.
    ...(mapped.grouping === "percentStacked" ? { valAxisLabelFormatCode: "0%" } : {}),
  };
}

/** The gradient series in a chart, each with the `a:gradFill` its series paints with. */
export function chartSeriesFills(
  mapped: ChartExportModel,
  theme: PptdProject["presentation"]["theme"],
): ChartSeriesFill[] {
  const fills: ChartSeriesFill[] = [];
  for (const series of mapped.series) {
    if (!series.gradient) continue;
    // The shape mapping keeps the gradient; a chart has no degradation to record for it.
    const shaped = fillToPptx(series.gradient, theme, [], 0, undefined, undefined, "shape");
    if (shaped.type !== "gradient") continue;
    fills.push({
      name: series.name,
      kind: series.pptxType,
      gradientXml: ooxmlGradientFill(shaped),
    });
  }
  return fills;
}

/** Replace the first solid fill in `xml` with the gradient. */
function paintFirstFill(xml: string, gradientXml: string): string {
  return xml.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>/, () => gradientXml);
}

/** Replace the solid fill of the series outline (`a:ln`) with the gradient. */
function paintOutline(xml: string, gradientXml: string): string {
  return xml.replace(
    /(<a:ln\b[^>]*>)<a:solidFill>[\s\S]*?<\/a:solidFill>/,
    (_match, open: string) => `${open}${gradientXml}`,
  );
}

/**
 * Each series' own `c:spPr` takes the gradient fill. A line or radar series also paints its
 * outline with it, as the editor strokes those series with the same paint. A pie or doughnut
 * paints each slice from its own `c:dPt`, so every slice takes the gradient too.
 */
function paintSeries(body: string, fill: ChartSeriesFill): string {
  const seriesSpPr = /<c:spPr>([\s\S]*?)<\/c:spPr>/;
  let next = body.replace(
    seriesSpPr,
    (_match, inner: string) => `<c:spPr>${paintFirstFill(inner, fill.gradientXml)}</c:spPr>`,
  );
  if (fill.kind === "line" || fill.kind === "radar") {
    next = next.replace(
      seriesSpPr,
      (_match, inner: string) => `<c:spPr>${paintOutline(inner, fill.gradientXml)}</c:spPr>`,
    );
  }
  if (fill.kind === "pie" || fill.kind === "doughnut") {
    next = next.replace(/<c:dPt>[\s\S]*?<\/c:dPt>/g, (block) =>
      block.replace(
        /<c:spPr>([\s\S]*?)<\/c:spPr>/,
        (_match, spPr: string) => `<c:spPr>${paintFirstFill(spPr, fill.gradientXml)}</c:spPr>`,
      ),
    );
  }
  return next;
}

/**
 * pptxgenjs writes `c:invertIfNegative` into every series, but a radar series does not allow it
 * (only bar series use it). Drop it from radar parts so the series follows CT_RadarSer.
 */
export function patchRadarSeries(xml: string): string {
  return xml.replace(/<c:radarChart>[\s\S]*?<\/c:radarChart>/g, (block) =>
    block.replace(/<c:invertIfNegative val="[01]"\/>/g, ""),
  );
}

/** Apply the gradient fills to the chart parts' series, pairing each series by its name. */
export function patchSeriesGradients(xml: string, fills: ChartSeriesFill[]): string {
  if (!fills.length) return xml;
  return xml.replace(/<c:ser>([\s\S]*?)<\/c:ser>/g, (match, body: string) => {
    const name = body.match(/<c:tx>[\s\S]*?<c:v>([^<]*)<\/c:v>/)?.[1];
    const fill = fills.find((entry) => encodeXmlName(entry.name) === name);
    return fill ? `<c:ser>${paintSeries(body, fill)}</c:ser>` : match;
  });
}
