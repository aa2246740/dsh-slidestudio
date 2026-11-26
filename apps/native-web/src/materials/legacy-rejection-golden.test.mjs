import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { ingestAttachment } from "./intake.mjs";
import {
  expectedRecord,
  goldenBytes,
  loadGolden,
  normalizeUpload,
  sha256Hex,
} from "./test-fixtures/legacy-rejection-golden.mjs";

const golden = loadGolden();
const NAMES = golden.samples.map((sample) => sample.name);

/** A legacy rejection never reaches the parse pool. */
const pool = {
  /** @returns {Promise<never>} */
  run() {
    throw new Error("a legacy rejection must not reach the parse pool");
  },
};

/** @type {string} */
let scratch;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-legacy-golden-"));
});

after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * One upload the way the upload route makes it, in the golden's normalized shape.
 * @param {AttachmentStore} store
 * @param {string} name
 */
async function upload(store, name) {
  const bytes = goldenBytes(golden, name);
  const { record, duplicateOf, uploadWarnings } = await ingestAttachment({ store, pool }, { name, bytes });
  const publicRecord = JSON.parse(
    JSON.stringify(
      attachmentPublic(record, {
        duplicateOf,
        ...(uploadWarnings ? { warnings: uploadWarnings } : {}),
      }),
    ),
  );
  const rawMeta = JSON.parse(fs.readFileSync(store.paths(record.meta.id).metadata, "utf8"));
  assert.equal("ownerId" in rawMeta, false, `${name}: the stored meta.json carries no owner`);
  return normalizeUpload(store, { name, bytes, id: record.meta.id, publicRecord });
}

describe("round-1 legacy rejection golden (captured from e7d164b, ownerless)", () => {
  test("names the commit it was captured from and the sample hashes it covers", () => {
    assert.match(golden.capture.commit, /^e7d164b[0-9a-f]{33}$/);
    assert.deepEqual(NAMES, ["legacy.doc", "legacy.xls", "legacy.ppt", "legacy-as.docx"]);
    for (const sample of golden.samples) {
      assert.equal(sha256Hex(goldenBytes(golden, sample.name)), sample.sha256, sample.name);
      assert.equal("ownerId" in sample.meta, false, `${sample.name}: no owner in the golden`);
    }
    assert.equal(golden.samples[3]?.sha256, golden.samples[0]?.sha256, "legacy-as.docx holds the bytes of legacy.doc");
  });

  test("each sample alone in a fresh store is refused with the captured public record, derivative bytes and meta.json", async () => {
    for (const sample of golden.samples) {
      const store = new AttachmentStore(path.join(scratch, "single", sample.name));
      const actual = await upload(store, sample.name);
      assert.deepEqual(actual, expectedRecord(sample), sample.name);
      assert.equal(actual.derivative, sample.derivative, `${sample.name} derivative bytes`);
      assert.equal(actual.publicRecord.status, "unsupported", sample.name);
      assert.equal(actual.publicRecord.errorCode, "legacy-office-format", sample.name);
    }
  });

  test("the four uploads one after another into one store answer exactly as each does alone", async () => {
    const store = new AttachmentStore(path.join(scratch, "sequence"));
    for (const sample of golden.samples) {
      assert.deepEqual(await upload(store, sample.name), expectedRecord(sample), sample.name);
    }
  });
});
