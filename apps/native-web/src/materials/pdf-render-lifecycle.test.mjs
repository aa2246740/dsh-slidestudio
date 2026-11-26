import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { PdfFixtureStore } from "./pdf-fixture-store.mjs";
import { pdfSample } from "./pdf-fixture-samples.mjs";
import { readPdfPage } from "./pdf-page-store.mjs";
import { enqueuePdfRender, publicPdfRenderStatus, readOwnedRecord } from "./pdf-render-store.mjs";
import { PdfRenderQueue } from "./pdf-render.mjs";

/** Stand-in render child: paints no canvas, writes a JPEG-marked page per message. */
const STUB = fileURLToPath(new URL("./test-fixtures/pdf-images-stub-child.mjs", import.meta.url));
const OVERRIDES = { childPath: STUB };
const NO_IMAGE = "页面图片没有生成，看图模型无法查看页面；PDF 文字仍可读取";

/** @type {string} */
let scratch;
/** @type {PdfFixtureStore} */
let store;
/** @type {string|undefined} */
let originalTmpdir;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-pdf-lifecycle-"));
  store = new PdfFixtureStore(path.join(scratch, "attachments"));
  const renderTmp = path.join(scratch, "tmp");
  fs.mkdirSync(renderTmp);
  originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = renderTmp;
});

after(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** @param {string} name */
const upload = (name) => store.add(name, pdfSample(name));

/** @param {string} id */
function readRecord(id) {
  const record = store.read(id);
  assert.ok(record, "the record must still be readable with a valid hash receipt");
  return /** @type {any} */ (record);
}

/** @param {string} id */
const pageFiles = (id) => fs.readdirSync(store.root).filter((name) => name.includes(`${id}.page-`));

/** @param {Buffer} bytes */
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * A queue whose jobs call `hook` once, after the child has rendered every page of
 * the document and before the store writes anything for it: the point where a
 * delete lands while the render is still running.
 * @param {{hook: (() => void)|null}} arm
 */
function hookedQueue(arm) {
  const queue = new PdfRenderQueue({ probe: async () => true });
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = (job) =>
    enqueue({
      ...job,
      run: async () => {
        const result = await job.run();
        const hook = arm.hook;
        arm.hook = null;
        hook?.();
        return result;
      },
    });
  return queue;
}

test("a PDF deleted while its render runs keeps no page image, and the queue drains and renders the next PDF", async () => {
  const record = await upload("text.pdf");
  const next = await upload("styled-report.pdf");
  const id = record.meta.id;
  let deleted = false;
  const arm = { hook: /** @type {(() => void)|null} */ (() => (deleted = store.delete(id))) };
  const queue = hookedQueue(arm);

  assert.equal(enqueuePdfRender({ store, queue, record, overrides: OVERRIDES }), true);
  assert.equal(enqueuePdfRender({ store, queue, record: next, overrides: OVERRIDES }), true);
  await queue.drain();

  assert.equal(arm.hook, null, "the armed render must have run");
  assert.equal(deleted, true, "the delete must land while the render is running");
  assert.deepEqual(pageFiles(id), [], "no page JPEG for the deleted id may stay in the store root");
  assert.equal(store.read(id), undefined, "the deleted record stays deleted");
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.pending.length, 0);

  const rendered = readRecord(next.meta.id).derivative.document;
  assert.equal(rendered.renderState, "ready");
  assert.equal(rendered.renderedPages.length, 1);
  const page = readPdfPage(store, next.meta.id, 1);
  assert.ok(page && page.bytes[0] === 0xff && page.bytes[1] === 0xd8, "next PDF page is a JPEG");
});

test("a rendered multi-page PDF records verified page JPEGs, measured wording and a public status", async () => {
  const record = await upload("mixed-scan.pdf");
  const id = record.meta.id;
  const queue = new PdfRenderQueue({ probe: async () => true });
  assert.equal(enqueuePdfRender({ store, queue, record, overrides: OVERRIDES }), true);
  await queue.drain();

  const ready = readRecord(id);
  const document = ready.derivative.document;
  assert.equal(document.renderState, "ready");
  assert.equal(document.renderedPages.length, document.pageCount);
  assert.ok(document.renderMetrics.durationMs >= 0);
  for (const descriptor of document.renderedPages) {
    const page = readPdfPage(store, id, descriptor.index);
    assert.ok(page, `page ${descriptor.index} is readable`);
    assert.equal(sha256(page.bytes), descriptor.sha256);
  }
  assert.equal(readPdfPage(store, id, document.pageCount + 1), undefined);
  // The stub measures page 1 as image-covered; the low-text pages 2-3 stay unmeasured-false.
  assert.deepEqual(
    document.pages.map((/** @type {{hasImage?: boolean}} */ page) => page.hasImage),
    [true, false, false, false],
  );
  const scanned = ready.derivative.warnings.find(
    (/** @type {{code: string}} */ warning) => warning.code === "scanned-pages",
  );
  assert.equal(scanned.message, "第 2、3 页几乎没有文字，这几页的内容 Agent 读不到");

  const status = publicPdfRenderStatus(ready, queue.available);
  assert.equal(status?.state, "ready");
  assert.equal(status?.available, true);
  assert.equal(status?.renderedPages, 4);
  assert.equal(status?.pages[0]?.url, `/api/attachments/${encodeURIComponent(id)}/pages/1`);
  assert.equal(readOwnedRecord(store, id)?.meta.id, id);
});

test("without the optional canvas the queue fails closed: text and vector hints stay, pages are unavailable", async () => {
  const record = await upload("styled-report.pdf");
  const before = structuredClone(record.derivative);
  const unavailable = new PdfRenderQueue({ probe: async () => false });
  assert.equal(enqueuePdfRender({ store, queue: unavailable, record }), true);
  await unavailable.drain();
  assert.equal(unavailable.available, false);

  const after = readRecord(record.meta.id);
  const document = after.derivative.document;
  assert.deepEqual(document.pages, before.document?.pages);
  assert.deepEqual(document.styleProfile, before.document?.styleProfile);
  assert.equal(document.styleProfile.accentColors[0].hex, "#C00000");
  assert.deepEqual(document.renderedPages, []);
  assert.equal(document.renderState, "unavailable");
  assert.equal(document.renderMessage, NO_IMAGE);
  assert.deepEqual(after.derivative.warnings, [...before.warnings, { code: "canvas-unavailable", message: NO_IMAGE }]);
  assert.deepEqual(pageFiles(record.meta.id), []);
  const status = publicPdfRenderStatus(after, unavailable.available);
  assert.equal(status?.available, false);
  assert.equal(status?.state, "unavailable");
  assert.equal(status?.message, NO_IMAGE);
});

test("the real probe decides availability, and a probe-less render never writes pages", async () => {
  const record = await upload("text.pdf");
  const queue = new PdfRenderQueue();
  const available = await queue.ready();
  assert.equal(typeof available, "boolean");
  if (available) return;
  enqueuePdfRender({ store, queue, record });
  await queue.drain();
  assert.equal(readRecord(record.meta.id).derivative.document.renderState, "unavailable");
  assert.deepEqual(pageFiles(record.meta.id), []);
});

test("a non-PDF record is never queued and has no public render status", () => {
  const queue = new PdfRenderQueue({ probe: async () => true });
  /** @type {any} */
  const record = {
    meta: { id: "00000000-0000-0000-0000-000000000000-a.csv" },
    derivative: { kind: "table", parser: { id: "csv-v1" }, warnings: [] },
  };
  assert.equal(enqueuePdfRender({ store, queue, record }), false);
  assert.equal(publicPdfRenderStatus(record, true), undefined);
});
