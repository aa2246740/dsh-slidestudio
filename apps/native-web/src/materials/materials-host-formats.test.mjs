import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { verifiedMaterialImage, verifyMaterial } from "@open-slidestudio/presentation-run";
import { resolveDesignAspects } from "../../../../packages/presentation-run/dist/domain/design-aspects.js";
import { readMaterialChunk } from "../../../../packages/presentation-run/dist/domain/material-content.js";
import { templateMaterialPartDescriptors } from "../../../../packages/presentation-run/dist/domain/material-template-text.js";
import { prepareSessionMaterials, writeSessionMaterials } from "@open-slidestudio/slides-tools/internal/material-store";
import { AttachmentStore } from "../attachments.mjs";
import { runParseJob } from "./parse-worker.mjs";
import { generateSamples, readSample, SAMPLES_SKIP } from "./sample-fixtures.mjs";
import { loadOptionalNative } from "../optional-native.mjs";

/** @typedef {Parameters<typeof prepareSessionMaterials>[1][number]} EditorAttachment */

const sharp = await loadOptionalNative("sharp");
const NO_SHARP = sharp ? false : "sharp is not installed";

let root = "";
let samples = "";

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-host-formats-"));
  samples = SAMPLES_SKIP ? "" : await generateSamples();
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Store an upload the way intake does, then materialize it into a fresh project.
 * @param {string} name
 * @param {Uint8Array} bytes
 * @param {string} label
 */
async function materialize(name, bytes, label) {
  const store = new AttachmentStore(path.join(root, `${label}-store`));
  const id = store.nextId(name);
  const derivative = await runParseJob({ materialId: id, name, bytes });
  assert.equal(derivative.status, "ok", `${name}: ${derivative.message ?? ""}`);
  const recorded = await store.record({
    name,
    bytes,
    derivative,
    needsVision: derivative.kind === "image",
  });
  /** @type {EditorAttachment} */
  const attachment = {
    id,
    name,
    kind: /** @type {EditorAttachment["kind"]} */ (derivative.kind),
    parser: /** @type {string} */ (derivative.parser.id),
    summaryZh: /** @type {NonNullable<typeof derivative.summary>} */ (derivative.summary).zh,
    needsVision: derivative.kind === "image",
    bytes: bytes.length,
    storeId: recorded.meta.storeId,
    originalSha256: recorded.meta.originalSha256,
    derivativeSha256: recorded.meta.derivativeSha256,
  };
  const project = path.join(root, `${label}-project`);
  const [material] = /** @type {[EditorAttachment]} */ (
    writeSessionMaterials(project, prepareSessionMaterials(store.root, [attachment]))
  );
  return { id, project, material, store, derivative };
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function filesUnder(directory) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

const LOGO = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#C8102E"/></svg>',
);

test("an SVG reaches the project only as the PNG it was rendered to", { skip: NO_SHARP }, async () => {
  const hostile = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" onload="alert(1)"><script>alert(1)</script><rect width="64" height="64" fill="#1F4E79"/></svg>',
  );
  for (const [label, bytes] of /** @type {[string, Buffer][]} */ ([
    ["svg-clean", LOGO],
    ["svg-hostile", hostile],
  ])) {
    const { id, project, material, store } = await materialize(`${label}.svg`, bytes, label);
    const files = filesUnder(project);
    assert.deepEqual(
      files.filter((/** @type {string} */ file) => /\.svg$/i.test(file)),
      [],
      label,
    );
    for (const file of files) {
      assert.equal(fs.readFileSync(file).includes("<svg"), false, `${label}: ${file}`);
      assert.equal(fs.readFileSync(file).includes("<script"), false, `${label}: ${file}`);
    }

    const directory = path.join(project, "_agent", "materials", id);
    const original = fs.readFileSync(path.join(directory, "original.png"));
    assert.equal((await sharp(original).metadata()).format, "png");
    const mediaSrc = /** @type {string} */ (material.mediaSrc);
    assert.match(mediaSrc, /^media\/material-[^/]+\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(project, mediaSrc)), original);

    const receipt = JSON.parse(fs.readFileSync(path.join(directory, "receipt.json"), "utf8"));
    assert.equal(receipt.rasterSha256, crypto.createHash("sha256").update(original).digest("hex"));
    const stored = /** @type {NonNullable<ReturnType<typeof store.read>>} */ (store.read(id));
    assert.equal(receipt.originalSha256, stored.meta.originalSha256);

    const verified = verifyMaterial(project, id);
    assert.equal(verified.originalExtension, ".png");
    assert.equal(verified.parser, "svg-raster-v1");
    const vision = verifiedMaterialImage(project, id);
    assert.equal((await sharp(vision.bytes).metadata()).format, "jpeg");
  }
});

test("the store keeps the upload for hashing and no read path hands it back", { skip: NO_SHARP }, async () => {
  const { id, store } = await materialize("kept.svg", LOGO, "svg-store");
  assert.deepEqual(fs.readFileSync(store.paths(id).original), LOGO);
  const record = /** @type {NonNullable<ReturnType<typeof store.read>>} */ (store.read(id));
  assert.doesNotMatch(JSON.stringify(record.derivative), /<svg|<circle/);
});

test(
  "an SVG record without a verifiable PNG is refused, never materialized as markup",
  { skip: NO_SHARP },
  async () => {
    const store = new AttachmentStore(path.join(root, "svg-broken-store"));
    const id = store.nextId("broken.svg");
    const derivative = await runParseJob({ materialId: id, name: "broken.svg", bytes: LOGO });
    const damaged = JSON.parse(JSON.stringify(derivative));
    delete damaged.image.raster;
    const recorded = await store.record({
      name: "broken.svg",
      bytes: LOGO,
      derivative: damaged,
      needsVision: true,
    });
    /** @type {EditorAttachment} */
    const attachment = {
      id,
      name: "broken.svg",
      kind: "image",
      parser: "svg-raster-v1",
      summaryZh: damaged.summary.zh,
      needsVision: true,
      bytes: LOGO.length,
      storeId: recorded.meta.storeId,
      originalSha256: recorded.meta.originalSha256,
      derivativeSha256: recorded.meta.derivativeSha256,
    };
    assert.throws(() => prepareSessionMaterials(store.root, [attachment]), /图片副本缺失或校验失败/);
    assert.equal(fs.existsSync(path.join(root, "svg-broken-project")), false);
  },
);

const containsAvifBox = (/** @type {fs.PathOrFileDescriptor} */ file) =>
  fs.readFileSync(file).includes(Buffer.from("ftypavif", "ascii"));
