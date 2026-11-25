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
import { openSession, renderModel } from "./index.js";

/*
 * The editor paints the same fallback colours the exporter writes for a saved deck whose colours
 * cannot resolve (see export-color-fallback.test.ts in exporter-native). The stored project is
 * never changed: the fallback is applied only to the render model.
 */

const CYCLIC_THEME: NonNullable<PptdProject["presentation"]["theme"]> = {
  colors: { a: "$b", b: "$a", ok: "#112233" },
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-color-fallback-"));
}

function coverProject(
  dir: string,
  elements: PptdElement[],
  options: { theme?: PptdProject["presentation"]["theme"]; background?: Fill } = {},
): void {
  const project = createEmptyProject(dir, { title: "颜色回退" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("颜色回退"));
  project.pages[0]!.page.elements = elements;
  if (options.background) project.pages[0]!.page.background = options.background;
  if (options.theme) project.presentation.theme = options.theme;
  saveProject(project);
}

describe("render model colour fallbacks for stored colours", () => {
  it("paints the exporter's fallback colours instead of throwing", () => {
    const dir = tmp();
    coverProject(
      dir,
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
        {
          elementId: "badge",
          elementType: "icon",
          iconName: "star",
          bounds: [400, 260, 60, 60],
          fill: { type: "solid", color: "$a" },
        },
      ] as PptdElement[],
      { theme: CYCLIC_THEME, background: { type: "solid", color: "$b" } },
    );
    const model = renderModel(openSession(dir));
    const find = (id: string) => model.elements.find((el) => el.id === id)!;
    assert.equal(model.backgroundCss, "#FFFFFF", "the page default white, as the export writes");
    assert.equal(find("box").border?.color, "#111111");
    assert.equal(find("box").border?.width, 3);
    assert.equal(find("panel").fillCss, undefined);
    assert.equal(find("label").color, "#000000");
    assert.equal(find("badge").fillCss, "#000000");
  });

  it("paints a six-digit unprefixed colour as the colour it spells, and the stored file keeps it", () => {
    const dir = tmp();
    coverProject(dir, [
      {
        elementId: "panel",
        elementType: "shape",
        shapeName: "rect",
        bounds: [60, 60, 300, 120],
        fill: { type: "solid", color: "0E0807" },
      },
      {
        elementId: "label",
        elementType: "text",
        bounds: [60, 260, 600, 80],
        content: { text: "标题", fontSize: 24, color: "E8DED7" },
      },
    ] as PptdElement[]);
    const model = renderModel(openSession(dir));
    const find = (id: string) => model.elements.find((el) => el.id === id)!;
    assert.equal(find("panel").fillCss, "#0E0807");
    assert.equal(find("label").color, "#E8DED7");
    const raw = fs.readFileSync(path.join(dir, "pages", "cover.page"), "utf8");
    assert.match(raw, /"0E0807"/, "the stored value is still the unprefixed string");
    assert.match(raw, /color: E8DED7/);
  });

  it("keeps the stored project unchanged for the next save", () => {
    const dir = tmp();
    coverProject(dir, [
      {
        elementId: "label",
        elementType: "text",
        bounds: [60, 260, 600, 80],
        content: { text: "标题", fontSize: 24, color: "$accent9" },
      },
    ] as PptdElement[]);
    renderModel(openSession(dir));
    const raw = fs.readFileSync(path.join(dir, "pages", "cover.page"), "utf8");
    assert.match(raw, /\$accent9/);
  });
});
