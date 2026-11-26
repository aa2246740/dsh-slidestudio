import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, test } from "node:test";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { listedChildrenIntact } from "./embedded-images.mjs";
import { ingestAttachment } from "./intake.mjs";
import { ParsePool } from "./parse-pool.mjs";
import { PdfRenderQueue } from "./pdf-render.mjs";
import { readSample } from "./sample-fixtures.mjs";
import {
  env,
  ingest,
  nextOwner,
  NO_SAMPLES,
  NO_SHARP,
  photo,
  readChild,
  recordingPool,
  useEmbeddedEnv,
} from "./test-fixtures/embedded-harness.mjs";

/** @typedef {import("../attachments.mjs").StoredRecord} StoredRecord */
/** @typedef {NonNullable<import("../attachments.mjs").StoredDerivative["document"]>} StoredDocument */
/** @typedef {import("./public-style-profile.mjs").StoredImage} StoredImage */
/** @typedef {import("./pdf-images-run.mjs").PdfImageRunner} PdfImageRunner */
/** @typedef {import("./pdf-images.mjs").PdfImage} PdfImage */
/** @typedef {{code: string, message: string}} Warning */

useEmbeddedEnv();
/** @type {string} */ let samples;
/** @type {string} */ let scratch;
/** @type {import("../attachments.mjs").AttachmentStore} */ let store;
/** @type {import("./parse-pool.mjs").ParsePool} */ let pool;
before(() => {
  ({ samples, scratch, store, pool } = env);
});

describe("VAL-PDF-007: embedded PDF images become image materials", { skip: NO_SHARP }, () => {
  test(
    "photo-in.pdf registers exactly its 2 photos with page notes and explains the 3 icons",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const { record } = await ingest("photo-in.pdf", readSample(samples, "photo-in.pdf"), ownerId);

      const section = /** @type {Required<StoredDocument>} */ (record.derivative.document).embeddedImages;
      assert.equal(section.origin, "pdf");
      assert.equal(section.found, 2);
      assert.equal(section.kept, 2);
      assert.deepEqual(
        section.images.map(({ note, position, width, height }) => ({
          note,
          page: position.page,
          width,
          height,
        })),
        [
          { note: "来自 PDF 第 1 页", page: 1, width: 240, height: 160 },
          { note: "来自 PDF 第 2 页", page: 2, width: 160, height: 200 },
        ],
      );
      assert.equal(section.skipped.small, 3);
      const warning = /** @type {Warning} */ (
        record.derivative.warnings.find(({ code }) => code === "embedded-images-skipped")
      );
      assert.match(warning.message, /3 张小于 64×64 像素/);
      for (const entry of section.images) {
        const child = readChild(ownerId, entry.id);
        const image = /** @type {Required<StoredImage>} */ (child.derivative.image);
        assert.equal(image.origin, "pdf");
        assert.equal(image.parent.name, "photo-in.pdf");
        assert.equal(image.styleProfile.source, "image-pixels");
        assert.match(/** @type {{zh: string}} */ (child.derivative.summary).zh, /^来自 PDF 第 [12] 页 · PNG 图片/);
      }
      assert.equal(record.derivative.status, "ok", "pictures never turn a parsed PDF into a failed one");
    },
  );

  test(
    "a PDF with more than 40 qualifying images keeps the first 40 in page order and warns without a total",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const counted = recordingPool();
      try {
        const { record } = await ingest("photo-many.pdf", readSample(samples, "photo-many.pdf"), ownerId, {
          pool: counted.pool,
        });
        const section = /** @type {Required<StoredDocument>} */ (record.derivative.document).embeddedImages;
        assert.equal(section.kept, 40);
        assert.equal(section.found, 41, "the scan ended at the first picture past the limit");
        assert.equal(section.countComplete, false);
        assert.equal(section.images.length, 40);
        const pages = section.images.map(({ position }) => /** @type {number} */ (position.page));
        assert.deepEqual(
          pages,
          [...pages].sort((a, b) => a - b),
          "registration order never reorders the pictures",
        );
        assert.deepEqual(
          section.images.slice(0, 6).map(({ note }) => note),
          [1, 1, 1, 1, 1, 2].map((page) => `来自 PDF 第 ${page} 页`),
        );
        const warning = record.derivative.warnings.find(({ code }) => code === "embedded-images-limit");
        assert.ok(warning);
        assert.match(warning.message, /40 张以上可用图片.*只保留了前 40 张/);
        assert.doesNotMatch(warning.message, /41 张|45 张/);
        assert.equal(listedChildrenIntact(store, record), true);
        const timings = /** @type {NonNullable<typeof section.timingsMs>} */ (section.timingsMs);
        assert.ok(timings.gather >= 0 && timings.register >= 0);
        assert.equal(counted.maxInFlight, 2, "registration runs as wide as the pool allows");
      } finally {
        await counted.pool.close();
      }
    },
  );

  test(
    "scan-pages.pdf registers nothing for its scan pages, is parsed, and still renders its pages",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const queue = new PdfRenderQueue();
      const { record } = await ingest("scan-pages.pdf", readSample(samples, "scan-pages.pdf"), ownerId, {
        renderQueue: queue,
      });
      await queue.drain();
      const section = /** @type {Required<StoredDocument>} */ (record.derivative.document).embeddedImages;
      assert.equal(record.derivative.status, "partial", "the 3 scan pages are low-text pages");
      assert.equal(section.skipped.pageScan, 3);
      assert.equal(section.kept, 1);
      assert.deepEqual(
        section.images.map(({ note, width, height }) => [note, width, height]),
        [["来自 PDF 第 4 页", 240, 160]],
      );
      const warning = /** @type {Warning} */ (
        record.derivative.warnings.find(({ code }) => code === "embedded-images-skipped")
      );
      assert.match(warning.message, /3 张是铺满整页的扫描图/);
      const rendered = /** @type {Required<StoredDocument>} */ (
        /** @type {StoredRecord} */ (store.read(record.meta.id)).derivative.document
      );
      assert.equal(rendered.renderState, "ready");
      assert.equal(rendered.renderedPages.length, 4, "the scan pages are still rendered");
    },
  );

  test("an extraction failure leaves the PDF parsed with a Chinese warning", { skip: NO_SAMPLES }, async () => {
    const ownerId = nextOwner();
    const crashed = async () => {
      throw new Error("图片提取子进程异常退出（SIGKILL）");
    };
    const { record } = await ingest("photo-in.pdf", readSample(samples, "photo-in.pdf"), ownerId, {
      pdfImages: crashed,
    });
    assert.equal(record.derivative.status, "ok");
    const document = /** @type {Required<StoredDocument>} */ (record.derivative.document);
    assert.equal(document.pageCount, 2);
    assert.equal(document.embeddedImages.failed, true);
    assert.deepEqual(document.embeddedImages.images, []);
    const warning = /** @type {Warning} */ (
      record.derivative.warnings.find(({ code }) => code === "embedded-images-failed")
    );
    assert.match(warning.message, /文档已识别，但里面的图片没有提取成功（图片提取子进程异常退出/);
    assert.equal(attachmentPublic(record).status, "parsed");
    assert.equal(await store.reuses(record), true, "the failed outcome is a current record, not a loop");
  });

  test("pictures are registered while later pages are still being read", { skip: NO_SAMPLES }, async () => {
    const ownerId = nextOwner();
    const counted = recordingPool();
    const pictures = await Promise.all([photo(80, 80, "#2E6FD8"), photo(90, 90, "#B5573A")]);
    const asImage = (/** @type {any} */ bytes, /** @type {number} */ page) => ({
      page,
      order: 1,
      width: 80,
      height: 80,
      format: "png",
      bytes,
    });
    let parsedWhileReading = -1;
    const streaming = async (/** @type {{onImages: (images: object[]) => void}} */ { onImages }) => {
      onImages([asImage(pictures[0], 1)]);
      await new Promise((resolve) => setTimeout(resolve, 600));
      parsedWhileReading = counted.jobs.filter((job) => job === "photo-in-p1-1.png").length;
      onImages([asImage(pictures[1], 2)]);
      return {
        images: [asImage(pictures[0], 1), asImage(pictures[1], 2)],
        qualifying: 2,
        countComplete: true,
        pagesScanned: 2,
        pageCount: 2,
        skipped: { small: 0, tooLarge: 0, duplicate: 0, unreadable: 0 },
        timedOut: false,
      };
    };
    try {
      const { record } = await ingest("photo-in.pdf", readSample(samples, "photo-in.pdf"), ownerId, {
        pdfImages: streaming,
        pool: counted.pool,
      });
      assert.equal(parsedWhileReading, 1, "page 1's picture was parsed before page 2 arrived");
      const section = /** @type {Required<StoredDocument>} */ (record.derivative.document).embeddedImages;
      assert.deepEqual(
        section.images.map(({ note }) => note),
        ["来自 PDF 第 1 页", "来自 PDF 第 2 页"],
        "no picture is registered twice when a runner both streams and returns them",
      );
      assert.equal(counted.jobs.filter((job) => job.startsWith("photo-in-p")).length, 2);
    } finally {
      await counted.pool.close();
    }
  });

  test("the pictures are read while the text is parsed, not after it", { skip: NO_SAMPLES }, async () => {
    const ownerId = nextOwner();
    /** @type {string[]} */
    const events = [];
    const inner = new ParsePool();
    const run = inner.run.bind(inner);
    inner.run = async (job) => {
      const outcome = await run(job);
      if (job.name === "photo-in.pdf") events.push("text-parsed");
      return outcome;
    };
    const reading = async () => {
      events.push("pictures-started");
      return {
        images: [],
        qualifying: 0,
        countComplete: true,
        pagesScanned: 0,
        pageCount: 0,
        skipped: { small: 0, tooLarge: 0, duplicate: 0, unreadable: 0 },
        timedOut: false,
      };
    };
    try {
      await ingest("photo-in.pdf", readSample(samples, "photo-in.pdf"), ownerId, {
        pdfImages: reading,
        pool: inner,
      });
    } finally {
      await inner.close();
    }
    assert.deepEqual(events, ["pictures-started", "text-parsed"]);
  });

  test("a PDF that cannot be parsed abandons the picture reading it started", { skip: NO_SAMPLES }, async () => {
    const ownerId = nextOwner();
    /** @type {AbortSignal | undefined} */
    let signal;
    const reading = (/** @type {{signal: AbortSignal}} */ { signal: given }) => {
      signal = given;
      return new Promise((_resolve, reject) => {
        given.addEventListener("abort", () => reject(Object.assign(new Error("取消"), { code: "aborted" })));
      });
    };
    const { record } = await ingest("garbage.pdf", readSample(samples, "garbage.pdf"), ownerId, {
      pdfImages: reading,
    });
    assert.equal(record.derivative.status, "unsupported");
    assert.equal(/** @type {AbortSignal} */ (signal).aborted, true);
  });

  test(
    "an extraction that fails after streaming pictures leaves the PDF with none of them",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const localStore = new AttachmentStore(path.join(scratch, "failed-midway"));
      const picture = await photo(80, 80, "#2E6FD8");
      /** @type {PdfImageRunner} */
      const failing = async ({ onImages }) => {
        /** @type {(images: PdfImage[]) => void} */ (onImages)([
          { page: 1, order: 1, width: 80, height: 80, format: "png", bytes: picture },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        throw new Error("图片提取子进程异常退出（SIGKILL）");
      };
      const upload = { name: "photo-in.pdf", bytes: readSample(samples, "photo-in.pdf"), ownerId };
      const { record } = await ingestAttachment({ store: localStore, pool, pdfImages: failing }, upload);
      const section = /** @type {Required<StoredDocument>} */ (record.derivative.document).embeddedImages;
      assert.equal(section.failed, true);
      assert.deepEqual(section.images, []);
      assert.equal(record.derivative.status, "ok");
      const stems = new Set(fs.readdirSync(localStore.root).map((file) => file.split(".")[0]));
      assert.equal(stems.size, 1, "only the document's own record remains; the streamed picture was discarded");
      assert.ok(record.derivative.warnings.some(({ code }) => code === "embedded-images-failed"));
    },
  );

  test(
    "a queue that is full and an encrypted file both end as warnings on a parsed PDF",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const full = async () => {
        throw Object.assign(new Error("图片提取队列已满，请稍后重新上传"), { code: "queue-full" });
      };
      const { record } = await ingest("photo-in.pdf", readSample(samples, "photo-in.pdf"), ownerId, {
        pdfImages: full,
      });
      assert.equal(record.derivative.status, "ok");
      assert.match(
        /** @type {Warning} */ (record.derivative.warnings.find(({ code }) => code === "embedded-images-failed"))
          .message,
        /图片提取队列已满/,
      );
    },
  );

  test(
    "a child stopped at the memory or time limit keeps what it sent and says why",
    { skip: NO_SAMPLES },
    async () => {
      const png = await photo(64, 64, "#2E6FD8");
      const stopped = (/** @type {string} */ reason) => async () => ({
        images: [{ page: 3, order: 1, width: 64, height: 64, format: "png", bytes: png }],
        qualifying: 7,
        countComplete: false,
        pagesScanned: 3,
        pageCount: 0,
        skipped: { small: 0, tooLarge: 0, duplicate: 0, unreadable: 0 },
        timedOut: reason === "time",
        stopped: reason,
      });
      const bytes = readSample(samples, "photo-in.pdf");
      const byMemory = await ingest("a.pdf", bytes, nextOwner(), { pdfImages: stopped("memory") });
      const memory = byMemory.record.derivative;
      const memoryImages = /** @type {Required<StoredDocument>} */ (memory.document).embeddedImages;
      assert.equal(memoryImages.kept, 1);
      assert.equal(memoryImages.images[0].note, "来自 PDF 第 3 页");
      assert.match(
        /** @type {Warning} */ (memory.warnings.find(({ code }) => code === "embedded-images-memory")).message,
        /占用内存过大，已停止；只保留了已经提取的 1 张/,
      );
      const byTime = await ingest("b.pdf", Buffer.concat([bytes, Buffer.from("\n")]), nextOwner(), {
        pdfImages: stopped("time"),
      });
      assert.match(
        /** @type {Warning} */ (
          byTime.record.derivative.warnings.find(({ code }) => code === "embedded-images-timeout")
        ).message,
        /用时过长，只扫描了前 3 页/,
      );
    },
  );

  test(
    "without an extraction runner a PDF records the section as unavailable and stays reusable",
    { skip: NO_SAMPLES },
    async () => {
      const ownerId = nextOwner();
      const localStore = new AttachmentStore(path.join(scratch, "no-runner"));
      const bytes = readSample(samples, "photo-in.pdf");
      const upload = { name: "photo-in.pdf", bytes, ownerId };
      const first = await ingestAttachment({ store: localStore, pool }, upload);
      const section = /** @type {Required<StoredDocument>} */ (first.record.derivative.document).embeddedImages;
      assert.equal(section.unavailable, true);
      assert.equal(section.kept, 0);
      assert.equal(
        first.record.derivative.warnings.some(({ code }) => code.startsWith("embedded-images")),
        false,
        "nothing is claimed about the file's pictures",
      );
      const second = await ingestAttachment({ store: localStore, pool }, upload);
      assert.equal(second.duplicateOf, first.record.meta.id);
    },
  );

  test("a PDF without pictures is not an error and lists nothing", { skip: NO_SAMPLES }, async () => {
    const ownerId = nextOwner();
    const { record } = await ingest("text.pdf", readSample(samples, "text.pdf"), ownerId);
    assert.equal(/** @type {Required<StoredDocument>} */ (record.derivative.document).embeddedImages.kept, 0);
    assert.equal(attachmentPublic(record).embeddedImages, undefined);
  });
});
