/**
 * Records stored by earlier builds ("legacy" record shapes, not legacy Office
 * files) are still served and parse as public records. The editor is
 * single-user local: records are read without any owner scope.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { AttachmentStore } from "../attachments.mjs";
import { parseAttachmentPublic } from "../../public/attachment-public.js";
import { solidPng } from "../testlib/pptx-fixture.mjs";
import { serveAttachmentGet } from "./attachment-routes.mjs";
import { ingestAttachment } from "./intake.mjs";
import { loadSharp } from "./optional-decoder.mjs";
import { ParsePool } from "./parse-pool.mjs";
import { imageParser } from "./parsers/image.mjs";
import { legacyImageDerivative, styledReportPdf, withPdfPagesScanned } from "./test-fixtures/legacy-records.mjs";

/** @type {string} */
let scratch;
/** @type {AttachmentStore} */
let store;
/** @type {ParsePool} */
let pool;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-legacy-public-"));
  store = new AttachmentStore(path.join(scratch, "output", "attachments"));
  pool = new ParsePool();
});

after(async () => {
  await pool?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * The GET the browser makes, answered by the real route handler.
 * @param {string} id
 */
function getRecord(id) {
  /** @type {{status: number, body: Record<string, unknown>}[]} */
  const replies = [];
  const handled = serveAttachmentGet(
    {
      req: /** @type {never} */ (undefined),
      url: new URL(`http://127.0.0.1/api/attachments/${encodeURIComponent(id)}`),
      res: /** @type {never} */ (undefined),
      reply: (status, body) => {
        replies.push({ status, body: /** @type {Record<string, unknown>} */ (body) });
      },
    },
    { store },
  );
  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  return /** @type {{status: number, body: Record<string, unknown>}} */ (replies[0]);
}

/**
 * Picture bytes for one case, or null when the optional image decoder is missing.
 * @param {"exif.jpg"|"sample.png"} name
 */
async function pictureBytes(name) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  if (name === "sample.png") return solidPng({ width: 64, height: 32 });
  // A landscape pixel grid tagged with EXIF orientation 6: it displays as portrait.
  return /** @type {Buffer} */ (
    await sharp(solidPng({ width: 64, height: 32 }))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
  );
}

/**
 * A picture stored the way the build before the orientation word stored it.
 * @param {"exif.jpg"|"sample.png"} name @param {Buffer} bytes @param {number} orientation
 */
async function storeLegacyImage(name, bytes, orientation) {
  const parsed = await imageParser.parse({ name, bytes });
  const mime = name.endsWith(".jpg") ? "image/jpeg" : "image/png";
  const derivative = legacyImageDerivative({
    materialId: store.nextId(name),
    source: store.sourceOf(name, bytes, null, mime, false),
    summary: parsed.summary,
    orientation,
    payload: /** @type {never} */ (parsed.payload),
  });
  const { meta } = await store.record({ name, bytes, derivative });
  return { id: meta.id, current: /** @type {{orientation?: string}} */ (parsed.payload) };
}

test("a stored picture with numeric EXIF orientation 6 is served and restored as a portrait word", async (t) => {
  const bytes = await pictureBytes("exif.jpg");
  if (!bytes) return t.skip("the optional image decoder (sharp) is not installed");
  const { id } = await storeLegacyImage("exif.jpg", bytes, 6);
  const { status, body } = getRecord(id);
  assert.equal(status, 200);
  assert.deepEqual(body.imageMetadata, { orientation: "portrait" });
  assert.doesNotThrow(() => parseAttachmentPublic(body));
  assert.equal(parseAttachmentPublic(body).imageMetadata?.orientation, "portrait");
});

test("a stored picture with numeric EXIF orientation 1 is served with the word of its stored size", async (t) => {
  const bytes = await pictureBytes("sample.png");
  if (!bytes) return t.skip("the optional image decoder (sharp) is not installed");
  const { id, current } = await storeLegacyImage("sample.png", bytes, 1);
  const { status, body } = getRecord(id);
  assert.equal(status, 200);
  assert.equal(current.orientation, "landscape");
  assert.deepEqual(body.imageMetadata, { orientation: "landscape" });
  assert.doesNotThrow(() => parseAttachmentPublic(body));
});

test("a stored PDF whose profile measured no pages is served without it, kept as stored, and parsed again on upload", async () => {
  const name = "styled-report.pdf";
  const bytes = styledReportPdf();
  const id = store.nextId(name);
  const outcome = await pool.run({ materialId: id, name, bytes });
  assert.equal(outcome.ok, true);
  const parsed = /** @type {import("../attachments.mjs").StoredDerivative} */ (outcome.derivative);
  const pagesScanned = /** @type {{pagesScanned?: number}} */ (parsed.document?.styleProfile)?.pagesScanned;
  assert.ok((pagesScanned ?? 0) >= 1);
  await store.record({ name, bytes, derivative: withPdfPagesScanned(parsed, 0) });

  const { status, body } = getRecord(id);
  assert.equal(status, 200);
  assert.equal(body.styleProfile, undefined, "the profile is not published");
  assert.equal(body.parser, parsed.parser.id);
  assert.doesNotThrow(() => parseAttachmentPublic(body));
  const kept = store.read(id)?.derivative.document?.styleProfile;
  assert.equal(kept?.pagesScanned, 0, "the stored record is unchanged");

  const again = await ingestAttachment({ store, pool }, { name, bytes });
  assert.equal(again.duplicateOf, undefined, "a copy that measured no pages is not reused");
  const profile = /** @type {{pagesScanned: number}} */ (again.record.derivative.document?.styleProfile);
  assert.ok(profile.pagesScanned >= 1 && profile.pagesScanned <= 30);
  assert.equal(store.read(id), undefined, "the stale copy is retired");
});
