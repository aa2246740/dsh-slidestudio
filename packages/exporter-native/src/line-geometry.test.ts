import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";

function lineProject(title: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-line-geometry-"));
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  project.pages[0]!.page.elements = [];
  return project;
}

async function slideXml(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
  assert.ok(xml);
  return xml;
}

function namedShape(xml: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shape = xml.match(
    new RegExp(`<p:sp>(?:(?!<\\/p:sp>)[\\s\\S])*?name="${escaped}"(?:(?!<\\/p:sp>)[\\s\\S])*?<\\/p:sp>`),
  )?.[0];
  assert.ok(shape, `missing editable OOXML shape ${name}`);
  return shape;
}

describe("native editable line geometry", () => {
  it("preserves descending diagonals and polylines from bounds/viewBox/points", async () => {
    const project = lineProject("线条几何");
    project.pages[0]!.page.elements = [
      {
        elementId: "diag",
        elementType: "line",
        bounds: [96, 54, 288, 216],
        viewBox: [300, 200],
        points: "M0 200 L300 0",
        border: { style: "solid", width: 4, color: "#172033" },
        arrow: ["diamond", "stealth"],
        rotation: 15,
        opacity: 0.4,
        flipH: true,
      },
      {
        elementId: "poly",
        elementType: "line",
        bounds: [480, 108, 240, 270],
        viewBox: [120, 90],
        points: "0,0 60,90 120,0",
        border: { style: "dashed", width: 2, color: "#D9485F" },
      },
    ];
    saveProject(project);

    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);
    const diagonal = namedShape(xml, "PPTD line diag");
    const polyline = namedShape(xml, "PPTD line poly");

    assert.match(diagonal, /<a:off x="914400" y="514350"\/>/);
    assert.match(diagonal, /<a:ext cx="2743200" cy="2057400"\/>/);
    assert.match(diagonal, /<a:path w="2743200" h="2057400">/);
    assert.match(diagonal, /<a:xfrm[^>]*rot="900000"/);
    assert.match(diagonal, /<a:xfrm[^>]*flipH="1"/);
    assert.match(diagonal, /<a:moveTo><a:pt x="0" y="2057400" \/><\/a:moveTo>/);
    assert.match(diagonal, /<a:lnTo><a:pt x="2743200" y="0" \/><\/a:lnTo>/);
    assert.match(diagonal, /<a:headEnd type="diamond"\/>/);
    assert.match(diagonal, /<a:tailEnd type="stealth"\/>/);
    assert.match(diagonal, /<a:alpha val="40000"\/>/);

    assert.match(polyline, /<a:off x="4572000" y="1028700"\/>/);
    assert.match(polyline, /<a:ext cx="2286000" cy="2571750"\/>/);
    assert.match(polyline, /<a:moveTo><a:pt x="0" y="0" \/><\/a:moveTo>/);
    assert.match(polyline, /<a:lnTo><a:pt x="1143000" y="2571750" \/><\/a:lnTo>/);
    assert.match(polyline, /<a:lnTo><a:pt x="2286000" y="0" \/><\/a:lnTo>/);
    assert.match(polyline, /<a:prstDash val="dash"\/>/);

    assert.equal((xml.match(/<a:custGeom>/g) ?? []).length, 2);
    assert.doesNotMatch(xml, /<p:pic>/);
    assert.equal(result.report.ok, true);
    assert.deepEqual(result.report.degradations, []);
    assert.deepEqual(result.report.editableLines, [
      {
        slideIndex: 0,
        elementId: "diag",
        source: {
          bounds: [96, 54, 288, 216],
          viewBox: [300, 200],
          points: "M0 200 L300 0",
          rotation: 15,
          opacity: 0.4,
          flipH: true,
        },
        output: {
          kind: "custom-geometry",
          objectName: "PPTD line diag",
          segmentCount: 1,
        },
        preserved: true,
      },
      {
        slideIndex: 0,
        elementId: "poly",
        source: {
          bounds: [480, 108, 240, 270],
          viewBox: [120, 90],
          points: "0,0 60,90 120,0",
        },
        output: {
          kind: "custom-geometry",
          objectName: "PPTD line poly",
          segmentCount: 2,
        },
        preserved: true,
      },
    ]);
  });

  it("reports unsupported path commands instead of silently changing geometry", async () => {
    const project = lineProject("无法解析的线条");
    project.pages[0]!.page.elements = [
      {
        elementId: "curve-command",
        elementType: "line",
        bounds: [100, 100, 300, 120],
        viewBox: [300, 120],
        points: "M0 120 C80 0 220 0 300 120",
        border: { width: 3, color: "#111111" },
      },
    ];

    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);

    assert.equal(result.report.ok, false);
    assert.deepEqual(result.report.editableLines, [
      {
        slideIndex: 0,
        elementId: "curve-command",
        source: {
          bounds: [100, 100, 300, 120],
          viewBox: [300, 120],
          points: "M0 120 C80 0 220 0 300 120",
        },
        output: {
          kind: "axis-fallback",
          objectName: "PPTD line curve-command",
          segmentCount: 1,
        },
        preserved: false,
      },
    ]);
    assert.deepEqual(
      result.report.degradations.map(({ elementId, kind }) => ({ elementId, kind })),
      [{ elementId: "curve-command", kind: "line-geometry" }],
    );
    assert.match(namedShape(xml, "PPTD line curve-command"), /<a:prstGeom prst="line">/);
    assert.doesNotMatch(xml, /<p:pic>/);
  });

  it("rejects relative commands and hard-fails unimplemented curved polylines", async () => {
    const project = lineProject("相对路径和曲线");
    project.pages[0]!.page.elements = [
      {
        elementId: "relative",
        elementType: "line",
        bounds: [40, 40, 200, 100],
        viewBox: [200, 100],
        points: "m0 100 l200 -100",
      },
      {
        elementId: "smooth",
        elementType: "line",
        bounds: [300, 40, 200, 100],
        viewBox: [200, 100],
        points: "0,100 100,0 200,100",
        curve: "smooth",
      },
    ];

    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);

    assert.equal(result.report.ok, false);
    assert.deepEqual(
      result.report.editableLines.map(({ elementId, output, preserved }) => ({
        elementId,
        kind: output.kind,
        preserved,
      })),
      [
        { elementId: "relative", kind: "axis-fallback", preserved: false },
        { elementId: "smooth", kind: "custom-geometry", preserved: false },
      ],
    );
    assert.deepEqual(
      result.report.degradations.map(({ elementId, kind }) => ({ elementId, kind })),
      [
        { elementId: "relative", kind: "line-geometry" },
        { elementId: "smooth", kind: "line-geometry" },
      ],
    );
    assert.match(namedShape(xml, "PPTD line relative"), /<a:prstGeom prst="line">/);
    assert.match(namedShape(xml, "PPTD line smooth"), /<a:custGeom>/);
  });
});
