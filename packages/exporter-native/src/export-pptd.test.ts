import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";
import { mapChartElement } from "./chart-map.js";
import type { ChartElement } from "@open-slidestudio/pptd-v2";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function projectWithCover(dir: string, title: string) {
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  saveProject(project);
  return project;
}

/** Chromatic = saturation at least 0.12 with lightness between 0.10 and 0.92 (palette rule). */
function isChromaticHex(hex: string): boolean {
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return saturation >= 0.12 && lightness >= 0.1 && lightness <= 0.92;
}

describe("export-native", () => {
  it("preserves action-card icons as distinct editable outlines, including regular and brand faces", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-icon-outlines-"));
    try {
      const project = projectWithCover(dir, "Icon fidelity");
      const names = [
        "fas:box-open",
        "fas:arrow-right",
        "fas:layer-group",
        "fas:arrows-rotate",
        "far:heart",
        "fab:github",
      ];
      project.pages[0]!.page.elements = names.map((iconName, index) => ({
        elementId: `icon-${index}`,
        elementType: "icon",
        iconName,
        bounds: [40 + index * 100, 100, 80, 80],
        fill: { type: "solid", color: "#123456" },
        rotation: 15,
        flipH: true,
      }));
      const result = await exportProjectToPptx(project);
      assert.equal(result.report.ok, true);
      assert.deepEqual(result.report.degradations, []);
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(result.data);
      const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
      assert.doesNotMatch(xml, /star5|<p:pic>/);
      const geometries = xml.match(/<a:custGeom>[\s\S]*?<\/a:custGeom>/g) ?? [];
      assert.equal(geometries.length, names.length);
      assert.equal(new Set(geometries).size, names.length);
      assert.match(xml, /<a:quadBezTo>/);
      assert.match(xml, /flipH="1"/);
      assert.match(xml, /rot="900000"/);
      assert.match(xml, /123456/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails export for an unknown icon instead of silently replacing its meaning", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-icon-missing-"));
    try {
      const project = projectWithCover(dir, "Missing icon");
      project.pages[0]!.page.elements = [
        {
          elementId: "unknown",
          elementType: "icon",
          iconName: "fas:does-not-exist",
          bounds: [20, 20, 40, 40],
        },
      ];
      const result = await exportProjectToPptx(project);
      assert.equal(result.report.ok, false);
      assert.equal(result.report.degradations[0]?.kind, "error");
      assert.match(result.report.degradations[0]!.reason, /Unsupported icon/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports PPTD text boxes without PowerPoint default insets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-text-inset-"));
    const project = projectWithCover(dir, "文本框边距");
    project.pages[0]!.page.elements = [
      {
        elementId: "action-number",
        elementType: "text",
        bounds: [320, 200, 60, 40],
        content: {
          text: "02",
          wrap: true,
          bold: true,
          fontSize: 28,
          color: "#6366F1",
        },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    const bodyPr = xml.match(/<a:bodyPr[^>]*>/)?.[0] || "";
    assert.match(bodyPr, /lIns="0"/);
    assert.match(bodyPr, /rIns="0"/);
    assert.match(bodyPr, /tIns="0"/);
    assert.match(bodyPr, /bIns="0"/);
    assert.match(xml, /<a:normAutofit\/>/);
    assert.match(xml, /<a:rPr[^>]*sz="2100"[^>]*>/, "PPTD CSS px must export as 0.75pt, so 28px becomes 21pt");
  });

  it("maps the PPTD CSS line box and preserves LF as pre-wrap soft breaks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-text-line-height-"));
    const project = projectWithCover(dir, "行距");
    project.pages[0]!.page.elements = [
      {
        elementId: "multiline",
        elementType: "text",
        bounds: [80, 80, 400, 180],
        content: { text: "第一行\n第二行", fontSize: 24, lineHeight: 1.35 },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    assert.match(xml, /<a:t>第一行<\/a:t>/);
    assert.match(xml, /<a:t>第二行<\/a:t>/);
    assert.match(xml, /<a:br\/>/);
    assert.equal((xml.match(/<a:p>/g) ?? []).length, 1);
    assert.match(xml, /<a:spcPts val="2430"\/>/, "24px × 1.35 must become an absolute 24.3pt line box");
  });

  it("exports empty project to valid pptx zip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-"));
    const project = projectWithCover(dir, "导出测试");
    project.presentation.pages.push("pages/2_chart.page");
    project.pages.push({
      path: "pages/2_chart.page",
      page: {
        pageType: "content",
        background: { type: "solid", color: "#FFFFFF" },
        elements: [
          {
            elementId: "c1",
            elementType: "chart",
            bounds: [80, 80, 800, 400],
            data: {
              cols: ["月", "收入"],
              rows: [
                ["1月", 10],
                ["2月", 20],
                ["3月", 15],
              ],
            },
            series: [{ type: "bar", name: "收入", encode: { x: "月", y: "收入" } }],
            title: "收入",
          },
        ],
      },
    });
    saveProject(project);

    const result = await exportProjectToPptx(project);
    assert.ok(result.data.byteLength > 1000);
    assert.equal(result.data[0], 0x50); // P
    assert.equal(result.data[1], 0x4b); // K
    assert.equal(result.report.slideCount, 2);
    assert.ok(result.report.editDataCharts.ok.includes("c1"));
    assert.ok(result.report.nativeCoverage > 0);
  });

  it("exports syn-smoke fixture with mixed elements", async () => {
    const fixture = path.join(repoRoot, "fixtures/syn-smoke");
    assert.ok(fs.existsSync(path.join(fixture, "deck.pptd")), "fixture present");
    const project = loadProject(fixture);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.slideCount, 2);
    assert.ok(result.data.byteLength > 5000);
    assert.ok(result.report.editDataCharts.ok.includes("chart1"));
    assert.equal(result.report.ok, true);
    assert.ok(result.report.nativeCoverage >= 0.9);
  });

  it("exports recovered open-kimi okp-yu7 fixture", async () => {
    const fixture = path.join(repoRoot, "fixtures/okp-yu7-ppt");
    assert.ok(fs.existsSync(path.join(fixture, "yu7.pptd")));
    const project = loadProject(fixture);
    const result = await exportProjectToPptx(project);
    assert.ok(result.report.slideCount >= 6);
    assert.ok(result.data.byteLength > 50_000);
    assert.ok(result.report.nativeCoverage >= 0.95);
    const hard = result.report.degradations.filter((d) =>
      ["missing-image", "error", "chart-export-failed"].includes(d.kind),
    );
    assert.equal(hard.length, 0);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const slide3 = await zip.file("ppt/slides/slide3.xml")?.async("string");
    assert.ok(slide3);
    assert.doesNotMatch(slide3, /<span style=/);
    assert.match(slide3, /1:3/);
    assert.match(slide3, /头身比/);
    const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/"));
    assert.ok(media.length >= 1, "page background images must be packed");
  });

  it("keeps yu7 page photos visible through the full-page overlay gradient", async () => {
    const fixture = path.join(repoRoot, "fixtures/okp-yu7-ppt");
    const project = loadProject(fixture);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);

    const imagePages = project.pages.filter((lp) => (lp.page.background as { type?: string })?.type === "image");
    assert.equal(imagePages.length, 8);

    for (let i = 0; i < project.pages.length; i += 1) {
      const bg = project.pages[i]!.page.background as {
        type?: string;
        src?: string;
      };
      if (bg?.type !== "image" || !bg.src) continue;
      const xml = await zip.file(`ppt/slides/slide${i + 1}.xml`)?.async("string");
      const rels = await zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`)?.async("string");
      assert.ok(xml, `slide ${i + 1} xml`);
      assert.ok(rels, `slide ${i + 1} rels`);
      const bgXml = xml.match(/<p:bg>[\s\S]*?<\/p:bg>/)?.[0] ?? "";
      const embed = bgXml.match(/r:embed="(rId\d+)"/)?.[1];
      assert.match(bgXml, /<a:blipFill/, `slide ${i + 1} must keep the photo as p:bg`);
      assert.ok(embed, `slide ${i + 1} background rId`);
      const target = rels.match(new RegExp(`Id="${embed}"[^>]*Target="([^"]+)"`))?.[1];
      assert.ok(target, `slide ${i + 1} background target`);
      const mediaPath = target.replace(/^\.\.\//, "ppt/");
      const packed = zip.file(mediaPath);
      assert.ok(packed, `slide ${i + 1} packed ${mediaPath}`);
      const bytes = await packed.async("uint8array");
      assert.ok(bytes.byteLength > 8_000, `slide ${i + 1} photo must not be an empty stub`);

      const overlay = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
        .map((m) => m[0])
        .find((shape) => /<a:off x="0" y="0"\/>/.test(shape) && /cx="9144000"/.test(shape));
      assert.ok(overlay, `slide ${i + 1} still has a full-page overlay`);
      assert.match(
        overlay,
        /<a:gradFill/,
        `slide ${i + 1} overlay must stay a gradient so the packed photo remains visible`,
      );
      assert.doesNotMatch(
        overlay,
        /<a:solidFill>\s*<a:srgbClr val="000000"><a:alpha val="9[0-9]{4}"\/>/,
        `slide ${i + 1} overlay must not collapse to near-opaque black over the photo`,
      );
      assert.ok((overlay.match(/<a:gs /g) ?? []).length >= 2, `slide ${i + 1} overlay needs the authored stops`);
    }
  });

  it("round-trips an image page background past a translucent gradient overlay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-bg-image-"));
    const project = projectWithCover(dir, "背景图");
    const mediaDir = path.join(dir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const photo = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(path.join(mediaDir, "hero.png"), photo);
    project.pages[0]!.page.background = {
      type: "image",
      src: "media/hero.png",
      fit: { mode: "cover" },
    };
    project.pages[0]!.page.elements = [
      {
        elementId: "overlay",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: {
          type: "gradient",
          gradientType: "linear",
          angle: 0,
          stops: [
            { position: 0, color: "#000000F2" },
            { position: 0.5, color: "#00000099" },
            { position: 1, color: "#00000000" },
          ],
        },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [60, 150, 660, 80],
        content: { text: "封面", fontSize: 42, color: "#FFFFFF", bold: true },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels")?.async("string");
    assert.ok(xml);
    assert.ok(rels);
    assert.match(xml, /<p:bg>[\s\S]*<a:blipFill/);
    assert.match(rels, /relationships\/image/);
    const overlay = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
      .map((m) => m[0])
      .find((shape) => /cx="9144000"/.test(shape) && /<a:off x="0" y="0"\/>/.test(shape));
    assert.ok(overlay);
    assert.match(overlay, /<a:gradFill[\s\S]*<a:gs pos="0"[\s\S]*<a:gs pos="50000"[\s\S]*<a:gs pos="100000"/);
    assert.match(overlay, /<a:alpha val="94902"\/>/);
    assert.match(overlay, /<a:lin ang="0"/);
    assert.doesNotMatch(overlay, /<a:solidFill>/);
    const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/"));
    assert.equal(media.length, 1);
    const packed = await zip.file(media[0]!)!.async("uint8array");
    assert.deepEqual(Buffer.from(packed), photo);
  });

  it("covers photo elements instead of stretching them to the frame", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-image-cover-"));
    const project = projectWithCover(dir, "配图");
    const mediaDir = path.join(dir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const photo = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(path.join(mediaDir, "photo.png"), photo);
    project.pages[0]!.page.elements = [
      {
        elementId: "photo",
        elementType: "image",
        src: "media/photo.png",
        bounds: [40, 80, 200, 400],
        fit: { mode: "cover" },
      },
    ];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    const pic = xml.match(/<p:pic>[\s\S]*?<\/p:pic>/)?.[0] ?? "";
    assert.match(pic, /<a:srcRect[^>]*t="\d+"/);
    assert.match(pic, /<a:srcRect[^>]*b="\d+"/);
    assert.doesNotMatch(pic, /<a:stretch>\s*<a:fillRect\/>/);
  });

  it("packs images extracted from a DOCX and a PDF byte-for-byte as editable pictures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-embedded-image-"));
    const project = projectWithCover(dir, "内嵌图片");
    const mediaDir = path.join(dir, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    // What the intake stores for a picture taken out of a DOCX (PNG) and out of a PDF (JPEG).
    const fromDocx = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAkklEQVQImQXBaWEBABiA4S+AIwAWgAnA3gBGgNkCOAJgARwBHAF2BBgrgD/vTxRAARRwPE8YmMYnLCJYww9sE37iCGf4i/+4xh0eCS94xxTm8BlfsIrvhC3s4RCn+IMLXOGW8IBnvGESs1jAMr4S1rGJXRzgBL9xjkvCDe7xhFdMYAbzWCKs4Bs2sIN9HOMX/vEAIeNgId/hEKsAAAAASUVORK5CYII=",
      "base64",
    );
    const fromPdf = Buffer.from(
      "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAcEAACAwEBAQEAAAAAAAAAAAABAgMEEQAhFDH/xAAUAQEAAAAAAAAAAAAAAAAAAAAG/8QAGxEAAgMAAwAAAAAAAAAAAAAAAQIAAzER0eH/2gAMAwEAAhEDEQA/AKEtatTvxPRgr/PMuhIY42CMPCMVJSB+HWb0k4MHOc4UFFihm32MAgsRWbejxP/Z",
      "base64",
    );
    fs.writeFileSync(path.join(mediaDir, "material-docx0001.png"), fromDocx);
    fs.writeFileSync(path.join(mediaDir, "material-pdf00001.jpg"), fromPdf);
    project.pages[0]!.page.elements = [
      {
        elementId: "docx-picture",
        elementType: "image",
        src: "media/material-docx0001.png",
        bounds: [40, 80, 300, 200],
        fit: { mode: "cover" },
      },
      {
        elementId: "pdf-picture",
        elementType: "image",
        src: "media/material-pdf00001.jpg",
        bounds: [400, 80, 300, 200],
        fit: { mode: "cover" },
      },
    ];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.equal((xml?.match(/<p:pic>/g) ?? []).length, 2, "both stay editable picture objects");
    const sha = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");
    const packed = new Set<string>();
    for (const name of Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/"))) {
      packed.add(sha(await zip.file(name)!.async("uint8array")));
    }
    assert.ok(packed.has(sha(fromDocx)), "the DOCX picture is packed unchanged");
    assert.ok(packed.has(sha(fromPdf)), "the PDF picture is packed unchanged");
  });

  it("maps bar colors and Y-max the same way the canvas paints", () => {
    const el = {
      elementId: "c1",
      elementType: "chart",
      bounds: [0, 0, 400, 200],
      data: {
        cols: ["项", "值"],
        rows: [
          ["直角边 a", 3],
          ["直角边 b", 4],
          ["斜边 c", 5],
        ],
      },
      series: [
        {
          type: "bar",
          name: "值",
          encode: { x: "项", y: "值" },
          fill: "#123456",
        },
      ],
      legend: false,
    } as ChartElement;
    const model = mapChartElement(el);
    assert.equal(model.valueMax, 5);
    assert.deepEqual(model.series[0]!.values, [3, 4, 5]);
    // A single series fill is that series' color on every category. The default
    // palette is only for charts that never named a fill.
    assert.deepEqual(model.colors, ["#123456", "#123456", "#123456"]);
    assert.equal(model.perCategoryColors, true);
    assert.equal(model.barDir, "col");
    assert.equal(model.showLegend, false);
  });

  it("exports an editable chart-area background behind manually inserted charts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-chart-background-"));
    const project = projectWithCover(dir, "图表背景");
    project.pages[0]!.page.elements = [
      {
        elementId: "chart-surface",
        elementType: "chart",
        bounds: [80, 120, 640, 280],
        background: { type: "solid", color: "#123456" },
        data: {
          cols: ["类目", "数值"],
          rows: [
            ["A", 3],
            ["B", 5],
            ["C", 2],
          ],
        },
        series: [{ type: "bar", name: "数值", encode: { x: "类目", y: "数值" } }],
        legend: true,
      } satisfies ChartElement,
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(slideXml);
    assert.match(slideXml, /123456/i, "solid chart surface must be exported");
    assert.match(slideXml, /<p:graphicFrame>/, "native editable chart must remain present");
    assert.ok(result.report.editDataCharts.ok.includes("chart-surface"));
  });

  it("uses explicit category colors for editable pie charts", () => {
    const el = {
      elementId: "mix",
      elementType: "chart",
      bounds: [0, 0, 400, 200],
      data: {
        cols: ["产品", "占比"],
        rows: [
          ["茶饮", 62],
          ["轻食", 21],
          ["周边", 17],
        ],
      },
      series: [{ type: "pie", name: "占比", encode: { category: "产品", value: "占比" } }],
      colors: ["#0064BC", "#00ACEE", "#E8943A"],
    } satisfies ChartElement;

    const model = mapChartElement(el);

    assert.deepEqual(model.colors, ["#0064BC", "#00ACEE", "#E8943A"]);
  });

  it("exports numeric-X categorical-Y bars horizontally", () => {
    const el = {
      elementId: "regions",
      elementType: "chart",
      bounds: [0, 0, 400, 200],
      data: {
        cols: ["区域", "金额"],
        rows: [
          ["华东", 4887],
          ["华南", 2829],
        ],
      },
      series: [{ type: "bar", name: "金额", encode: { x: "金额", y: "区域" } }],
      legend: false,
    } as ChartElement;

    const model = mapChartElement(el);

    assert.equal(model.barDir, "bar");
    assert.deepEqual(model.categories, ["华东", "华南"]);
    assert.deepEqual(model.series[0]?.values, [4887, 2829]);
  });

  it("keeps horizontal bars top-to-bottom and their values inside the plot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-horizontal-bar-"));
    const project = projectWithCover(dir, "区域");
    project.pages[0]!.page.elements = [
      {
        elementId: "regions",
        elementType: "chart",
        bounds: [40, 40, 600, 300],
        data: {
          cols: ["区域", "金额"],
          rows: [
            ["华东", 4887],
            ["华南", 2829],
          ],
        },
        series: [{ type: "bar", name: "金额", encode: { x: "金额", y: "区域" } }],
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartName = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    assert.ok(chartName);
    const xml = await zip.file(chartName)!.async("string");
    assert.match(xml, /<c:barDir val="bar"\/>/);
    assert.match(xml, /<c:orientation val="maxMin"\/>/);
    // Clustered bars label past the bar end. pptxgenjs drops that position;
    // the exporter writes it back. The value axis crosses at max so the
    // category axis stays at the bottom.
    assert.match(xml, /<c:dLblPos val="outEnd"\/>/);
    assert.doesNotMatch(xml, /<c:dLblPos val="inEnd"\/>/);
    assert.match(xml, /<c:crosses val="max"\/>/);
  });

  it("preserves decimal chart labels instead of rounding them to integers", () => {
    const el = {
      elementId: "trend",
      elementType: "chart",
      bounds: [0, 0, 400, 200],
      data: {
        cols: ["月", "营收"],
        rows: [
          ["2月", 0.89],
          ["3月", 0.97],
          ["7月", 1.286],
        ],
      },
      series: [{ type: "line", name: "营收", encode: { x: "月", y: "营收" } }],
    } as ChartElement;

    const model = mapChartElement(el);

    assert.equal(model.dataLabelFormatCode, "#,##0.000");
  });

  it("exports every value column so a taller series is not dropped", () => {
    const el = {
      elementId: "c2",
      elementType: "chart",
      bounds: [0, 0, 400, 200],
      data: {
        cols: ["边", "长", "平方"],
        rows: [
          ["a", 3, 9],
          ["b", 4, 16],
          ["c", 5, 25],
        ],
      },
      series: [
        { type: "bar", name: "长", encode: { x: "边", y: "长" }, fill: "#111111" },
        { type: "bar", name: "平方", encode: { x: "边", y: "平方" }, fill: "#222222" },
      ],
      legend: true,
    } as ChartElement;
    const model = mapChartElement(el);
    assert.equal(model.series.length, 2);
    assert.equal(model.valueMax, 25);
    assert.deepEqual(model.series[1]!.values, [9, 16, 25]);
    assert.deepEqual(model.colors, ["#111111", "#222222"]);
  });

  it("writes chart text at the shared px sizes, latin Arial and ea 微软雅黑", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-chart-fonts-"));
    const project = projectWithCover(dir, "图表字号");
    project.pages[0]!.page.elements = [
      {
        elementId: "cust",
        elementType: "chart",
        bounds: [80, 80, 400, 260],
        data: {
          cols: ["月", "2025增量", "2026增量"],
          rows: [
            ["1月", 0.091, 1.2],
            ["2月", 8.641, 3.4],
          ],
        },
        series: [
          { type: "bar", name: "2025增量", encode: { x: "月", y: "2025增量" } },
          { type: "bar", name: "2026增量", encode: { x: "月", y: "2026增量" } },
        ],
        legend: { position: "bottom" },
      } satisfies ChartElement,
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartName = Object.keys(zip.files).find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
    assert.ok(chartName);
    const xml = await zip.file(chartName)!.async("string");
    // 9px tick labels → 6.75pt → sz="675"; never the pptxgenjs 12pt default.
    assert.match(xml, /sz="675"/);
    assert.doesNotMatch(xml, /sz="1200"/);
    assert.match(xml, /<a:latin typeface="Arial"\/>/);
    assert.match(xml, /<a:ea typeface="微软雅黑"\/>/);
    assert.doesNotMatch(xml, /\*\*\*/);
    assert.match(xml, /<c:legendPos val="b"\/>/);
    // Per-series numFmt: 2025增量 carries 0.091's decimals, 2026增量 keeps 0.
    assert.match(xml, /formatCode="#,##0\.000"/);
    assert.match(xml, /formatCode="#,##0"/);
    // Value axis carries the shared nice scale, not the raw max.
    assert.match(xml, /<c:min val="0"\/>/);
    assert.match(xml, /<c:max val="10"\/>/);
    assert.match(xml, /<c:majorUnit val="2"\/>/);
  });

  it("negative bars stay below the zero baseline and keep the full axis", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-neg-bar-"));
    const project = projectWithCover(dir, "负数");
    project.pages[0]!.page.elements = [
      {
        elementId: "pnl",
        elementType: "chart",
        bounds: [60, 60, 400, 240],
        data: {
          cols: ["季度", "利润"],
          rows: [
            ["Q1", -300],
            ["Q2", 800],
          ],
        },
        series: [{ type: "bar", name: "利润", encode: { x: "季度", y: "利润" } }],
        legend: false,
      } satisfies ChartElement,
    ];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartName = Object.keys(zip.files).find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
    assert.ok(chartName);
    const xml = await zip.file(chartName)!.async("string");
    const min = Number(xml.match(/<c:min val="(-?[\d.]+)"/)?.[1]);
    const max = Number(xml.match(/<c:max val="([\d.]+)"/)?.[1]);
    assert.ok(min <= -300, `min ${min} must include -300`);
    assert.ok(max >= 800, `max ${max} must include 800`);
    assert.match(xml, /<c:tickLblPos val="low"\/>|<c:lblOffset/, "negative category labels move off the axis");
  });

  it("table cells match .el-table: 9.75pt 微软雅黑, 4×6px padding, D1D5DB borders", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-table-"));
    const project = projectWithCover(dir, "表格");
    project.pages[0]!.page.elements = [
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
    ];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    assert.match(xml, /sz="975"/, "13px → 9.75pt");
    const cells = xml.match(/<a:tc[\s\S]*?<\/a:tc>/g) ?? [];
    assert.ok(cells.length >= 4, "table has a cell per value");
    for (const cell of cells) {
      assert.match(cell, /<a:latin typeface="Arial"/);
      assert.match(cell, /<a:ea typeface="微软雅黑"/);
    }
    assert.doesNotMatch(xml, /\*\*\*/);
    assert.match(xml, /D1D5DB/, "#d1d5db border");
    assert.match(xml, /F3F4F6/, "header row fills #f3f4f6 by default");
    // 4px/6px cell padding in EMU: marT/marB=38100, marL/marR=57150.
    assert.match(xml, /marT="38100"|marR="57150"/);
  });

  it("table rules stay neutral under an adopted accent theme", async () => {
    // Regression: the cool grey D1D5DB (saturation 0.122) reached palette-adopted decks.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-table-palette-"));
    const project = projectWithCover(dir, "配色表格");
    project.presentation.theme = {
      ...project.presentation.theme,
      neutralChrome: true,
      colors: { ...project.presentation.theme?.colors, primary: "#C00000", accent1: "#C00000" },
    };
    project.pages[0]!.page.elements = [
      {
        elementId: "t1",
        elementType: "table",
        bounds: [40, 40, 500, 160],
        columnWidths: [1, 1],
        rowHeights: [1, 1],
        rows: [
          [
            { text: "表头A", color: "#C00000" },
            { text: "表头B", color: "#C00000" },
          ],
          [
            { text: "值1", color: "#C00000" },
            { text: "值2", color: "#C00000" },
          ],
        ],
      },
    ];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    const colours = new Set(
      [...xml.matchAll(/srgbClr val="([0-9A-Fa-f]{6})"/g)].map((match) => match[1]!.toUpperCase()),
    );
    assert.ok(colours.has("CCCCCC"), "table rules use the neutral grey");
    const outside = [...colours].filter((hex) => hex !== "C00000" && isChromaticHex(hex));
    assert.deepEqual(outside, [], "no chromatic slide colour outside the adopted accent");
  });

  it("charSpacing maps CSS px to OOXML 1/100pt exactly (×75)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-spacing-"));
    const project = projectWithCover(dir, "字距");
    project.pages[0]!.page.elements = [
      {
        elementId: "sp",
        elementType: "text",
        bounds: [60, 60, 300, 40],
        content: { text: "LETTER", fontSize: 20, letterSpacing: 2 },
      },
    ];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(xml);
    assert.match(xml, /spc="150"/, "2px letterSpacing must be 1.5pt → spc=150");
  });

  it("exports an editable bar-line combination with a secondary value axis", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-combo-chart-"));
    const project = projectWithCover(dir, "会员趋势");
    project.pages[0]!.page.elements = [
      {
        elementId: "member-combo",
        elementType: "chart",
        bounds: [60, 60, 840, 360],
        data: {
          cols: ["月", "新增", "复购率"],
          rows: [
            ["6月", 11.2, 25.8],
            ["7月", 12.8, 26.4],
          ],
        },
        series: [
          { type: "bar", name: "新增", encode: { x: "月", y: "新增" } },
          {
            type: "line",
            name: "复购率",
            encode: { x: "月", y: "复购率" },
            axis: "secondary",
          },
        ],
        axis: { x: "月份", y: "新增会员（万）", secondaryY: "复购率（%）" },
        legend: true,
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);

    assert.equal(result.report.ok, true, JSON.stringify(result.report.degradations));
    assert.ok(result.report.editDataCharts.ok.includes("member-combo"));
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartName = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    assert.ok(chartName);
    const xml = await zip.file(chartName)!.async("string");
    assert.match(xml, /<c:barChart>/);
    assert.match(xml, /<c:lineChart>/);
    assert.equal((xml.match(/<c:valAx>/g) ?? []).length, 2);
    assert.equal(
      (xml.match(/<c:catAx>/g) ?? []).length,
      2,
      "secondary value data needs a matching hidden secondary category axis",
    );
    assert.match(xml, /<c:delete val="1"\/>/);
    const barXml = xml.match(/<c:barChart>[\s\S]*?<\/c:barChart>/)?.[0] ?? "";
    const lineXml = xml.match(/<c:lineChart>[\s\S]*?<\/c:lineChart>/)?.[0] ?? "";
    assert.match(barXml, /<c:dLblPos val="outEnd"\/>/);
    assert.doesNotMatch(barXml, /<c:dLblPos val="inEnd"\/>/);
    assert.match(lineXml, /<c:dLblPos val="t"\/>/);
    assert.doesNotMatch(lineXml, /<c:dLblPos val="outEnd"\/>/);
    assert.match(xml, /复购率（%）/);
  });

  it("places a standalone line chart's labels above the points", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-line-labels-"));
    const project = projectWithCover(dir, "折线");
    project.pages[0]!.page.elements = [
      {
        elementId: "trend",
        elementType: "chart",
        bounds: [40, 40, 640, 320],
        data: {
          cols: ["月", "营收"],
          rows: [
            ["2月", 0.89],
            ["3月", 0.97],
          ],
        },
        series: [{ type: "line", name: "营收", encode: { x: "月", y: "营收" } }],
        legend: false,
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartName = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    assert.ok(chartName);
    const xml = await zip.file(chartName)!.async("string");
    const lineXml = xml.match(/<c:lineChart>[\s\S]*?<\/c:lineChart>/)?.[0] ?? "";
    assert.match(lineXml, /<c:dLblPos val="t"\/>/);
    assert.doesNotMatch(lineXml, /<c:dLblPos val="inEnd"\/>/);
  });

  it("writes one explicit series color and axis max into the pptx", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-chart-"));
    const project = projectWithCover(dir, "柱状图");
    project.pages[0]!.page.elements = [
      {
        elementId: "bars",
        elementType: "chart",
        bounds: [80, 80, 800, 400],
        data: {
          cols: ["项", "值"],
          rows: [
            ["a", 3],
            ["b", 4],
            ["c", 5],
          ],
        },
        series: [{ type: "bar", name: "值", encode: { x: "项", y: "值" }, fill: "#2563EB" }],
        legend: false,
      },
    ];
    saveProject(project);
    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartName = Object.keys(zip.files).find((n) => n.startsWith("ppt/charts/chart"));
    assert.ok(chartName, "chart part present");
    const xml = await zip.file(chartName)!.async("string");
    assert.match(xml, /2563EB/i);
    // The named series fill is the only bar color. Default amber/green swatches
    // must not appear beside it.
    assert.doesNotMatch(xml, /F59E0B|10B981/i);
    assert.match(xml, /<c:max val="5"\/>/);
    assert.match(xml, /<c:barDir val="col"\/>/);
    assert.match(xml, /<c:dLblPos val="outEnd"\/>/);
    assert.doesNotMatch(xml, /<c:dLblPos val="inEnd"\/>/);
    // Shared layout, scale, and the default font pair land in the chart XML.
    assert.match(xml, /<c:manualLayout>/);
    assert.match(xml, /<a:latin typeface="Arial"\/>/);
    assert.match(xml, /<a:ea typeface="微软雅黑"\/>/);
  });

  it("does not leak microscopic hidden helper charts into the visible slide", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-hidden-chart-"));
    const project = projectWithCover(dir, "隐藏图表");
    project.pages[0]!.page.elements = [
      {
        elementId: "hidden-scatter",
        elementType: "chart",
        bounds: [0, 0, 2, 2],
        opacity: 0.02,
        data: {
          cols: ["可能性", "影响"],
          rows: [
            [4, 5],
            [3, 4],
          ],
        },
        series: [{ type: "scatter", encode: { x: "可能性", y: "影响" } }],
        legend: false,
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartParts = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");

    assert.deepEqual(chartParts, []);
    assert.ok(slideXml);
    assert.doesNotMatch(slideXml, /P1|P2|可能性|影响/);
    assert.equal(result.report.nativeCoverage, 1);
  });

  it("exports editable waterfall, scatter, and mug icon without silent fallbacks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-advanced-chart-"));
    const project = projectWithCover(dir, "高级图表");
    project.pages[0]!.page.elements = [
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
            ["净额", 1350, null],
            ["投资", -486, null],
            ["筹资", -180, null],
            ["期末", 5964, null],
          ],
        },
        series: [{ type: "waterfall", encode: { x: "步", y: "额", isTotal: "tot" } }],
        legend: false,
      },
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
        series: [
          {
            type: "scatter",
            name: "风险",
            encode: { x: "可能", y: "影响" },
            fill: "#DC2626",
          },
        ],
        legend: false,
      },
      {
        elementId: "cup",
        elementType: "icon",
        bounds: [40, 420, 36, 36],
        iconName: "fas:mug-hot",
        fill: { type: "solid", color: "#F59E0B" },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);

    assert.equal(result.report.ok, true);
    assert.deepEqual(result.report.degradations, []);
    assert.ok(result.report.editDataCharts.ok.includes("wf"));
    assert.ok(result.report.editDataCharts.ok.includes("risk"));
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartParts = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))
        .map((name) => zip.file(name)!.async("string")),
    );
    const chartXml = chartParts.join("\n");
    const scatterXml = chartParts.find((xml) => xml.includes("<c:scatterChart>"));
    assert.ok(scatterXml);
    assert.match(chartXml, /<c:scatterChart>/);
    assert.match(chartXml, /<c:grouping val="stacked"\/>/);
    const stackedXml = chartParts.find((part) => part.includes('<c:grouping val="stacked"/>'));
    assert.ok(stackedXml);
    assert.doesNotMatch(
      stackedXml,
      /<c:dLblPos val="outEnd"\/>/,
      "stacked bars cannot use outEnd; only clustered bars are rewritten",
    );
    assert.equal(
      scatterXml.match(/<c:ser>/g)?.length,
      1,
      "one semantic scatter series must not become one OOXML series per point",
    );
    assert.doesNotMatch(scatterXml, /爆品缺货|华北同店/, "point labels belong on the slide, not in chart series names");
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    assert.ok(slideXml);
    assert.match(slideXml, /爆品缺货/);
    assert.match(slideXml, /<a:bodyPr[^>]*wrap="none"/);
    assert.match(slideXml, /prst="roundRect"/);
    assert.doesNotMatch(slideXml, /prst="star5"/);
  });
});
