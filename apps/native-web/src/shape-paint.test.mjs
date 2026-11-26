import assert from "node:assert/strict";
import { test } from "node:test";
import "../public/shape-paint.js";

/** The painted markup, or "" when the painter refused the input. @param {unknown} value */
function paint(value) {
  return globalThis.shapePaintMarkup(value) ?? "";
}

test("native callout leader preserves an explicitly zero stroke instead of inventing visible ink", () => {
  const svg = paint({
    pathStroke: "M0 0 L50 50",
    border: { color: "#111111", width: 0 },
  });
  assert.match(svg, /stroke-width="0"/);
  assert.doesNotMatch(svg, /stroke-width="1\.5"/);
  assert.match(paint({ pathStroke: "M0 0 L50 50" }), /stroke-width="1\.5"/);
});

test("shape markup rejects malformed and inherited native paint metadata without coercion", () => {
  const valid = { pathD: "M0 0 H100 V100 H0 Z", fillCss: "#FFFFFF" };
  for (const value of [
    { ...valid, pathD: true },
    { ...valid, fillCss: true },
    { ...valid, border: { color: 42 } },
    { ...valid, border: { width: "2" } },
    { ...valid, border: { width: -1 } },
    { ...valid, border: { width: Infinity } },
    Object.create(valid),
    null,
  ]) {
    assert.doesNotThrow(() => assert.equal(globalThis.shapePaintMarkup(value), null));
  }
});

test("shape gradients never publish non-finite geometry from malformed angle text", () => {
  for (const fillCss of [
    "linear-gradient(..deg, #FF0000 0%, #0000FF 100%)",
    "linear-gradient(1.2.3deg, #FF0000 0%, #0000FF 100%)",
  ])
    assert.equal(globalThis.shapePaintMarkup({ pathD: "M0 0 H100 V100 Z", fillCss }), null);
});

const CUSTOM_PATH = "M 0 0 L 200 0 C 200 50 150 100 100 100 Q 50 100 0 50 Z";

test("a custom path paints its stored d in an SVG whose viewBox is the model viewBox", () => {
  const svg = paint({
    pathD: CUSTOM_PATH,
    viewBox: [200, 100],
    fillCss: "#FF0000",
    border: { color: "#111111", width: 2 },
  });
  assert.match(svg, /<svg class="shape-paint" viewBox="0 0 200 100"/);
  assert.match(
    svg,
    /<path d="M 0 0 L 200 0 C 200 50 150 100 100 100 Q 50 100 0 50 Z" fill="#FF0000" stroke="#111111" stroke-width="2"/,
  );
});

test("a custom path gradient has one stop per model stop, in viewBox units", () => {
  const svg = paint({
    pathD: CUSTOM_PATH,
    viewBox: [200, 100],
    fillCss: "linear-gradient(90deg, #FF0000 0%, #00FF00 50%, #0000FF 100%)",
  });
  assert.equal((svg.match(/<stop /g) ?? []).length, 3);
  assert.match(svg, /<stop offset="0%" stop-color="#FF0000"\/>/);
  assert.match(svg, /<stop offset="50%" stop-color="#00FF00"\/>/);
  assert.match(svg, /<stop offset="100%" stop-color="#0000FF"\/>/);
  assert.match(svg, /x1="0" y1="50" x2="200" y2="50"/);
});

test("a custom path with an invalid viewBox paints nothing", () => {
  for (const viewBox of [[0, 100], [200, -1], [200], "200x100", [Infinity, 100]]) {
    assert.equal(globalThis.shapePaintMarkup({ pathD: CUSTOM_PATH, viewBox }), null);
  }
});

/** Attributes of the first element with this tag name, read independent of attribute order. */
/** @param {string} svg @param {string} tag @returns {Record<string, string>} */
function attrsOf(svg, tag) {
  const element = svg.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0] ?? "";
  return Object.fromEntries([...element.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

const IMAGE_BOX = { pathD: "M0 0 H200 V100 H0 Z", viewBox: [200, 100], fillCss: "#E5E7EB" };

test("a stretched picture fill paints through an SVG pattern that references the media URL", () => {
  const svg = paint({
    ...IMAGE_BOX,
    imageFill: { href: "/media/photo.png?project=p", mode: "stretch" },
  });
  const pattern = attrsOf(svg, "pattern");
  assert.equal(pattern.patternUnits, "userSpaceOnUse");
  assert.equal(pattern.width, "200");
  assert.equal(pattern.height, "100");
  const picture = attrsOf(svg, "image");
  assert.equal(picture.href, "/media/photo.png?project=p");
  assert.equal(picture.preserveAspectRatio, "none");
  assert.equal(picture.width, "200");
  assert.equal(picture.height, "100");
  assert.match(svg, /<path d="M0 0 H200 V100 H0 Z" fill="url\(#oss-shape-image-\d+\)"/);
});

test("a tiled picture fill repeats the natural tile size instead of stretching across the box", () => {
  const svg = paint({
    ...IMAGE_BOX,
    imageFill: { href: "/media/tile.png", mode: "tile", tile: [40, 30] },
  });
  const pattern = attrsOf(svg, "pattern");
  assert.equal(pattern.width, "40");
  assert.equal(pattern.height, "30");
  assert.equal(attrsOf(svg, "image").width, "40");
});

test("a picture fill crop scales and offsets the picture inside the pattern", () => {
  const svg = paint({
    ...IMAGE_BOX,
    imageFill: {
      href: "/media/photo.png",
      mode: "stretch",
      crop: { left: 0.25, top: 0, right: 0.25, bottom: 0.5 },
    },
  });
  // The visible window is half the picture wide and half tall, so it draws at twice the box size.
  const picture = attrsOf(svg, "image");
  assert.equal(picture.x, "-100");
  assert.equal(picture.y, "0");
  assert.equal(picture.width, "400");
  assert.equal(picture.height, "200");
});

test("a picture fill without a loadable URL paints its placeholder colour and no pattern", () => {
  for (const imageFill of [{ mode: "stretch" }, { href: 42, mode: "stretch" }]) {
    const svg = paint({ ...IMAGE_BOX, imageFill });
    assert.doesNotMatch(svg, /<pattern\b/);
    assert.match(svg, /fill="#E5E7EB"/);
  }
});
