import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import {
  applyImageCropDisplay,
  createCanvasElement,
  elementTransform,
  paintCanvasText,
  paintIconSvg,
} from "../public/canvas-element-paint.js";
/** @import { RenderElement } from "@open-slidestudio/canvas-session" */

/** @template T @param {T | null | undefined} value @returns {T} */
function must(value) {
  assert.ok(value);
  return value;
}

/** @type {RenderElement} */
const element = {
  id: "element",
  type: "text",
  bounds: [0, 0, 200, 100],
  rotation: 0,
  opacity: 1,
};

/** The transform createCanvasElement paints for one element, built in a fresh document. @param {Partial<RenderElement>} extra */
function paintedTransform(extra) {
  const dom = new JSDOM("<main></main>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const node = createCanvasElement(
      { ...element, type: "shape", ...extra },
      { ids: new Set(), groups: [], step: null, opts: {} },
    );
    return node.style.transform;
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
}

test("a rotated and flipped element paints rotate first, so the flip happens inside the box before the turn", () => {
  assert.equal(paintedTransform({ rotation: 30, flipH: true }), "rotate(30deg) scaleX(-1)");
  assert.equal(paintedTransform({ rotation: 30, flipV: true }), "rotate(30deg) scaleY(-1)");
  assert.equal(paintedTransform({ rotation: 30, flipH: true, flipV: true }), "rotate(30deg) scaleX(-1) scaleY(-1)");
  assert.equal(paintedTransform({ rotation: -45, flipV: true }), "rotate(-45deg) scaleY(-1)");
});

test("a flip-only, rotation-only or plain element keeps the transform it always had", () => {
  assert.equal(paintedTransform({ flipH: true }), "scaleX(-1)");
  assert.equal(paintedTransform({ flipV: true }), "scaleY(-1)");
  assert.equal(paintedTransform({ flipH: true, flipV: true }), "scaleX(-1) scaleY(-1)");
  assert.equal(paintedTransform({ rotation: 30 }), "rotate(30deg)");
  assert.equal(paintedTransform({}), "");
});

test("elementTransform takes the live angle of a rotate drag and keeps the element's flips in the same order", () => {
  /** @type {RenderElement} */
  const flipped = { ...element, rotation: 30, flipH: true, flipV: true };
  assert.equal(elementTransform(flipped), "rotate(30deg) scaleX(-1) scaleY(-1)");
  assert.equal(elementTransform(flipped, 72.5), "rotate(72.5deg) scaleX(-1) scaleY(-1)");
  assert.equal(elementTransform(flipped, 0), "scaleX(-1) scaleY(-1)", "a zero angle drops rotate");
  assert.equal(elementTransform({ ...element, rotation: 30 }, 10), "rotate(10deg)");
  assert.equal(elementTransform(element, 0), "");
});

test("text painting preserves rich runs, links, wrapping, list paragraphs and vertical alignment", () => {
  const dom = new JSDOM("<main></main>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const node = must(dom.window.document.querySelector("main"));
    paintCanvasText(
      node,
      {
        ...element,
        align: ["center", "middle"],
        href: "https://example.test",
        wrap: false,
        runs: [
          { text: "Hello ", bold: true },
          { text: "世界", color: "#D97757" },
        ],
      },
      false,
    );
    assert.equal(node.textContent, "Hello 世界");
    assert.equal(node.dataset.href, "https://example.test");
    assert.equal(node.style.whiteSpace, "nowrap");
    assert.equal(node.style.justifyContent, "center");
    assert.equal(must(node.querySelector("span")).style.fontWeight, "700");
    node.replaceChildren();
    paintCanvasText(node, { ...element, text: "First\n\n第三", list: "number" }, false);
    assert.deepEqual(
      [...node.querySelectorAll("ol > li")].map((item) => item.textContent),
      ["First", "", "第三"],
    );
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("image crop projection changes only display geometry and keeps the native crop fractions", () => {
  const dom = new JSDOM("<main></main>");
  try {
    const node = must(dom.window.document.querySelector("main"));
    const crop = { left: 0.1, right: 0.1, top: 0.2, bottom: 0 };
    const clipPath = 'path("M 0 0 L 200 0 L 200 100 Z")';
    applyImageCropDisplay(node, {
      ...element,
      type: "image",
      crop,
      cropShape: { shapeName: "ellipse" },
      clipPath,
    });
    assert.equal(node.style.backgroundSize, "125% 125%");
    assert.equal(node.style.backgroundPosition, "50% 100%");
    assert.equal(node.style.clipPath, clipPath, "the render model's generic clip path is applied");
    assert.equal(node.style.borderRadius, "", "presets no longer use a CSS radius mask");
    assert.deepEqual(crop, { left: 0.1, right: 0.1, top: 0.2, bottom: 0 });
    applyImageCropDisplay(node, { ...element, type: "image", fit: "contain" });
    assert.equal(node.style.backgroundSize, "contain");
    assert.equal(node.style.clipPath, "", "an unclipped picture drops the clip path");
  } finally {
    dom.window.close();
  }
});

test("fallback icon paint escapes fill and retains the star fallback for unknown names", () => {
  const unsafe = '"><script>window.compromised=true</script>';
  const dom = new JSDOM(paintIconSvg({ ...element, type: "icon", iconName: "unknown", fillCss: unsafe }));
  try {
    assert.equal(dom.window.document.querySelector("script"), null);
    assert.equal(must(dom.window.document.querySelector("path")).getAttribute("fill"), unsafe);
    assert.match(must(dom.window.document.querySelector("path")).getAttribute("d") ?? "", /^M12 2l2.9/);
  } finally {
    dom.window.close();
  }
});
