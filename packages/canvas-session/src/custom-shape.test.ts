import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
  type PptdElement,
  type PptdProject,
  type ShapeElement,
} from "@open-slidestudio/pptd-v2";
import {
  insertChart,
  openSession,
  persist,
  redo,
  renderModel,
  selectElement,
  setSelectedBounds,
  setSelectedShapeName,
  undo,
} from "./index.js";

const ALLOW = ["element.bounds.set", "element.shape.kind.set", "chrome.history.undo", "chrome.history.redo"];

const CUSTOM_PATH = "M 0 0 L 200 0 C 200 50 150 100 100 100 Q 50 100 0 50 Z";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-custom-"));
}

function coverProject(dir: string, elements: PptdElement[], theme?: PptdProject["presentation"]["theme"]) {
  const project = createEmptyProject(dir, { title: "自定义路径" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("自定义路径"));
  project.pages[0]!.page.elements = elements;
  if (theme) project.presentation.theme = theme;
  saveProject(project);
  return project;
}

const customShape = (): ShapeElement => ({
  elementId: "freeform",
  elementType: "shape",
  shapeName: "custom",
  bounds: [60, 80, 300, 150],
  geometry: { viewBox: [200, 100], path: CUSTOM_PATH },
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
  border: { color: "#111111", width: 2 },
});

/** A full-page triangle: its bounds cover the slide, but the opposite corner stays open. */
const fullPageTriangle = (): ShapeElement => ({
  elementId: "triangle",
  elementType: "shape",
  shapeName: "custom",
  bounds: [0, 0, 960, 540],
  geometry: { viewBox: [960, 540], path: "M 0 0 L 960 0 L 0 540 Z" },
  fill: { type: "solid", color: "#FF0000" },
});

const fullPageRect = (): ShapeElement => ({
  elementId: "rect",
  elementType: "shape",
  shapeName: "rect",
  bounds: [0, 0, 960, 540],
  fill: { type: "solid", color: "#FF0000" },
});

describe("custom path shapes in the canvas session", () => {
  it("renders the stored path and viewBox without changing the geometry", () => {
    const dir = tmp();
    coverProject(dir, [customShape()]);
    const el = renderModel(openSession(dir)).elements.find((item) => item.id === "freeform");
    assert.ok(el);
    assert.equal(el.shapeName, "custom");
    assert.equal(el.pathD, CUSTOM_PATH);
    assert.deepEqual(el.viewBox, [200, 100]);
    assert.match(el.fillCss ?? "", /^linear-gradient\(/);
    assert.equal(el.adjustHandles, undefined);
  });

  it("paints a stored geometry it cannot draw as a rectangle, the degradation the export applies", () => {
    const dir = tmp();
    const broken: ShapeElement = {
      ...customShape(),
      geometry: { viewBox: [200, 100], path: "M 0 0 A 5 5 0 0 1 10 10" },
    };
    coverProject(dir, [broken]);
    const el = renderModel(openSession(dir)).elements[0]!;
    assert.equal(el.shapeName, "rect");
    assert.equal(el.viewBox, undefined);
    assert.notEqual(el.pathD, broken.geometry!.path);
  });

  it("selects, moves and resizes a custom shape; only bounds change and undo restores them", () => {
    const dir = tmp();
    const original = customShape();
    coverProject(dir, [original]);
    const s = openSession(dir, { allowedControlIds: ALLOW });
    selectElement(s, "freeform");
    assert.deepEqual(renderModel(s).selection, {
      kind: "element",
      pageIndex: 0,
      elementId: "freeform",
    });

    setSelectedBounds(s, "element.bounds.set", [120, 140, 300, 150]);
    setSelectedBounds(s, "element.bounds.set", [120, 140, 600, 300]);
    persist(s);

    const saved = loadProject(dir).pages[0]!.page.elements[0] as PptdElement & {
      geometry?: unknown;
      bounds: number[];
    };
    assert.deepEqual(saved.geometry, original.geometry);
    assert.deepEqual(saved.bounds, [120, 140, 600, 300]);

    assert.equal(undo(s), true);
    assert.deepEqual(renderModel(s).elements[0]!.bounds, [120, 140, 300, 150]);
    assert.equal(undo(s), true);
    assert.deepEqual(renderModel(s).elements[0]!.bounds, [60, 80, 300, 150]);
    assert.equal(redo(s), true);
    assert.deepEqual(renderModel(s).elements[0]!.bounds, [120, 140, 300, 150]);
    assert.equal(renderModel(s).elements[0]!.pathD, CUSTOM_PATH);
  });

  it("switches a custom shape to a preset by clearing its path, and refuses custom without geometry", () => {
    const dir = tmp();
    const plain: PptdElement = {
      elementId: "plain",
      elementType: "shape",
      shapeName: "rect",
      bounds: [0, 0, 100, 50],
      fill: { type: "solid", color: "#FFFFFF" },
    };
    coverProject(dir, [customShape(), plain]);
    const s = openSession(dir, { allowedControlIds: ALLOW });

    selectElement(s, "plain");
    assert.throws(() => setSelectedShapeName(s, "element.shape.kind.set", "custom"), /缺少 geometry/);
    assert.equal((s.project.pages[0]!.page.elements[1] as { shapeName: string }).shapeName, "rect");

    selectElement(s, "freeform");
    setSelectedShapeName(s, "element.shape.kind.set", "custom");
    assert.equal(renderModel(s).elements[0]!.pathD, CUSTOM_PATH);

    setSelectedShapeName(s, "element.shape.kind.set", "ellipse");
    const preset = s.project.pages[0]!.page.elements[0] as PptdElement & {
      geometry?: unknown;
      shapeName: string;
    };
    assert.equal(preset.shapeName, "ellipse");
    assert.equal(preset.geometry, undefined);
    assert.equal(undo(s), true);
    assert.equal((s.project.pages[0]!.page.elements[0] as { shapeName: string }).shapeName, "custom");
  });

  it("gives an unstyled line the theme primary at 2 px, while an explicit border wins", () => {
    const dir = tmp();
    const line = (elementId: string, border?: { color?: string; width?: number }): PptdElement => ({
      elementId,
      elementType: "line",
      bounds: [40, 300, 400, 20],
      viewBox: [400, 20],
      points: "0,0 400,20",
      ...(border ? { border } : {}),
    });
    coverProject(dir, [line("plain"), line("styled", { color: "#00AA00", width: 3 })], {
      colors: { primary: "#D97757" },
    });
    const elements = renderModel(openSession(dir)).elements;
    assert.deepEqual(elements.find((item) => item.id === "plain")!.border, {
      color: "#D97757",
      width: 2,
    });
    assert.deepEqual(elements.find((item) => item.id === "styled")!.border, {
      color: "#00AA00",
      width: 3,
    });
  });

  it("falls back to #111111 for an unstyled line when the theme primary is invalid", () => {
    const dir = tmp();
    coverProject(
      dir,
      [
        {
          elementId: "plain",
          elementType: "line",
          bounds: [40, 300, 400, 20],
          viewBox: [400, 20],
          points: "0,0 400,20",
        },
      ],
      { colors: { primary: "D9775" } },
    );
    const el = renderModel(openSession(dir)).elements[0]!;
    assert.deepEqual(el.border, { color: "#111111", width: 2 });
  });

  it("paints an unstyled line in the theme primary when it is six hex digits without #", () => {
    const dir = tmp();
    coverProject(
      dir,
      [
        {
          elementId: "plain",
          elementType: "line",
          bounds: [40, 300, 400, 20],
          viewBox: [400, 20],
          points: "0,0 400,20",
        },
      ],
      { colors: { primary: "d97757" } },
    );
    const el = renderModel(openSession(dir)).elements[0]!;
    assert.deepEqual(el.border, { color: "#D97757", width: 2 });
  });

  it("gives a colour with no width the same 1 px default on a preset and on a custom shape", () => {
    const dir = tmp();
    const preset: ShapeElement = {
      elementId: "box",
      elementType: "shape",
      shapeName: "rect",
      bounds: [40, 40, 200, 100],
      fill: { type: "solid", color: "#FFFFFF" },
      border: { color: "#111111" },
    };
    coverProject(dir, [preset, { ...customShape(), border: { color: "#111111" } }]);
    const [box, path] = renderModel(openSession(dir)).elements;
    assert.deepEqual(box!.border, { color: "#111111", width: 1 });
    assert.deepEqual(path!.border, { color: "#111111", width: 1 });
  });

  it("does not promote a full-page custom triangle to the page backdrop", () => {
    const dir = tmp();
    coverProject(dir, [fullPageTriangle()]);
    const model = renderModel(openSession(dir));
    // The page's own white background shows outside the triangle; the triangle paints only itself.
    assert.equal(model.backgroundCss, "#FFFFFF");
    assert.equal(model.elements[0]!.fillCss, "#FF0000");
  });

  it("still promotes a full-page rectangle to the page backdrop", () => {
    const dir = tmp();
    coverProject(dir, [fullPageRect()]);
    assert.equal(renderModel(openSession(dir)).backgroundCss, "#FF0000");
  });

  it("reports only a plain preset rectangle as plainRect, the shape a chart may take its surface from", () => {
    const dir = tmp();
    const ellipse: ShapeElement = {
      elementId: "ellipse",
      elementType: "shape",
      shapeName: "ellipse",
      bounds: [40, 40, 300, 200],
      fill: { type: "solid", color: "#FF0000" },
    };
    const panel: ShapeElement = {
      elementId: "panel",
      elementType: "shape",
      shapeName: "rect",
      bounds: [20, 20, 460, 240],
      fill: { type: "solid", color: "#111111" },
    };
    coverProject(dir, [fullPageTriangle(), ellipse, panel]);
    const elements = renderModel(openSession(dir)).elements;
    // Ruling 121: a custom path and another preset never supply a chart's surface, even full-page.
    assert.equal(elements.find((item) => item.id === "triangle")!.plainRect, false);
    assert.equal(elements.find((item) => item.id === "ellipse")!.plainRect, false);
    assert.equal(elements.find((item) => item.id === "panel")!.plainRect, true);
  });

  it("gives an inserted chart the page surface, not a full-page custom triangle's colour", () => {
    const dir = tmp();
    coverProject(dir, [fullPageTriangle()]);
    const s = openSession(dir, { allowedControlIds: ["insert.chart"] });
    insertChart(s, "insert.chart");
    const chart = s.project.pages[0]!.page.elements.find((element) => element.elementType === "chart") as
      { background?: unknown } | undefined;
    assert.deepEqual(chart?.background, { type: "solid", color: "#FFFFFF" });
  });

  it("resolves a theme-token outline before it reaches the paint, on a custom shape and on a preset", () => {
    const dir = tmp();
    const outlinedPath: ShapeElement = {
      elementId: "outlined-path",
      elementType: "shape",
      shapeName: "custom",
      bounds: [60, 80, 300, 150],
      geometry: { viewBox: [200, 100], path: CUSTOM_PATH },
      border: { color: "$primary", width: 2 },
    };
    const outlinedBox: ShapeElement = {
      elementId: "outlined-box",
      elementType: "shape",
      shapeName: "rect",
      bounds: [400, 80, 200, 100],
      border: { color: "$primary", width: 2 },
    };
    coverProject(dir, [outlinedPath, outlinedBox], { colors: { primary: "#D97757" } });
    const [path, box] = renderModel(openSession(dir)).elements;
    assert.deepEqual(path!.border, { color: "#D97757", width: 2 });
    assert.deepEqual(box!.border, { color: "#D97757", width: 2 });
  });

  it("renders a saved compact two-subpath path as the custom path, not a rectangle", () => {
    const dir = tmp();
    const compact = "M0 0L100 0L100 100ZM20 20L40 20L40 40Z";
    coverProject(dir, [{ ...customShape(), geometry: { viewBox: [100, 100], path: compact } }]);
    const el = renderModel(openSession(dir)).elements[0]!;
    assert.equal(el.shapeName, "custom");
    assert.equal(el.pathD, compact);
    assert.deepEqual(el.viewBox, [100, 100]);
  });
});
