/**
 * Cached chart data shared by the Word and Excel parsers (CAP-33). Only
 * cached OOXML values are read through the same reader as PPTX charts, so
 * all three formats expose one shape; Word/Excel records carry `slide: null`
 * (no slide) instead of PPTX's page number. External chart targets are never
 * fetched, and a container with more charts than the cap keeps the first
 * MAX_OFFICE_CHARTS with a Chinese warning.
 */
import { attrOf, descendantsOf, parseRels, parseXml, resolvePartPath } from "./ooxml.mjs";
import { readChart } from "./pptx-charts.mjs";

export const MAX_OFFICE_CHARTS = 100;

const CHART_REL = "chart";
/** Charts reference no slide and no frame box outside a presentation. */
const NOT_IN_SLIDE = { slide: null, box: null };
const EMPTY_THEME = { colors: {}, fonts: {} };

/**
 * The `c:chart` relationship ids the container part's own XML references
 * through `<c:chart r:id="…"/>` drawing elements. A relationship-table entry
 * no container element points at (an orphan rel) never appears here, so a
 * leftover unused chart part is not mistaken for an embedded chart.
 * @param {import("./ooxml.mjs").PackageReader} pkg
 * @param {string} containerPart
 * @returns {Set<string>}
 */
function referencedChartIds(pkg, containerPart) {
  const text = pkg.text(containerPart);
  if (text === undefined) return new Set();
  const root = parseXml(text, containerPart);
  const ids = new Set();
  for (const chart of descendantsOf(root, "chart")) {
    const id = attrOf(chart, "r:id");
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Read the chart parts the container part actually embeds: a `chart`
 * relationship counts only when the container's own XML references it through
 * a `c:chart r:id` element; orphan relationship-table entries are ignored.
 * A missing or unparsable part is skipped; external targets stay unread. The
 * result is empty (never an error) for a container without referenced charts.
 * @param {import("./ooxml.mjs").PackageReader} pkg
 * @param {string} containerPart the part whose drawings embed the charts
 *   (`word/document.xml`, or a drawing part for a workbook sheet)
 * @param {Map<string, import("./ooxml.mjs").PartRelationship>} rels
 * @param {{sheet?: string}} [meta] the worksheet name a workbook chart sits on
 * @returns {{charts: Record<string, unknown>[], warnings: {code: string, message: string}[]}}
 */
export function readOfficeCharts(pkg, containerPart, rels, meta = {}) {
  const candidates = [...rels.entries()].filter(([, rel]) => rel.type === CHART_REL && !rel.external);
  if (!candidates.length) return { charts: [], warnings: [] };
  const referenced = referencedChartIds(pkg, containerPart);
  /** @type {Record<string, unknown>[]} */
  const charts = [];
  /** @type {{code: string, message: string}[]} */
  const warnings = [];
  for (const [relationshipId, rel] of candidates) {
    if (!referenced.has(relationshipId)) continue;
    if (charts.length >= MAX_OFFICE_CHARTS) {
      warnings.push({
        code: "charts-truncated",
        message: `图表较多，仅读取前 ${MAX_OFFICE_CHARTS} 个`,
      });
      break;
    }
    const chartPart = resolvePartPath(containerPart, rel.target);
    const chartText = pkg.text(chartPart);
    if (!chartText) continue;
    const chart = parseXml(chartText, chartPart);
    const chartRels = parseRels(pkg, chartPart);
    // A chart linked to an outside workbook keeps its cached values; the
    // workbook itself is never opened (same rule as PPTX charts).
    const external = descendantsOf(chart, "externalData").some((externalData) => {
      const relationshipId = attrOf(externalData, "r:id");
      return relationshipId ? chartRels.get(relationshipId)?.external === true : false;
    });
    const record = readChart(chart, {
      chartId: chartPart.slice(chartPart.lastIndexOf("/") + 1).replace(/\.xml$/i, ""),
      ...NOT_IN_SLIDE,
      external,
      theme: EMPTY_THEME,
      map: {},
    });
    charts.push(meta.sheet ? { ...record, sheet: meta.sheet } : record);
  }
  return { charts, warnings };
}

/**
 * The drawing relationship ids the worksheet's own XML references through
 * `<drawing r:id="…"/>` elements. A relationship-table entry no worksheet
 * element points at (a leftover drawing rel from a removed chart) never
 * appears here, so its drawing and chart parts are not read as embedded
 * charts.
 * @param {import("./ooxml.mjs").PackageReader} pkg
 * @param {string} sheetPart
 * @returns {Set<string>}
 */
function referencedDrawingIds(pkg, sheetPart) {
  const text = pkg.text(sheetPart);
  if (text === undefined) return new Set();
  const root = parseXml(text, sheetPart);
  const ids = new Set();
  for (const drawing of descendantsOf(root, "drawing")) {
    const id = attrOf(drawing, "r:id");
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The workbook charts of one sheet: worksheet `<drawing r:id>` → drawing rel →
 * drawing part → chart rels. Only drawing relationships the worksheet XML
 * actually references are followed, so a leftover drawing rel (with whatever
 * drawing/chart/cache bytes remain) neither publishes a chart nor masks the
 * referenced drawing when it is listed first. A sheet without a drawing (or
 * with an unreadable one) has no charts; discovery never fails the workbook.
 * @param {import("./ooxml.mjs").PackageReader} pkg
 * @param {string} sheetPart
 * @param {Map<string, import("./ooxml.mjs").PartRelationship>} sheetRels
 * @param {string} sheetName
 * @returns {{charts: Record<string, unknown>[], warnings: {code: string, message: string}[]}}
 */
export function readSheetCharts(pkg, sheetPart, sheetRels, sheetName) {
  const referenced = referencedDrawingIds(pkg, sheetPart);
  for (const [relationshipId, rel] of sheetRels) {
    if (rel.type !== "drawing" || rel.external) continue;
    if (!referenced.has(relationshipId)) continue;
    const drawingPart = resolvePartPath(sheetPart, rel.target);
    const drawingText = pkg.text(drawingPart);
    if (!drawingText) continue;
    return readOfficeCharts(pkg, drawingPart, parseRels(pkg, drawingPart), { sheet: sheetName });
  }
  return { charts: [], warnings: [] };
}
