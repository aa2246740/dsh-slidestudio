import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { runParseJob } from "./parse-worker.mjs";
import { MaterialRejection } from "./zip-guard.mjs";
import { avifRasterParser } from "./parsers/avif-raster.mjs";
import { loadOptionalNative } from "../optional-native.mjs";

const sharp = await loadOptionalNative("sharp");
const NO_SHARP = sharp ? false : "sharp is not installed";

const sha256 = (/** @type {Buffer<ArrayBuffer> | crypto.BinaryLike} */ bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * A real AVIF built by sharp: `channels` 4 gives it an alpha channel.
 * @param {{width?: number, height?: number, channels?: number,
 *   background?: string | {r: number, g: number, b: number, alpha: number},
 *   metadata?: {orientation?: number}}} [options]
 */
async function makeAvif({ width = 16, height = 12, channels = 3, background, metadata } = {}) {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels,
      background: background ?? (channels === 4 ? { r: 200, g: 16, b: 46, alpha: 0.5 } : "#336699"),
    },
  });
  return (metadata ? pipeline.withMetadata(metadata) : pipeline).avif({ quality: 30 }).toBuffer();
}

/**
 * Random pixels, so the JPEG copy stays large enough to exercise the size budget.
 * @param {number} width
 * @param {number} height
 */
async function makeNoisyAvif(width, height) {
  const raw = crypto.randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .avif({ quality: 60, effort: 0 })
    .toBuffer();
}

/**
 * Parsed sections such as `image` are open JSON that the assertions walk
 * dynamically, so they are typed loosely on top of the derivative envelope.
 * @typedef {import("./derivative.mjs").Derivative & {[section: string]: any}} ParsedDerivative
 * @typedef {{zh: string, facts: {format?: string}}} ParsedSummary
 * @typedef {{raster: {bytes: number, width: number, sha256: string, data: string}, width: number, height: number}} AvifPayload
 */

const parseJob = (/** @type {string} */ name, /** @type {any} */ bytes) =>
  /** @type {Promise<ParsedDerivative>} */ (runParseJob({ materialId: "m1", name, bytes }));

test(
  "an opaque AVIF becomes a quality-90 JPEG at its own size, and nothing else is kept",
  { skip: NO_SHARP },
  async () => {
    const avif = await makeAvif();
    const derivative = await parseJob("photo.avif", avif);

    assert.equal(derivative.status, "ok");
    assert.equal(derivative.kind, "image");
    assert.equal(derivative.parser.id, "avif-raster-v1");
    assert.equal(derivative.source.detectedMime, "image/avif");

    const { image } = derivative;
    assert.equal(image.format, "avif");
    assert.equal(image.width, 16);
    assert.equal(image.height, 12);
    assert.equal(image.hasAlpha, false);

    const raster = Buffer.from(image.raster.data, "base64");
    assert.equal(image.raster.format, "jpeg");
    assert.equal(image.raster.sha256, sha256(raster));
    assert.equal(image.raster.bytes, raster.length);
    assert.equal((await sharp(raster).metadata()).format, "jpeg");
    const expected = await sharp(avif).rotate().jpeg({ quality: 90 }).toBuffer();
    assert.deepEqual(raster, expected);
    assert.deepEqual([image.raster.width, image.raster.height], [16, 12]);

    // The vision copy and the style data come from the raster like for any other image.
    assert.equal((await sharp(Buffer.from(image.normalized.data, "base64")).metadata()).format, "jpeg");
    assert.match(image.dominant, /^#[0-9A-F]{6}$/);
    assert.ok(image.palette.length >= 1);

    // The AVIF container never lands in the derivative, in any encoding.
    const text = JSON.stringify(derivative);
    assert.equal(text.includes(avif.toString("base64").slice(0, 40)), false);
    assert.doesNotMatch(text, /HEIC|heic/);
    const summary = /** @type {ParsedSummary} */ (derivative.summary);
    assert.match(summary.zh, /^AVIF 图片 · 16×12 · 主色 #[0-9A-F]{6} · 已转为 JPG 图片/);
    assert.equal(summary.facts.format, "avif");
  },
);

test("an AVIF with an alpha channel becomes a PNG that keeps the transparency", { skip: NO_SHARP }, async () => {
  const avif = await makeAvif({ channels: 4 });
  const derivative = await parseJob("logo.avif", avif);

  assert.equal(derivative.status, "ok");
  const { image } = derivative;
  assert.equal(image.format, "avif");
  assert.equal(image.hasAlpha, true);
  assert.equal(image.raster.format, "png");
  const raster = Buffer.from(image.raster.data, "base64");
  assert.equal(image.raster.sha256, sha256(raster));
  const meta = await sharp(raster).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.hasAlpha, true);
  const { data } = await sharp(raster).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[3] > 0 && data[3] < 255, `alpha ${data[3]}`);
  assert.match(/** @type {ParsedSummary} */ (derivative.summary).zh, /已转为 PNG 图片/);
});

test(
  "the raster is upright: an AVIF stored with EXIF orientation reports the displayed size",
  { skip: NO_SHARP },
  async () => {
    const avif = await makeAvif({ width: 20, height: 10, metadata: { orientation: 6 } });
    const derivative = await parseJob("turned.avif", avif);
    const raster = Buffer.from(derivative.image.raster.data, "base64");
    const meta = await sharp(raster).metadata();
    assert.deepEqual([meta.width, meta.height], [10, 20]);
    assert.deepEqual([derivative.image.width, derivative.image.height], [10, 20]);
    assert.equal(meta.orientation, undefined);
  },
);

test(
  "an AVIF that sharp cannot decode is refused in Chinese without sharp's own wording",
  { skip: NO_SHARP },
  async () => {
    const real = await makeAvif();
    const stub = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypavif", "ascii"),
      Buffer.alloc(4),
      Buffer.from("mif1avif", "ascii"),
      Buffer.alloc(64, 7),
    ]);
    for (const [label, bytes] of [
      ["stub", stub],
      ["truncated", real.subarray(0, Math.floor(real.length / 2))],
    ]) {
      await assert.rejects(
        () => parseJob(`${label}.avif`, bytes),
        (error) => {
          assert.ok(error instanceof MaterialRejection, label);
          assert.equal(error.code, "corrupt", label);
          assert.match(error.message, /AVIF/, label);
          assert.match(error.message, /[一-鿿]/, label);
          assert.doesNotMatch(error.message, /seek|heif:|Input buffer|libheif/i, label);
          assert.doesNotMatch(error.message, /HEIC|导出为 JPG/, label);
          return true;
        },
      );
    }
  },
);

test(
  "an AVIF past the 40 megapixel limit is refused as too large before it is decoded",
  { skip: NO_SHARP },
  async () => {
    const huge = await sharp({
      create: { width: 6400, height: 6400, channels: 3, background: "#808080" },
    })
      .avif({ quality: 10, effort: 0 })
      .toBuffer();
    await assert.rejects(
      () => parseJob("huge.avif", huge),
      (error) => {
        assert.ok(error instanceof MaterialRejection);
        assert.equal(error.code, "too-large");
        assert.match(error.message, /4000 万/);
        return true;
      },
    );
  },
);

test(
  "a raster above the byte budget is rendered again smaller, never larger than the source",
  { skip: NO_SHARP },
  async () => {
    const avif = await makeNoisyAvif(400, 300);
    const budget = 60_000;
    const read = await avifRasterParser.parse({ name: "noise.avif", bytes: avif }, { maxRasterBytes: budget });
    const { raster, width, height } = /** @type {AvifPayload} */ (read.payload);
    assert.ok(raster.bytes <= budget, `${raster.bytes}`);
    assert.ok(width < 400 && height < 300, `${width}x${height}`);
    assert.ok(width <= 400 && height <= 300);
    assert.equal(raster.width, width);
    assert.equal(raster.sha256, sha256(Buffer.from(raster.data, "base64")));
    const warning = read.warnings.find((entry) => entry.code === "avif-downscaled");
    assert.match(warning?.message ?? "", /400×300.*缩小/);

    await assert.rejects(
      () => avifRasterParser.parse({ name: "noise.avif", bytes: avif }, { maxRasterBytes: 100 }),
      (error) => error instanceof MaterialRejection && error.code === "too-large",
    );
  },
);

test("an AVIF that fits the budget is not downscaled and carries no warning", { skip: NO_SHARP }, async () => {
  const read = await avifRasterParser.parse({ name: "photo.avif", bytes: await makeAvif() });
  assert.deepEqual(read.warnings, []);
  assert.equal(/** @type {AvifPayload} */ (read.payload).raster.width, 16);
});
