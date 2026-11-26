import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import { openSession, renderModel } from "@open-slidestudio/canvas-session";
import * as chartRuntime from "@open-slidestudio/pptd-v2";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import { chartContextOf, configureChartRuntime, paintChartSvg } from "../public/chart-paint.js";

// The browser hands the painters the `/runtime/` chart modules; Node tests hand them the same
// pptd-v2 build, so the real painter runs here.
configureChartRuntime(chartRuntime);
/** @import { Fill, Page } from "@open-slidestudio/pptd-v2" */

/*
 * Ruling 121: the surface behind a chart is its own background, else the topmost opaque plain
 * preset rectangle under it (a dark panel), else the page surface the render model resolves (the
 * page backdrop from findPageBackdrop, or the page background). A custom path or another preset
 * never sets it, even when it covers the whole page; nor does a translucent or gradient panel. Each case saves a real project, reads the chart from
 * the render model the editor receives and paints it with the real chart module.
 */
const CHART_ID = "backdrop-chart";
const CHART_BOUNDS = [40, 40, 420, 200];
const DARK = { type: "solid", color: "#111111" };
/** @param {string} color */
const solid = (color) => ({ type: "solid", color });

function chart() {
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

const pageTriangle = {
  elementId: "page-triangle",
  elementType: "shape",
  shapeName: "custom",
  bounds: [0, 0, 960, 540],
  geometry: { viewBox: [960, 540], path: "M 0 0 L 960 0 L 0 540 Z" },
  fill: solid("#111111"),
};
const pageEllipse = {
  elementId: "page-ellipse",
  elementType: "shape",
  shapeName: "ellipse",
  bounds: [0, 0, 960, 540],
  fill: solid("#111111"),
};
const pageRect = {
  elementId: "page-rect",
  elementType: "shape",
  shapeName: "rect",
  bounds: [0, 0, 960, 540],
  fill: solid("#111111"),
};
const panel = {
  elementId: "panel",
  elementType: "shape",
  shapeName: "rect",
  bounds: [20, 20, 460, 240],
  fill: solid("#111111"),
};

/** A one-page project with `elements` on it and, when given, a page background.
 * @param {unknown[]} elements @param {unknown} [background] */
function deck(elements, background) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-backdrop-paint-"));
  const project = createEmptyProject(dir, { title: "图表底色" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图表底色"));
  project.pages[0].page.elements = /** @type {Page["elements"]} */ (elements);
  if (background) project.pages[0].page.background = /** @type {Fill} */ (background);
  saveProject(project);
  return dir;
}

/** The chart markup the editor paints for a saved page, read from its render model.
 * @param {unknown[]} elements @param {unknown} [background] */
function paintedChart(elements, background) {
  const dir = deck(elements, background);
  try {
    const model = renderModel(openSession(dir));
    const el = model.elements.find((item) => item.id === CHART_ID);
    assert.ok(el, "the render model carries the chart");
    return paintChartSvg(el, chartContextOf(model, -1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The fill of every text run in the chart, read back from its painted DOM. @param {string} markup */
function textInk(markup) {
  const dom = new JSDOM(markup);
  try {
    const fills = [...dom.window.document.querySelectorAll("text")].map((node) => node.getAttribute("fill"));
    assert.ok(fills.length > 0, "the chart paints text");
    return [...new Set(fills)];
  } finally {
    dom.window.close();
  }
}

test("a full-page custom triangle or another full-page preset behind a chart is not its surface", () => {
  const onPlainPage = paintedChart([chart()]);
  assert.deepEqual(textInk(paintedChart([pageTriangle, chart()])), textInk(onPlainPage));
  assert.equal(paintedChart([pageTriangle, chart()]), onPlainPage);
  assert.deepEqual(textInk(paintedChart([pageEllipse, chart()])), textInk(onPlainPage));
  assert.equal(paintedChart([pageEllipse, chart()]), onPlainPage);
});

test("a plain panel under a chart sets its surface, as a dark panel does for a legacy chart", () => {
  const onPlainPage = paintedChart([chart()]);
  const onDarkPanel = paintedChart([panel, chart()]);
  assert.notDeepEqual(textInk(onDarkPanel), textInk(onPlainPage));
  assert.equal(onDarkPanel, paintedChart([chart()], DARK));
});

test("a translucent or gradient plain panel under a chart does not set its surface", () => {
  const onPlainPage = paintedChart([chart()]);
  const translucent = { ...panel, elementId: "translucent", fill: solid("#111111B3") };
  const gradient = {
    ...panel,
    elementId: "gradient",
    fill: {
      type: "gradient",
      angle: 0,
      stops: [
        { position: 0, color: "#111111" },
        { position: 1, color: "#FFFFFF" },
      ],
    },
  };
  assert.equal(paintedChart([translucent, chart()]), onPlainPage);
  assert.equal(paintedChart([gradient, chart()]), onPlainPage);
});

test("a full-page plain rectangle is the surface behind a chart, as a dark page background is", () => {
  const onDarkPage = paintedChart([chart()], DARK);
  assert.notDeepEqual(textInk(onDarkPage), textInk(paintedChart([chart()])));
  assert.deepEqual(textInk(paintedChart([pageRect, chart()])), textInk(onDarkPage));
  assert.equal(paintedChart([pageRect, chart()]), onDarkPage);
});
