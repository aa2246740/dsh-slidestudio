import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";

function projectWithCover(dir: string, title: string) {
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  saveProject(project);
  return project;
}

describe("export-native surfaces and report validation", () => {
  it("uses the exported first gradient stop and backplates scatter labels on a dark surface", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-dark-specialized-chart-"));
    const project = projectWithCover(dir, "深色图表配色");
    project.pages[0]!.page.background = {
      type: "gradient",
      gradientType: "linear",
      stops: [
        { position: 0, color: "#07111F" },
        { position: 1, color: "#DCE8F5" },
      ],
    };
    project.pages[0]!.page.elements = [
      {
        elementId: "wf-dark",
        elementType: "chart",
        bounds: [20, 28, 430, 260],
        title: "现金桥",
        axis: { x: "阶段", y: "金额" },
        data: {
          cols: ["阶段", "金额", "总计"],
          rows: [
            ["期初", 120, true],
            ["流入", 60, false],
            ["流出", -35, false],
            ["期末", 145, true],
          ],
        },
        series: [{ type: "waterfall", encode: { x: "阶段", y: "金额", isTotal: "总计" } }],
        legend: false,
      },
      {
        elementId: "scatter-dark",
        elementType: "chart",
        bounds: [490, 28, 430, 300],
        title: "风险矩阵",
        axis: { x: "可能性", y: "影响" },
        data: {
          cols: ["风险", "可能性", "影响"],
          rows: [
            ["供应", 4, 5],
            ["价格", 3, 4],
          ],
        },
        series: [{ type: "scatter", encode: { x: "可能性", y: "影响" }, fill: "#38BDF8" }],
        legend: false,
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartParts = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))
        .map((name) => zip.file(name)!.async("string")),
    );
    const chartXml = chartParts.join("\n");
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");

    assert.equal(result.report.ok, true);
    assert.match(chartXml, /<c:barChart>/);
    assert.match(chartXml, /<c:scatterChart>/);
    assert.match(chartXml, /<a:srgbClr val="CBD5E1"\/>/);
    assert.match(chartXml, /<a:srgbClr val="475569"\/>/);
    assert.doesNotMatch(
      chartXml,
      /<a:srgbClr val="000000"\/>/,
      "specialized chart axis and title text must not fall back to black on navy",
    );
    assert.ok(slideXml);
    assert.match(slideXml, /<a:srgbClr val="CBD5E1"\/>/);
    assert.doesNotMatch(slideXml, /<a:srgbClr val="0B1F3A"\/>/);
    assert.ok(
      (slideXml.match(/prst="roundRect"/g) ?? []).length >= 2,
      "each scatter label needs a readable export backplate",
    );
    assert.match(
      slideXml,
      /<a:srgbClr val="F8FAFC"/,
      "labels receive a light backplate when dark ink is more readable",
    );
    assert.match(
      slideXml,
      /<a:srgbClr val="0F172A"/,
      "label foreground is recomputed against the quadrant's effective color",
    );
  });

  it("does not export a missing-fill ellipse as opaque white over title text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-missing-fill-"));
    const project = projectWithCover(dir, "门店深度复盘");
    project.pages[0]!.page.elements = [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#08151C" },
      },
      {
        elementId: "bg_glow",
        elementType: "shape",
        shapeName: "ellipse",
        bounds: [80, 240, 480, 220],
        opacity: 0.3,
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [60, 360, 800, 50],
        content: { text: "门店深度复盘", fontSize: 34, color: "#FFFFFF", bold: true },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    assert.match(xml, /门店深度复盘/);
    assert.doesNotMatch(xml, /prst="ellipse"/);
    const opaqueWhiteEllipse =
      /prst="ellipse"[\s\S]{0,1200}?<a:solidFill>\s*<a:srgbClr val="FFFFFF"\s*\/>\s*<\/a:solidFill>/;
    assert.doesNotMatch(xml, opaqueWhiteEllipse);
  });

  it("exports an explicit fill color and applies element opacity as transparency", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-fill-opacity-"));
    const project = projectWithCover(dir, "填充透明度");
    project.pages[0]!.page.elements = [
      {
        elementId: "mark",
        elementType: "shape",
        shapeName: "ellipse",
        bounds: [100, 100, 200, 120],
        opacity: 0.3,
        fill: { type: "solid", color: "#A100FF" },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [40, 40, 400, 40],
        content: { text: "可见标题", fontSize: 20, color: "#FFFFFF" },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    assert.match(xml, /prst="ellipse"/);
    assert.match(xml, /srgbClr val="A100FF"/);
    assert.match(xml, /<a:alpha val="30000"\/>/);
  });

  it("HEX8 text color exports RGB, not invented srgb 000000 from CSS rgba", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-hex8-text-"));
    const project = projectWithCover(dir, "YU7 hex8");
    project.pages[0]!.page.elements = [
      {
        elementId: "label",
        elementType: "text",
        bounds: [80, 80, 400, 80],
        content: { text: "头身比", fontSize: 24, color: "#FFFFFFB3" },
      },
    ];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.nativeCoverage, 1);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    assert.match(xml, /srgbClr val="FFFFFF"/i);
    assert.doesNotMatch(xml, /srgbClr val="000000"/i);
  });

  it("unprefixed YAML hex never exports as invented srgb 000000", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-unprefixed-hex-"));
    const project = projectWithCover(dir, "个人答辩");
    project.pages[0]!.page.elements = [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "0E0807" },
      },
      {
        elementId: "recap",
        elementType: "text",
        bounds: [60, 120, 840, 80],
        content: { text: "审议请求", fontSize: 24, color: "E8DED7" },
      },
    ];
    saveProject(project);
    try {
      const result = await exportProjectToPptx(project);
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(result.data);
      const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
      assert.ok(xml);
      assert.match(xml, /srgbClr val="0E0807"/i);
      assert.match(xml, /srgbClr val="E8DED7"/i);
      const inventedBlackFromUnprefixed =
        /srgbClr val="000000"[\s\S]{0,200}审议请求|审议请求[\s\S]{0,400}srgbClr val="000000"/;
      assert.doesNotMatch(xml, inventedBlackFromUnprefixed);
    } catch (error) {
      assert.match(String(error), /must not become #000000|InvalidPptdColor|#RRGGBB/);
    }
  });

  describe("validateExportReport", () => {
    const baseValidReport = {
      ok: true,
      slideCount: 4,
      nativeCoverage: 1,
      degradations: [],
      editDataCharts: { ok: ["chart1"], failed: [] },
      editableLines: [],
      bytes: 12345,
    };

    it("accepts a clean report with ok=true and positive bytes", async () => {
      const { validateExportReport } = await import("./export-pptd.js");
      const validation = validateExportReport(baseValidReport);
      assert.equal(validation.ok, true);
    });

    it("rejects when ok is false", async () => {
      const { validateExportReport } = await import("./export-pptd.js");
      const validation = validateExportReport({ ...baseValidReport, ok: false });
      assert.equal(validation.ok, false);
      assert.match(validation.reason, /report\.ok is not true/);
    });

    it("rejects hard degradations: missing-image, chart-export-failed, full-page raster", async () => {
      const { validateExportReport } = await import("./export-pptd.js");
      const r1 = validateExportReport({
        ...baseValidReport,
        degradations: [{ slideIndex: 0, kind: "missing-image", reason: "image not found" }],
      });
      assert.equal(r1.ok, false);
      assert.match(r1.reason, /missing-image/);

      const r2 = validateExportReport({
        ...baseValidReport,
        degradations: [{ slideIndex: 1, kind: "full-page-raster", reason: "fallback" }],
      });
      assert.equal(r2.ok, false);
      assert.match(r2.reason, /full-page-raster/);

      const r3 = validateExportReport({
        ...baseValidReport,
        degradations: [{ slideIndex: 2, kind: "shape-fallback", reason: "full-page screenshot slide used" }],
      });
      assert.equal(r3.ok, false);
      assert.match(r3.reason, /screenshot slide/);
    });

    it("rejects failed editDataCharts", async () => {
      const { validateExportReport } = await import("./export-pptd.js");
      const validation = validateExportReport({
        ...baseValidReport,
        editDataCharts: { ok: [], failed: ["chart-fail"] },
      });
      assert.equal(validation.ok, false);
      assert.match(validation.reason, /failed editDataCharts/);
    });

    it("rejects zero or missing bytes and invalid slideCount", async () => {
      const { validateExportReport } = await import("./export-pptd.js");
      const r1 = validateExportReport({ ...baseValidReport, bytes: 0 });
      assert.equal(r1.ok, false);
      assert.match(r1.reason, /bytes/);

      const r2 = validateExportReport({ ...baseValidReport, slideCount: 0 });
      assert.equal(r2.ok, false);
      assert.match(r2.reason, /slideCount/);
    });
  });
});
