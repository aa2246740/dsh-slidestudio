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
  type ChartElement,
  type Page,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx, type Degradation } from "./export-pptd.js";

const cols = ["类别", "甲", "乙", "丙", "丁"];
const rows: (number | string)[][] = [
  ["一月", 30, 2.5, 7, 11],
  ["二月", 40, 3.5, 8, 12],
  ["三月", 50, 4.5, 9, 13],
];
const categories = rows.map((row) => String(row[0]));
const column = (name: string): number[] => rows.map((row) => Number(row[cols.indexOf(name)]));

function series(type: string, name: string, extra: Record<string, unknown> = {}) {
  return { type, name, encode: { x: "类别", y: name }, ...extra };
}

function chart(
  elementId: string,
  declared: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  data: { cols: string[]; rows: (number | string)[][] } = { cols, rows },
): ChartElement {
  return {
    elementId,
    elementType: "chart",
    bounds: [40, 40, 640, 320],
    data,
    series: declared,
    legend: { show: true, position: "bottom" },
    ...extra,
  } as unknown as ChartElement;
}

type Exported = {
  zip: JSZip;
  chartName: string;
  chart: string;
  slide: string;
  degradations: Degradation[];
};

/** Export one chart on its own page and return its chart part and slide XML. */
async function exportChart(element: ChartElement): Promise<Exported> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-primary-combo-"));
  try {
    const project = createEmptyProject(dir, { title: "组合图" });
    listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("组合图"));
    const page: Page = {
      pageType: "content",
      background: { type: "solid", color: "#FFFFFF" },
      elements: [element as Page["elements"][number]],
    };
    listComposedPage(project, "pages/01-chart.page", page);
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    const chartNames = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    assert.equal(chartNames.length, 1, "one chart part");
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
    return {
      zip,
      chartName: chartNames[0]!,
      chart: await zip.file(chartNames[0]!)!.async("string"),
      slide: await zip.file(slideNames[slideNames.length - 1]!)!.async("string"),
      degradations: result.report.degradations,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function group(xml: string, type: "bar" | "line"): string {
  return xml.match(new RegExp(`<c:${type}Chart>[\\s\\S]*?</c:${type}Chart>`))?.[0] ?? "";
}

function seriesBlocks(xml: string): string[] {
  return xml.match(/<c:ser>[\s\S]*?<\/c:ser>/g) ?? [];
}

function seriesName(ser: string): string {
  return ser.match(/<c:tx>[\s\S]*?<c:v>([^<]*)<\/c:v>/)?.[1] ?? "";
}

function points(ser: string, tag: "val" | "cat"): string[] {
  const body = ser.match(new RegExp(`<c:${tag}>([\\s\\S]*?)</c:${tag}>`))?.[1] ?? "";
  return [...body.matchAll(/<c:pt idx="(\d+)"[^>]*><c:v>([^<]*)<\/c:v><\/c:pt>/g)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => match[2]!);
}

const values = (ser: string): number[] => points(ser, "val").map(Number);

function axisIds(xml: string): string[] {
  return [...xml.matchAll(/<c:axId val="(\d+)"\/>/g)].map((match) => match[1]!);
}

function labelFormat(ser: string): string | undefined {
  return ser.match(/<c:dLbls><c:numFmt formatCode="([^"]*)"/)?.[1];
}

function count(xml: string, tag: string): number {
  return xml.split(tag).length - 1;
}

/** Numeric cells of the first worksheet of the chart's embedded workbook, by reference. */
async function workbookCells({ zip, chartName }: Exported): Promise<Map<string, number>> {
  const rel = await zip.file(chartName.replace("ppt/charts/", "ppt/charts/_rels/") + ".rels")!.async("string");
  const target = rel.match(/Target="\.\.\/embeddings\/([^"]+\.xlsx)"/)?.[1];
  assert.ok(target, "embedded workbook");
  const workbook = await JSZip.loadAsync(await zip.file(`ppt/embeddings/${target}`)!.async("uint8array"));
  const sheet = await workbook.file("xl/worksheets/sheet1.xml")!.async("string");
  const cells = new Map<string, number>();
  for (const match of sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*?>([\s\S]*?)<\/c>/g)) {
    const value = match[2]?.match(/<v>([^<]*)<\/v>/)?.[1];
    if (value !== undefined && Number.isFinite(Number(value))) cells.set(match[1]!, Number(value));
  }
  return cells;
}

describe("export-native: a clustered bar + line chart on the primary axis keeps its line series", () => {
  it("writes one clustered barChart and one lineChart on the same primary axis pair", async () => {
    const exported = await exportChart(chart("bar-line", [series("bar", "甲"), series("line", "乙")]));
    const bar = group(exported.chart, "bar");
    const line = group(exported.chart, "line");
    assert.equal(count(exported.chart, "<c:plotArea>"), 1);
    assert.equal(count(exported.chart, "<c:barChart>"), 1);
    assert.equal(count(exported.chart, "<c:lineChart>"), 1);
    assert.match(bar, /<c:barDir val="col"\/><c:grouping val="clustered"\/>/);
    assert.deepEqual(seriesBlocks(bar).map(seriesName), ["甲"]);
    assert.deepEqual(seriesBlocks(line).map(seriesName), ["乙"]);
    const [barCat, barVal] = axisIds(bar);
    const [lineCat, lineVal] = axisIds(line);
    assert.equal(barCat, lineCat, "one category axis");
    assert.equal(barVal, lineVal, "one value axis");
    assert.equal(count(exported.chart, "<c:valAx>"), 1, "no secondary value axis");
    assert.equal(count(exported.chart, "<c:catAx>"), 1, "no secondary category axis");
    assert.deepEqual(exported.degradations, [], "the export reports no degradation");
  });

  it("keeps series order, names, categories and cached values equal to the model", async () => {
    const exported = await exportChart(
      chart("two-bars-one-line", [series("bar", "甲"), series("bar", "丙"), series("line", "乙")]),
    );
    const written = seriesBlocks(exported.chart);
    assert.deepEqual(written.map(seriesName), ["甲", "丙", "乙"]);
    assert.deepEqual(written.map(values), [column("甲"), column("丙"), column("乙")]);
    for (const ser of written) assert.deepEqual(points(ser, "cat"), categories);
    assert.deepEqual(
      written.map((ser) => Number(ser.match(/<c:order val="(\d+)"\/>/)?.[1])),
      [0, 1, 2],
    );
    assert.deepEqual(seriesBlocks(group(exported.chart, "bar")).map(seriesName), ["甲", "丙"]);
    assert.deepEqual(seriesBlocks(group(exported.chart, "line")).map(seriesName), ["乙"]);
  });

  it("writes one bar and three lines with every value equal to the model", async () => {
    const exported = await exportChart(
      chart("one-bar-three-lines", [
        series("bar", "甲"),
        series("line", "乙"),
        series("line", "丙"),
        series("line", "丁"),
      ]),
    );
    assert.deepEqual(seriesBlocks(group(exported.chart, "bar")).map(values), [column("甲")]);
    assert.deepEqual(seriesBlocks(group(exported.chart, "line")).map(values), [
      column("乙"),
      column("丙"),
      column("丁"),
    ]);
    const cells = await workbookCells(exported);
    for (const ser of seriesBlocks(exported.chart)) {
      const ref = ser.match(/<c:val>[\s\S]*?<c:f>Sheet1!\$([A-Z])\$(\d+):\$[A-Z]\$(\d+)<\/c:f>/);
      assert.ok(ref, `${seriesName(ser)} has a workbook reference`);
      const workbookValues: number[] = [];
      for (let row = Number(ref![2]); row <= Number(ref![3]); row += 1) {
        workbookValues.push(cells.get(`${ref![1]}${row}`) ?? Number.NaN);
      }
      assert.deepEqual(workbookValues, values(ser), `${seriesName(ser)} workbook cells`);
    }
  });

  it("keeps the bars when the first declared series is a line", async () => {
    const exported = await exportChart(chart("line-first", [series("line", "乙"), series("bar", "甲")]));
    assert.match(group(exported.chart, "bar"), /<c:grouping val="clustered"\/>/);
    assert.deepEqual(seriesBlocks(group(exported.chart, "bar")).map(seriesName), ["甲"]);
    assert.deepEqual(seriesBlocks(group(exported.chart, "line")).map(seriesName), ["乙"]);
    assert.deepEqual(exported.degradations, []);
  });

  it("paints bar labels outside the bar end and line labels above the point", async () => {
    const exported = await exportChart(chart("labels", [series("bar", "甲"), series("line", "乙")]));
    assert.match(group(exported.chart, "bar"), /<c:dLblPos val="outEnd"\/>/);
    assert.match(group(exported.chart, "line"), /<c:dLblPos val="t"\/>/);
    assert.match(group(exported.chart, "line"), /<a:ln w="28575"/, "the 3 px line width");
  });

  it("gives each series the label format of its own decimals when bars and lines are interleaved", async () => {
    const exported = await exportChart(
      chart("interleaved", [series("bar", "甲"), series("line", "乙"), series("bar", "丙")]),
    );
    const formatByName = new Map(seriesBlocks(exported.chart).map((ser) => [seriesName(ser), labelFormat(ser)]));
    assert.equal(formatByName.get("甲"), "#,##0");
    assert.equal(formatByName.get("乙"), "#,##0.0");
    assert.equal(formatByName.get("丙"), "#,##0");
  });

  it("keeps each series' declared idx and order when bars and lines are interleaved", async () => {
    const exported = await exportChart(
      chart("interleaved-order", [series("bar", "甲"), series("line", "乙"), series("bar", "丙")]),
    );
    const written = seriesBlocks(exported.chart);
    assert.deepEqual(written.map(seriesName), ["甲", "丙", "乙"], "type groups stay contiguous");
    // The declared series order 甲, 乙, 丙 is carried by c:idx and c:order, not
    // by the written document order pptxgenjs produces when it concatenates the
    // type groups it split the declaration into.
    assert.deepEqual(
      written.map((ser) => Number(ser.match(/<c:idx val="(\d+)"\/>/)?.[1])),
      [0, 2, 1],
    );
    assert.deepEqual(
      written.map((ser) => Number(ser.match(/<c:order val="(\d+)"\/>/)?.[1])),
      [0, 2, 1],
    );
    // Identity: the series carrying order 1 is the declared second series, the
    // line 乙, with the model's categories and values; order 2 is the bar 丙.
    const byOrder = new Map(written.map((ser) => [Number(ser.match(/<c:order val="(\d+)"\/>/)?.[1]), ser]));
    assert.equal(seriesName(byOrder.get(1)!), "乙");
    assert.deepEqual(values(byOrder.get(1)!), column("乙"));
    assert.equal(seriesName(byOrder.get(2)!), "丙");
    assert.deepEqual(values(byOrder.get(2)!), column("丙"));
    for (const ser of written) assert.deepEqual(points(ser, "cat"), categories);
  });

  it("keeps each interleaved series' workbook reference on its own values", async () => {
    const exported = await exportChart(
      chart("interleaved-refs", [series("bar", "甲"), series("line", "乙"), series("bar", "丙")]),
    );
    const cells = await workbookCells(exported);
    for (const ser of seriesBlocks(exported.chart)) {
      const ref = ser.match(/<c:val>[\s\S]*?<c:f>Sheet1!\$([A-Z])\$(\d+):\$[A-Z]\$(\d+)<\/c:f>/);
      assert.ok(ref, `${seriesName(ser)} has a workbook reference`);
      const workbookValues: number[] = [];
      for (let row = Number(ref![2]); row <= Number(ref![3]); row += 1) {
        workbookValues.push(cells.get(`${ref![1]}${row}`) ?? Number.NaN);
      }
      assert.deepEqual(workbookValues, values(ser), `${seriesName(ser)} workbook cells`);
    }
  });

  it("keeps the chart title text box beside the combination", async () => {
    const exported = await exportChart(
      chart("titled", [series("bar", "甲"), series("line", "乙")], { title: "季度趋势" }),
    );
    assert.equal(count(exported.slide, "季度趋势"), 1);
  });

  it("leaves a plain clustered column chart and a plain line chart as one chart type each", async () => {
    const columns = await exportChart(chart("columns", [series("bar", "甲"), series("bar", "丙")]));
    assert.equal(count(columns.chart, "<c:barChart>"), 1);
    assert.equal(count(columns.chart, "<c:lineChart>"), 0);
    const lines = await exportChart(chart("lines", [series("line", "乙"), series("line", "丙")]));
    assert.equal(count(lines.chart, "<c:barChart>"), 0);
    assert.equal(count(lines.chart, "<c:lineChart>"), 1);
  });

  it("keeps a horizontal bar chart with a second series horizontal", async () => {
    const exported = await exportChart(
      chart(
        "horizontal",
        [
          { type: "bar", name: "销量", encode: { x: "销量", y: "地区" } },
          { type: "line", name: "利润", encode: { x: "利润", y: "地区" } },
        ],
        {},
        {
          cols: ["销量", "利润", "地区"],
          rows: [
            [30, 4, "华北"],
            [40, 6, "华东"],
            [50, 5, "华南"],
          ],
        },
      ),
    );
    assert.match(exported.chart, /<c:barDir val="bar"\/>/);
    assert.equal(count(exported.chart, "<c:lineChart>"), 0);
  });
});
