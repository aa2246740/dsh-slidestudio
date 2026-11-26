/**
 * Chart XML post-passes for the native exporter. pptxgenjs writes the chart parts; these
 * functions correct what it cannot express (series formats, legend layout, label positions,
 * pie separators, horizontal bar crossing), then pair each part with its ChartPatch.
 */
import type JSZip from "jszip";
import type { LegendPosition, Rect } from "@open-slidestudio/pptd-v2";
import { patchRadarSeries, patchSeriesGradients, type ChartSeriesFill } from "./export-chart-kinds.js";
import { patchChartFonts } from "./export-slide-xml.js";

export type ChartPatch = {
  slideIndex: number;
  elementId: string;
  /** Per-series Excel format codes, in declared series order. */
  seriesFormatCodes: string[];
  /** Series names written into the chart, used to pair a part back here. */
  seriesNames: string[];
  /**
   * Combo charts only: the declared series index of each `c:ser` in part
   * document order. pptxgenjs numbers idx/order by written position after
   * grouping the declaration by type, which renumbers a bar, line, bar model;
   * these values restore the model's identity and order.
   */
  seriesIndexes?: number[];
  legend?: { position: LegendPosition; layout?: Rect };
  /** ManualLayout fractions of the chart element for the plot area. */
  plotLayout?: { x: number; y: number; w: number; h: number };
  barHorizontal?: boolean;
  pie?: boolean;
  radar?: boolean;
  /** `false` when the element hides its data labels: every label show flag is cleared in the XML. */
  labels?: boolean;
  /** Gradient series fills, written as `a:gradFill` in each series' `c:spPr`. */
  seriesFills?: ChartSeriesFill[];
  /** MiSans needs matching ea/cs typefaces for CJK labels. */
  fontFace: string;
};

/** Escape an XML attribute value the same way pptxgenjs does. */
function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * pptxgenjs writes one chart-level `dataLabelFormatCode` under each series'
 * `dLbls`. Per-series precision differs (0.091 vs 8.641 in the same chart), so
 * rewrite each `<c:ser>`'s `dLbls/numFmt` with the series' own format code.
 */
function patchSeriesFormatCodes(xml: string, formatCodes: string[]): string {
  let index = 0;
  return xml.replace(/<c:ser>([\s\S]*?)<\/c:ser>/g, (match, body: string) => {
    const code = formatCodes[index];
    index += 1;
    if (!code) return match;
    const replaced = body.replace(
      /<c:dLbls>([\s\S]*?)<\/c:dLbls>/,
      (block, inner: string) =>
        `<c:dLbls>${inner.replace(
          /<c:numFmt formatCode="[^"]*" sourceLinked="0"\/>/,
          `<c:numFmt formatCode="${xmlAttr(code)}" sourceLinked="0"/>`,
        )}</c:dLbls>`,
    );
    return `<c:ser>${replaced}</c:ser>`;
  });
}

/**
 * Pptxgenjs writes `c:idx`/`c:order` from the position in the part after it
 * concatenated the type groups, so a bar, line, bar declaration is renumbered
 * bar, bar, line and the legend loses the model's order. OOXML numbers both
 * across the whole chart (a line group's series may carry smaller values than
 * a later bar group's), so each series' pair is rewritten to its declared
 * index. The workbook references stay per written series: every `c:ser` keeps
 * its own name, categories and values, so the semantic references stay
 * consistent without moving embedded workbook columns.
 */
function patchSeriesIndexes(xml: string, indexes: number[]): string {
  let position = 0;
  return xml.replace(/<c:ser>([\s\S]*?)<\/c:ser>/g, (match, body: string) => {
    const index = indexes[position];
    position += 1;
    if (index === undefined) return match;
    const replaced = body
      .replace(/<c:idx val="\d+"\/>/, `<c:idx val="${index}"/>`)
      .replace(/<c:order val="\d+"\/>/, `<c:order val="${index}"/>`);
    return `<c:ser>${replaced}</c:ser>`;
  });
}

/**
 * Pptxgenjs never writes a legend manualLayout, so PowerPoint drops the
 * legend wherever it wants. Inject the shared layout rect so legend position
 * matches the canvas, right after `<c:legendPos>` per the schema.
 */
function patchLegendLayout(xml: string, patch: ChartPatch): string {
  if (!patch.legend?.layout) return xml;
  const { x, y, w, h } = patch.legend.layout;
  const manual =
    `<c:layout><c:manualLayout>` +
    `<c:layoutTarget val="outer"/>` +
    `<c:xMode val="edge"/><c:yMode val="edge"/>` +
    `<c:x val="${x.toFixed(6)}"/><c:y val="${y.toFixed(6)}"/>` +
    `<c:w val="${w.toFixed(6)}"/><c:h val="${h.toFixed(6)}"/>` +
    `</c:manualLayout></c:layout>`;
  // CT_Legend: legendPos → legendEntry → layout → overlay → txPr …
  return xml.replace(/<c:legend>([\s\S]*?)<\/c:legend>/, (match, inner: string) =>
    inner.includes("<c:layout>")
      ? match
      : `<c:legend>${inner.replace(/(<c:legendPos val="[a-z]+"\/>)/, `$1${manual}`)}</c:legend>`,
  );
}

/**
 * Pie and doughnut labels: the canvas renders "name pct%". pptxgenjs only writes
 * `showCatName`/`showPercent`; without a separator PowerPoint jams them. CT_DLbls puts
 * `separator` after `showBubbleSize` and before `showLeaderLines`, so it goes there.
 * `c:separator` is element text (xsd:string), not an attribute, so the space is the text.
 */
function patchPieSeparator(xml: string): string {
  return xml.replace(
    /(<c:showBubbleSize val="[01]"\/>)(?=\s*<c:showLeaderLines|\s*<\/c:dLbl>)/g,
    `$1<c:separator> </c:separator>`,
  );
}

/**
 * An element saved with `labels:false` shows no data labels in the editor. pptxgenjs writes its
 * own category and percent flags for pie and doughnut slices whatever the options say, so every
 * show flag in each `c:dLbls` (series, chart type and point) is cleared here.
 */
function patchHiddenLabels(xml: string): string {
  return xml.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g, (block) =>
    block.replace(
      /<c:(showLegendKey|showVal|showCatName|showSerName|showPercent|showBubbleSize) val="1"\/>/g,
      '<c:$1 val="0"/>',
    ),
  );
}

/**
 * Horizontal bars use a `maxMin` category axis; PowerPoint then pins the
 * value axis to the top unless the value axis crosses at max.
 */
function patchHorizontalBarCrossing(xml: string): string {
  return xml.replace(/<c:valAx>([\s\S]*?)<\/c:valAx>/g, (match) =>
    match.includes("<c:crosses")
      ? match.replace(/<c:crosses val="[^"]*"\/>/, '<c:crosses val="max"/>')
      : match.replace(/(<c:axId[^/]*\/>)/, `$1<c:crosses val="max"/>`),
  );
}

/**
 * The canvas draws bar labels just past the bar end and line labels above the
 * point. OOXML allows `outEnd` on clustered bars (not stacked), but the
 * pptxgenjs 3.12 validator has that rule inverted and drops `outEnd` from
 * clustered bars, so the chart is generated with `inEnd` and corrected here.
 * Line labels get `t`; pptxgenjs writes none for a standalone line (PowerPoint
 * then defaults to the right) and the shared combo position for a combo line.
 */
function patchDataLabelPositions(xml: string): string {
  const setPos = (block: string, pos: string) =>
    block.replace(/<c:dLbls>([\s\S]*?)<\/c:dLbls>/g, (_match, inner: string) => {
      const next = /<c:dLblPos val="[^"]*"\/>/.test(inner)
        ? inner.replace(/<c:dLblPos val="[^"]*"\/>/, `<c:dLblPos val="${pos}"/>`)
        : inner.replace(/(\s*<c:showLegendKey)/, `<c:dLblPos val="${pos}"/>$1`);
      return `<c:dLbls>${next}</c:dLbls>`;
    });
  return xml
    .replace(/<c:barChart>[\s\S]*?<\/c:barChart>/g, (block) =>
      /<c:grouping val="clustered"\/>/.test(block) ? setPos(block, "outEnd") : block,
    )
    .replace(/<c:lineChart>[\s\S]*?<\/c:lineChart>/g, (block) => setPos(block, "t"));
}

/** Apply every chart patch to `ppt/charts/chart*.xml`, in slide order. */
export async function patchChartXml(zip: JSZip, charts: ChartPatch[]): Promise<void> {
  if (!charts.length) return;
  // pptxgenjs names chart parts chart1.xml…chartN.xml in addChart order.
  // A stacked waterfall can be split into two chart parts for one call, so
  // the part count may exceed the call count. The slide-order pairing still
  // holds: walk parts in the same order as `charts` and reuse the last
  // pending patch for any extra part belonging to the same call.
  const partNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/chart(\d+)\.xml/)?.[1]) - Number(b.match(/chart(\d+)\.xml/)?.[1]));
  if (partNames.length < charts.length) {
    throw new Error(`native exporter: expected at least ${charts.length} chart parts, found ${partNames.length}`);
  }
  // Pair each part to the chart whose series names it contains. A split
  // stacked chart shares names across its parts, so the first matching
  // unconsumed patch wins and stays available for the extra part.
  const pending = charts.map((patch) => ({ patch, matched: false }));
  for (const [index, rel] of partNames.entries()) {
    const file0 = zip.file(rel);
    if (!file0) continue;
    const preview = await file0.async("string");
    const owner =
      pending.find(
        (entry) => !entry.matched && entry.patch.seriesNames.some((name) => preview.includes(xmlAttr(name))),
      ) ?? pending.find((entry) => entry.matched);
    const patch = owner?.patch ?? charts[Math.min(index, charts.length - 1)]!;
    if (owner && !owner.matched) owner.matched = true;
    const file = zip.file(rel);
    if (!file) {
      throw new Error(`native exporter: ${rel} missing while patching ${patch.elementId}`);
    }
    let xml = await file.async("string");
    xml = patchChartFonts(xml);
    xml = patchSeriesFormatCodes(xml, patch.seriesFormatCodes);
    if (patch.seriesIndexes) xml = patchSeriesIndexes(xml, patch.seriesIndexes);
    xml = patchSeriesGradients(xml, patch.seriesFills ?? []);
    xml = patchLegendLayout(xml, patch);
    xml = patchDataLabelPositions(xml);
    if (patch.pie) xml = patchPieSeparator(xml);
    if (patch.labels === false) xml = patchHiddenLabels(xml);
    if (patch.radar) xml = patchRadarSeries(xml);
    if (patch.barHorizontal) xml = patchHorizontalBarCrossing(xml);
    zip.file(rel, xml);
  }
}
