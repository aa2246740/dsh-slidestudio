import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import { shadowFollowsClip } from "../public/canvas-element-paint.js";
import { paintCanvasImage } from "../public/canvas-image-paint.js";
/** @import { RenderElement } from "@open-slidestudio/canvas-session" */

/** @param {ParentNode} node @param {string} selector */
function layer(node, selector) {
  const found = /** @type {HTMLElement | null} */ (node.querySelector(selector));
  assert.ok(found, selector);
  return found;
}

const SHADOW = { blur: 8, offsetX: 3, offsetY: 3, color: "rgba(0, 0, 0, 0.35)" };
const ELLIPSE = 'path("M 0 50 A 50 50 0 1 0 100 50 A 50 50 0 1 0 0 50 Z")';

/** @param {Partial<RenderElement>} [extra] @returns {RenderElement} */
function picture(extra = {}) {
  return {
    id: "photo",
    type: "image",
    src: "media/photo.png",
    bounds: [0, 0, 200, 100],
    rotation: 0,
    opacity: 1,
    ...extra,
  };
}

/** Paints one picture into a jsdom frame and hands its `.el` frame to the checks.
 * @param {RenderElement} el @param {(node: HTMLElement) => void} check */
function paintInFrame(el, check) {
  const dom = new JSDOM('<main class="el image"></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const node = layer(dom.window.document, "main");
    paintCanvasImage(node, el, {
      cropping: false,
      mediaUrl: (src) => `/media/${src}`,
      startCropDrag() {},
    });
    check(node);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
}

test("a clipped picture's shadow is a drop shadow on the layer that holds the clip (M5-SCR-006)", () => {
  paintInFrame(picture({ clipPath: ELLIPSE, shadow: SHADOW }), (node) => {
    const shadow = layer(node, ":scope > .el-shadow");
    assert.equal(shadow.style.filter, "drop-shadow(3px 3px 8px rgba(0, 0, 0, 0.35))");
    assert.equal(shadow.style.pointerEvents, "none", "the layer never takes pointer input");
    const surface = layer(shadow, ":scope > .el-picture");
    assert.equal(surface.style.clipPath, ELLIPSE, "the clip stays on the picture, not the shadow");
    assert.equal(node.style.overflow, "visible", "the drop shadow may leave the frame");
  });
});

test("a rectangular picture keeps its shadow on the frame with no shadow layer", () => {
  paintInFrame(picture({ shadow: SHADOW }), (node) => {
    assert.equal(node.querySelector(".el-shadow"), null);
    assert.equal(node.style.overflow, "", "the frame keeps its own overflow");
    assert.equal(layer(node, ":scope > .el-picture").style.clipPath, "");
  });
});

test("a clipped picture without a shadow has the clip and no shadow layer", () => {
  paintInFrame(picture({ clipPath: ELLIPSE }), (node) => {
    assert.equal(node.querySelector(".el-shadow"), null);
    assert.equal(layer(node, ":scope > .el-picture").style.clipPath, ELLIPSE);
  });
});

test("only a painted clipped picture moves its shadow to the clip layer", () => {
  assert.equal(shadowFollowsClip(picture({ clipPath: ELLIPSE, shadow: SHADOW })), true);
  assert.equal(shadowFollowsClip(picture({ shadow: SHADOW })), false, "a rectangle keeps its box");
  // paintSlide paints a picture only when it has media; without media no clip layer exists,
  // so the frame must keep the box shadow or the shadow would vanish.
  assert.equal(
    shadowFollowsClip(picture({ src: undefined, clipPath: ELLIPSE, shadow: SHADOW })),
    false,
    "a picture without media keeps its box shadow",
  );
});
