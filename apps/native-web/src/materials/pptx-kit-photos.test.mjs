import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pptxParser } from "./parsers/pptx.mjs";
import { kitPptx, picture, SLIDE_SIZE } from "./test-fixtures/kit-pptx.mjs";
import {
  sharp,
  NO_SHARP,
  sha,
  parseDeck,
  kitOf,
  imagesOf,
  BODY_TEXT,
  textLine,
} from "./test-fixtures/pptx-kit-test-kit.mjs";

const SW = SLIDE_SIZE.cx;
const SH = SLIDE_SIZE.cy;

const noisePng = (/** @type {number} */ seed, size = 64) => {
  const raw = Buffer.alloc(size * size * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * seed) % 251;
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
};
/** The header decodes, the pixel data does not: sharp reads the size and then fails to desaturate. */
const truncated = (/** @type {Buffer} */ png) => png.subarray(0, Math.floor(png.length * 0.6));
const SATURATION = '<a14:saturation xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" sat="0"/>';
const DUOTONE = '<a:duotone><a:srgbClr val="000000"/><a:srgbClr val="FFFFFF"/></a:duotone>';
/** Half a slide each way, so it is chrome and never a logo candidate. */
const HALF = { w: SW / 2, h: SH / 2 };

/**
 * Chrome images: desaturated on a layout (grayscl, duotone) and on the master (saturation 0),
 * one small desaturated logo, and one ordinary colour picture.
 * @param {{layer?: Buffer, master?: Buffer}} [broken] replacement bytes for an image that cannot be decoded
 */
async function chromeDeck(broken = {}) {
  const images = {
    "layer-gray.png": broken.layer ?? (await noisePng(37)),
    "duo.png": await noisePng(41),
    "master-gray.png": broken.master ?? (await noisePng(43)),
    "colour.png": await noisePng(47),
    "logo-gray.png": await noisePng(53, 32),
  };
  const bytes = kitPptx({
    slides: [{ shapes: textLine(2, "封面") }, { shapes: textLine(3, BODY_TEXT) }],
    layouts: [
      {
        shapes: [
          picture({ id: 10, rid: "rGray", effect: "<a:grayscl/>", x: 0, y: 0, ...HALF }),
          picture({ id: 11, rid: "rDuo", effect: DUOTONE, x: SW / 2, y: 0, ...HALF }),
          picture({ id: 12, rid: "rColour", x: 0, y: SH / 2, ...HALF }),
          picture({
            id: 13,
            rid: "rLogo",
            effect: "<a:grayscl/>",
            x: 8000000,
            y: 100000,
            w: 900000,
            h: 500000,
          }),
        ].join(""),
        rels: [
          ["rGray", "image", "../media/layer-gray.png"],
          ["rDuo", "image", "../media/duo.png"],
          ["rColour", "image", "../media/colour.png"],
          ["rLogo", "image", "../media/logo-gray.png"],
        ],
      },
    ],
    master: {
      shapes: picture({
        id: 20,
        rid: "rMasterGray",
        effect: SATURATION,
        x: SW / 2,
        y: SH / 2,
        ...HALF,
      }),
      rels: [["rMasterGray", "image", "../media/master-gray.png"]],
    },
    media: images,
  });
  return { bytes, images };
}

describe("M6-SCR-003: a desaturated photo that only a layout or master uses is derived", () => {
  const GREY_SRC = /^media\/tpl-photo-\d+-gray\.png$/;

  test("ordinary colour chrome keeps its original and gets no derivative", async () => {
    const { bytes, images } = await chromeDeck();
    const deck = (await parseDeck(bytes))["deck-template"];
    const colour = imagesOf(deck.templateKit).filter(
      (/** @type {{ src: string; }} */ element) => !GREY_SRC.test(element.src),
    );
    assert.deepEqual(
      colour.map((/** @type {{ src: any; }} */ element) => element.src),
      ["media/colour.png"],
    );
    const asset = deck.templateKit.assets.find(
      (/** @type {{ file: string; }} */ entry) => entry.file === "media/colour.png",
    );
    assert.equal(asset.kind, "original");
    assert.equal(asset.sha256, sha(images["colour.png"]));
    // Layout and master photos are not template photos, and only the four derived files are stored.
    assert.deepEqual(deck.photos, []);
    assert.equal(deck.templateDetail.assets.length, 4);
    // The logo list still points at the colour bytes of the small logo.
    assert.equal(deck.logo.mediaId, "logo-gray.png");
    assert.equal(deck.logos[0].sha256, sha(images["logo-gray.png"]));
  });

  test("a failed derivation records a skip and ships no colour substitute", async () => {
    const layer = truncated(await noisePng(59));
    const master = truncated(await noisePng(61));
    const { bytes } = await chromeDeck({ layer, master });
    const derivative = await parseDeck(bytes);
    const templateKit = kitOf(derivative);
    const sources = imagesOf(templateKit).map((/** @type {{ src: any; }} */ element) => element.src);
    assert.equal(
      sources.some((/** @type {string} */ src) => /layer-gray|master-gray/.test(src)),
      false,
      sources.join(),
    );
    const shipped = new Set(templateKit.assets.map((/** @type {{ sha256: any; }} */ entry) => entry.sha256));
    assert.equal(shipped.has(sha(layer)), false, "no colour original of the layout photo");
    assert.equal(shipped.has(sha(master)), false, "no colour original of the master photo");
    assert.deepEqual(
      templateKit.receipt.skipped
        .map((/** @type {{ source: any; reason: any; }} */ item) => [item.source, item.reason])
        .sort(),
      [
        ["layout", "图片去色处理失败，已跳过"],
        ["master", "图片去色处理失败，已跳过"],
      ],
    );
    // The images that did derive, and the colour chrome, are still there.
    assert.equal(sources.filter((/** @type {string} */ src) => GREY_SRC.test(src)).length, 2);
    assert.ok(sources.includes("media/colour.png"));
    assert.match(derivative.summary.zh, /另有 2 项无法读取，已跳过/);
  });
});

describe("the derived grey of layout and master pictures has a total size budget", () => {
  test("pictures past the budget are skipped with a reason, never shipped in colour", { skip: NO_SHARP }, async () => {
    const { bytes, images } = await chromeDeck();
    const first = await sharp(images["layer-gray.png"]).grayscale().png().toBuffer();
    const parse = async (/** @type {number} */ chromeGreyMaxBytes) =>
      /** @type {import("./test-fixtures/pptx-kit-test-kit.mjs").DeckTemplate} */ (
        (await pptxParser.parse({ name: "chrome.pptx", bytes }, { chromeGreyMaxBytes })).payload
      ).templateKit;
    const some = await parse(first.length);
    assert.deepEqual(
      imagesOf(some).map((/** @type {{ src: any; }} */ element) => element.src),
      ["media/tpl-photo-1-gray.png", "media/colour.png"],
    );
    assert.deepEqual(
      some.receipt.skipped.map((/** @type {{ source: any; count: any; }} */ item) => [item.source, item.count ?? 1]),
      [
        ["layout", 2],
        ["master", 1],
      ],
    );
    const none = await parse(1);
    assert.deepEqual(
      imagesOf(none).map((/** @type {{ src: any; }} */ element) => element.src),
      ["media/colour.png"],
    );
    assert.deepEqual(
      none.receipt.skipped.map((/** @type {{ source: any; count: any; }} */ item) => [item.source, item.count ?? 1]),
      [
        ["layout", 3],
        ["master", 1],
      ],
    );
    assert.deepEqual(
      none.assets.map((/** @type {{ kind: any; }} */ asset) => asset.kind),
      ["original"],
    );
  });
});

describe("M6-SCR-007: same-stem media of different types keep distinct derived files", () => {
  const noiseJpeg = (/** @type {number} */ seed, size = 64) => {
    const raw = Buffer.alloc(size * size * 3);
    for (let index = 0; index < raw.length; index += 1) raw[index] = (index * seed) % 251;
    return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
  };
  const pair = async () => ({
    "same.png": await noisePng(37),
    "same.jpeg": await noiseJpeg(41),
  });
  const PAIR_RELS = [
    ["rPng", "image", "../media/same.png"],
    ["rJpeg", "image", "../media/same.jpeg"],
  ];
  const twoPictures = (/** @type {string} */ effect) =>
    [
      picture({ id: 10, rid: "rPng", effect, x: 0, y: 0, ...HALF }),
      picture({ id: 11, rid: "rJpeg", effect, x: SW / 2, y: 0, ...HALF }),
    ].join("");
  /**
   * Every file the Host can be asked for is stored once, under a name it accepts, with its recorded hash.
   * @param {{ templateDetail: { assets: any[]; }; }} deck
   * @param {string | any[]} recorded
   */
  function assertStoredOnce(deck, recorded) {
    const names = deck.templateDetail.assets.map((/** @type {{ file: any; }} */ entry) => entry.file);
    assert.equal(new Set(names).size, names.length, names.join());
    assert.equal(names.length, recorded.length);
    for (const { file, sha256 } of recorded) {
      assert.match(file, /^photos\/[^/\\]+$/);
      const stored = deck.templateDetail.assets.filter((/** @type {{ file: any; }} */ entry) => entry.file === file);
      assert.equal(stored.length, 1, file);
      assert.equal(sha(Buffer.from(stored[0].content, "base64")), sha256, file);
    }
  }

  test("slide photos same.png and same.jpeg get unique processed files", async () => {
    const deck = (
      await parseDeck(
        kitPptx({
          slides: [{ shapes: twoPictures(""), rels: PAIR_RELS }],
          media: await pair(),
        }),
      )
    )["deck-template"];
    assert.equal(deck.photos.length, 2);
    assert.equal(
      new Set(deck.photos.map((/** @type {{ processed: { file: any; }; }} */ photo) => photo.processed.file)).size,
      2,
    );
    assertStoredOnce(
      deck,
      deck.photos.map((/** @type {{ processed: any; }} */ photo) => photo.processed),
    );
  });

  test("a photo in a media sub-folder gets a flat derived name the Host accepts", async () => {
    const deck = (
      await parseDeck(
        kitPptx({
          slides: [
            {
              shapes: picture({ id: 10, rid: "rDeep", x: 0, y: 0, ...HALF }),
              rels: [["rDeep", "image", "../media/sub/deep.png"]],
            },
          ],
          media: { "sub/deep.png": await noisePng(37) },
        }),
      )
    )["deck-template"];
    assert.equal(deck.photos.length, 1);
    assertStoredOnce(
      deck,
      deck.photos.map((/** @type {{ processed: any; }} */ photo) => photo.processed),
    );
  });
});

describe("through the real intake", () => {});
