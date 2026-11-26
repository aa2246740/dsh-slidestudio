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
 * A negative value keeps its minus sign on the value axis and in its data label, as the exported
 * chart does. Each case saves a real project, reads the chart from the render model the editor
 * receives and paints it with the real chart module. The text the painter writes is read back
 * from the DOM, so the assertions see what the user sees.
 */
const CHART_ID = "sign-chart";
const MINUS = "\u2212";

/** @param {number[]} values @param {Record<string, unknown>} [extra] */
function chart(values, extra = {}) {
  return {
    elementId: CHART_ID,
    elementType: "chart",
    bounds: [40, 40, 420, 200],
    data: {
      cols: ["类别", "甲"],
      rows: values.map((value, index) => [`类别${index + 1}`, value]),
    },
    series: [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" } }],
    ...extra,
  };
}

/** Save a one-page project with `elements` on it and return the chart markup the editor paints.
 * @param {unknown[]} elements */
function paintedChart(elements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-value-sign-"));
  try {
    const project = createEmptyProject(dir, { title: "图表符号" });
    listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图表符号"));
    project.pages[0].page.elements = /** @type {Page["elements"]} */ (elements);
    saveProject(project);
    const model = renderModel(openSession(dir));
    const el = model.elements.find((item) => item.id === CHART_ID);
    assert.ok(el, "the render model carries the chart");
    return paintChartSvg(el, chartContextOf(model, -1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The text content of every text node the chart paints. @param {string} markup */
function paintedTexts(markup) {
  const dom = new JSDOM(markup);
  try {
    return [...dom.window.document.querySelectorAll("text")].map((node) => node.textContent);
  } finally {
    dom.window.close();
  }
}

test("a negative bar keeps its minus sign in its data label and on the value axis", () => {
  const texts = paintedTexts(paintedChart([chart([-30, 40])]));
  assert.ok(texts.includes(`${MINUS}30`), `the data label keeps the minus: ${texts}`);
  assert.ok(
    texts.some((text) => text.startsWith(MINUS) && text !== `${MINUS}30`),
    `a negative value-axis tick keeps the minus: ${texts}`,
  );
  assert.ok(!texts.includes("30"), `no unsigned copy of the negative label: ${texts}`);
});

test("percent-stacked shares and their percent axis keep the ASCII percent text", () => {
  const percent = chart([-25, 40], {
    grouping: "percentStacked",
    data: {
      cols: ["类别", "甲", "乙"],
      rows: [
        ["一月", -25, 75],
        ["二月", 40, 60],
      ],
    },
    series: [
      { type: "bar", name: "甲", encode: { x: "类别", y: "甲" } },
      { type: "bar", name: "乙", encode: { x: "类别", y: "乙" } },
    ],
  });
  const texts = paintedTexts(paintedChart([percent]));
  assert.ok(texts.includes("-25%"), `a negative share reads -25%: ${texts}`);
  assert.ok(texts.includes("-50%"), `the percent axis reads -50%: ${texts}`);
  assert.ok(
    texts.every((text) => !text.includes(MINUS)),
    `percent text has no typographic minus: ${texts}`,
  );
});
