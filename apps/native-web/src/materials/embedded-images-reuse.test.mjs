import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, test } from "node:test";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { EMBEDDED_IMAGES_VERSION } from "./embedded-images.mjs";
import { readSample } from "./sample-fixtures.mjs";
import {
  docxWithTablePictures,
  docxWithWrappedPictures,
  env,
  ingest,
  nextOwner,
  NO_SAMPLES,
  NO_SHARP,
  recordingPool,
  useEmbeddedEnv,
} from "./test-fixtures/embedded-harness.mjs";

/** @typedef {import("../attachments.mjs").StoredRecord} StoredRecord */
/** @typedef {import("../attachments.mjs").StoredDerivative} StoredDerivative */
/** @typedef {NonNullable<StoredDerivative["document"]>} DocumentSection */
/** @typedef {import("./embedded-images.mjs").EmbeddedImagesSection} EmbeddedImagesSection */
/**
 * The owner-scoped calls this suite makes on a store.
 * @typedef {AttachmentStore & {
 *   record: (intake: Parameters<AttachmentStore["record"]>[0] & {ownerId: string}) => Promise<StoredRecord>,
 *   read: (id: string, scope: {ownerId: string}) => ReturnType<AttachmentStore["read"]>,
 *   delete: (id: string, scope: {ownerId: string}) => ReturnType<AttachmentStore["delete"]>,
 * }} OwnerScopedStore
 */

/** @param {StoredDerivative} derivative */
const documentOf = (derivative) => /** @type {DocumentSection} */ (derivative.document);
/** @param {StoredDerivative} derivative */
const sectionOf = (derivative) => /** @type {EmbeddedImagesSection} */ (documentOf(derivative).embeddedImages);

useEmbeddedEnv();
/** @type {string} */ let samples;
/** @type {string} */ let scratch;
/** @type {OwnerScopedStore} */ let store;
/** @type {import("./parse-pool.mjs").ParsePool} */ let pool;
before(() => {
  ({ samples, scratch, store, pool } = /** @type {typeof env & {store: OwnerScopedStore}} */ (env));
});

describe("VAL-PDF-007: reuse, versioning and hostile shapes", { skip: NO_SHARP }, () => {
  test(
    "an identical re-upload reuses the document and its pictures without any new job",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const counted = recordingPool();
      try {
        const bytes = readSample(samples, "report.docx");
        const first = await ingest("report.docx", bytes, ownerId, { store, pool: counted.pool });
        const jobsAfterFirst = counted.jobs.length;
        const second = await ingest("report.docx", bytes, ownerId, { store, pool: counted.pool });
        assert.equal(second.duplicateOf, first.record.meta.id);
        assert.deepEqual(
          /** @type {{embeddedImages: {id: string}[]}} */ (attachmentPublic(second.record)).embeddedImages.map(
            ({ id }) => id,
          ),
          sectionOf(first.record.derivative).images.map(({ id }) => id),
        );
        assert.equal(counted.jobs.length, jobsAfterFirst, "no re-parse and no second extraction");
      } finally {
        await counted.pool.close();
      }
    },
  );

  test(
    "a record stored before this version is parsed once more and gets its pictures",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const bytes = readSample(samples, "report.docx");
      const first = await ingest("report.docx", bytes, ownerId);
      const stale = structuredClone(first.record.derivative);
      delete documentOf(stale).embeddedImages;
      stale.materialId = store.nextId("report.docx");
      const aged = /** @type {OwnerScopedStore} */ (new AttachmentStore(path.join(scratch, "aged")));
      await aged.record({ name: "report.docx", bytes, ownerId, derivative: stale });
      assert.equal(await aged.reuses(aged.read(stale.materialId, { ownerId })), false);

      const again = await ingest("report.docx", bytes, ownerId, { store: aged, pool });
      assert.equal(again.duplicateOf, undefined, "the stale record is not reused");
      assert.equal(sectionOf(again.record.derivative).kept, 1);
      assert.equal(aged.read(stale.materialId, { ownerId }), undefined, "retireSameHash removed the stale copy");
    },
  );

  test("a DOCX stored under the previous section version is parsed once more for its table pictures", async () => {
    const ownerId = nextOwner();
    const bytes = await docxWithTablePictures();
    const first = await ingest("tables.docx", bytes, ownerId);
    // What a record stored before the table pictures held: the body picture only, version 2.
    const stale = structuredClone(first.record.derivative);
    const section = sectionOf(stale);
    documentOf(stale).embeddedImages = {
      ...section,
      version: EMBEDDED_IMAGES_VERSION - 1,
      kept: 1,
      images: section.images.slice(0, 1),
    };
    stale.materialId = store.nextId("tables.docx");
    const aged = /** @type {OwnerScopedStore} */ (new AttachmentStore(path.join(scratch, "aged-tables")));
    await aged.record({ name: "tables.docx", bytes, ownerId, derivative: stale });
    assert.equal(await aged.reuses(aged.read(stale.materialId, { ownerId })), false);

    const again = await ingest("tables.docx", bytes, ownerId, { store: aged, pool });
    assert.equal(again.duplicateOf, undefined, "the stale record is not reused");
    assert.equal(sectionOf(again.record.derivative).kept, 3);
    assert.equal(aged.read(stale.materialId, { ownerId }), undefined, "retireSameHash removed the stale copy");
  });

  test("a DOCX stored under version 3 is parsed once more for the pictures of its wrapped rows and cells", async () => {
    const ownerId = nextOwner();
    const bytes = await docxWithWrappedPictures();
    const first = await ingest("wrapped.docx", bytes, ownerId);
    // What a version 3 record holds: the body picture only, since its wrapped table pictures
    // were not kept yet.
    const stale = structuredClone(first.record.derivative);
    const section = sectionOf(stale);
    documentOf(stale).embeddedImages = {
      ...section,
      version: 3,
      kept: 1,
      images: section.images.slice(0, 1),
    };
    stale.materialId = store.nextId("wrapped.docx");
    const aged = /** @type {OwnerScopedStore} */ (new AttachmentStore(path.join(scratch, "aged-wrapped")));
    await aged.record({ name: "wrapped.docx", bytes, ownerId, derivative: stale });
    assert.equal(await aged.reuses(aged.read(stale.materialId, { ownerId })), false);

    const again = await ingest("wrapped.docx", bytes, ownerId, { store: aged, pool });
    assert.equal(again.duplicateOf, undefined, "the version 3 record is not reused");
    assert.equal(sectionOf(again.record.derivative).version, EMBEDDED_IMAGES_VERSION);
    assert.equal(sectionOf(again.record.derivative).kept, 6);
    assert.equal(aged.read(stale.materialId, { ownerId }), undefined, "retireSameHash removed the stale copy");
  });

  test("a parent whose listed pictures are gone is not reusable", { skip: NO_SAMPLES }, async () => {
    const ownerId = nextOwner();
    const bytes = readSample(samples, "report.docx");
    const { record } = await ingest("report.docx", bytes, ownerId);
    assert.equal(await store.reuses(record), true);
    const childId = sectionOf(record.derivative).images[0].id;
    store.delete(childId, { ownerId });
    assert.equal(await store.reuses(record), false);
    const again = await ingest("report.docx", bytes, ownerId);
    assert.equal(again.duplicateOf, undefined);
    assert.notEqual(sectionOf(again.record.derivative).images[0].id, childId);
  });

  test("a document that fails parsing registers no pictures", { skip: NO_SAMPLES }, async () => {
    const ownerId = nextOwner();
    const before = fs.readdirSync(store.root).length;
    const { record } = await ingest("garbage.pdf", readSample(samples, "garbage.pdf"), ownerId);
    assert.equal(record.derivative.status, "unsupported");
    assert.equal(record.derivative.document, undefined);
    assert.equal(fs.readdirSync(store.root).length - before, 3, "only the failed record's files");
  });

  test("the picture records are owner-scoped like any upload", { skip: NO_SAMPLES }, async () => {
    const ownerId = nextOwner();
    const { record } = await ingest("report.docx", readSample(samples, "report.docx"), ownerId);
    const childId = sectionOf(record.derivative).images[0].id;
    assert.equal(store.read(childId, { ownerId: "someone-else" }), undefined);
  });
});
