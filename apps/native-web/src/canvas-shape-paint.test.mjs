import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import "../public/shape-paint.js";
import { inheritedHint, paintCanvasShape, paintFaIcon, shapeSvgMarkup } from "../public/canvas-element-paint.js";
/** @import { RenderElement } from "@open-slidestudio/canvas-session" */

/** @type {RenderElement} */
const SHAPE = {
  id: "shape",
  type: "shape",
  bounds: [0, 0, 120, 60],
  rotation: 0,
  opacity: 1,
  pathD: "M0 0H100V100H0Z",
  fillCss: "#14355C",
};
const SHADOW = { blur: 8, offsetX: 3, offsetY: 4, color: "rgba(0, 0, 0, 0.35)" };

/** @param {(document: Document) => void} run */
function withDocument(run) {
  const dom = new JSDOM("<main></main>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    run(dom.window.document);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
}

test("a drawable shape paints the shared SVG into its box with a transparent background", () => {
  withDocument((document) => {
    const node = document.createElement("div");
    paintCanvasShape(node, SHAPE, { mediaUrl: (src) => `/media/${src}` });
    const svg = node.querySelector("svg.shape-paint");
    assert.ok(svg, "the shape-paint svg is the first child");
    assert.equal(svg.querySelector("path")?.getAttribute("fill"), "#14355C");
    assert.equal(node.style.background, "transparent");
    assert.equal(node.style.boxShadow, "");
  });
});

test("a plain rectangle casts its shadow from the box while other outlines keep the SVG filter", () => {
  const rect = shapeSvgMarkup({ ...SHAPE, shapeName: "rect", shadow: SHADOW }, String);
  assert.ok(rect);
  assert.doesNotMatch(rect, /drop-shadow/);
  const ellipse = shapeSvgMarkup({ ...SHAPE, shapeName: "ellipse", shadow: SHADOW }, String);
  assert.match(String(ellipse), /drop-shadow\(3px 4px 8px rgba\(0, 0, 0, 0\.35\)\)/);
  withDocument((document) => {
    const node = document.createElement("div");
    paintCanvasShape(node, { ...SHAPE, shapeName: "rect", shadow: SHADOW }, { mediaUrl: String });
    assert.match(node.style.boxShadow, /3px 4px 8px/);
  });
});

test("a picture fill resolves its project file through the editor's media URL", () => {
  const markup = shapeSvgMarkup(
    { ...SHAPE, shapeName: "ellipse", imageFill: { src: "media/photo.png", mode: "stretch" } },
    (src) => `/api/media?path=${encodeURIComponent(String(src))}`,
  );
  assert.match(String(markup), /<pattern id="oss-shape-image-\d+"/);
  assert.match(String(markup), /href="\/api\/media\?path=media%2Fphoto\.png"/);
});

test("a shape the painter cannot draw falls back to a CSS box with preset rounding and border", () => {
  withDocument((document) => {
    const node = document.createElement("div");
    paintCanvasShape(
      node,
      {
        ...SHAPE,
        pathD: undefined,
        shapeName: "ellipse",
        border: { width: 2, color: "#ff0000" },
      },
      { mediaUrl: String },
    );
    assert.equal(node.querySelector("svg"), null);
    assert.equal(node.style.borderRadius, "50%");
    assert.match(node.style.border, /2px solid/);
  });
});

test("Font Awesome icons use the bundled glyph when known and the SVG outline otherwise", () => {
  const icon = { ...SHAPE, type: "icon", iconName: "fab:github", fillCss: '#000"><x' };
  const glyph = paintFaIcon(icon, { github: "f09b" });
  assert.match(glyph, /class="fa-icon"/);
  assert.match(glyph, /Font Awesome 6 Brands/);
  assert.match(glyph, /&#xf09b;/);
  assert.doesNotMatch(glyph, /"><x/, "the fill is escaped");
  const fallback = paintFaIcon({ ...icon, iconName: "fas:unknown" }, { github: "f09b" });
  assert.match(fallback, /^<svg viewBox="0 0 24 24"/);
  assert.match(paintFaIcon({ ...icon, iconName: "fas:toString" }, {}), /^<svg/, "prototype names are not glyphs");
});

test("the inherited-copy hint names where the copy came from", () => {
  assert.equal(inheritedHint({ scope: "master", name: "主母版" }), "来自母版『主母版』· 双击编辑");
  assert.equal(inheritedHint({ scope: "layout", name: "标题页" }), "来自版式『标题页』· 双击编辑");
});
