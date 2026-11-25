import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
  type PptdElement,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";
import { assertWellFormedXml } from "./xml-lint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
/** Slide XML the exporter wrote before the M5 effects, for a page that uses none of the M5 fields. */
const preM5Golden = path.join(
  repoRoot,
  "packages/exporter-native/src/__golden__/pre-m5-effects/expected/ppt/slides/slide1.xml",
);

const SOLID_PATH = "M 0 0 L 200 0 C 200 50 150 100 100 100 Q 50 100 0 50 Z";

function customProject(title: string, elements: PptdElement[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-effects-"));
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

function lintXml(xml: string, label: string): void {
  assertWellFormedXml(xml, label);
}

const shadowOffset = Math.hypot(3, 3) * 9525;

const shadowedRect: PptdElement = {
  elementId: "shadowed-rect",
  elementType: "shape",
  shapeName: "rect",
  bounds: [40, 40, 240, 120],
  fill: { type: "solid", color: "#2563EB" },
  shadow: { blur: 8, color: "#000000", offsetX: 3, offsetY: 3, opacity: 0.35 },
};

const shadowedPath: PptdElement = {
  elementId: "shadowed-path",
  elementType: "shape",
  shapeName: "custom",
  bounds: [40, 240, 200, 150],
  geometry: { viewBox: [200, 100], path: SOLID_PATH },
  fill: { type: "solid", color: "#0057FF" },
  shadow: { blur: 8, color: "#000000", offsetX: 3, offsetY: 3, opacity: 0.35 },
};

const gradientStops = [
  { position: 0, color: "#FFF4F4", alpha: 0.5 },
  { position: 1, color: "#C00000" },
];

describe("element shadows export as a:outerShdw", () => {
  it("a shape and a custom path write blurRad, dist, dir and the shadow alpha", async () => {
    const project = customProject("阴影", [shadowedRect, shadowedPath]);
    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);
    lintXml(xml, "shadow slide");

    for (const name of ["shadowed-rect", "shadowed-path"]) {
      const shape = namedShape(xml, name);
      const shadow = shape.match(/<a:outerShdw\b[^>]*>/)?.[0] ?? "";
      assert.ok(shadow, `${name} has an outer shadow`);
      assert.equal(shape.match(/<a:effectLst>/g)?.length, 1, `${name} has one effect list`);
      assert.match(shadow, /blurRad="76200"/, "8 px blur is 76 200 EMU");
      assert.match(shadow, /dir="2700000"/, "a 3 px right and 3 px down offset points at 45°");
      const dist = Number(shadow.match(/dist="(\d+)"/)?.[1]);
      assert.ok(Math.abs(dist - shadowOffset) / shadowOffset < 0.01, `dist ${dist} ≈ hypot(3,3) px`);
      assert.match(shape, /<a:srgbClr val="000000"><a:alpha val="35000"\/><\/a:srgbClr>/);
      // CT_ShapeProperties order: fill, ln, then effectLst, directly before </p:spPr>.
      assert.match(shape, /<\/a:ln><a:effectLst><a:outerShdw\b[\s\S]*<\/a:effectLst><\/p:spPr>/);
    }
  });

  it("a shadow with full opacity writes the colour without an alpha child", async () => {
    const project = customProject("阴影", [
      {
        ...shadowedRect,
        shadow: { blur: 0, color: "#101010", offsetX: 0, offsetY: 0 },
      },
    ]);
    const xml = await slideXml((await exportProjectToPptx(project)).data);
    const shape = namedShape(xml, "shadowed-rect");
    assert.match(shape, /<a:outerShdw blurRad="0" dist="0" dir="0"[^>]*><a:srgbClr val="101010"\/>/);
  });

  it("a text box with a shadow is recorded as a soft degradation, not dropped silently", async () => {
    const project = customProject("阴影", [
      {
        elementId: "shadowed-text",
        elementType: "text",
        bounds: [40, 40, 300, 60],
        content: { text: "带阴影的文字", fontSize: 28 },
        shadow: { blur: 4, color: "#000000", offsetX: 2, offsetY: 2, opacity: 0.4 },
      },
    ]);
    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);
    assert.doesNotMatch(xml, /outerShdw/);
    const shadowDegradations = result.report.degradations.filter((item) => item.kind === "shadow-not-exported");
    assert.equal(shadowDegradations.length, 1);
    assert.equal(shadowDegradations[0]!.elementId, "shadowed-text");
    assert.equal(result.report.ok, true, "a soft degradation keeps the export usable");
  });

  it("pages without a shadow write no effect list", async () => {
    const project = customProject("无阴影", [{ ...shadowedRect, elementId: "plain", shadow: undefined }]);
    const xml = await slideXml((await exportProjectToPptx(project)).data);
    assert.doesNotMatch(xml, /effectLst|outerShdw/);
  });
});

describe("gradient page backgrounds export as p:bg/a:gradFill", () => {
  it("a two-stop linear background at 90° writes both stops and a 5 400 000 angle", async () => {
    const project = customProject("渐变背景", [shadowedRect]);
    project.pages[0]!.page.background = {
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: [
        { position: 0, color: "#FFF4F4" },
        { position: 1, color: "#C00000" },
      ],
    } as never;
    const result = await exportProjectToPptx(project);
    const xml = await slideXml(result.data);
    lintXml(xml, "gradient background slide");
    const background = xml.match(/<p:bg>[\s\S]*?<\/p:bg>/)?.[0] ?? "";
    assert.equal(
      background,
      '<p:bg><p:bgPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FFF4F4"/></a:gs><a:gs pos="100000"><a:srgbClr val="C00000"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill></p:bgPr></p:bg>',
    );
    assert.equal(
      result.report.degradations.some((item) => item.kind === "gradient-as-solid"),
      false,
      "a page gradient is exported, not collapsed",
    );
  });

  it("a page without a background adds no p:bg element", async () => {
    const project = customProject("无背景", [shadowedRect]);
    delete (project.pages[0]!.page as { background?: unknown }).background;
    const xml = await slideXml((await exportProjectToPptx(project)).data);
    assert.doesNotMatch(xml, /<p:bg>/);
  });

  it("a stop alpha writes an a:alpha child on the page background and on a shape fill", async () => {
    const project = customProject("透明渐变", [
      {
        elementId: "alpha-ellipse",
        elementType: "shape",
        shapeName: "ellipse",
        bounds: [40, 240, 200, 200],
        fill: { type: "gradient", gradientType: "linear", angle: 90, stops: gradientStops },
      },
    ]);
    project.pages[0]!.page.background = {
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: gradientStops,
    } as never;
    const xml = await slideXml((await exportProjectToPptx(project)).data);
    const background = xml.match(/<p:bg>[\s\S]*?<\/p:bg>/)?.[0] ?? "";
    assert.match(background, /<a:srgbClr val="FFF4F4"><a:alpha val="50000"\/><\/a:srgbClr>/);
    const shape = namedShape(xml, "alpha-ellipse");
    assert.match(shape, /<a:srgbClr val="FFF4F4"><a:alpha val="50000"\/><\/a:srgbClr>/);
  });
});

describe("pages that use no M5 field export byte-identical slide XML", () => {
  it("the pre-M5 golden page reproduces its slide part exactly", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "exp-effects-golden-"));
    try {
      const source = path.join(repoRoot, "packages/exporter-native/src/__golden__/pre-m5-effects/project");
      const project = path.join(work, "project");
      fs.cpSync(source, project, { recursive: true });
      const golden = fs.readFileSync(preM5Golden, "utf8");
      const first = await slideXml((await exportProjectToPptx(loadProject(project))).data);
      const second = await slideXml((await exportProjectToPptx(loadProject(project))).data);
      assert.equal(first, golden);
      assert.equal(second, first, "a second export of the same project writes the same bytes");
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
