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
  type PptdElement,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";
import { assertWellFormedXml } from "./xml-lint.js";

const SOLID_PATH = "M 0 0 L 200 0 C 200 50 150 100 100 100 Q 50 100 0 50 Z";
const GRADIENT_PATH = "M 60 0 L 120 120 L 0 120 Z";
const TWO_SUBPATHS = "M 0 0 L 40 0 L 40 40 Z M 60 10 L 90 10 L 90 50 Z";
const ARC_PATH = "M 0 0 A 10 10 0 0 1 20 20 Z";

function customProject(title: string, elements: PptdElement[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-custom-geometry-"));
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  project.pages[0]!.page.elements = elements;
  saveProject(project);
  return project;
}

async function slideXml(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
  assert.ok(xml);
  return xml;
}

/** The whole <p:sp> that carries `name`, so counts never leak across shapes. */
function namedShape(xml: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shape = xml.match(
    new RegExp(`<p:sp>(?:(?!<\\/p:sp>)[\\s\\S])*?name="${escaped}"(?:(?!<\\/p:sp>)[\\s\\S])*?<\\/p:sp>`),
  )?.[0];
  assert.ok(shape, `missing editable OOXML shape ${name}`);
  return shape;
}

/** Count a DrawingML path command such as moveTo, lnTo, cubicBezTo, quadBezTo or close. */
function commandCount(shape: string, command: string): number {
  return (shape.match(new RegExp(`<a:${command}(?=[\\s/>])`, "g")) ?? []).length;
}

function lintXml(xml: string, label: string): void {
  assertWellFormedXml(xml, label);
}

const solidShape: PptdElement = {
  elementId: "solid-path",
  elementType: "shape",
  shapeName: "custom",
  bounds: [40, 40, 300, 150],
  geometry: { viewBox: [200, 100], path: SOLID_PATH },
  fill: { type: "solid", color: "#0057FF" },
};

const gradientShape: PptdElement = {
  elementId: "gradient-path",
  elementType: "shape",
  shapeName: "custom",
  bounds: [400, 40, 240, 240],
  geometry: { viewBox: [120, 120], path: GRADIENT_PATH },
  fill: {
    type: "gradient",
    gradientType: "linear",
    angle: 90,
    stops: [
      { position: 0, color: "#FF0000" },
      { position: 0.5, color: "#00FF00" },
      { position: 1, color: "#0000FF" },
    ],
  },
};

const borderedShape: PptdElement = {
  elementId: "bordered-path",
  elementType: "shape",
  shapeName: "custom",
  bounds: [40, 300, 200, 120],
  geometry: { viewBox: [100, 60], path: TWO_SUBPATHS },
  fill: { type: "solid", color: "#FFFFFF" },
  border: { color: "#111111", width: 2 },
};

describe("custom path export (custGeom)", () => {
  it("emits one custGeom per shape with the model's path size and segment counts", async () => {
    const project = customProject("自定义路径", [solidShape, gradientShape, borderedShape]);
    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);

    const solid = namedShape(xml, "solid-path");
    assert.equal((solid.match(/<a:custGeom>/g) ?? []).length, 1);
    assert.match(solid, /<a:path w="200" h="100">/);
    assert.equal(commandCount(solid, "moveTo"), 1);
    assert.equal(commandCount(solid, "lnTo"), 1);
    assert.equal(commandCount(solid, "cubicBezTo"), 1);
    assert.equal(commandCount(solid, "quadBezTo"), 1);
    assert.equal(commandCount(solid, "close"), 1);
    assert.doesNotMatch(solid, /<a:prstGeom/);
    assert.match(solid, /<a:solidFill><a:srgbClr val="0057FF"\/><\/a:solidFill>/);

    const gradient = namedShape(xml, "gradient-path");
    assert.match(gradient, /<a:path w="120" h="120">/);
    assert.equal(commandCount(gradient, "moveTo"), 1);
    assert.equal(commandCount(gradient, "lnTo"), 2);
    assert.equal(commandCount(gradient, "close"), 1);

    const bordered = namedShape(xml, "bordered-path");
    assert.match(bordered, /<a:path w="100" h="60">/);
    assert.equal(commandCount(bordered, "moveTo"), 2);
    assert.equal(commandCount(bordered, "lnTo"), 4);
    assert.equal(commandCount(bordered, "close"), 2);

    assert.deepEqual(result.report.degradations, []);
  });

  it("writes the gradient stops from the model: count, position and colour", async () => {
    const project = customProject("渐变路径", [gradientShape]);
    const result = await exportProjectToPptx(project);
    const gradient = namedShape(await slideXml(result.data), "gradient-path");

    assert.equal((gradient.match(/<a:gradFill\b/g) ?? []).length, 1);
    assert.equal((gradient.match(/<a:gs /g) ?? []).length, 3);
    assert.match(gradient, /<a:gs pos="0"><a:srgbClr val="FF0000"\/><\/a:gs>/);
    assert.match(gradient, /<a:gs pos="50000"><a:srgbClr val="00FF00"\/><\/a:gs>/);
    assert.match(gradient, /<a:gs pos="100000"><a:srgbClr val="0000FF"\/><\/a:gs>/);
    assert.doesNotMatch(gradient, /<a:solidFill>/);
  });

  it("maps the border to a:ln with width × 9525 EMU (border.width is PPTD px)", async () => {
    const project = customProject("描边路径", [borderedShape]);
    const result = await exportProjectToPptx(project);
    const bordered = namedShape(await slideXml(result.data), "bordered-path");

    assert.match(bordered, /<a:ln w="19050">/);
    assert.match(bordered, /<a:ln w="19050">[\s\S]*?<a:srgbClr val="111111"\/>[\s\S]*?<\/a:ln>/);
  });

  it("keeps every exported part well-formed under xmllint", async () => {
    const project = customProject("xmllint", [solidShape, gradientShape, borderedShape]);
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    for (const part of ["ppt/slides/slide1.xml", "ppt/slideLayouts/slideLayout1.xml"]) {
      const xml = await zip.file(part)?.async("string");
      assert.ok(xml, `missing ${part}`);
      lintXml(xml, part);
    }
  });

  it("degrades a stored path with an unsupported command to a rectangle, without a custGeom", async () => {
    const project = customProject("旧路径", [
      {
        elementId: "arc-path",
        elementType: "shape",
        shapeName: "custom",
        bounds: [40, 40, 200, 100],
        geometry: { viewBox: [100, 100], path: ARC_PATH },
        fill: { type: "solid", color: "#0057FF" },
      },
    ]);
    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);

    assert.match(namedShape(xml, "arc-path"), /<a:prstGeom prst="rect">/);
    assert.doesNotMatch(namedShape(xml, "arc-path"), /<a:custGeom>/);
    assert.deepEqual(
      result.report.degradations.map(({ elementId, kind }) => ({ elementId, kind })),
      [{ elementId: "arc-path", kind: "shape-as-rect" }],
    );
  });

  it("exports both subpaths of a compact path whose command letters touch (ZM)", async () => {
    const project = customProject("紧凑路径", [
      {
        elementId: "compact-path",
        elementType: "shape",
        shapeName: "custom",
        bounds: [40, 40, 200, 200],
        geometry: { viewBox: [100, 100], path: "M0 0L100 0L100 100ZM20 20L40 20L40 40Z" },
        fill: { type: "solid", color: "#0057FF" },
      },
    ]);
    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);
    const shape = namedShape(xml, "compact-path");

    assert.equal((shape.match(/<a:custGeom>/g) ?? []).length, 1);
    assert.equal((shape.match(/<a:path\b/g) ?? []).length, 1);
    assert.match(shape, /<a:path w="100" h="100">/);
    assert.equal(commandCount(shape, "moveTo"), 2);
    assert.match(shape, /<a:moveTo><a:pt x="20" y="20"\/><\/a:moveTo>/);
    assert.equal(commandCount(shape, "lnTo"), 4);
    assert.equal(commandCount(shape, "close"), 2);
    assert.doesNotMatch(shape, /<a:prstGeom/);
    assert.deepEqual(result.report.degradations, []);
    lintXml(xml, "slide1.xml");
  });
});
