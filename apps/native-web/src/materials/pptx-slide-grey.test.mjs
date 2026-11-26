import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOptionalNative } from "../optional-native.mjs";
import {
  LARGE_DECK_BYTES,
  LARGE_DECK_SLIDE_GREY_MAX_BYTES,
  SLIDE_GREY_MAX_BYTES,
  readTemplateMedia,
} from "./parsers/pptx-logos.mjs";

const sharp = await loadOptionalNative("sharp");
const NO_SHARP = sharp ? false : "sharp is not installed";

/** A seeded noise PNG, so a grey copy of it is large and nearly incompressible.
 * @param {number} seed @param {number} [side] */
async function noisePhoto(seed, side = 96) {
  const raw = Buffer.alloc(side * side * 3);
  let state = seed >>> 0;
  for (let i = 0; i < raw.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    raw[i] = state >>> 24;
  }
  return sharp(raw, { raw: { width: side, height: side, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

/** @typedef {import("./parsers/ooxml.mjs").PackageReader} PackageReader */

/**
 * The slice of PackageReader that readTemplateMedia uses, over in-memory pictures.
 * @param {Record<string, Buffer>} pictures
 * @param {number} [packageBytes]
 * @returns {PackageReader} only entries, bytes.length and read are present
 */
function packageOf(pictures, packageBytes = 1024) {
  const entries = Object.keys(pictures).map((name) => ({ name }));
  const slice = { entries, bytes: { length: packageBytes }, read: (/** @type {string} */ name) => pictures[name] };
  return /** @type {PackageReader} */ (/** @type {unknown} */ (slice));
}

const slideUse = () => ({ roles: new Set(["slide"]), boxes: [], placements: [] });

/**
 * @param {number} count
 * @param {{ chromeGreyMaxBytes?: number; slideGreyMaxBytes?: number; } | undefined} options
 */
async function readPhotos(count, options, { side = 96, packageBytes = 1024 } = {}) {
  /** @type {Record<string, Buffer>} */
  const pictures = {};
  for (let index = 0; index < count; index += 1) {
    pictures[`ppt/media/photo${index + 1}.png`] = await noisePhoto(index + 1, side);
  }
  const uses = new Map(Object.keys(pictures).map((name) => [name, slideUse()]));
  const result = await readTemplateMedia(packageOf(pictures, packageBytes), uses, new Map(), options);
  return { pictures, result };
}

test("the grey copies of slide photos have a documented total budget, smaller above 20 MiB", () => {
  assert.equal(SLIDE_GREY_MAX_BYTES, 12 * 1024 * 1024);
  assert.equal(LARGE_DECK_BYTES, 20 * 1024 * 1024);
  assert.equal(LARGE_DECK_SLIDE_GREY_MAX_BYTES, 3 * 1024 * 1024);
});

test("a deck above 20 MiB keeps fewer grey copies by default than a smaller one", { skip: NO_SHARP }, async () => {
  // Five 600-px noise photos: each grey PNG is about 1 MB, so 3 MiB holds two and 12 MiB all five.
  const small = await readPhotos(5, {}, { side: 600, packageBytes: 10 * 1024 * 1024 });
  assert.equal(small.result.photos.filter((photo) => photo.processed).length, 5);
  const large = await readPhotos(5, {}, { side: 600, packageBytes: LARGE_DECK_BYTES + 1 });
  const kept = large.result.photos.filter((photo) => photo.processed).length;
  assert.ok(kept >= 1 && kept < 5, `kept ${kept}`);
  const shipped = large.result.assets.reduce((sum, asset) => sum + Buffer.from(asset.content, "base64").length, 0);
  assert.ok(shipped <= LARGE_DECK_SLIDE_GREY_MAX_BYTES, `shipped ${shipped}`);
  assert.equal(large.result.warnings.filter((warning) => warning.code === "photo-processing-failed").length, 1);
});

test("every slide photo gets a grey copy while the budget lasts", { skip: NO_SHARP }, async () => {
  const { result } = await readPhotos(3, { slideGreyMaxBytes: 50 * 1024 * 1024 });
  assert.equal(result.photos.length, 3);
  assert.ok(result.photos.every((photo) => photo.processed));
  assert.equal(result.assets.length, 3);
  assert.deepEqual(result.warnings, []);
});

test(
  "photos past the budget keep their original, ship no grey, and the user is told once",
  { skip: NO_SHARP },
  async () => {
    const probe = await readPhotos(1, { slideGreyMaxBytes: 50 * 1024 * 1024 });
    const oneGrey = Buffer.from(probe.result.assets[0].content, "base64").length;
    const { result } = await readPhotos(4, { slideGreyMaxBytes: oneGrey * 2 + 10 });
    assert.equal(result.photos.length, 4);
    assert.equal(result.photos.filter((photo) => photo.processed).length, 2);
    assert.equal(result.assets.length, 2);
    const shipped = result.assets.reduce((sum, asset) => sum + Buffer.from(asset.content, "base64").length, 0);
    assert.ok(shipped <= oneGrey * 2 + 10);
    const notes = result.warnings.filter((warning) => warning.code === "photo-processing-failed");
    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /无法去色，已保留原图/);
  },
);

test("the slide-photo budget is separate from the layout and master budget", { skip: NO_SHARP }, async () => {
  const { result } = await readPhotos(2, {
    slideGreyMaxBytes: 50 * 1024 * 1024,
    chromeGreyMaxBytes: 1,
  });
  assert.ok(result.photos.every((photo) => photo.processed));
});
