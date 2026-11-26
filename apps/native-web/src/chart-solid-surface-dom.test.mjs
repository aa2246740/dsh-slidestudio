import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { strFromU8, unzipSync } from "fflate";
import { test } from "node:test";
import { openSession, renderModel } from "@open-slidestudio/canvas-session";
import * as chartRuntime from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "@open-slidestudio/exporter-native";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import { chartContextOf, configureChartRuntime, paintChartSvg } from "../public/chart-paint.js";

// The browser hands the painters the `/runtime/` chart modules; Node tests hand them the same
// pptd-v2 build, so the real painter runs here.
configureChartRuntime(chartRuntime);
/** @import { Fill, Page } from "@open-slidestudio/pptd-v2" */

/*
 * M5-SCR-R3-001 through the real modules. A plain rectangle with one gradient stop paints as that
 * stop's solid colour, so it is a solid surface: the chart on top of it takes the light ink in
 * the editor (renderModel and the real chart painter) and in the exported chart part alike. A
 * gradient with two stops is not a surface on either side, and neither is a solid panel missing
 * from the page. Each case saves a real deck and reads the chart back from both paths.
 */
const CHART_ID = "surface-chart";
const PANEL_BOUNDS = [20, 20, 460, 240];
const CHART_BOUNDS = [40, 40, 400, 180];
const LIGHT_INK = "#CBD5E1";
const DARK_INK = "#626976";

/** @param {unknown} fill */
function panel(fill) {
  return {
    elementId: "panel",
    elementType: "shape",
    shapeName: "rect",
    bounds: PANEL_BOUNDS,
    fill,
  };
}

/** @param {{position: number, color: string}[]} stops */
const gradient = (stops) => ({ type: "gradient", gradientType: "linear", angle: 0, stops });

/** An ordinary column chart with no background of its own. */
function columnChart() {
  return {
    elementId: CHART_ID,
    elementType: "chart",
    bounds: CHART_BOUNDS,
    data: {
      cols: ["类别", "甲"],
      rows: [
        ["一月", 30],
        ["二月", 40],
      ],
    },
    series: [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" } }],
  };
}

/** @param {unknown[]} elements */
function deck(elements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-solid-surface-"));
  const project = createEmptyProject(dir, { title: "图表底色" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图表底色"));
  project.pages[0].page.elements = /** @type {Page["elements"]} */ (elements);
  saveProject(project);
  return dir;
}

/** The distinct text inks the editor paints on the chart, from the real painter. @param {string} dir */
function editorInk(dir) {
  const model = renderModel(openSession(dir));
  const el = model.elements.find((item) => item.id === CHART_ID);
  assert.ok(el, "the render model carries the chart");
  const dom = new JSDOM(paintChartSvg(el, chartContextOf(model, -1)));
  try {
    const fills = [...dom.window.document.querySelectorAll("text")].map((node) => node.getAttribute("fill"));
    assert.ok(fills.length > 0, "the chart paints text");
    return [...new Set(fills)];
  } finally {
    dom.window.close();
  }
}

/** The distinct colours of the one exported chart part, and the export's degradation report. @param {string} dir */
async function exportedChart(dir) {
  const result = await exportProjectToPptx(dir);
  const files = unzipSync(new Uint8Array(result.data));
  const parts = Object.keys(files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  assert.equal(parts.length, 1, "one chart part");
  const xml = strFromU8(files[parts[0]]);
  const colours = [...xml.matchAll(/srgbClr val="([0-9A-Fa-f]{6})"/g)].map((match) => match[1].toUpperCase());
  return { colours: [...new Set(colours)], report: result.report };
}

test("a dark one-stop gradient panel under a column chart gives the same light ink in the editor and the export", async () => {
  const dir = deck([panel(gradient([{ position: 0, color: "#112233" }])), columnChart()]);
  try {
    assert.deepEqual(editorInk(dir), [LIGHT_INK], "the editor paints the light ink");
    const exported = await exportedChart(dir);
    assert.ok(exported.colours.includes("CBD5E1"), `export light ink: ${exported.colours}`);
    assert.ok(!exported.colours.includes("626976"), `no dark ink: ${exported.colours}`);
    assert.ok(
      exported.report.degradations.some((d) => d.kind === "gradient-as-solid" && d.elementId === "panel"),
      "the panel still records gradient-as-solid",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a solid dark panel under the chart keeps the light ink on both sides", async () => {
  const dir = deck([panel({ type: "solid", color: "#112233" }), columnChart()]);
  try {
    assert.deepEqual(editorInk(dir), [LIGHT_INK]);
    assert.ok((await exportedChart(dir)).colours.includes("CBD5E1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a two-stop gradient panel is not a surface on either side, so the chart keeps the page ink", async () => {
  const dir = deck([
    panel(
      gradient([
        { position: 0, color: "#112233" },
        { position: 1, color: "#FFFFFF" },
      ]),
    ),
    columnChart(),
  ]);
  try {
    assert.deepEqual(editorInk(dir), [DARK_INK]);
    const exported = await exportedChart(dir);
    assert.ok(exported.colours.includes("626976"), `dark ink: ${exported.colours}`);
    assert.ok(!exported.colours.includes("CBD5E1"), `no light ink: ${exported.colours}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a chart on the white page without a panel keeps the dark ink on both sides", async () => {
  const dir = deck([columnChart()]);
  try {
    assert.deepEqual(editorInk(dir), [DARK_INK]);
    assert.ok((await exportedChart(dir)).colours.includes("626976"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
