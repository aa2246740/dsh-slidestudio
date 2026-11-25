import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import { openSession, renderModel } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function loadPaint(): (el: object) => string | null {
  const src = fs.readFileSync(path.join(repoRoot, "apps/native-web/public/shape-paint.js"), "utf8");
  const g: { shapePaintMarkup?: (el: object) => string | null } = {};
  new Function("globalThis", src)(g);
  if (typeof g.shapePaintMarkup !== "function") {
    throw new Error("shape-paint.js did not assign shapePaintMarkup");
  }
  return g.shapePaintMarkup;
}

describe("native shape paint markup", () => {
  it("converts a CSS rgba gradient into an SVG gradient instead of an invalid fill", () => {
    const paint = loadPaint();
    const svg = paint({
      id: "overlay",
      pathD: "M0 0H100V100H0Z",
      fillCss: "linear-gradient(0deg, rgba(0, 0, 0, 0.949) 0%, rgba(0, 0, 0, 0.6) 50%, rgba(0, 0, 0, 0) 100%)",
    });
    assert.ok(svg);
    assert.match(svg, /<linearGradient/);
    assert.match(svg, /offset="50%"/);
    assert.match(svg, /stop-opacity="0\.6"/);
    assert.match(svg, /fill="url\(#oss-shape-gradient-/);
    assert.doesNotMatch(svg, /fill="linear-gradient/);
  });

  it("paints syn-shapes callout with overflow leader and body border", () => {
    const paint = loadPaint();
    const session = openSession(path.join(repoRoot, "fixtures/syn-shapes"));
    const el = renderModel(session).elements.find((e) => e.shapeName === "accentBorderCallout1");
    assert.ok(el, "callout on fixture");
    assert.ok(el.pathStroke && el.pathStroke.length > 4, "interpreter stroke leader");
    assert.match(el.pathStroke, /-/);
    const svg = paint(el);
    assert.ok(svg);
    assert.match(svg, /overflow="visible"/);
    assert.match(svg, /stroke="#111111"/);
    assert.ok(svg.includes(el.pathStroke), "leader path in svg");
    assert.doesNotMatch(
      svg,
      new RegExp(`path d="${el.pathD!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" fill="[^"]+" stroke="none"`),
    );
  });

  it("omitted shape fill is no paint in Hub SVG, not default blue", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omit-fill-shape-"));
    const project = createEmptyProject(dir, { title: "omit-fill" });
    listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("omit-fill"));
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
        opacity: 0.18,
      },
    ];
    saveProject(project);
    const session = openSession(dir);
    const el = renderModel(session).elements.find((item) => item.id === "bg_glow");
    assert.ok(el);
    assert.equal(el.fillCss, undefined);
    const svg = loadPaint()(el);
    assert.ok(svg);
    assert.match(svg, /fill="none"/);
    assert.doesNotMatch(svg, /#2563EB/i);
  });

  it("omitted icon fill uses official black, not a Hub-invented color", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omit-fill-icon-"));
    const project = createEmptyProject(dir, { title: "omit-icon" });
    listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("omit-icon"));
    project.pages[0]!.page.elements = [
      {
        elementId: "mark",
        elementType: "icon",
        iconName: "fas:star",
        bounds: [40, 40, 36, 36],
      },
    ];
    saveProject(project);
    const session = openSession(dir);
    const el = renderModel(session).elements.find((item) => item.id === "mark");
    assert.ok(el);
    assert.equal(el.fillCss, "#000000");
  });
});
