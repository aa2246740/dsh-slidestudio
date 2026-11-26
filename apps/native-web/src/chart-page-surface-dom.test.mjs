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
 * Ruling 131: one page-surface rule decides the chart ink. A picture page background, its own or
 * one inherited from a layout, is the #111111 surface in the editor, so the chart paints light ink
 * there. The exported chart part of the same deck must carry that ink too. A picture backdrop is
 * no surface, so a white page keeps the dark ink on both sides. Each case saves a real deck and
 * reads the chart back from the renderModel, the real chart painter and the exported chart part.
 */
const CHART_ID = "surface-chart";
const CHART_BOUNDS = [40, 40, 400, 180];
const LIGHT_INK = "#CBD5E1";
const DARK_INK = "#626976";
const PHOTO_SRC = "media/photo.png";
// A 1 by 1 PNG, the same bytes the exporter tests use for a page picture.
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

/** @param {string} dir */
function writePhoto(dir) {
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, PHOTO_SRC), PHOTO);
}

/** A saved deck whose cover page has the given elements and, optionally, its own background.
 * @param {unknown[]} elements @param {unknown} [background] */
function deck(elements, background) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-page-surface-"));
  const project = createEmptyProject(dir, { title: "页面底色" });
  writePhoto(dir);
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("页面底色"));
  project.pages[0].page.elements = /** @type {Page["elements"]} */ (elements);
  if (background) project.pages[0].page.background = /** @type {Fill} */ (background);
  saveProject(project);
  return dir;
}

/**
 * A saved deck whose cover page uses a layout with a picture background. The page keeps no
 * background of its own, so saving materialises the layout's picture onto the page.
 */
/** @param {unknown[]} elements */
function deckOnPictureLayout(elements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-page-surface-layout-"));
  const project = createEmptyProject(dir, { title: "版式底色" });
  writePhoto(dir);
  project.presentation.layouts = [
    {
      id: "photo",
      name: "照片底",
      background: { type: "image", src: PHOTO_SRC },
      elements: [],
    },
  ];
  // The cover template carries its own white background, which would win over the layout's.
  const { background: _ownBackground, ...page } = titleOnlyCoverPage("版式底色");
  listComposedPage(project, "pages/cover.page", { ...page, layoutId: "photo" });
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

test("a picture page background is the dark surface on both sides, so the chart takes light ink", async () => {
  const dir = deck([columnChart()], { type: "image", src: PHOTO_SRC });
  try {
    assert.deepEqual(editorInk(dir), [LIGHT_INK], "the editor paints the light ink");
    const exported = await exportedChart(dir);
    assert.ok(exported.colours.includes("CBD5E1"), `export light ink: ${exported.colours}`);
    assert.ok(!exported.colours.includes("626976"), `no dark ink: ${exported.colours}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a picture background inherited from a layout is the same surface on both sides", async () => {
  const dir = deckOnPictureLayout([columnChart()]);
  try {
    assert.deepEqual(editorInk(dir), [LIGHT_INK], "the editor paints the light ink");
    const exported = await exportedChart(dir);
    assert.ok(exported.colours.includes("CBD5E1"), `export light ink: ${exported.colours}`);
    assert.ok(!exported.colours.includes("626976"), `no dark ink: ${exported.colours}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a picture backdrop is no surface, so a white page keeps the dark ink on both sides", async () => {
  const photoBackdrop = {
    elementId: "photo-backdrop",
    elementType: "shape",
    shapeName: "rect",
    bounds: [0, 0, 960, 540],
    fill: { type: "image", src: PHOTO_SRC },
  };
  const dir = deck([photoBackdrop, columnChart()]);
  try {
    assert.deepEqual(editorInk(dir), [DARK_INK]);
    const exported = await exportedChart(dir);
    assert.ok(exported.colours.includes("626976"), `dark ink: ${exported.colours}`);
    assert.ok(!exported.colours.includes("CBD5E1"), `no light ink: ${exported.colours}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
