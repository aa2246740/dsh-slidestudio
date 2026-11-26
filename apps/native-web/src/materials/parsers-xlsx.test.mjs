import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { runParseJob } from "./parse-worker.mjs";
import {
  buildXlsx,
  columnLetter,
  esc,
  MAIN_NS,
  OFFICE_DOC_REL,
  RELS_NS,
  SHEET_REL,
  XML_DECL,
} from "./test-fixtures/xlsx-build.mjs";
import { generateSamples, readSample, SAMPLES_SKIP } from "./sample-fixtures.mjs";

/**
 * @typedef {{name: string, headerRow: unknown[], rows: unknown[][], columns: {inferredType: string}[]}} SheetView
 * @typedef {{chartId: string, type: string, sheet: string, series: {values: number[]}[]}} ChartView
 * @typedef {import("./derivative.mjs").Derivative & {table: {sheets: SheetView[], charts: ChartView[]}}} TableDerivative
 * @typedef {{code?: string, message: string}} CodedError
 */

const styleSheetXml = (/** @type {any[]} */ cellXfs, numFmts = "") =>
  `${XML_DECL}<styleSheet xmlns="${MAIN_NS}">` +
  (numFmts ? `<numFmts count="1">${numFmts}</numFmts>` : "") +
  `<fonts count="1"><font/></fonts><fills count="1"><fill/></fills>` +
  `<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>` +
  `<cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs></styleSheet>`;

test("numFmt date styles and date1904 convert serial numbers to ISO dates", async () => {
  const styles = styleSheetXml(
    ['<xf numFmtId="164"/>', '<xf numFmtId="14"/>', '<xf numFmtId="0"/>'],
    '<numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/>',
  );
  const sheet = {
    name: "日期",
    rows: [
      [
        { ref: "A1", s: "0", v: "45783" },
        { ref: "B1", s: "1", v: "45783" },
        { ref: "C1", s: "2", v: "45783" },
      ],
    ],
  };
  const expected = new Date(Math.round((45783 - 25569) * 86400000)).toISOString();
  const leap = new Date(Math.round((45783 - 25569 + 1462) * 86400000)).toISOString();

  const normal = buildXlsx([sheet], { stylesXml: styles });
  const parsedNormal = /** @type {TableDerivative} */ (
    await runParseJob({ materialId: "md", name: "dates.xlsx", bytes: normal })
  );
  const cells = parsedNormal.table.sheets[0].rows[0];
  assert.equal(cells[0], expected);
  assert.equal(cells[1], expected);
  assert.equal(cells[2], 45783);
  assert.equal(parsedNormal.table.sheets[0].columns[0].inferredType, "date");
  assert.equal(parsedNormal.table.sheets[0].columns[2].inferredType, "number");

  const book1904 = buildXlsx([sheet], { stylesXml: styles, date1904: true });
  const parsed1904 = /** @type {TableDerivative} */ (
    await runParseJob({
      materialId: "md2",
      name: "dates1904.xlsx",
      bytes: book1904,
    })
  );
  assert.equal(parsed1904.table.sheets[0].rows[0][0], leap);
});

test("workbooks beyond the sheet cap or the cell cap are rejected as too-large", { timeout: 60_000 }, async () => {
  const manySheets = Array.from({ length: 51 }, (_, i) => ({
    name: `表${i + 1}`,
    rows: [[{ ref: "A1", text: "x" }]],
  }));
  await assert.rejects(
    runParseJob({ materialId: "ms", name: "many.xlsx", bytes: buildXlsx(manySheets) }),
    (/** @type {CodedError} */ error) => error.code === "too-large" && /工作表/.test(error.message),
  ); // 25 sheets × 501 rows × 80 columns = 1,002,500 cells.
  const wideRow = Array.from({ length: 80 }, (_, c) => c + 1);
  const wideSheets = Array.from({ length: 25 }, (_, s) => ({
    name: `宽${s + 1}`,
    rows: Array.from({ length: 501 }, (_, r) => wideRow.map((c) => ({ ref: `${columnLetter(c)}${r + 1}`, v: "1" }))),
  }));
  await assert.rejects(
    runParseJob({ materialId: "mc", name: "wide.xlsx", bytes: buildXlsx(wideSheets) }),
    (/** @type {CodedError} */ error) => error.code === "too-large" && /单元格/.test(error.message),
  );
});

test("a workbook whose sheet part is missing is corrupt with a Chinese reason", async () => {
  const orphan = Buffer.from(
    zipSync(
      {
        "[Content_Types].xml": strToU8(
          `${XML_DECL}<Types xmlns="${RELS_NS}"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
        ),
        "_rels/.rels": strToU8(
          `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_DOC_REL}" Target="xl/workbook.xml"/></Relationships>`,
        ),
        "xl/workbook.xml": strToU8(
          `${XML_DECL}<workbook xmlns="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        ),
        "xl/_rels/workbook.xml.rels": strToU8(
          `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${SHEET_REL}" Target="worksheets/missing.xml"/></Relationships>`,
        ),
      },
      { level: 6 },
    ),
  );
  await assert.rejects(
    runParseJob({ materialId: "mo", name: "orphan.xlsx", bytes: orphan }),
    (/** @type {CodedError} */ error) => error.code === "corrupt" && /损坏/.test(error.message),
  );
});

test("shared strings and inline strings both decode to text values", async () => {
  const shared = buildXlsx(
    [
      {
        name: "共享",
        rows: [
          [
            { ref: "A1", text: "地区" },
            { ref: "B1", text: "备注" },
          ],
          [
            { ref: "A2", t: "s", v: "0" },
            { ref: "B2", text: "直接内联" },
          ],
        ],
      },
    ],
    { sharedStrings: ["华东区域"] },
  );
  const parsed = /** @type {TableDerivative} */ (
    await runParseJob({ materialId: "mss", name: "shared.xlsx", bytes: shared })
  );
  const cells = parsed.table.sheets[0].rows[0];
  assert.equal(cells[0], "华东区域");
  assert.equal(cells[1], "直接内联");
});

// --- CAP-33: embedded chart data -------------------------------------------

const CHART_NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XDR_NS = 'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"';
const DRAWING_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const CHART_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";

/** One cached `c:ser`. @param {{index: number, name: string, cats: string[], values: number[],
 *   group?: "cat"|"x", ptCount?: number}} series */
const chartSer = ({ index, name, cats, values, ptCount }) =>
  `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>` +
  `<c:tx><c:strRef><c:f>S!$B$1</c:f><c:strCache><c:ptCount val="1"/>` +
  `<c:pt idx="0"><c:v>${esc(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
  `<c:cat><c:strRef><c:f>S!$A$2:$A$5</c:f><c:strCache><c:ptCount val="${cats.length}"/>` +
  cats.map((cat, i) => `<c:pt idx="${i}"><c:v>${esc(cat)}</c:v></c:pt>`).join("") +
  `</c:strCache></c:strRef></c:cat>` +
  `<c:val><c:numRef><c:f>S!$B$2:$B$5</c:f><c:numCache><c:formatCode>General</c:formatCode>` +
  `<c:ptCount val="${ptCount ?? values.length}"/>` +
  values.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join("") +
  `</c:numCache></c:numRef></c:val></c:ser>`;

/** A chartSpace with one plot group: `group` names the plot element, `series` and `extra`
 *   are XML injected verbatim (`extra` carries hostile caches). */
const chartSpace = (/** @type {"barChart"|"lineChart"|"pieChart"} */ group, /** @type {string} */ series, extra = "") =>
  `${XML_DECL}<c:chartSpace ${CHART_NS}><c:chart><c:plotArea><c:layout/>` +
  `<c:${group}>${extra}${series}</c:${group}>` +
  `</c:plotArea></c:chart></c:chartSpace>`;

/** One `<xdr:twoCellAnchor>` graphicFrame embedding the chart with `relId`. */
const chartAnchor = (/** @type {string} */ relId, /** @type {number} */ index) =>
  `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>` +
  `<xdr:row>${index * 14}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
  `<xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${index * 14 + 13}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
  `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>` +
  `<xdr:cNvPr id="${index + 1}" name="图表 ${index + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
  `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="3200400"/></xdr:xfrm>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
  `<c:chart r:id="${relId}"/></a:graphicData></a:graphic></xdr:graphicFrame>` +
  `<xdr:clientData/></xdr:twoCellAnchor>`;

/**
 * A workbook whose sheet1 carries a drawing chain: sheet rel → drawing →
 * drawing rels → the given chart parts.
 * @param {Record<string, string>} charts path under xl/charts → chart XML
 * @param {{withDrawing?: boolean, orphanRel?: {id: string, path: string, xml: string},
 *   worksheetDrawingRef?: string|null, orphanDrawing?: {relId: string, path: string,
 *   chartPath: string, chartXml: string}}} [options]
 *   withDrawing:false keeps the chart parts but drops every reference (orphan
 *   parts are ignored); orphanRel adds a chart relationship the drawing XML
 *   never references (an orphan relationship-table entry);
 *   worksheetDrawingRef:null removes only the worksheet's `<drawing r:id>`
 *   element while the sheet relationship, drawing part and chart caches stay
 *   (an unreferenced worksheet drawing); orphanDrawing adds a leftover drawing
 *   part with its own complete chart chain whose sheet relationship is listed
 *   before the referenced one
 */
function xlsxWithCharts(charts, { withDrawing = true, orphanRel, worksheetDrawingRef = "rId1", orphanDrawing } = {}) {
  const chartNames = Object.keys(charts);
  const drawingRels =
    `${XML_DECL}<Relationships xmlns="${RELS_NS}">` +
    chartNames
      .map((path, index) => {
        const name = path.split("/").at(-1);
        return `<Relationship Id="rId${index + 1}" Type="${CHART_REL}" Target="../charts/${name}"/>`;
      })
      .join("") +
    (orphanRel
      ? `<Relationship Id="${orphanRel.id}" Type="${CHART_REL}" Target="../charts/${orphanRel.path.split("/").at(-1)}"/>`
      : "") +
    `</Relationships>`;
  const drawing =
    `${XML_DECL}<xdr:wsDr ${XDR_NS} ${CHART_NS}>` +
    chartNames.map((_, index) => chartAnchor(`rId${index + 1}`, index)).join("") +
    `</xdr:wsDr>`;
  /** @type {Record<string, Uint8Array>} */
  const files = {
    "[Content_Types].xml": strToU8(
      `${XML_DECL}<Types xmlns="${RELS_NS}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_DOC_REL}" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `${XML_DECL}<workbook xmlns="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="指标" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${SHEET_REL}" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `${XML_DECL}<worksheet xmlns="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>季度</t></is></c>` +
        `<c r="B1" t="inlineStr"><is><t>营收</t></is></c></row>` +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>一</t></is></c><c r="B2"><v>7</v></c></row></sheetData>` +
        (withDrawing && worksheetDrawingRef ? `<drawing r:id="${worksheetDrawingRef}"/>` : "") +
        `</worksheet>`,
    ),
  };
  if (withDrawing) {
    files["xl/worksheets/_rels/sheet1.xml.rels"] = strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}">` +
        (orphanDrawing
          ? `<Relationship Id="${orphanDrawing.relId}" Type="${DRAWING_REL}" Target="../drawings/${orphanDrawing.path.split("/").at(-1)}"/>`
          : "") +
        `<Relationship Id="rId1" Type="${DRAWING_REL}" Target="../drawings/drawing1.xml"/>` +
        `</Relationships>`,
    );
    files["xl/drawings/drawing1.xml"] = strToU8(drawing);
    files["xl/drawings/_rels/drawing1.xml.rels"] = strToU8(drawingRels);
  }
  if (orphanDrawing) {
    const name = orphanDrawing.path.split("/").at(-1);
    files[orphanDrawing.path] = strToU8(
      `${XML_DECL}<xdr:wsDr ${XDR_NS} ${CHART_NS}>${chartAnchor("rId1", 0)}</xdr:wsDr>`,
    );
    files[`xl/drawings/_rels/${name}.rels`] = strToU8(
      `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${CHART_REL}" Target="../charts/${orphanDrawing.chartPath.split("/").at(-1)}"/></Relationships>`,
    );
    files[orphanDrawing.chartPath] = strToU8(orphanDrawing.chartXml);
  }
  for (const [path, xml] of Object.entries(charts)) {
    files[path] = strToU8(xml);
  }
  if (orphanRel) files[orphanRel.path] = strToU8(orphanRel.xml);
  return Buffer.from(zipSync(files, { level: 6 }));
}

test("chart parts without a drawing chain are ignored", async () => {
  const bytes = xlsxWithCharts(
    {
      "xl/charts/chart1.xml": chartSpace("lineChart", chartSer({ index: 0, name: "营收", cats: ["一"], values: [1] })),
    },
    { withDrawing: false },
  );
  const derivative = /** @type {TableDerivative} */ (
    await runParseJob({ materialId: "mo", name: "orphan-chart.xlsx", bytes })
  );
  assert.deepEqual(derivative.table.charts, []);
});

test("a drawing chart relationship with no c:chart reference is ignored", async () => {
  const bytes = xlsxWithCharts(
    {
      "xl/charts/chart1.xml": chartSpace("lineChart", chartSer({ index: 0, name: "营收", cats: ["一"], values: [1] })),
    },
    {
      orphanRel: {
        id: "rId99",
        path: "xl/charts/chart-orphan.xml",
        xml: chartSpace("pieChart", chartSer({ index: 0, name: "残留", cats: ["一"], values: [9] })),
      },
    },
  );
  const derivative = /** @type {TableDerivative} */ (
    await runParseJob({ materialId: "morc", name: "orphan-rel.xlsx", bytes })
  );
  assert.deepEqual(
    derivative.table.charts.map((chart) => chart.chartId),
    ["chart1"],
    "only the drawing-referenced chart is embedded",
  );
});

test("an unreferenced worksheet drawing relationship produces no charts and keeps the sheet data", async () => {
  const bytes = xlsxWithCharts(
    {
      "xl/charts/chart1.xml": chartSpace("lineChart", chartSer({ index: 0, name: "营收", cats: ["一"], values: [1] })),
    },
    // The sheet relationship, drawing part and chart cache all stay; only the
    // worksheet's own `<drawing r:id>` element is removed (a leftover drawing
    // rel from a deleted chart must not publish a chart).
    { worksheetDrawingRef: null },
  );
  const derivative = /** @type {TableDerivative} */ (
    await runParseJob({ materialId: "mwref", name: "unref-drawing.xlsx", bytes })
  );
  assert.deepEqual(derivative.table.charts, []);
  assert.equal(derivative.table.sheets[0]?.name, "指标");
  assert.deepEqual(derivative.table.sheets[0]?.headerRow, ["季度", "营收"]);
  assert.deepEqual(derivative.table.sheets[0]?.rows[0], ["一", 7]);
});

test("an orphan drawing relationship before the referenced one cannot mask the referenced chart", async () => {
  const bytes = xlsxWithCharts(
    {
      "xl/charts/chart1.xml": chartSpace("lineChart", chartSer({ index: 0, name: "营收", cats: ["一"], values: [1] })),
    },
    {
      orphanDrawing: {
        relId: "rIdO",
        path: "xl/drawings/drawing-orphan.xml",
        chartPath: "xl/charts/chart-orphan.xml",
        chartXml: chartSpace("pieChart", chartSer({ index: 0, name: "残留", cats: ["一"], values: [9] })),
      },
    },
  );
  const derivative = /** @type {TableDerivative} */ (
    await runParseJob({
      materialId: "modr",
      name: "orphan-drawing.xlsx",
      bytes,
    })
  );
  assert.deepEqual(
    derivative.table.charts.map((chart) => chart.chartId),
    ["chart1"],
    "only the worksheet-referenced drawing's chart is embedded",
  );
  assert.equal(derivative.table.charts[0]?.type, "line");
  assert.deepEqual(derivative.table.charts[0]?.series[0]?.values, [1]);
  assert.equal(derivative.table.charts[0]?.sheet, "指标");
  assert.deepEqual(derivative.table.sheets[0]?.headerRow, ["季度", "营收"]);
  assert.deepEqual(derivative.table.sheets[0]?.rows[0], ["一", 7]);
});

test("a workbook chart cache above the point cap fails closed with a Chinese reason", async () => {
  const bytes = xlsxWithCharts({
    "xl/charts/chart1.xml": chartSpace(
      "lineChart",
      chartSer({ index: 0, name: "营收", cats: ["一"], values: [1], ptCount: 200_000 }),
    ),
  });
  await assert.rejects(
    runParseJob({ materialId: "mb", name: "huge.xlsx", bytes }),
    (/** @type {CodedError} */ error) => error.code === "archive-limit" && /图表缓存/.test(error.message),
  );
});

test("workbook chart discovery is capped at 100 parts with a Chinese warning", async () => {
  const charts = Object.fromEntries(
    Array.from({ length: 120 }, (_, index) => [
      `xl/charts/chart${index + 1}.xml`,
      chartSpace("lineChart", chartSer({ index: 0, name: "营收", cats: ["一"], values: [1] })),
    ]),
  );
  const derivative = /** @type {TableDerivative} */ (
    await runParseJob({
      materialId: "mcap",
      name: "many.xlsx",
      bytes: xlsxWithCharts(charts),
    })
  );
  assert.equal(derivative.table.charts.length, 100);
  assert.ok(derivative.warnings.some((warning) => warning.code === "charts-truncated" && /图表/.test(warning.message)));
});
