import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BORDER_WIDTH_PX } from "@open-slidestudio/pptd-v2";
import "../public/shape-paint.js";
import "../public/border-width.js";

// Ported from the reference shape-effects suite: the painter half. The shadow command half
// (`commandShadow`) belongs to the server command module and is not part of this port.
const TRIANGLE = "M 0 0 L 100 0 L 50 100 Z";

/** @param {unknown} value */
function paint(value) {
  const svg = globalThis.shapePaintMarkup(value);
  assert.ok(svg, "the shape paints");
  return svg;
}

test("a custom path with a shadow paints an SVG drop-shadow with the render model's offset, blur and colour", () => {
  const svg = paint({
    pathD: TRIANGLE,
    fillCss: "#2563EB",
    viewBox: [100, 100],
    shadow: { blur: 8, offsetX: 3, offsetY: 3, color: "rgba(0, 0, 0, 0.35)" },
  });
  assert.match(
    svg,
    /^<svg class="shape-paint" style="filter: drop-shadow\(3px 3px 8px rgba\(0, 0, 0, 0\.35\)\)" viewBox="0 0 100 100"/,
  );
});

test("a shape without a shadow keeps the pre-M5 svg opening tag", () => {
  const svg = paint({
    pathD: TRIANGLE,
    fillCss: "#2563EB",
    viewBox: [100, 100],
  });
  assert.match(svg, /^<svg class="shape-paint" viewBox="0 0 100 100"/);
  assert.doesNotMatch(svg, /drop-shadow/);
});

test("a gradient stop with alpha paints as stop-opacity on the same SVG gradient", () => {
  const svg = paint({
    pathD: TRIANGLE,
    fillCss: "linear-gradient(180deg, rgba(255, 244, 244, 0.5) 0%, #C00000 100%)",
    viewBox: [100, 100],
  });
  assert.match(svg, /<stop offset="0%" stop-color="rgb\(255, 244, 244\)" stop-opacity="0\.5"\/>/);
  assert.match(svg, /<stop offset="100%" stop-color="#C00000"\/>/);
});

test("the editor's default border width is the same 1 px the canvas and export draw", () => {
  assert.equal(DEFAULT_BORDER_WIDTH_PX, 1);
  assert.equal(globalThis.DEFAULT_BORDER_WIDTH_PX, DEFAULT_BORDER_WIDTH_PX);
});
