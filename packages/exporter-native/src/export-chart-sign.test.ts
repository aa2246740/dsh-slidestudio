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
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";

/*
 * The editor writes a negative chart value with its minus sign: data labels, value-axis ticks and
 * waterfall totals alike. The exporter writes the same labels as slide text, so a negative waterfall
 * total must keep its sign there too.
 */
const waterfall = {
  elementId: "wf",
  elementType: "chart",
  bounds: [40, 40, 420, 200],
  data: {
    cols: ["步", "额"],
    rows: [
      ["期初", -500],
      ["流入", 200],
      ["期末", -300],
    ],
  },
  series: [{ type: "waterfall", encode: { x: "步", y: "额" } }],
  legend: false,
} as unknown as ChartElement;

async function slideXmlOf(element: ChartElement): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-chart-sign-"));
  try {
    const project: PptdProject = createEmptyProject(dir, { title: "图表符号" });
    listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("图表符号"));
    project.pages[0]!.page.elements = [element];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml, "slide 1 is exported");
    return xml;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("export: a negative chart value keeps its minus sign (M5-SCR-003)", () => {
  it("writes a negative waterfall total label with the minus sign the editor paints", async () => {
    const xml = await slideXmlOf(waterfall);
    assert.match(xml, /<a:t>−500<\/a:t>/, "the negative starting total keeps its minus sign");
    assert.match(xml, /<a:t>−300<\/a:t>/, "the negative closing total keeps its minus sign");
    assert.match(xml, /<a:t>\+200<\/a:t>/, "a positive delta keeps its explicit plus sign");
  });
});
