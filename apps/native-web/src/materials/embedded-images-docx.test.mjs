import assert from "node:assert/strict";
import fs from "node:fs";
import { before, describe, test } from "node:test";
import { attachmentPublic } from "../attachments.mjs";
import { EMBEDDED_IMAGES_VERSION } from "./embedded-images.mjs";
import { readSample } from "./sample-fixtures.mjs";
import { docxWithMedia } from "./test-fixtures/docx-media.mjs";
import {
  docxWithTablePictures,
  docxWithWrappedPictures,
  env,
  ingest,
  nextOwner,
  NO_SAMPLES,
  NO_SHARP,
  photo,
  readChild,
  sharp,
  useEmbeddedEnv,
} from "./test-fixtures/embedded-harness.mjs";

/** @typedef {import("../attachments.mjs").StoredRecord} StoredRecord */
/** @typedef {import("./embedded-images.mjs").EmbeddedImagesSection} EmbeddedImagesSection */
/** @typedef {import("./embedded-images.mjs").EmbeddedImageEntry} EmbeddedImageEntry */
/**
 * A stored embedded picture: the image payload always names its parent and carries its style
 * profile and the normalized vision copy.
 * @typedef {import("./public-style-profile.mjs").StoredImage & {parent: {materialId: string, name: string},
 *   styleProfile: Record<string, unknown>, normalized: {data: string}}} ChildImage
 */

/** The embedded-images section a parsed DOCX record carries. @param {StoredRecord} record */
const sectionOf = (record) =>
  /** @type {{embeddedImages: EmbeddedImagesSection}} */ (record.derivative.document).embeddedImages;
/** The image payload of a stored embedded picture. @param {StoredRecord} child */
const imageOf = (child) => /** @type {ChildImage} */ (child.derivative.image);
/** The public record's embedded picture entries. @param {StoredRecord} record */
const publicEmbedded = (record) => /** @type {EmbeddedImageEntry[]} */ (attachmentPublic(record).embeddedImages);

useEmbeddedEnv();
/** @type {string} */ let samples;
/** @type {import("../attachments.mjs").AttachmentStore} */ let store;
before(() => {
  ({ samples, store } = env);
});

describe("VAL-PDF-007: embedded DOCX images become image materials", { skip: NO_SHARP }, () => {
  test(
    "report.docx registers its picture with origin, the paragraph note and its own style profile",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const bytes = readSample(samples, "report.docx");
      const { record } = await ingest("report.docx", bytes, ownerId);

      assert.equal(record.derivative.kind, "document");
      assert.equal(record.derivative.status, "ok");
      const section = sectionOf(record);
      assert.equal(section.version, EMBEDDED_IMAGES_VERSION);
      assert.equal(section.origin, "docx");
      assert.equal(section.kept, 1);
      assert.equal(section.images.length, 1);

      const entry = section.images[0];
      assert.equal(entry.origin, "docx");
      assert.equal(entry.note, "来自文档第 10 段");
      assert.deepEqual(entry.position, { paragraph: 10 });
      assert.equal(entry.kind, "image");
      assert.equal(entry.needsVision, true);
      assert.match(entry.summary.zh, /^来自文档第 10 段 · PNG 图片 · 8×8/);

      const child = readChild(ownerId, entry.id);
      assert.equal(child.derivative.kind, "image");
      assert.equal(child.derivative.parser.id, "image-sharp-v1");
      assert.equal(imageOf(child).origin, "docx");
      assert.equal(imageOf(child).note, "来自文档第 10 段");
      assert.equal(imageOf(child).parent.name, "report.docx");
      assert.equal(imageOf(child).parent.materialId, record.meta.id);
      assert.equal(imageOf(child).styleProfile.schema, "style-profile/v1");
      assert.equal(imageOf(child).styleProfile.source, "image-pixels");
      assert.ok(imageOf(child).normalized.data, "the vision copy is present");
      assert.equal(child.meta.needsVision, true);
      assert.equal(entry.sha256, child.derivative.source.sha256);

      const publicRecord = attachmentPublic(record);
      assert.deepEqual(
        /** @type {EmbeddedImageEntry[]} */ (publicRecord.embeddedImages).map(({ id, origin, note }) => ({
          id,
          origin,
          note,
        })),
        [{ id: entry.id, origin: "docx", note: "来自文档第 10 段" }],
      );
      assert.equal(publicRecord.imageMaterials, undefined, "a document is never replaced by its images");
      assert.equal(publicRecord.status, "parsed");
    },
  );

  test("pictures are numbered by body paragraph and skipped, duplicate and undecodable ones are explained", async () => {
    const ownerId = nextOwner();
    const good = await photo(120, 80, "#2E6FD8");
    const jpeg = await photo(96, 96, "#B5573A", "jpeg");
    const gif = await sharp(await photo(40, 40, "#467343"))
      .gif()
      .toBuffer();
    const truncated = good.subarray(0, Math.floor(good.length / 2));
    const docx = docxWithMedia([
      { name: "a.png", bytes: good },
      { name: "b.jpg", bytes: jpeg },
      { name: "dup.png", bytes: good },
      { name: "broken.png", bytes: truncated },
      { name: "vector.emf", bytes: Buffer.from("EMF-not-an-image-at-all") },
      { name: "c.gif", bytes: gif },
    ]);
    const { record } = await ingest("mixed.docx", docx, ownerId);

    assert.equal(record.derivative.status, "ok", "the document itself stays parsed");
    const section = sectionOf(record);
    assert.deepEqual(
      section.images.map(({ name, note }) => [name, note]),
      [
        ["mixed-a.png", "来自文档第 2 段"],
        ["mixed-b.jpg", "来自文档第 4 段"],
        ["mixed-c.gif", "来自文档第 12 段"],
      ],
    );
    assert.deepEqual(section.skipped, { duplicate: 1, undecodable: 1, unsupported: 1 });
    const warning = record.derivative.warnings.find(({ code }) => code === "embedded-images-skipped");
    assert.ok(warning, "skipped pictures are reported");
    assert.match(warning.message, /1 张格式不支持/);
    assert.match(warning.message, /1 张无法完整解码/);
    assert.match(warning.message, /1 张与已保留的图片重复/);
    for (const entry of section.images) {
      const child = readChild(ownerId, entry.id);
      const decoded = await sharp(fs.readFileSync(store.paths(entry.id).original))
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(decoded.info.width, imageOf(child).width);
    }
  });

  test("a picture over the 16-megapixel decode cap is refused, not stored", async () => {
    const ownerId = nextOwner();
    const huge = await sharp({
      create: { width: 5000, height: 3600, channels: 3, background: "#808080" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const { record } = await ingest("huge.docx", docxWithMedia([{ name: "huge.png", bytes: huge }]), ownerId);
    assert.equal(sectionOf(record).kept, 0);
    assert.equal(sectionOf(record).skipped.undecodable, 1);
    assert.equal(record.derivative.status, "ok");
  });

  test("a truncated JPEG is not accepted as a picture", async () => {
    const ownerId = nextOwner();
    const jpeg = await photo(200, 200, "#B5573A", "jpeg");
    const { record } = await ingest(
      "cut.docx",
      docxWithMedia([{ name: "cut.jpg", bytes: jpeg.subarray(0, jpeg.length - 40) }]),
      ownerId,
    );
    assert.equal(sectionOf(record).kept, 0);
    assert.equal(sectionOf(record).skipped.undecodable, 1);
    assert.equal(record.derivative.status, "ok");
  });

  test("pictures inside a table cell register with a table note and their position", async () => {
    const ownerId = nextOwner();
    const { record } = await ingest("tables.docx", await docxWithTablePictures(), ownerId);

    assert.equal(record.derivative.status, "ok");
    const section = sectionOf(record);
    assert.equal(section.version, EMBEDDED_IMAGES_VERSION);
    assert.equal(section.kept, 3);
    assert.deepEqual(
      section.images.map(({ note, position }) => [note, position]),
      [
        ["来自文档第 2 段", { paragraph: 2 }],
        ["来自文档第 1 个表格", { table: 1, row: 1, column: 1 }],
        ["来自文档第 1 个表格", { table: 1, row: 1, column: 2 }],
      ],
    );
    for (const entry of section.images) {
      const child = readChild(ownerId, entry.id);
      assert.equal(imageOf(child).origin, "docx");
      assert.equal(imageOf(child).note, entry.note);
      assert.deepEqual(imageOf(child).position, entry.position);
      assert.equal(imageOf(child).parent.name, "tables.docx");
    }
    assert.deepEqual(
      publicEmbedded(record).map(({ id, note, position }) => ({
        id,
        note,
        position,
      })),
      section.images.map(({ id, note, position }) => ({ id, note, position })),
    );
  });

  test("pictures in rows, cells and blocks wrapped by content controls or customXml register with their table notes", async () => {
    const ownerId = nextOwner();
    const { record } = await ingest("wrapped.docx", await docxWithWrappedPictures(), ownerId);

    assert.equal(record.derivative.status, "ok");
    const section = sectionOf(record);
    assert.equal(section.version, EMBEDDED_IMAGES_VERSION);
    assert.equal(section.kept, 6);
    assert.deepEqual(
      section.images.map(({ note, position }) => [note, position]),
      [
        ["来自文档第 1 段", { paragraph: 1 }],
        ["来自文档第 1 个表格", { table: 1, row: 1, column: 1 }],
        ["来自文档第 1 个表格", { table: 1, row: 2, column: 2 }],
        ["来自文档第 2 个表格", { table: 2, row: 1, column: 1 }],
        ["来自文档第 2 个表格", { table: 2, row: 1, column: 2 }],
        ["来自文档第 3 个表格", { table: 3, row: 1, column: 1 }],
      ],
    );
    for (const entry of section.images) {
      const child = readChild(ownerId, entry.id);
      assert.equal(imageOf(child).origin, "docx");
      assert.equal(imageOf(child).note, entry.note);
      assert.deepEqual(imageOf(child).position, entry.position);
      assert.equal(imageOf(child).parent.name, "wrapped.docx");
    }
    assert.deepEqual(
      publicEmbedded(record).map(({ id }) => id),
      section.images.map(({ id }) => id),
    );
  });

  test("a document without pictures carries an empty current section and no warning", async () => {
    const ownerId = nextOwner();
    const { record } = await ingest("notes.docx", docxWithMedia([]), ownerId);
    assert.equal(sectionOf(record).version, EMBEDDED_IMAGES_VERSION);
    assert.deepEqual(sectionOf(record).images, []);
    assert.equal(attachmentPublic(record).embeddedImages, undefined);
    assert.equal(
      record.derivative.warnings.some(({ code }) => code.startsWith("embedded-images")),
      false,
    );
  });
});
