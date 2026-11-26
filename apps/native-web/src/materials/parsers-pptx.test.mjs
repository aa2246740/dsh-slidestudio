import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, mock } from "node:test";
import { loadOptionalNative } from "../optional-native.mjs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MATERIAL_MAX_LOGO_BYTES } from "@open-slidestudio/presentation-run";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { generateSamples, readSample, SAMPLES_SKIP } from "./sample-fixtures.mjs";
import { buildPptx, solidPng, tinyPng } from "../testlib/pptx-fixture.mjs";
import { normalizeFontFamily } from "@open-slidestudio/pptd-v2";
import { prepareSessionMaterials, writeSessionMaterials } from "@open-slidestudio/slides-tools/internal/material-store";

/**
 * Parsers type their payloads as `object`; these tests walk the stored
 * `deck-template` JSON directly, so payload keys stay loose (`any`).
 * @typedef {import("./derivative.mjs").Derivative & {summary: {zh: string, facts?: object}} & Record<string, any>} ParsedDerivative
 */

const NO_SHARP = (await loadOptionalNative("sharp")) ? false : "sharp is not installed";

/** @param {unknown} value */
function assertNoDataField(value) {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoDataField(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  assert.equal(Object.hasOwn(value, "data"), false);
  for (const child of Object.values(value)) assertNoDataField(child);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {Record<string, unknown>} */ (value)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {any} value
 */
function canonicalHash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * @param {{ parser: any; }} derivative
 */
function stableDerivative(derivative) {
  return {
    ...derivative,
    parser: { ...derivative.parser, durationMs: 0 },
  };
}

test("hidden slides are reported and layout placeholders inherit the master box", async () => {
  const derivative = /** @type {ParsedDerivative} */ (
    await runParseJob({
      materialId: "mh",
      name: "hand.pptx",
      bytes: buildPptx({}),
    })
  );
  const deck = derivative["deck-template"];
  assert.equal(deck.slides.length, 2);
  assert.equal(deck.slides[0].hidden, false);
  assert.equal(deck.slides[1].hidden, true);

  const layout = deck.masters[0].layouts[0];
  const inherited = layout.placeholders.find((/** @type {{ type: string; }} */ p) => p.type === "title");
  assert.equal(inherited?.inherited, true);
  assert.ok(inherited?.box);
  const masterBox = deck.masters[0].placeholders.find((/** @type {{ type: string; }} */ p) => p.type === "title")?.box;
  assert.deepEqual(inherited?.box, masterBox);

  assert.equal(deck.theme.colors.dk1, "#000000");
  assert.equal(deck.theme.colors.lt1, "#FFFFFF");
  assert.equal(deck.theme.fonts.major.ea, "思源黑体");
  assert.match(derivative.summary.zh, /未发现 Logo 候选/);
});

test("a small master picture is flagged as a logo candidate with sharp dimensions", { skip: NO_SHARP }, async () => {
  const derivative = /** @type {ParsedDerivative} */ (
    await runParseJob({
      materialId: "ml",
      name: "hand-logo.pptx",
      bytes: buildPptx({ withMedia: true }),
    })
  );
  const deck = derivative["deck-template"];
  const logo = deck.media.find((/** @type {{ logoCandidate: any; }} */ entry) => entry.logoCandidate);
  assert.ok(logo);
  assert.equal(logo.format, "png");
  assert.equal(logo.width, 4);
  assert.equal(logo.height, 4);
  assert.deepEqual(logo.roles, ["master"]);
  assert.equal(Object.hasOwn(logo, "data"), false);
  assert.match(logo.sha256, /^[a-f0-9]{64}$/);
  assert.equal(logo.bytes, tinyPng().length);
  assert.equal(logo.part, "ppt/media/logo.png");
  assert.ok(Array.isArray(logo.placements));
  assertNoDataField(derivative);
});

test("multiple logo candidates keep metadata only and store one byte payload", { skip: NO_SHARP }, async () => {
  const first = tinyPng();
  const second = solidPng({ rgb: [0x00, 0x28, 0x55] });
  const bytes = buildPptx({
    media: [
      { name: "logo-a.png", bytes: first },
      { name: "logo-b.png", bytes: second },
    ],
  });
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-two.pptx";
  const derivative = /** @type {ParsedDerivative} */ (await runParseJob({ materialId: id, name: "two.pptx", bytes }));
  const deck = derivative["deck-template"];
  const logos = deck.media.filter((/** @type {{ id: any; }} */ entry) =>
    deck.logos.some((/** @type {{ mediaId: any; }} */ logo) => logo.mediaId === entry.id),
  );
  assert.equal(deck.media.filter((/** @type {{ logoCandidate: any; }} */ entry) => entry.logoCandidate).length, 1);
  assert.equal(deck.logos.length, 2);
  assert.equal(logos.length, 2);
  assert.deepEqual(
    logos.map((/** @type {{ part: any; }} */ entry) => entry.part),
    ["ppt/media/logo-a.png", "ppt/media/logo-b.png"],
  );
  assertNoDataField(derivative);
  for (const logo of logos) {
    assert.match(logo.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof logo.bytes, "number");
    assert.equal(typeof logo.width, "number");
    assert.equal(typeof logo.height, "number");
    assert.equal(logo.format, "png");
    assert.ok(Array.isArray(logo.placements));
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-logo-payload-"));
  try {
    const store = new AttachmentStore(path.join(root, "uploads"));
    await store.record({ name: "two.pptx", bytes, derivative });
    const logoFiles = fs.readdirSync(store.root).filter((name) => name.endsWith(".logo"));
    assert.deepEqual(logoFiles, [`${id}.logo`]);
    assert.deepEqual(fs.readFileSync(store.paths(id).logo), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a legal ~18.9MB PPTX with a 2520×2500 logo yields a derivative under 1MB", { skip: NO_SHARP }, async () => {
  const png = solidPng({ width: 2520, height: 2500, level: 0 });
  const bytes = buildPptx({ media: [{ name: "logo.png", bytes: png }], zipLevel: 0 });
  assert.ok(
    bytes.length > 18_000_000 && bytes.length < 20 * 1024 * 1024,
    `expected a legal near-limit PPTX, got ${bytes.length} bytes`,
  );
  const derivative = /** @type {ParsedDerivative} */ (
    await runParseJob({
      materialId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-large.pptx",
      name: "large-logo.pptx",
      bytes,
    })
  );
  const encoded = Buffer.byteLength(`${JSON.stringify(derivative, null, 2)}\n`);
  assert.ok(encoded < 1024 * 1024, `derivative is ${encoded} bytes`);
  const logo = derivative["deck-template"].media.find(
    (/** @type {{ logoCandidate: any; }} */ entry) => entry.logoCandidate,
  );
  assert.ok(logo);
  assert.equal(logo.width, 2520);
  assert.equal(logo.height, 2500);
  assert.equal(Object.hasOwn(logo, "data"), false);
  assertNoDataField(derivative);
});

test(
  "a PPTX under 20 MiB whose logo exceeds the raw cap is recognized without a logo and still materializes",
  { skip: NO_SHARP },
  async () => {
    const png = solidPng({
      width: 3000,
      height: 3000,
      level: 0,
      // Mild redundancy: the zip stays under 20 MiB and under the ratio bomb,
      // while the PNG itself stays above the raw logo cap.
      fill(raw, width) {
        const stride = 1 + width * 3;
        for (let i = 0; i < raw.length; i += 1) {
          raw[i] = i % stride === 0 ? 0 : (Math.imul(i, 16777619) >>> 16) & 255;
        }
      },
    });
    const mb = Math.round(png.length / (1024 * 1024));
    assert.ok(png.length > MATERIAL_MAX_LOGO_BYTES, `logo ${png.length} should exceed the raw cap`);
    assert.equal(mb, 26);
    const note = `模板 Logo 过大（约 ${mb} MB），未提取；如需使用 Logo，请换用较小的图片后重新上传`;
    const bytes = buildPptx({ media: [{ name: "logo.png", bytes: png }], zipLevel: 9 });
    assert.ok(bytes.length < 20 * 1024 * 1024, `pptx is ${bytes.length} bytes`);
    const id = "30303030-3030-3030-3030-303030303030-大logo.pptx";
    const derivative = /** @type {ParsedDerivative} */ (
      await runParseJob({
        materialId: id,
        name: "大logo.pptx",
        bytes,
      })
    );
    assert.equal(derivative.status, "ok");
    assert.match(derivative.summary.zh, /PPT 模板/);
    assert.match(derivative.summary.zh, /accent1 #C8102E/i);
    assert.ok(derivative.summary.zh.includes(note), derivative.summary.zh);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-oversize-logo-"));
    try {
      const store = new AttachmentStore(path.join(root, "store"));
      const recorded = await store.record({
        name: "大logo.pptx",
        bytes,
        derivative,
      });
      const published = attachmentPublic(recorded);
      assert.equal(published.status, "parsed");
      const publishedSummary = /** @type {{zh: string}} */ (published.summary);
      assert.ok(publishedSummary.zh.includes(note), publishedSummary.zh);
      assert.equal(fs.existsSync(store.paths(id).logo), false);
      const project = path.join(root, "project");
      const [material] = writeSessionMaterials(
        project,
        prepareSessionMaterials(store.root, [
          {
            id,
            name: "大logo.pptx",
            kind: "deck-template",
            parser: "pptx-ooxml-v2",
            summaryZh: derivative.summary.zh,
            needsVision: false,
            bytes: bytes.length,
            storeId: recorded.meta.storeId,
            originalSha256: recorded.meta.originalSha256,
            derivativeSha256: recorded.meta.derivativeSha256,
          },
        ]),
      );
      assert.equal(material.mediaSrc, undefined);
      const source = JSON.parse(
        fs.readFileSync(path.join(project, "_agent", "materials", id, "design-source.json"), "utf8"),
      );
      assert.equal(source.colors.accent1, "#C8102E");
      assert.deepEqual(source.logos, []);
      assert.equal(fs.existsSync(path.join(project, "media")), false);
      assert.equal(fs.existsSync(path.join(project, "pages")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
