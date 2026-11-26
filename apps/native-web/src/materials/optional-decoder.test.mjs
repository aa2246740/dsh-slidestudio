import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOptionalNative, setOptionalNativeOverride } from "../optional-native.mjs";
import { attachmentPublic } from "../attachments.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { DECODER_UNAVAILABLE } from "./optional-decoder.mjs";
import { imageFullyDecodes } from "./logo-bytes.mjs";
import { buildPptx, solidPng, tinyPng } from "../testlib/pptx-fixture.mjs";
import { docxWithMedia } from "./test-fixtures/docx-media.mjs";
import { ingest, tempStore } from "./test-fixtures/material-harness.mjs";

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#1F4E79"/></svg>',
);
/** An ISO-BMFF header whose `ftyp` brand is AVIF: detection routes it to avif-raster-v1. */
const AVIF_HEADER = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from("ftypavif", "ascii"),
  Buffer.alloc(4),
  Buffer.from("avifmif1miaf", "ascii"),
  Buffer.alloc(64),
]);

/** @param {{after: (fn: () => void) => void}} t */
function withoutSharp(t) {
  setOptionalNativeOverride("sharp", null);
  t.after(() => setOptionalNativeOverride("sharp", undefined));
}

const sharpInstalled = Boolean(await loadOptionalNative("sharp"));

/** @param {string} name @param {Uint8Array} bytes */
const parse = (name, bytes) => runParseJob({ materialId: `${"0".repeat(8)}-${name}`, name, bytes });

test("without sharp, PNG, SVG and AVIF parses reject with the typed decoder-unavailable code", async (t) => {
  withoutSharp(t);
  for (const [name, bytes, message] of [
    ["mark.png", tinyPng(), /暂时无法识别图片/],
    ["logo.svg", SVG, /SVG 已通过安全检查/],
    ["photo.avif", AVIF_HEADER, /无法把 AVIF 转为图片/],
  ]) {
    await assert.rejects(parse(String(name), /** @type {Buffer} */ (bytes)), (error) => {
      assert.equal(/** @type {{code?: string}} */ (error).code, DECODER_UNAVAILABLE, String(name));
      assert.match(String(/** @type {Error} */ (error).message), /** @type {RegExp} */ (message));
      return true;
    });
  }
});

test("without sharp, intake stores the outcome as a visible record instead of throwing", async (t) => {
  withoutSharp(t);
  const { store } = tempStore(t);
  for (const [name, bytes] of [
    ["mark.png", tinyPng()],
    ["logo.svg", SVG],
    ["photo.avif", AVIF_HEADER],
  ]) {
    const { record } = await ingest(store, String(name), /** @type {Buffer} */ (bytes));
    const shown = attachmentPublic(record);
    assert.equal(shown.status, "unsupported", String(name));
    assert.equal(shown.errorCode, DECODER_UNAVAILABLE, String(name));
    assert.match(String(shown.message), /可选的图片解码组件/);
    assert.equal(store.read(record.meta.id)?.meta.id, record.meta.id);
  }
});

test("without sharp, a PPTX with pictures still parses and explains the missing logo/grey work", async (t) => {
  withoutSharp(t);
  const derivative = await parse("deck.pptx", buildPptx({ withMedia: true }));
  assert.equal(derivative.status, "ok");
  assert.ok(derivative.warnings.some((warning) => warning.code === DECODER_UNAVAILABLE));
  const deck = /** @type {Record<string, any>} */ (derivative)["deck-template"];
  assert.ok(Array.isArray(deck.media) && deck.media.length > 0, "media parts are still listed");
  assert.equal(
    deck.media.some((/** @type {{sha256?: string}} */ entry) => entry.sha256),
    false,
    "no logo bytes are claimed without a decode",
  );
});

test("without sharp, a DOCX with a picture parses and keeps no undecoded child image", async (t) => {
  withoutSharp(t);
  const { store } = tempStore(t);
  const { record } = await ingest(store, "report.docx", docxWithMedia([{ name: "a.png", bytes: solidPng() }]));
  assert.equal(record.derivative.status, "ok");
  const section = record.derivative.document?.embeddedImages;
  assert.equal(section?.kept, 0);
  assert.equal(section?.skipped.undecodable, 1);
  assert.equal(await imageFullyDecodes(solidPng()), false);
});

test(
  "with sharp installed, the same SVG becomes an image with a verified PNG raster",
  { skip: !sharpInstalled && "sharp is not installed" },
  async () => {
    const derivative = /** @type {Record<string, any>} */ (await parse("logo.svg", SVG));
    assert.equal(derivative.status, "ok");
    assert.equal(derivative.image.raster.format, "png");
    assert.equal(await imageFullyDecodes(Buffer.from(derivative.image.raster.data, "base64")), true);
  },
);
