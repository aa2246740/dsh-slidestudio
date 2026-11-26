import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { describe, test } from "node:test";
import { loadOptionalNative, setOptionalNativeOverride } from "../optional-native.mjs";
import {
  extractPdfImages,
  PDF_IMAGE_LIMITS,
  PDF_IMAGES_UNAVAILABLE_CODE,
  runPdfImagesJob as runJob,
} from "./pdf-images.mjs";
import { MaterialRejection } from "./zip-guard.mjs";
import { LOW_TEXT_CHARS } from "./parsers/pdf.mjs";
import { pdfSample } from "./pdf-fixture-samples.mjs";

/**
 * Encoder stand-in with sharp's call shape, used when the optional add-on is not
 * installed: PNG output is the deflated raw pixels, JPEG an eighth of them, and
 * `resize(..., {fit: "inside"})` rounds the same way.
 * @param {Buffer} input @param {{raw: {width: number, height: number}}} options
 */
function stubSharp(input, { raw }) {
  let { width, height } = raw;
  let format = "png";
  const pipeline = {
    /** @param {number} maxWidth @param {number} maxHeight */
    resize(maxWidth, maxHeight) {
      const scale = Math.min(1, maxWidth / width, maxHeight / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      return pipeline;
    },
    png: () => ((format = "png"), pipeline),
    flatten: () => pipeline,
    jpeg: () => ((format = "jpeg"), pipeline),
    /** @param {{resolveWithObject?: boolean}} [options] */
    async toBuffer(options) {
      const data = format === "png" ? deflateSync(input) : input.subarray(0, Math.ceil(input.length / 8));
      return options?.resolveWithObject ? { data, info: { width, height } } : data;
    },
  };
  return pipeline;
}

/** The real encoder when installed; decode checks below only run with it. */
const realSharp = await loadOptionalNative("sharp");
/** @type {any} */
const sharp = realSharp ?? stubSharp;

/** @param {Uint8Array} bytes */
const runPdfImagesJob = (bytes) => runJob(bytes, { sharp });

/** Open a sample the way the job does, so limit overrides can be injected. */
async function withProxy(/** @type {any} */ name, /** @type {any} */ run) {
  const unpdf = await import("unpdf");
  // Passed through a variable so the unpdf option type does not reject isEvalSupported.
  const options = { isEvalSupported: false, maxImageSize: PDF_IMAGE_LIMITS.maxPixels };
  const proxy = await unpdf.getDocumentProxy(new Uint8Array(pdfSample(name)), options);
  try {
    return await run({ unpdf, proxy });
  } finally {
    await proxy.loadingTask?.destroy?.();
  }
}

describe("VAL-PDF-007: PDF embedded images", () => {
  test("photo-in.pdf yields exactly the 2 photos, each with its page; the 3 icons are skipped", async () => {
    const result = await runPdfImagesJob(new Uint8Array(pdfSample("photo-in.pdf")));
    assert.deepEqual(
      result.images.map(({ page, width, height }) => ({ page, width, height })),
      [
        { page: 1, width: 240, height: 160 },
        { page: 2, width: 160, height: 200 },
      ],
    );
    assert.equal(result.qualifying, 2);
    assert.equal(result.skipped.small, 3);
    assert.equal(result.countComplete, true);
    assert.equal(result.timedOut, false);
    for (const image of result.images) {
      assert.equal(image.format, "png");
      if (!realSharp) continue;
      // A full decode with sharp's default failOn must succeed on every kept image.
      const decoded = await sharp(image.bytes).raw().toBuffer({ resolveWithObject: true });
      assert.equal(decoded.info.width, image.width);
      assert.equal(decoded.info.height, image.height);
    }
  });

  test("a PDF with more than 40 qualifying images keeps the first 40 in page order and flags the count open", async () => {
    const result = await runPdfImagesJob(new Uint8Array(pdfSample("photo-many.pdf")));
    assert.equal(result.images.length, PDF_IMAGE_LIMITS.maxImages);
    assert.equal(PDF_IMAGE_LIMITS.maxImages, 40);
    assert.equal(result.qualifying, 41, "the scan ends at the first picture past the limit");
    assert.equal(result.countComplete, false);
    assert.equal(result.pagesScanned, 9);
    assert.deepEqual(
      result.images.slice(0, 6).map(({ page, order }) => [page, order]),
      [
        [1, 1],
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 5],
        [2, 1],
      ],
    );
    assert.deepEqual(
      result.images.map(({ page }) => page),
      [...result.images.map(({ page }) => page)].sort((a, b) => a - b),
    );
  });

  test("the scan stops on the page that holds the extra picture and decodes no later page", async () => {
    /** @type {any[]} */ const decoded = [];
    await withProxy("photo-many.pdf", async (/** @type {any} */ { unpdf, proxy }) => {
      const spy = {
        ...unpdf,
        extractImages: (/** @type {any} */ target, /** @type {any} */ page) => {
          decoded.push(page);
          return unpdf.extractImages(target, page);
        },
      };
      const result = await extractPdfImages({ unpdf: spy, sharp, proxy, limits: { maxImages: 3 } });
      assert.equal(result.images.length, 3);
      assert.equal(result.qualifying, 4);
      assert.equal(result.countComplete, false);
      assert.equal(result.pagesScanned, 1);
    });
    assert.deepEqual(decoded, [1]);
  });

  test("scan-pages.pdf registers no picture for its 3 scan pages and still extracts the photo on the text page", async () => {
    const result = await runPdfImagesJob(new Uint8Array(pdfSample("scan-pages.pdf")));
    assert.deepEqual(
      result.images.map(({ page, width, height }) => ({ page, width, height })),
      [{ page: 4, width: 240, height: 160 }],
    );
    assert.equal(result.skipped.pageScan, 3);
    assert.equal(result.skipped.flat, 0, "scans are counted as scans, not as decoration");
    assert.equal(result.qualifying, 1);
    assert.equal(result.countComplete, true);
    assert.equal(result.pagesScanned, 4);
  });

  test("a scan page is a page the text parser calls low-text, so both mean the same", () => {
    assert.equal(PDF_IMAGE_LIMITS.scanMaxChars, LOW_TEXT_CHARS);
    assert.equal(PDF_IMAGE_LIMITS.scanCoverage, 0.85);
  });

  test("photo-in.pdf and photo-many.pdf count no decoration", async () => {
    for (const name of ["photo-in.pdf", "photo-many.pdf"]) {
      const { skipped } = await runPdfImagesJob(new Uint8Array(pdfSample(name)));
      assert.deepEqual([skipped.pageScan, skipped.strip, skipped.faint, skipped.flat], [0, 0, 0, 0], name);
    }
  });

  test("a text-only PDF has no images and is not an error", async () => {
    const result = await runPdfImagesJob(new Uint8Array(pdfSample("text.pdf")));
    assert.deepEqual(result.images, []);
    assert.equal(result.qualifying, 0);
  });

  test("a photograph that makes a heavy PNG is re-encoded as a decodable JPEG", async () => {
    await withProxy("photo-in.pdf", async (/** @type {any} */ { unpdf, proxy }) => {
      const result = await extractPdfImages({
        unpdf,
        sharp,
        proxy,
        limits: { pngPreferredBytes: 1000 },
      });
      assert.deepEqual(
        result.images.map((image) => image.format),
        ["jpeg", "jpeg"],
      );
      for (const image of realSharp ? result.images : []) {
        const metadata = await sharp(image.bytes).metadata();
        assert.equal(metadata.format, "jpeg");
        assert.equal(metadata.width, image.width);
      }
    });
  });

  test("pictures longer than the edge cap are shrunk and report their stored size", async () => {
    await withProxy("photo-in.pdf", async (/** @type {any} */ { unpdf, proxy }) => {
      const result = await extractPdfImages({ unpdf, sharp, proxy, limits: { maxEdge: 100 } });
      assert.deepEqual(
        result.images.map(({ width, height }) => [width, height]),
        [
          [100, 67],
          [80, 100],
        ],
      );
      for (const image of realSharp ? result.images : []) {
        const metadata = await sharp(image.bytes).metadata();
        assert.deepEqual([metadata.width, metadata.height], [image.width, image.height]);
      }
    });
    assert.equal(PDF_IMAGE_LIMITS.maxEdge, 2560);
  });

  test("an image that stays over the per-image byte cap is skipped and counted", async () => {
    await withProxy("photo-in.pdf", async (/** @type {any} */ { unpdf, proxy }) => {
      const result = await extractPdfImages({
        unpdf,
        sharp,
        proxy,
        limits: { pngPreferredBytes: 1000, maxImageBytes: 2000 },
      });
      assert.deepEqual(result.images, []);
      assert.equal(result.skipped.tooLarge, 2);
      assert.equal(result.qualifying, 2);
    });
  });

  test("the total encoded-byte cap stops further images", async () => {
    await withProxy("photo-in.pdf", async (/** @type {any} */ { unpdf, proxy }) => {
      const first = await extractPdfImages({ unpdf, sharp, proxy });
      const cap = first.images[0].bytes.length + 10;
      const result = await extractPdfImages({
        unpdf,
        sharp,
        proxy,
        limits: { maxTotalBytes: cap },
      });
      assert.equal(result.images.length, 1);
      assert.equal(result.skipped.tooLarge, 1);
    });
  });

  test("an exhausted wall-clock budget returns what was found and says it timed out", async () => {
    await withProxy("photo-in.pdf", async (/** @type {any} */ { unpdf, proxy }) => {
      let calls = 0;
      const now = () => (calls++ === 0 ? 0 : PDF_IMAGE_LIMITS.budgetMs + 1_000);
      const result = await extractPdfImages({ unpdf, sharp, proxy, now });
      assert.equal(result.timedOut, true);
      assert.equal(result.countComplete, false);
      assert.equal(result.pagesScanned, 0);
    });
  });

  test("the page cap stops the scan and the count is flagged incomplete", async () => {
    await withProxy("photo-in.pdf", async (/** @type {any} */ { unpdf, proxy }) => {
      const result = await extractPdfImages({ unpdf, sharp, proxy, limits: { maxPages: 1 } });
      assert.equal(result.pagesScanned, 1);
      assert.equal(result.images.length, 1);
      assert.equal(result.countComplete, false);
    });
  });

  describe("with a described document", () => {
    const OPS = { save: 10, restore: 11, transform: 12, paintImageXObject: 13 };

    /** A photograph-like bitmap: per-pixel noise seeded by `seed`. */
    /**
     * @typedef {{key?: string, width?: number, height?: number, channels?: number,
     *   seed?: number, pixel?: (index: number) => number, coverage?: number}} RawSpec
     */
    /** @param {RawSpec} spec */
    function raw({ key, width = 128, height = 96, channels = 3, seed = 0, pixel }) {
      const data = new Uint8ClampedArray(width * height * channels);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = pixel ? pixel(i) : ((i * 2654435761 + seed * 40503) >>> 7) & 255;
      }
      return { key, width, height, channels, data };
    }

    /**
     * @param {{chars?: number, images: RawSpec[]}[]} pages
     */
    function describedDocument(pages) {
      /** @type {any[]} */ const decoded = [];
      /** @type {any[]} */ const released = [];
      /** @type {any[]} */ const documentCleanups = [];
      const unpdf = {
        getResolvedPDFJS: async () => ({ OPS }),
        extractImages: async (/** @type {any} */ _proxy, /** @type {any} */ pageNumber) => {
          decoded.push(pageNumber);
          return pages[pageNumber - 1].images.map(({ coverage: _coverage, ...image }) => raw(image));
        },
      };
      const proxy = {
        numPages: pages.length,
        cleanup: async () => {
          documentCleanups.push(released.length);
        },
        getPage: async (/** @type {any} */ pageNumber) => {
          const { chars = 400, images } = pages[pageNumber - 1];
          return {
            cleanup: () => released.push(pageNumber),
            getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] }),
            getOperatorList: async () => {
              const fnArray = [];
              const argsArray = [];
              for (const image of images) {
                const side = Math.sqrt(image.coverage ?? 0.1) * 100;
                fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore);
                argsArray.push([], [side, 0, 0, side, 0, 0], [image.key], []);
              }
              return { fnArray, argsArray };
            },
            getTextContent: async () => ({ items: [{ str: "字".repeat(chars) }] }),
          };
        },
      };
      return { unpdf, proxy, decoded, released, documentCleanups };
    }

    const extract = (/** @type {any} */ document, /** @type {any} */ limits = undefined) =>
      extractPdfImages({ unpdf: document.unpdf, sharp, proxy: document.proxy, limits });

    test("a picture over 85% of a page with fewer than 20 characters is a page scan", async () => {
      const document = describedDocument([
        { chars: 0, images: [{ key: "a", seed: 1, coverage: 1 }] },
        { chars: 19, images: [{ key: "b", seed: 2, coverage: 0.86 }] },
        { chars: 20, images: [{ key: "c", seed: 3, coverage: 0.95 }] },
        { chars: 5, images: [{ key: "d", seed: 4, coverage: 0.84 }] },
      ]);
      const result = await extract(document);
      assert.equal(result.skipped.pageScan, 2);
      assert.deepEqual(
        result.images.map(({ page }) => page),
        [3, 4],
      );
      assert.equal(result.qualifying, 2);
    });

    test("decoration is counted by reason, before the picture is encoded, and never qualifies", async () => {
      const document = describedDocument([
        {
          images: [
            { key: "strip", seed: 1, width: 900, height: 100 },
            { key: "faint", seed: 2, channels: 4, pixel: (/** @type {any} */ i) => (i % 4 === 3 ? 1 : 200) },
            { key: "flat", seed: 3, channels: 4, pixel: (/** @type {any} */ i) => (i % 4 === 3 ? 100 : 180) },
            { key: "photo", seed: 4 },
          ],
        },
      ]);
      const result = await extract(document);
      assert.deepEqual([result.skipped.strip, result.skipped.faint, result.skipped.flat], [1, 1, 1]);
      assert.equal(result.images.length, 1);
      assert.equal(result.qualifying, 1);
    });

    test("a picture repeated on every page is kept once and does not use up the limit", async () => {
      const logo = { seed: 99, width: 96, height: 96 };
      const document = describedDocument([
        {
          images: [
            { key: "l1", ...logo },
            { key: "p1", seed: 1 },
          ],
        },
        {
          images: [
            { key: "l2", ...logo },
            { key: "p2", seed: 2 },
          ],
        },
        {
          images: [
            { key: "l3", ...logo },
            { key: "p3", seed: 3 },
          ],
        },
        {
          images: [
            { key: "l4", ...logo },
            { key: "p4", seed: 4 },
          ],
        },
        {
          images: [
            { key: "l5", ...logo },
            { key: "p5", seed: 5 },
          ],
        },
      ]);
      const result = await extract(document, { maxImages: 3 });
      assert.deepEqual(
        result.images.map(({ page, order }) => [page, order]),
        [
          [1, 1],
          [1, 2],
          [2, 1],
        ],
      );
      assert.equal(result.skipped.duplicate, 2, "the logo on pages 2 and 3");
      assert.equal(result.qualifying, 4, "logo, p1, p2 and the first picture past the limit, p3");
      assert.equal(result.countComplete, false);
      assert.deepEqual(document.decoded, [1, 2, 3]);
    });

    test("every finished page is released at once and the document caches are cleared every 10 pages", async () => {
      const document = describedDocument(
        Array.from({ length: 12 }, (_, index) => ({
          images: [{ key: `k${index}`, seed: index + 1 }],
        })),
      );
      await extract(document);
      assert.deepEqual(
        document.released,
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      assert.deepEqual(document.documentCleanups, [10]);
    });

    test("a document with 40 or fewer usable pictures is scanned to the end and counted complete", async () => {
      const document = describedDocument(
        Array.from({ length: 6 }, (_, index) => ({
          images: [{ key: `k${index}`, seed: index + 1 }],
        })),
      );
      const result = await extract(document, { maxImages: 6 });
      assert.equal(result.images.length, 6);
      assert.equal(result.countComplete, true);
      assert.equal(result.pagesScanned, 6);
    });
  });

  test("a damaged or encrypted PDF fails with a Chinese rejection, never a crash", async () => {
    await assert.rejects(
      runPdfImagesJob(new Uint8Array(pdfSample("garbage.pdf"))),
      (error) => error instanceof MaterialRejection && error.code === "corrupt",
    );
    await assert.rejects(
      runPdfImagesJob(new Uint8Array(pdfSample("secret.pdf"))),
      (error) => error instanceof MaterialRejection && error.code === "encrypted",
    );
  });

  test("without the optional image encoder the job degrades to a typed rejection", async (t) => {
    setOptionalNativeOverride("sharp", null);
    t.after(() => setOptionalNativeOverride("sharp", undefined));
    await assert.rejects(
      runJob(new Uint8Array(pdfSample("photo-in.pdf"))),
      (error) =>
        error instanceof MaterialRejection &&
        error.code === PDF_IMAGES_UNAVAILABLE_CODE &&
        /图片处理组件/.test(error.message),
    );
  });
});
