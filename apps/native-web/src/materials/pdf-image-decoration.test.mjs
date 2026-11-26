import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decorationReason } from "./pdf-image-decoration.mjs";

/**
 * @param {number} width @param {number} height @param {number} channels
 * @param {(x: number, y: number) => number[]} pixel
 */
function bitmap(width, height, channels, pixel) {
  const data = new Uint8ClampedArray(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * channels);
  }
  return { data, width, height, channels };
}

/** Deterministic noise, so a "photo" has real spread. */
const noise = (/** @type {any} */ x, /** @type {any} */ y, seed = 1) =>
  ((x * 73856093) ^ (y * 19349663) ^ (seed * 83492791)) & 255;

describe("VAL-PDF-007: decoration test for decoded PDF bitmaps", () => {
  test("a long thin strip is a strip however it is painted", () => {
    const strip = bitmap(900, 100, 3, (x, y) => [noise(x, y), noise(y, x), noise(x, x)]);
    assert.equal(decorationReason(strip), "strip");
    const tall = bitmap(100, 900, 3, (x, y) => [noise(x, y), 0, 0]);
    assert.equal(decorationReason(tall), "strip");
    const wide = bitmap(799, 100, 3, (x, y) => [noise(x, y), 0, 0]);
    assert.equal(decorationReason(wide), undefined, "an aspect ratio of 8 or less is allowed");
  });

  test("a photograph with colour variation is kept", () => {
    const photo = bitmap(320, 240, 3, (x, y) => [noise(x, y, 1), noise(x, y, 2), noise(x, y, 3)]);
    assert.equal(decorationReason(photo), undefined);
    const withAlpha = bitmap(320, 240, 4, (x, y) => [noise(x, y, 1), noise(x, y, 2), 90, 255]);
    assert.equal(decorationReason(withAlpha), undefined);
  });

  test("an opaque picture is never decoration, however plain", () => {
    assert.equal(decorationReason(bitmap(200, 200, 3, () => [236, 236, 232])), undefined);
    assert.equal(decorationReason(bitmap(200, 200, 4, () => [10, 90, 200, 255])), undefined);
    assert.equal(decorationReason(bitmap(200, 200, 1, () => [128])), undefined);
  });

  test("a nearly invisible overlay is faint whatever its hidden colour is", () => {
    const faint = bitmap(300, 300, 4, (x, y) => [noise(x, y), noise(y, x), 40, 2]);
    assert.equal(decorationReason(faint), "faint");
  });

  test("one colour under a fading transparency (shadow, glow, bar) is flat", () => {
    const fade = bitmap(120, 300, 4, (_x, y) => [193, 12, 13, 40 + Math.floor((y / 300) * 160)]);
    assert.equal(decorationReason(fade), "flat");
  });

  test("a single-colour logo with a hard-edged mask is kept", () => {
    const logo = bitmap(240, 120, 4, (x, y) => {
      const inside = (x > 20 && x < 60) || (y > 50 && y < 70 && x > 20 && x < 220);
      return inside ? [192, 0, 0, 255] : [0, 0, 0, 0];
    });
    assert.equal(decorationReason(logo), undefined);
  });

  test("a soft-masked picture whose colours vary is kept", () => {
    const photo = bitmap(256, 256, 4, (x, y) => [noise(x, y, 4), noise(x, y, 5), noise(x, y, 6), 140]);
    assert.equal(decorationReason(photo), undefined);
  });

  test("thresholds can be overridden", () => {
    const fade = bitmap(120, 300, 4, (_x, y) => [193, 12, 13, 40 + Math.floor((y / 300) * 160)]);
    assert.equal(decorationReason(fade), "flat");
    assert.equal(decorationReason(fade, { fadeSpread: -1 }), undefined);
    assert.equal(decorationReason(fade, { maxAspect: 1.5 }), "strip");
  });
});
