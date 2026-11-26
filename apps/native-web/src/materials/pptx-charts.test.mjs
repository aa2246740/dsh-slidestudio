import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parseXml } from "./parsers/ooxml.mjs";
import { readChart } from "./parsers/pptx-charts.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { buildPptx } from "../testlib/pptx-fixture.mjs";
import {
  matchTemplateChartFigures,
  pageChartsForFigures,
} from "../../../../packages/presentation-run/dist/domain/template-chart-provenance.js";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";

/**
 * @param {string} plotArea
 */
function chartRoot(plotArea) {
  return parseXml(chartXml(plotArea), "ppt/charts/chart1.xml");
}

/**
 * @param {any} plotArea
 */
function chartXml(plotArea) {
  return `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:plotArea>${plotArea}</c:plotArea></c:chart></c:chartSpace>`;
}

/**
 * @param {string} plotArea
 */
async function parsedChart(plotArea) {
  const files = unzipSync(buildPptx());
  const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const frame =
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Synthetic chart"/>` +
    `<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="1219200" y="1371600"/><a:ext cx="3657600" cy="2743200"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${r}" r:id="rIdChart"/>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`;
  files["ppt/slides/slide1.xml"] = strToU8(
    strFromU8(files["ppt/slides/slide1.xml"]).replace("</p:spTree>", `${frame}</p:spTree>`),
  );
  const rels = "ppt/slides/_rels/slide1.xml.rels";
  files[rels] = strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdLayout" Type="${r}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rIdChart" Type="${r}/chart" Target="../charts/chart1.xml"/></Relationships>`,
  );
  files["[Content_Types].xml"] = strToU8(
    strFromU8(files["[Content_Types].xml"]).replace(
      "</Types>",
      `<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
    ),
  );
  files["ppt/charts/chart1.xml"] = strToU8(chartXml(plotArea));
  // The "deck-template" section is open JSON that the assertions walk dynamically.
  const derivative = /** @type {import("./derivative.mjs").Derivative & {[section: string]: any}} */ (
    await runParseJob({
      materialId: "synthetic-chart",
      name: "synthetic-chart.pptx",
      bytes: zipSync(files),
    })
  );
  assert.equal(derivative.parser.id, "pptx-ooxml-v2");
  assert.equal(derivative.status, "ok");
  const [result] = derivative["deck-template"].templateDetail.charts;
  assert.equal(result.chartId, "chart1");
  assert.deepEqual(result.box, [0.1, 0.2, 0.3, 0.4]);
  return result;
}

/**
 * @param {number} index
 * @param {number} order
 * @param {string} name
 * @param {any[]} values
 */
function literalSeries(index, order, name, values, paint = "") {
  return (
    `<c:ser><c:idx val="${index}"/><c:order val="${order}"/><c:tx><c:v>${name}</c:v></c:tx>` +
    paint +
    `<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt>` +
    `<c:pt idx="1"><c:v>B</c:v></c:pt></c:strLit></c:cat>` +
    `<c:val><c:numLit><c:formatCode>0.00</c:formatCode><c:ptCount val="2"/>` +
    values
      .map((/** @type {any} */ value, /** @type {any} */ idx) => `<c:pt idx="${idx}"><c:v>${value}</c:v></c:pt>`)
      .join("") +
    `</c:numLit></c:val></c:ser>`
  );
}

/**
 * @param {string} type
 */
function chartGroup(type, contents = "") {
  return `<c:${type}>${contents}</c:${type}>`;
}

/**
 * @param {{ nodeType: number; nodeName: string; nodeValue: string | null; textContent: string | null; firstChild: import("./parsers/ooxml.mjs").DomNode | null; nextSibling: import("./parsers/ooxml.mjs").DomNode | null; parentNode: import("./parsers/ooxml.mjs").DomNode | null; attributes: import("./parsers/ooxml.mjs").DomAttributes | null; }} root
 */
function chart(root, overrides = {}) {
  return readChart(root, {
    chartId: "chart1",
    slide: 1,
    box: [0.1, 0.2, 0.3, 0.4],
    external: false,
    theme: { colors: { accent1: "#C00000" } },
    map: {},
    ...overrides,
  });
}

test("recognizes chart families, bar direction, grouping and combinations", () => {
  const families = [
    ["barChart", "bar"],
    ["lineChart", "line"],
    ["pieChart", "pie"],
    ["areaChart", "area"],
    ["radarChart", "radar"],
    ["doughnutChart", "doughnut"],
    ["scatterChart", "scatter"],
  ];
  for (const [element, expected] of families) {
    assert.equal(chart(chartRoot(chartGroup(element))).type, expected);
  }

  const bar = chart(chartRoot(chartGroup("barChart", '<c:barDir val="col"/><c:grouping val="clustered"/>')));
  assert.equal(bar.direction, "column");
  assert.equal(bar.grouping, "clustered");

  const combination = chart(
    chartRoot(
      chartGroup("barChart", '<c:barDir val="col"/><c:grouping val="stacked"/>') +
        chartGroup("lineChart", '<c:grouping val="standard"/>'),
    ),
  );
  assert.equal(combination.type, "combination");
  assert.equal(combination.grouping, "stacked");
  assert.deepEqual(combination.combo, [
    { type: "bar", grouping: "stacked", direction: "column" },
    { type: "line", grouping: "standard" },
  ]);
});

test("reads series names, categories, numeric caches, number formats and colours", () => {
  const series =
    `<c:ser><c:tx><c:strRef><c:strCache><c:ptCount val="1"/>` +
    `<c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
    `<c:cat><c:strRef><c:strCache><c:ptCount val="3"/>` +
    `<c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt>` +
    `<c:pt idx="2"><c:v>Mar</c:v></c:pt></c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache>` +
    `<c:formatCode>0.0</c:formatCode><c:ptCount val="3"/>` +
    `<c:pt idx="0"><c:v>12.5</c:v></c:pt><c:pt idx="1"><c:v>0</c:v></c:pt>` +
    `<c:pt idx="2"><c:v>-4</c:v></c:pt></c:numCache></c:numRef></c:val>` +
    `<c:spPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></c:spPr></c:ser>`;
  const result = chart(chartRoot(chartGroup("barChart", `<c:grouping val="clustered"/>${series}`)));
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].name, "Revenue");
  assert.deepEqual(result.series[0].categories, ["Jan", "Feb", "Mar"]);
  assert.deepEqual(result.series[0].values, [12.5, 0, -4]);
  assert.equal(result.series[0].numFmt, "0.0");
  assert.equal(result.series[0].color, "#C00000");
});

test("retains sparse cache indexes and gradient series colours", () => {
  const series =
    `<c:ser><c:tx><c:v>Traffic</c:v></c:tx>` +
    `<c:cat><c:numRef><c:numCache><c:ptCount val="3"/>` +
    `<c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>3</c:v></c:pt>` +
    `</c:numCache></c:numRef></c:cat>` +
    `<c:val><c:numRef><c:numCache><c:ptCount val="3"/>` +
    `<c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="2"><c:v>30</c:v></c:pt>` +
    `</c:numCache></c:numRef></c:val>` +
    `<c:spPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="C00000"/></a:gs>` +
    `<a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst></a:gradFill></c:spPr></c:ser>`;
  const result = chart(chartRoot(chartGroup("areaChart", series)));
  assert.deepEqual(result.series[0].categories, [1, null, 3]);
  assert.deepEqual(result.series[0].values, [10, null, 30]);
  assert.deepEqual(result.series[0].gradient, {
    stops: [
      { position: 0, hex: "#C00000", alpha: 1, mods: [] },
      { position: 1, hex: "#FFFFFF", alpha: 1, mods: [] },
    ],
    angle: 0,
  });
});

test("cache point counts cannot force unbounded allocation", () => {
  const series =
    `<c:ser><c:val><c:numRef><c:numCache><c:ptCount val="1000000000"/>` +
    `<c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>`;
  assert.throws(() => chart(chartRoot(chartGroup("lineChart", series))), /图表缓存数据超出安全限制/);
});

test("uses cached literal categories and values without a workbook reference", () => {
  const series =
    `<c:ser><c:tx><c:v>Score</c:v></c:tx>` +
    `<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>Low</c:v></c:pt>` +
    `<c:pt idx="1"><c:v>High</c:v></c:pt></c:strLit></c:cat>` +
    `<c:val><c:numLit><c:ptCount val="2"/><c:pt><c:v>2</c:v></c:pt>` +
    `<c:pt><c:v>5</c:v></c:pt></c:numLit></c:val></c:ser>`;
  const result = chart(chartRoot(chartGroup("radarChart", series)));
  assert.deepEqual(result.series[0].categories, ["Low", "High"]);
  assert.deepEqual(result.series[0].values, [2, 5]);
});

test("M3-SCR-004: production scatter parsing retains x/y caches and independent formats", async () => {
  const series =
    `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Coordinates</c:v></c:tx>` +
    `<c:xVal><c:numRef><c:f>Sheet1!$A$2:$A$5</c:f><c:numCache>` +
    `<c:formatCode>0.000</c:formatCode><c:ptCount val="4"/>` +
    `<c:pt idx="3"><c:v>2.125</c:v></c:pt><c:pt idx="0"><c:v>-1.25</c:v></c:pt>` +
    `<c:pt idx="1"><c:v>0</c:v></c:pt></c:numCache></c:numRef></c:xVal>` +
    `<c:yVal><c:numLit><c:formatCode>0.0%</c:formatCode><c:ptCount val="4"/>` +
    `<c:pt idx="0"><c:v>0.125</c:v></c:pt><c:pt idx="1"><c:v>-0.25</c:v></c:pt>` +
    `<c:pt idx="3"><c:v>0.5</c:v></c:pt></c:numLit></c:yVal></c:ser>`;
  const result = await parsedChart(chartGroup("scatterChart", '<c:scatterStyle val="lineMarker"/>' + series));
  assert.equal(result.type, "scatter");
  assert.deepEqual(result.series[0].categories, [-1.25, 0, null, 2.125]);
  assert.deepEqual(result.series[0].values, [0.125, -0.25, null, 0.5]);
  assert.equal(result.series[0].xNumFmt, "0.000");
  assert.equal(result.series[0].numFmt, "0.0%");
});

test("M3-SCR-005: declared series order spans combo groups and keeps provenance vectors aligned", async () => {
  const result = await parsedChart(
    chartGroup(
      "barChart",
      '<c:barDir val="col"/><c:grouping val="clustered"/>' +
        literalSeries(0, 2, "Third", [31, 32]) +
        literalSeries(2, 0, "First", [11, 12]),
    ) + chartGroup("lineChart", '<c:grouping val="standard"/>' + literalSeries(1, 1, "Second", [21, 22])),
  );
  assert.equal(result.type, "combination");
  assert.deepEqual(
    result.series.map((/** @type {{name: string, order: number, values: unknown[]}} */ { name, order, values }) => ({
      name,
      order,
      values,
    })),
    [
      { name: "First", order: 0, values: [11, 12] },
      { name: "Second", order: 1, values: [21, 22] },
      { name: "Third", order: 2, values: [31, 32] },
    ],
  );
  // The downstream matcher uses complete vectors, not their position in either chart.
  const output = pageChartsForFigures({
    elements: [
      {
        elementType: "chart",
        data: {
          cols: ["Category", "Third", "First", "Second"],
          rows: [
            ["A", 31, 11, 21],
            ["B", 32, 12, 22],
          ],
        },
        series: ["Third", "First", "Second"].map((name) => ({
          type: "bar",
          encode: { x: "Category", y: name },
        })),
      },
    ],
  });
  const [match] = matchTemplateChartFigures(output, [
    {
      ...result,
      sourcePage: 1,
      categories: result.series[0].categories,
      sourcePeriods: [],
    },
  ]);
  assert.equal(match.valueMatch, "exact");
  assert.equal(match.categoriesMatch, undefined);
  assert.deepEqual(match.values, ["31", "32", "11", "12", "21", "22"]);
});

const solidPaint = '<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill>';
const gradientPaint =
  '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="C00000"/></a:gs>' +
  '<a:gs pos="100000"><a:srgbClr val="FFFFFF"><a:alpha val="50000"/></a:srgbClr></a:gs>' +
  '</a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>';

for (const [family, style] of [
  ["lineChart", '<c:grouping val="standard"/>'],
  ["radarChart", '<c:radarStyle val="standard"/>'],
  ["radarChart", '<c:radarStyle val="marker"/>'],
]) {
  for (const [kind, paint] of [
    ["solid", solidPaint],
    ["gradient", gradientPaint],
  ]) {
    test(`M3-SCR-006: production ${family} ${style} reads visible ${kind} line paint`, async () => {
      const spPr = `<c:spPr><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><a:ln w="28575">${paint}</a:ln></c:spPr>`;
      const result = await parsedChart(chartGroup(family, style + literalSeries(0, 0, "Paint", [2, 5], spPr)));
      if (kind === "solid") {
        assert.equal(result.series[0].color, "#640817");
        assert.equal(result.series[0].gradient, undefined);
      } else {
        assert.equal(result.series[0].color, undefined);
        assert.deepEqual(result.series[0].gradient, {
          stops: [
            { position: 0, hex: "#C00000", alpha: 1, mods: [] },
            { position: 1, hex: "#FFFFFF", alpha: 0.5, mods: [{ name: "alpha", value: 50000 }] },
          ],
          angle: 90,
        });
      }
    });
  }
}

test("filled radar keeps its area paint instead of its outline", async () => {
  const spPr = `<c:spPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:ln>${gradientPaint}</a:ln></c:spPr>`;
  const result = await parsedChart(
    chartGroup("radarChart", '<c:radarStyle val="filled"/>' + literalSeries(0, 0, "Area", [2, 5], spPr)),
  );
  assert.equal(result.series[0].color, "#00FF00");
  assert.equal(result.series[0].gradient, undefined);
});

test("absent, invalid and tied series orders retain stable traversal order", () => {
  const absent = literalSeries(0, 0, "Absent", [1, 2]).replace('<c:order val="0"/>', "");
  const invalid = literalSeries(1, -1, "Invalid", [3, 4]);
  const firstTie = literalSeries(2, 2, "First tie", [5, 6]);
  const secondTie = literalSeries(3, 2, "Second tie", [7, 8]);
  const result = chart(chartRoot(chartGroup("barChart", absent + invalid + firstTie + secondTie)));
  assert.deepEqual(
    result.series.map(({ name }) => name),
    ["Absent", "Invalid", "First tie", "Second tie"],
  );
  assert.deepEqual(
    result.series.map(({ order }) => order),
    [undefined, undefined, 2, 2],
  );
});

test("an explicit unpainted line does not borrow the series area colour", () => {
  const series = literalSeries(
    0,
    0,
    "Invisible line",
    [2, 5],
    '<c:spPr><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>',
  );
  const result = chart(chartRoot(chartGroup("lineChart", series)));
  assert.equal(result.series[0].color, undefined);
  assert.equal(result.series[0].gradient, undefined);
});
