import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type Fill,
  type PptdElement,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx, validateExportReport, type Degradation } from "./export-pptd.js";

/*
 * A deck saved before the write refusal can hold colours the exporter cannot resolve: an unknown
 * `$token`, a `$a -> $b -> $a` cycle, or a named colour in run HTML. The export must not throw.
 * Each element takes the colour it would inherit without that value (or the documented default)
 * and the export records one `color-fallback` degradation per element.
 */

const CYCLIC_THEME: NonNullable<PptdProject["presentation"]["theme"]> = {
  colors: { a: "$b", b: "$a", ok: "#112233" },
};

function coverProject(
  dir: string,
  elements: PptdElement[],
  options: { theme?: PptdProject["presentation"]["theme"]; background?: Fill } = {},
): PptdProject {
  const project = createEmptyProject(dir, { title: "颜色回退" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("颜色回退"));
  project.pages[0]!.page.elements = elements;
  if (options.background) project.pages[0]!.page.background = options.background;
  if (options.theme) project.presentation.theme = options.theme;
  saveProject(project);
  return project;
}

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `exp-color-fallback-${name}-`));
}

async function slideXml(data: Buffer): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
  assert.ok(xml, "slide1.xml present");
  return xml;
}

function colorFallbacks(degradations: Degradation[]): Array<string | undefined> {
  return degradations
    .filter((d) => d.kind === "color-fallback")
    .map((d) => d.elementId)
    .sort();
}

describe("export colour fallbacks for stored colours", () => {
  it("exports unknown and cyclic token colours without throwing, one degradation per element", async () => {
    const project = coverProject(
      tmp("shape-text"),
      [
        {
          elementId: "box",
          elementType: "shape",
          shapeName: "rect",
          bounds: [60, 60, 300, 120],
          border: { width: 3, color: "$accent9" },
        },
        {
          elementId: "panel",
          elementType: "shape",
          shapeName: "rect",
          bounds: [400, 60, 300, 120],
          fill: { type: "solid", color: "$a" },
        },
        {
          elementId: "label",
          elementType: "text",
          bounds: [60, 260, 600, 80],
          content: { text: "标题", fontSize: 24, color: "$accent9" },
        },
      ] as PptdElement[],
      { theme: CYCLIC_THEME },
    );
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true);
    assert.deepEqual(colorFallbacks(result.report.degradations), ["box", "label", "panel"]);
    const xml = await slideXml(result.data);
    // The bordered box takes the unstyled line colour, the label the text default, and the cyclic
    // fill paints nothing.
    assert.match(xml, /srgbClr val="111111"/i);
    assert.match(xml, /srgbClr val="000000"/i);
    assert.doesNotMatch(xml, /\$accent9|\$a\b|\$b\b/);
    assert.equal(validateExportReport(result.report).ok, true);
  });

  it("records a page-level degradation for an unresolvable page background", async () => {
    const project = coverProject(
      tmp("page-background"),
      [
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 120, 600, 80],
          content: { text: "背景", fontSize: 24, color: "#112233" },
        },
      ] as PptdElement[],
      { theme: CYCLIC_THEME, background: { type: "solid", color: "$a" } },
    );
    const result = await exportProjectToPptx(project);
    const pageFallbacks = result.report.degradations.filter((d) => d.kind === "color-fallback");
    assert.equal(pageFallbacks.length, 1);
    assert.equal(pageFallbacks[0]!.elementId, undefined);
    assert.equal(pageFallbacks[0]!.slideIndex, 0);
    assert.match(await slideXml(result.data), /srgbClr val="FFFFFF"/i);
  });

  it("uses the inherited text colour for a stored named run colour", async () => {
    const project = coverProject(tmp("run-colour"), [
      {
        elementId: "runs",
        elementType: "text",
        bounds: [60, 120, 600, 80],
        content: {
          text: '<p><span style="color:red">红</span>字</p>',
          fontSize: 24,
          color: "#112233",
        },
      },
    ] as PptdElement[]);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true);
    assert.deepEqual(colorFallbacks(result.report.degradations), ["runs"]);
    const xml = await slideXml(result.data);
    assert.match(xml, /srgbClr val="112233"/i);
    assert.doesNotMatch(xml, /red/i);
  });

  it("falls back for table cells, shadows, lines and chart swatches without corrupt XML", async () => {
    const project = coverProject(
      tmp("other-elements"),
      [
        {
          elementId: "grid",
          elementType: "table",
          bounds: [60, 60, 400, 120],
          columnWidths: [200, 200],
          rows: [[{ text: "甲", color: "$accent9" }, { text: "乙" }]],
        },
        {
          elementId: "shadowed",
          elementType: "shape",
          shapeName: "rect",
          bounds: [60, 220, 300, 120],
          fill: { type: "solid", color: "#FFFFFF" },
          shadow: { blur: 8, opacity: 0.5, color: "$a" },
        },
        {
          elementId: "rule",
          elementType: "line",
          bounds: [60, 380, 300, 4],
          viewBox: [300, 4],
          points: "0,2 300,2",
          border: { width: 2, color: "$a" },
        },
        {
          elementId: "bars",
          elementType: "chart",
          bounds: [480, 60, 420, 300],
          data: {
            cols: ["项", "甲", "乙"],
            rows: [
              ["a", 3, 4],
              ["b", 4, 5],
            ],
          },
          series: [
            { type: "bar", name: "甲", encode: { x: "项", y: "甲" } },
            { type: "bar", name: "乙", encode: { x: "项", y: "乙" } },
          ],
          colors: ["$accent9", "#10B981"],
          legend: false,
        },
      ] as PptdElement[],
      { theme: CYCLIC_THEME },
    );
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true);
    assert.deepEqual(colorFallbacks(result.report.degradations), ["bars", "grid", "rule", "shadowed"]);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartName = Object.keys(zip.files).find((n) => n.startsWith("ppt/charts/chart"));
    assert.ok(chartName, "chart part present");
    const chartXml = await zip.file(chartName)!.async("string");
    assert.match(chartXml, /2563EB/i, "first series keeps its palette swatch");
    assert.match(chartXml, /10B981/i, "explicit second swatch is kept");
    assert.doesNotMatch(chartXml, /\$accent9|\$a\b/, "no theme token text reaches the chart part");
    const xml = await slideXml(result.data);
    assert.match(xml, /1A1917/i, "table cell text uses the table default");
    assert.doesNotMatch(xml, /\$accent9|\$a\b/);
  });

  it("exports a six-digit unprefixed colour as the colour it spells, with no degradation", async () => {
    const project = coverProject(
      tmp("unprefixed"),
      [
        {
          elementId: "panel",
          elementType: "shape",
          shapeName: "rect",
          bounds: [60, 60, 400, 120],
          fill: { type: "solid", color: "0E0807" },
          border: { width: 2, color: "2563eb" },
        },
        {
          elementId: "accent",
          elementType: "shape",
          shapeName: "rect",
          bounds: [480, 60, 300, 120],
          fill: { type: "solid", color: "$accent" },
        },
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 260, 840, 120],
          content: {
            text: '<p><span style="color:E8DED7">审议</span>请求</p>',
            fontSize: 24,
            color: "E8DED7",
          },
        },
      ] as PptdElement[],
      { theme: { colors: { accent: "d97757" } } },
    );
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true);
    assert.deepEqual(colorFallbacks(result.report.degradations), []);
    const xml = await slideXml(result.data);
    assert.match(xml, /srgbClr val="0E0807"/i);
    assert.match(xml, /srgbClr val="2563EB"/i);
    assert.match(xml, /srgbClr val="D97757"/i, "a palette token reads the palette's colour");
    assert.match(xml, /srgbClr val="E8DED7"/i);
    assert.equal(validateExportReport(result.report).ok, true);
  });
});
