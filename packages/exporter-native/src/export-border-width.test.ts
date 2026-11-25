import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type LineElement,
  type PptdElement,
  type PptdProject,
  type ShapeElement,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";

/*
 * Ruling 112: border.width is PPTD px for every element kind, like x and y. The export
 * slide is 10 inches wide, so 1 px = 9 525 EMU = 0.75 pt and a:ln w = width × 9 525.
 */
const EMU_PER_PX = 9525;
const CUSTOM_PATH = "M 0 0 L 200 0 L 100 100 Z";

function deck(title: string, elements: PptdElement[], theme?: PptdProject["presentation"]["theme"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-border-width-"));
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  project.pages[0]!.page.elements = elements;
  if (theme) project.presentation.theme = theme;
  saveProject(project);
  return project;
}

async function partXml(data: Buffer, part: string): Promise<string> {
  const xml = await (await JSZip.loadAsync(data)).file(part)?.async("string");
  assert.ok(xml, `missing ${part}`);
  return xml;
}

/**
 * The chart part of a one-chart deck. pptxgenjs numbers charts with a module-level counter,
 * so the file name depends on earlier exports in the process and is never assumed.
 */
async function chartXml(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const parts = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  assert.equal(parts.length, 1, "a one-chart deck has exactly one chart part");
  const xml = await zip.file(parts[0]!)?.async("string");
  assert.ok(xml, `missing ${parts[0]}`);
  return xml;
}

/** The whole <p:sp> that carries `name`, so widths never leak from a neighbouring shape. */
function namedShape(xml: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shape = xml.match(
    new RegExp(`<p:sp>(?:(?!<\\/p:sp>)[\\s\\S])*?name="${escaped}"(?:(?!<\\/p:sp>)[\\s\\S])*?<\\/p:sp>`),
  )?.[0];
  assert.ok(shape, `missing editable OOXML shape ${name}`);
  return shape;
}

/** The a:ln w of the first outline inside a shape, in EMU. */
function outlineWidth(shape: string): number {
  const width = shape.match(/<a:ln w="(\d+)"/)?.[1];
  assert.ok(width, "shape has an a:ln w");
  return Number(width);
}

const presetBox = (border?: ShapeElement["border"]): ShapeElement => ({
  elementId: "preset-box",
  elementType: "shape",
  shapeName: "rect",
  bounds: [40, 40, 200, 100],
  fill: { type: "solid", color: "#FFFFFF" },
  ...(border ? { border } : {}),
});

const customBox = (border?: ShapeElement["border"]): ShapeElement => ({
  elementId: "custom-box",
  elementType: "shape",
  shapeName: "custom",
  bounds: [300, 40, 200, 100],
  geometry: { viewBox: [200, 100], path: CUSTOM_PATH },
  fill: { type: "solid", color: "#FFFFFF" },
  ...(border ? { border } : {}),
});

const rule = (border?: LineElement["border"]): LineElement => ({
  elementId: "rule",
  elementType: "line",
  bounds: [40, 300, 400, 20],
  viewBox: [400, 20],
  points: "0,0 400,20",
  ...(border ? { border } : {}),
});

describe("border.width is PPTD px for every element kind (ruling 112)", () => {
  it("one border.width of 2 px exports the same a:ln w on a preset shape, a custom shape and a line", async () => {
    const border = { color: "#111111", width: 2 };
    const result = await exportProjectToPptx(deck("线宽单位", [presetBox(border), customBox(border), rule(border)]));
    const xml = await partXml(result.data, "ppt/slides/slide1.xml");

    assert.equal(outlineWidth(namedShape(xml, "preset-box")), 2 * EMU_PER_PX);
    assert.equal(outlineWidth(namedShape(xml, "custom-box")), 2 * EMU_PER_PX);
    assert.equal(outlineWidth(namedShape(xml, "PPTD line rule")), 2 * EMU_PER_PX);
  });

  it("a colour with no width draws 1 px (9 525 EMU) on a preset shape and on a custom shape", async () => {
    const border = { color: "#111111" };
    const result = await exportProjectToPptx(deck("默认描边", [presetBox(border), customBox(border)]));
    const xml = await partXml(result.data, "ppt/slides/slide1.xml");

    assert.equal(outlineWidth(namedShape(xml, "preset-box")), EMU_PER_PX);
    assert.equal(outlineWidth(namedShape(xml, "custom-box")), EMU_PER_PX);
  });

  it("an explicit line border keeps its colour and writes its own px width", async () => {
    const result = await exportProjectToPptx(deck("显式线条", [rule({ color: "#00AA00", width: 3 })]));
    const shape = namedShape(await partXml(result.data, "ppt/slides/slide1.xml"), "PPTD line rule");

    assert.equal(outlineWidth(shape), 3 * EMU_PER_PX);
    assert.match(shape, /<a:srgbClr val="00AA00"\/>/);
  });

  it("an unstyled line exports 2 px (19 050 EMU) in the theme primary, or #111111 when the primary is invalid", async () => {
    const themed = await exportProjectToPptx(deck("默认线", [rule()]));
    const themedShape = namedShape(await partXml(themed.data, "ppt/slides/slide1.xml"), "PPTD line rule");
    assert.equal(outlineWidth(themedShape), 19050);
    assert.match(themedShape, /<a:srgbClr val="2563EB"\/>/);

    const invalid = await exportProjectToPptx(deck("无效主色", [rule()], { colors: { primary: "D9775" } }));
    const invalidShape = namedShape(await partXml(invalid.data, "ppt/slides/slide1.xml"), "PPTD line rule");
    assert.equal(outlineWidth(invalidShape), 19050);
    assert.match(invalidShape, /<a:srgbClr val="111111"\/>/);
  });

  it("an unstyled line takes a six-digit unprefixed theme primary as the colour it spells", async () => {
    const result = await exportProjectToPptx(deck("无前缀主色", [rule()], { colors: { primary: "d97757" } }));
    assert.deepEqual(
      result.report.degradations.filter((d) => d.kind === "color-fallback"),
      [],
    );
    const shape = namedShape(await partXml(result.data, "ppt/slides/slide1.xml"), "PPTD line rule");
    assert.equal(outlineWidth(shape), 19050);
    assert.match(shape, /<a:srgbClr val="D97757"\/>/);
  });

  it("table rules export 1 px (9 525 EMU) on every edge", async () => {
    const result = await exportProjectToPptx(
      deck("表格线宽", [
        {
          elementId: "t1",
          elementType: "table",
          bounds: [40, 40, 500, 160],
          columnWidths: [1, 1],
          rowHeights: [1, 1],
          rows: [
            [{ text: "表头A" }, { text: "表头B" }],
            [{ text: "值1" }, { text: "值2" }],
          ],
        },
      ]),
    );
    const xml = await partXml(result.data, "ppt/slides/slide1.xml");
    const edges = ["lnL", "lnR", "lnT", "lnB"].map((edge) => xml.match(new RegExp(`<a:${edge} w="(\\d+)"`))?.[1]);
    assert.deepEqual(edges, ["9525", "9525", "9525", "9525"]);
  });
});

describe("chart strokes follow the px convention (ruling 112)", () => {
  it("bar chart gridlines and axis lines export 1 px (9 525 EMU)", async () => {
    const result = await exportProjectToPptx(
      deck("柱图线宽", [
        {
          elementId: "bar",
          elementType: "chart",
          bounds: [40, 40, 500, 300],
          data: {
            cols: ["月", "收入"],
            rows: [
              ["1月", 10],
              ["2月", 20],
              ["3月", 15],
            ],
          },
          series: [{ type: "bar", name: "收入", encode: { x: "月", y: "收入" } }],
          legend: false,
        },
      ]),
    );
    const chart = await chartXml(result.data);
    const gridlines = chart.match(/<c:majorGridlines>[\s\S]*?<\/c:majorGridlines>/)?.[0];
    assert.ok(gridlines, "value axis has major gridlines");
    assert.match(gridlines, /<a:ln w="9525"/);
    const catAxis = chart.match(/<c:catAx>[\s\S]*?<\/c:catAx>/)?.[0] ?? "";
    assert.match(catAxis, /<a:ln w="9525"/, "category axis line is 1 px");
    const valAxis = chart.match(/<c:valAx>[\s\S]*?<\/c:valAx>/)?.[0] ?? "";
    assert.match(valAxis.replace(/<c:majorGridlines>[\s\S]*?<\/c:majorGridlines>/, ""), /<a:ln w="9525"/);
  });

  it("a line series keeps its 3 px width (28 575 EMU)", async () => {
    const result = await exportProjectToPptx(
      deck("折线线宽", [
        {
          elementId: "trend",
          elementType: "chart",
          bounds: [40, 40, 500, 300],
          data: {
            cols: ["月", "营收"],
            rows: [
              ["2月", 0.89],
              ["3月", 0.97],
              ["7月", 1.286],
            ],
          },
          series: [{ type: "line", name: "营收", encode: { x: "月", y: "营收" } }],
          legend: false,
        },
      ]),
    );
    const chart = await chartXml(result.data);
    const series = chart.match(/<c:ser>[\s\S]*?<\/c:ser>/)?.[0] ?? "";
    assert.match(series, /<a:ln w="28575"/);
  });

  it("scatter markers, the plot border and the chart area follow the editor", async () => {
    const result = await exportProjectToPptx(
      deck("散点线宽", [
        {
          elementId: "risk",
          elementType: "chart",
          bounds: [500, 20, 420, 360],
          data: {
            cols: ["风险", "可能", "影响"],
            rows: [
              ["爆品缺货", 4.5, 4.8],
              ["华北同店", 4.2, 4.5],
            ],
          },
          series: [{ type: "scatter", name: "风险", encode: { x: "可能", y: "影响" }, fill: "#DC2626" }],
          legend: false,
        },
      ]),
    );
    const chart = await chartXml(result.data);
    const marker = chart.match(/<c:marker>[\s\S]*?<\/c:marker>/)?.[0] ?? "";
    assert.match(marker, /<a:ln w="19050"/, "marker ring is the editor's 2 px ring");
    // Ruling 113: the editor paints no plot-area frame, so the export draws none either.
    const plotSpPr = chart.match(/<c:spPr>((?:(?!<c:spPr>)[\s\S])*?)<\/c:spPr>\s*<\/c:plotArea>/)?.[1];
    assert.ok(plotSpPr !== undefined, "plot area has its own spPr");
    assert.match(plotSpPr, /<a:ln><a:noFill\/><\/a:ln>/, "plot area draws no frame");
    const chartArea = chart.match(/<\/c:chart>\s*<c:spPr>[\s\S]*?<\/c:spPr>/)?.[0] ?? "";
    assert.match(chartArea, /<a:ln><a:noFill\/><\/a:ln>/, "chart area draws no frame, as in the editor");
  });

  it("waterfall connectors keep their 1 px dashed rule (9 525 EMU)", async () => {
    const result = await exportProjectToPptx(
      deck("瀑布连接线", [
        {
          elementId: "wf",
          elementType: "chart",
          bounds: [20, 20, 440, 220],
          data: {
            cols: ["步", "额", "tot"],
            rows: [
              ["期初", 5280, null],
              ["流入", 12210, null],
              ["流出", -10860, null],
              ["期末", 5964, null],
            ],
          },
          series: [{ type: "waterfall", encode: { x: "步", y: "额", isTotal: "tot" } }],
          legend: false,
        },
      ]),
    );
    const xml = await partXml(result.data, "ppt/slides/slide1.xml");
    assert.match(xml, /<a:ln w="9525"[^>]*>(?:(?!<\/a:ln>)[\s\S])*?<a:prstDash val="dash"\/>/);
  });
});

/** The a:ln of a shape or line, self-closing or with children; undefined when it has none. */
function outlineOf(shape: string): string | undefined {
  return shape.match(/<a:ln\b[^>]*\/>/)?.[0] ?? shape.match(/<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/)?.[0];
}

/** A zero-width outline draws nothing: the explicit no-fill a:ln the export writes for it. */
function assertNoVisibleOutline(shape: string, label: string): void {
  assert.equal(outlineOf(shape), "<a:ln><a:noFill/></a:ln>", `${label} draws no outline`);
}

describe("a zero border.width draws no outline (M5-SCR-004)", () => {
  const rawRule = (elementId: string, extra: Partial<LineElement> = {}): LineElement => ({
    elementId,
    elementType: "line",
    bounds: [40, 300, 400, 20],
    viewBox: [400, 20],
    points: "0,0 400,20",
    border: { color: "#00AA00", width: 0 },
    ...extra,
  });

  it("a line with border.width 0 exports an explicit no-fill outline, not pptxgenjs's 1 pt default", async () => {
    const result = await exportProjectToPptx(deck("零线宽", [rawRule("zero-rule")]));
    const xml = await partXml(result.data, "ppt/slides/slide1.xml");

    assert.doesNotMatch(xml, /<a:ln w="12700"/);
    assert.equal(outlineOf(namedShape(xml, "PPTD line zero-rule")), "<a:ln><a:noFill/></a:ln>");
  });

  it("a zero-width arrow line exports no arrowhead, as the editor paints none", async () => {
    const result = await exportProjectToPptx(
      deck("零线宽箭头", [rawRule("zero-arrow", { arrow: ["arrow", "stealth"] })]),
    );
    const shape = namedShape(await partXml(result.data, "ppt/slides/slide1.xml"), "PPTD line zero-arrow");

    assert.doesNotMatch(shape, /<a:(headEnd|tailEnd)\b/);
  });

  it("an axis-fallback line with border.width 0 also draws no outline", async () => {
    const result = await exportProjectToPptx(
      deck("零线宽回退", [rawRule("zero-fallback", { points: "not a polyline" })]),
    );
    const shape = namedShape(await partXml(result.data, "ppt/slides/slide1.xml"), "PPTD line zero-fallback");

    assert.match(shape, /prst="line"/);
    assert.equal(outlineOf(shape), "<a:ln><a:noFill/></a:ln>");
  });

  it("zero-width shapes draw no outline, while a 2 px line beside them keeps 19 050 EMU", async () => {
    const shapeAt = (elementId: string, border: ShapeElement["border"], x: number) => ({
      ...presetBox(border),
      elementId,
      bounds: [x, 40, 200, 100] as ShapeElement["bounds"],
    });
    const result = await exportProjectToPptx(
      deck("零描边形状", [
        shapeAt("zero-preset", { color: "#111111", width: 0 }, 40),
        { ...customBox({ color: "#111111", width: 0 }), elementId: "zero-custom" },
        rawRule("solid-rule", { border: { color: "#00AA00", width: 2 } }),
      ]),
    );
    const xml = await partXml(result.data, "ppt/slides/slide1.xml");

    assert.doesNotMatch(xml, /<a:ln w="12700"/);
    assertNoVisibleOutline(namedShape(xml, "zero-preset"), "preset shape at width 0");
    assertNoVisibleOutline(namedShape(xml, "zero-custom"), "custom shape at width 0");
    assert.equal(outlineWidth(namedShape(xml, "PPTD line solid-rule")), 2 * EMU_PER_PX);
  });
});
