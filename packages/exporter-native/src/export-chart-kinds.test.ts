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
import { chart, chartNumber, cols, exportChartParts, gradient, rows } from "./export-chart-support.js";
import { exportProjectToPptx, type Degradation } from "./export-pptd.js";

/** One chart of each new kind, a stacked bar plus line combo, a gradient series and a scatter. */
const fixture: ChartElement[] = [
  chart("radar", [{ type: "radar", encode: { x: "类别" } }]),
  chart("stacked", [{ type: "bar", encode: { x: "类别" } }], { grouping: "stacked" }),
  chart("percent-stacked", [{ type: "bar", encode: { x: "类别" } }], {
    grouping: "percentStacked",
  }),
  chart("doughnut", [{ type: "doughnut", name: "甲", encode: { x: "类别", y: "甲" } }]),
  chart(
    "stacked-combo",
    [
      { type: "bar", name: "甲", encode: { x: "类别", y: "甲" } },
      { type: "line", name: "乙", encode: { x: "类别", y: "乙" } },
    ],
    { grouping: "stacked" },
  ),
  chart("gradient-series", [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" }, fill: gradient }]),
  chart(
    "scatter",
    [{ type: "scatter", name: "体重", encode: { x: "身高", y: "体重" } }],
    {},
    {
      cols: ["身高", "体重"],
      rows: [
        [160, 50],
        [170, 65],
        [180, 80],
      ],
    },
  ),
  chart("line", [{ type: "line", name: "乙", encode: { x: "类别", y: "乙" } }]),
];

type ExportedCharts = {
  zip: JSZip;
  /** Chart part names ordered by part number, one per fixture chart in fixture order. */
  names: string[];
  /** Chart XML in the order of `fixture`. */
  parts: string[];
  degradations: Degradation[];
};

/**
 * Export each fixture chart on its own page. pptxgenjs numbers chart parts from a
 * process-wide counter, so parts are matched to fixture entries by their order
 * within this one export, never by their number.
 */
async function exportFixtureCharts(): Promise<ExportedCharts> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-chart-kinds-"));
  try {
    const project = createEmptyProject(dir, { title: "图表类型" });
    listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图表类型"));
    for (const [index, element] of fixture.entries()) {
      const page: Page = {
        pageType: "content",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [element as Page["elements"][number]],
      };
      listComposedPage(project, `pages/${String(index + 1).padStart(2, "0")}-chart.page`, page);
    }
    saveProject(project);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true, JSON.stringify(result.report.degradations));
    const zip = await JSZip.loadAsync(result.data);
    const names = Object.keys(zip.files)
      .filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))
      .sort((a, b) => chartNumber(a) - chartNumber(b));
    assert.equal(names.length, fixture.length, "one chart part per fixture chart");
    const parts: string[] = [];
    for (const name of names) parts.push(await zip.file(name)!.async("string"));
    return { zip, names, parts, degradations: result.report.degradations };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function partFor(exported: ExportedCharts, elementId: string): string {
  const index = fixture.findIndex((element) => element.elementId === elementId);
  const part = exported.parts[index];
  assert.ok(part, `part for ${elementId}`);
  return part;
}

function seriesBlocks(xml: string): string[] {
  return xml.match(/<c:ser>[\s\S]*?<\/c:ser>/g) ?? [];
}

/** Numeric points of a series' values in idx order: c:val, or c:yVal for a scatter series. */
function valuePoints(serXml: string): number[] {
  const val = serXml.match(/<c:(?:val|yVal)>([\s\S]*?)<\/c:(?:val|yVal)>/)?.[1] ?? "";
  return [...val.matchAll(/<c:pt idx="(\d+)"[^>]*><c:v>([^<]*)<\/c:v><\/c:pt>/g)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => Number(match[2]));
}

/** Numeric cell values by reference from the first worksheet of a chart's embedded workbook. */
async function workbookCells(zip: JSZip, partName: string): Promise<Map<string, number>> {
  const relName = partName.replace("ppt/charts/", "ppt/charts/_rels/") + ".rels";
  const rel = await zip.file(relName)!.async("string");
  const target = rel.match(/Target="\.\.\/embeddings\/([^"]+\.xlsx)"/)?.[1];
  assert.ok(target, `${partName} has an embedded workbook`);
  const bytes = await zip.file(`ppt/embeddings/${target}`)!.async("uint8array");
  const workbook = await JSZip.loadAsync(bytes);
  const sheet = await workbook.file("xl/worksheets/sheet1.xml")!.async("string");
  const cells = new Map<string, number>();
  for (const match of sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*?>([\s\S]*?)<\/c>/g)) {
    const value = match[2]?.match(/<v>([^<]*)<\/v>/)?.[1];
    if (value !== undefined && Number.isFinite(Number(value))) cells.set(match[1]!, Number(value));
  }
  return cells;
}

describe("export-native: radar, stacked, percent-stacked and doughnut charts", () => {
  it("writes c:radarChart with c:radarStyle for a radar chart", async () => {
    const exported = await exportFixtureCharts();
    assert.match(partFor(exported, "radar"), /<c:radarChart>[\s\S]*?<c:radarStyle val="[a-z]+"\/>/);
  });

  it("writes stacked and percent-stacked bars with grouping and a full overlap", async () => {
    const exported = await exportFixtureCharts();
    assert.match(
      partFor(exported, "stacked"),
      /<c:barChart>[\s\S]*?<c:grouping val="stacked"\/>[\s\S]*?<c:overlap val="100"\/>/,
    );
    assert.match(
      partFor(exported, "percent-stacked"),
      /<c:barChart>[\s\S]*?<c:grouping val="percentStacked"\/>[\s\S]*?<c:overlap val="100"\/>/,
    );
  });

  it("exports a percent-stacked bar with a negative share on a -100 to 100 percent axis", async () => {
    const [part] = await exportChartParts([
      chart(
        "percent-negative",
        [
          { type: "bar", name: "甲", encode: { x: "类别", y: "甲" } },
          { type: "bar", name: "乙", encode: { x: "类别", y: "乙" } },
        ],
        { grouping: "percentStacked" },
        { cols, rows: [["一月", -25, 75]] },
      ),
    ]);
    const axis = part!.match(/<c:valAx>[\s\S]*?<\/c:valAx>/)?.[0] ?? "";
    assert.match(axis, /<c:max val="1"\/>/);
    assert.match(axis, /<c:min val="-1"\/>/);
    const [negative, positive] = seriesBlocks(part!).map(valuePoints);
    assert.deepEqual(negative, [-25], "the negative share keeps its sign");
    assert.deepEqual(positive, [75]);
  });

  it("keeps a 0 to 100 percent axis for a percent-stacked bar without negative values", async () => {
    const exported = await exportFixtureCharts();
    const axis = partFor(exported, "percent-stacked").match(/<c:valAx>[\s\S]*?<\/c:valAx>/)?.[0];
    assert.ok(axis, "value axis");
    assert.doesNotMatch(axis, /<c:min val="-/);
    assert.match(axis, /<c:max val="1"\/>/);
    assert.match(axis, /<c:numFmt formatCode="0%" sourceLinked="0"\/>/);
  });

  it("writes c:doughnutChart with a hole size", async () => {
    const exported = await exportFixtureCharts();
    assert.match(partFor(exported, "doughnut"), /<c:doughnutChart>[\s\S]*?<c:holeSize val="\d+"\/>/);
  });

  it("puts a stacked bar and a line into one plotArea", async () => {
    const exported = await exportFixtureCharts();
    const combo = partFor(exported, "stacked-combo");
    assert.equal((combo.match(/<c:plotArea>/g) ?? []).length, 1);
    assert.match(combo, /<c:barChart>[\s\S]*?<c:grouping val="stacked"\/>/);
    assert.match(combo, /<c:lineChart>/);
  });

  it("writes a gradient series fill as a:gradFill in its c:spPr with the model stops", async () => {
    const exported = await exportFixtureCharts();
    const series = seriesBlocks(partFor(exported, "gradient-series"))[0] ?? "";
    const spPr = series.match(/<c:spPr>([\s\S]*?)<\/c:spPr>/)?.[1] ?? "";
    assert.match(spPr, /<a:gradFill[\s>]/);
    assert.match(spPr, /<a:gs pos="0"[^>]*>\s*<a:srgbClr val="2563EB"\/>/);
    assert.match(spPr, /<a:gs pos="100000"[^>]*>\s*<a:srgbClr val="10B981"[^>]*>\s*<a:alpha val="50000"\/>/);
  });

  it("writes every chart's c:val points equal to the model values", async () => {
    const exported = await exportFixtureCharts();
    const expected = [
      [30, 40, 50],
      [20, 25, 30],
    ];
    for (const id of ["radar", "stacked", "percent-stacked"]) {
      assert.deepEqual(seriesBlocks(partFor(exported, id)).map(valuePoints), expected, `${id} values`);
    }
    assert.deepEqual(valuePoints(seriesBlocks(partFor(exported, "doughnut"))[0] ?? ""), [30, 40, 50]);
  });

  it("writes embedded workbook cells equal to the value points of every series", async () => {
    const exported = await exportFixtureCharts();
    for (const [index, element] of fixture.entries()) {
      const partName = exported.names[index]!;
      const cells = await workbookCells(exported.zip, partName);
      for (const series of seriesBlocks(exported.parts[index]!)) {
        const ref = series.match(/<c:(?:val|yVal)>[\s\S]*?<c:f>Sheet1!\$([A-Z])\$(\d+):\$[A-Z]\$(\d+)<\/c:f>/);
        assert.ok(ref, `${element.elementId} series has a workbook reference`);
        const [, column, first, last] = ref!;
        const workbookValues: number[] = [];
        for (let row = Number(first); row <= Number(last); row += 1) {
          workbookValues.push(cells.get(`${column}${row}`) ?? Number.NaN);
        }
        assert.deepEqual(workbookValues, valuePoints(series), `${element.elementId} workbook`);
      }
    }
  });

  it("removes the scatter plot-area frame so the export matches the editor", async () => {
    const exported = await exportFixtureCharts();
    const plotArea = partFor(exported, "scatter").match(/<c:plotArea>[\s\S]*<\/c:plotArea>/)?.[0];
    assert.ok(plotArea, "scatter has a plot area");
    const plotSpPr = plotArea.match(/<c:spPr>((?:(?!<c:spPr>)[\s\S])*?)<\/c:spPr>\s*<\/c:plotArea>/)?.[1];
    assert.ok(plotSpPr !== undefined, "plot area has its own spPr");
    const frame = plotSpPr.match(/<a:ln\b[\s\S]*?<\/a:ln>/)?.[0];
    assert.ok(
      frame === undefined || /^<a:ln[^>]*><a:noFill\/><\/a:ln>$/.test(frame),
      `plot area must not paint a frame, found ${frame}`,
    );
  });

  it("keeps the 3 px line series width (28575 EMU) for line charts", async () => {
    const exported = await exportFixtureCharts();
    assert.match(partFor(exported, "line"), /<a:ln w="28575"/);
  });

  it("records only the percent-stacked label degradation among the chart kinds", async () => {
    const exported = await exportFixtureCharts();
    assert.deepEqual(
      exported.degradations.filter((item) => item.kind.startsWith("chart-")).map((item) => [item.elementId, item.kind]),
      [["percent-stacked", "chart-percent-labels-as-values"]],
    );
  });
});

/** The value axis block whose own `c:axId` is `axId`. */
function valueAxisById(xml: string, axId: string | undefined): string {
  return (
    (xml.match(/<c:valAx>[\s\S]*?<\/c:valAx>/g) ?? []).find((axis) => axis.includes(`<c:axId val="${axId}"/>`)) ?? ""
  );
}

/** Axis ids a chart group refers to, in document order: category axis, then value axis. */
function axisIds(group: string): string[] {
  return [...group.matchAll(/<c:axId val="(\d+)"\/>/g)].map((match) => match[1]!);
}

describe("export-native: dual-axis combos honour their grouping in the final chart XML", () => {
  const dualCols = ["类别", "甲", "乙", "丙"];
  const dualRows: (number | string | null)[][] = [
    ["一月", 60, 30, 20],
    ["二月", 40, 20, 10],
  ];
  const dualSeries = [
    { type: "bar", name: "甲", encode: { x: "类别", y: "甲" } },
    { type: "bar", name: "乙", encode: { x: "类别", y: "乙" } },
    { type: "line", name: "丙", axis: "secondary", encode: { x: "类别", y: "丙" } },
  ];

  it("stacks the two primary bars and puts the line on its own secondary value axis", async () => {
    const [combo] = await exportChartParts([
      chart("dual-stacked", dualSeries, { grouping: "stacked" }, { cols: dualCols, rows: dualRows }),
    ]);
    const bar = combo!.match(/<c:barChart>[\s\S]*?<\/c:barChart>/)?.[0] ?? "";
    const line = combo!.match(/<c:lineChart>[\s\S]*?<\/c:lineChart>/)?.[0] ?? "";
    assert.match(bar, /<c:grouping val="stacked"\/>[\s\S]*?<c:overlap val="100"\/>/);
    assert.deepEqual(seriesBlocks(bar).map(valuePoints), [
      [60, 40],
      [30, 20],
    ]);
    assert.deepEqual(seriesBlocks(line).map(valuePoints), [[20, 10]]);
    const [, primaryId] = axisIds(bar);
    const [, secondaryId] = axisIds(line);
    assert.notEqual(secondaryId, primaryId, "the line uses a separate value axis");
    assert.match(valueAxisById(combo!, primaryId), /<c:max val="100"\/>/);
    const secondary = valueAxisById(combo!, secondaryId);
    assert.match(secondary, /<c:min val="0"\/>/);
    assert.match(secondary, /<c:max val="20"\/>/);
  });

  it("keeps the secondary axis of a percent-stacked combo in plain numbers", async () => {
    const [combo] = await exportChartParts([
      chart("dual-percent", dualSeries, { grouping: "percentStacked" }, { cols: dualCols, rows: dualRows }),
    ]);
    const bar = combo!.match(/<c:barChart>[\s\S]*?<\/c:barChart>/)?.[0] ?? "";
    const line = combo!.match(/<c:lineChart>[\s\S]*?<\/c:lineChart>/)?.[0] ?? "";
    assert.match(bar, /<c:grouping val="percentStacked"\/>[\s\S]*?<c:overlap val="100"\/>/);
    const [, primaryId] = axisIds(bar);
    const [, secondaryId] = axisIds(line);
    assert.match(
      valueAxisById(combo!, primaryId),
      /<c:numFmt formatCode="0%" sourceLinked="0"\/>/,
      "the shared bar axis reads shares",
    );
    const secondary = valueAxisById(combo!, secondaryId);
    assert.match(secondary, /<c:max val="20"\/>/);
    assert.doesNotMatch(secondary, /formatCode="0%"/, "the line axis shows the line's values");
  });
});
