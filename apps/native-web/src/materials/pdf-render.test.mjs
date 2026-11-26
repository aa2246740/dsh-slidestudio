import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as unpdf from "unpdf";
import {
  PDF_RENDER_CONFIG,
  PdfRenderQueue,
  combinePixelProfiles,
  mergePdfPixelStyle,
  probePdfRenderChild,
  renderedPageIndexes,
  runPdfRenderChild,
} from "./pdf-render.mjs";
import { deltaE2000 } from "./image-style.mjs";
import { pdfParser } from "./parsers/pdf.mjs";
import { pdfSample } from "./pdf-fixture-samples.mjs";
import { extractPdfPageImageCoverage, MAX_PDF_STYLE_PAGES, PDF_DOCUMENT_OPTIONS } from "./pdf-style-hints.mjs";
import { mergePdfPageImages, pdfWording } from "./pdf-wording.mjs";

const STUB = fileURLToPath(new URL("./test-fixtures/pdf-images-stub-child.mjs", import.meta.url));
/** Real page rendering needs the optional canvas and encoder add-ons. */
const canvasAvailable = await probePdfRenderChild();
const NO_CANVAS = canvasAvailable ? false : "@napi-rs/canvas or sharp is not installed";

/** @param {string} name @param {Buffer} bytes */
function tempPdf(name, bytes) {
  const file = path.join(os.tmpdir(), `oss-pdf-${name}-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(file, bytes);
  return file;
}

test("PDF render limits are centralized and keep the render width bounded", () => {
  assert.deepEqual(PDF_RENDER_CONFIG, {
    childProcess: true,
    concurrency: 1,
    queueCap: 8,
    sampledRssCapMb: 1024,
    pageTimeoutMs: 30_000,
    documentTimeoutMs: 180_000,
    maxPages: 40,
    width: 960,
  });
  assert.deepEqual(
    renderedPageIndexes(42),
    Array.from({ length: 40 }, (_, index) => index + 1),
  );
  assert.deepEqual(renderedPageIndexes(2), [1, 2]);
  assert.deepEqual(renderedPageIndexes(0), []);
});

test("render queue serializes work and caps all outstanding documents at eight", async () => {
  const queue = new PdfRenderQueue({ probe: async () => true });
  let inFlight = 0;
  let maxInFlight = 0;
  /** @type {(() => void)[]} */
  const releases = [];
  for (let index = 0; index < PDF_RENDER_CONFIG.queueCap; index += 1) {
    /** @type {Promise<void>} */
    const gate = new Promise((resolve) => releases.push(() => resolve()));
    assert.equal(
      queue.enqueue({
        id: `job-${index}`,
        run: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gate;
          inFlight -= 1;
        },
      }),
      true,
    );
  }
  assert.equal(queue.enqueue({ id: "overflow", run: async () => {} }), false);
  await queue.ready();
  releases.forEach((release) => release());
  await queue.drain();
  assert.equal(maxInFlight, 1);
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.pending.length, 0);
});

test("without the optional canvas the real render child fails closed with canvas-unavailable", async (t) => {
  if (canvasAvailable) return t.skip("the canvas is installed here; the render path runs below");
  const file = tempPdf("no-canvas", pdfSample("text.pdf"));
  try {
    await assert.rejects(runPdfRenderChild({ filePath: file, pageCount: 2 }), (error) => {
      const failure = /** @type {{code: string, message: string}} */ (error);
      assert.equal(failure.code, "canvas-unavailable");
      assert.match(failure.message, /PDF 文字仍可读取/);
      return true;
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("each page renders in its own child and the parent keeps verified page bytes", async () => {
  const file = tempPdf("stub", pdfSample("text.pdf"));
  try {
    const result = await runPdfRenderChild({
      filePath: file,
      pageCount: 3,
      overrides: { childPath: STUB },
    });
    assert.deepEqual(
      result.renderedPages.map((page) => [page.index, page.file]),
      [
        [1, "page-1.jpg"],
        [2, "page-2.jpg"],
        [3, "page-3.jpg"],
      ],
    );
    for (const page of result.renderedPages) {
      const bytes = Buffer.from(page.data ?? "", "base64");
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
    }
    assert.deepEqual(
      result.pageImages.map((page) => page.hasImage),
      [true, false, false],
    );
    assert.equal(result.pixelStyleProfile, undefined, "the stub reports no pixel palette");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test(
  "render child produces deterministic page JPEG bytes within the configured width",
  { skip: NO_CANVAS, timeout: 30_000 },
  async () => {
    const file = tempPdf("render", pdfSample("text.pdf"));
    try {
      const first = await runPdfRenderChild({ filePath: file, pageCount: 2 });
      const second = await runPdfRenderChild({ filePath: file, pageCount: 2 });
      assert.equal(first.renderedPages.length, 2);
      assert.ok(first.renderedPages.every((page) => page.px.width <= PDF_RENDER_CONFIG.width));
      assert.deepEqual(
        first.renderedPages.map((page) => page.sha256),
        second.renderedPages.map((page) => page.sha256),
      );
      assert.ok(first.renderedPages.every((page) => page.file.endsWith(".jpg")));
    } finally {
      fs.rmSync(file, { force: true });
    }
  },
);

test(
  "page-pixel palette retains vector colours and detects the raster #B40606 banner",
  { skip: NO_CANVAS, timeout: 30_000 },
  async () => {
    const bytes = pdfSample("styled-report.pdf");
    const parsed = /** @type {any} */ (await pdfParser.parse({ name: "styled-report.pdf", bytes }));
    const file = tempPdf("style", bytes);
    try {
      const result = await runPdfRenderChild({ filePath: file, pageCount: 1 });
      const merged = /** @type {any} */ (mergePdfPixelStyle(parsed.payload.styleProfile, result.pixelStyleProfile));
      assert.equal(merged.source, "pdf-vector-ops");
      assert.ok(merged.accentColors.some((/** @type {any} */ color) => color.hex === "#C00000"));
      assert.equal(merged.pagePixels.source, "pdf-page-pixels");
      assert.ok(
        merged.pagePixels.accentColors.some(
          (/** @type {{hex: string}} */ color) => deltaE2000(color.hex, "#B40606") <= 5,
        ),
        JSON.stringify(merged.pagePixels.accentColors),
      );
    } finally {
      fs.rmSync(file, { force: true });
    }
  },
);

/** One rendered page's pixel palette, as the render child reports it. @param {string} hex */
const pixelPage = (hex) => ({
  profile: {
    schema: "style-profile/v1",
    source: "pdf-page-pixels",
    pagesScanned: 1,
    accentColors: [{ hex, share: 1 }],
    neutralColors: [{ hex: "#FFFFFF" }],
    background: "#FFFFFF",
  },
  pixels: 1000,
});

test("page-pixel statistics cover only the published 30-page style window", () => {
  const combined = combinePixelProfiles(Array.from({ length: 35 }, () => pixelPage("#B40606")));
  assert.equal(combined?.pagesScanned, MAX_PDF_STYLE_PAGES);
  assert.equal(combinePixelProfiles([]), undefined);
});

test("a PDF without vector style hints publishes a pixel-only profile the schema accepts", () => {
  const pixels = combinePixelProfiles([pixelPage("#B40606"), pixelPage("#B40606")]);
  const merged = /** @type {Record<string, any>} */ (mergePdfPixelStyle(undefined, pixels));
  assert.equal(merged.source, "pdf-page-pixels");
  assert.equal(merged.pagesScanned, 2, "pagesScanned counts the pixel pages measured");
  assert.ok(merged.pagesScanned >= 1 && merged.pagesScanned <= MAX_PDF_STYLE_PAGES);
  assert.deepEqual(merged.pagePixels, pixels);
});

test("canvas probe failure rejects queued renders with a fail-closed result", async () => {
  const queue = new PdfRenderQueue({ probe: async () => false });
  /** @type {{code?: string}|undefined} */
  let failure;
  assert.equal(
    queue.enqueue({
      id: "unavailable",
      run: async () => assert.fail("render must not run without canvas"),
      fail: (error) => (failure = error),
    }),
    true,
  );
  await queue.drain();
  assert.equal(queue.available, false);
  assert.equal(failure?.code, "canvas-unavailable");
});

/**
 * Parse a sample, then measure its page image coverage exactly as the render
 * child does (operator-list geometry, no canvas needed) and apply the
 * measurements the way the render store does.
 * @param {string} name
 */
async function measuredWording(name) {
  const bytes = pdfSample(name);
  const parsed = /** @type {any} */ (await pdfParser.parse({ name, bytes }));
  // Images must decode, as in the render child: PDF_DOCUMENT_OPTIONS drops them.
  const options = { ...PDF_DOCUMENT_OPTIONS, maxImageSize: -1 };
  const proxy = await unpdf.getDocumentProxy(new Uint8Array(bytes), options);
  try {
    const pageNumbers = renderedPageIndexes(parsed.payload.pageCount);
    const coverage = await extractPdfPageImageCoverage({ unpdf, proxy, pageNumbers });
    const pageImages = [...coverage].map(([index, value]) => ({
      index,
      hasImage: value >= 0.5,
      imageCoverage: Math.round(value * 1e6) / 1e6,
    }));
    const pages = mergePdfPageImages(parsed.payload.pages, pageImages);
    const wording = pdfWording({
      parserId: pdfParser.id,
      pageCount: parsed.payload.pageCount,
      chars: parsed.payload.chars,
      pages,
      extractedPages: parsed.payload.pages.length,
    });
    return { pages, ...wording };
  } finally {
    await proxy.loadingTask.destroy();
  }
}

test(
  "measured image coverage upgrades low-text wording only where an image covers the page",
  { timeout: 60_000 },
  async () => {
    const mixed = await measuredWording("mixed-scan.pdf");
    assert.deepEqual(
      mixed.pages.map((page) => page.hasImage),
      [false, true, true, false],
    );
    assert.match(mixed.summary.zh, /第 2、3 页主要是图片，未识别文字（不做 OCR）$/);
    assert.equal(mixed.warnings[0].message, "第 2、3 页主要是图片，未识别文字（不做 OCR），这几页的内容 Agent 读不到");

    const scanOnly = await measuredWording("scan-only.pdf");
    assert.ok(scanOnly.pages.every((page) => page.hasImage === true));
    assert.match(scanOnly.summary.zh, /第 1、2、3 页主要是图片，未识别文字（不做 OCR）$/);
    assert.doesNotMatch(scanOnly.summary.zh, /扫描图片|几乎没有/);

    const blank = await measuredWording("blank-page.pdf");
    assert.equal(blank.pages[0].hasImage, false);
    assert.match(blank.summary.zh, /第 1 页几乎没有文字$/);
    assert.equal(blank.warnings[0].message, "第 1 页几乎没有文字，这几页的内容 Agent 读不到");
    assert.doesNotMatch(blank.warnings[0].message, /主要是图片|可能是整页图片/);

    const styled = await measuredWording("styled-report.pdf");
    const banner = styled.pages[0];
    assert.equal(banner?.hasImage, false, "a 420×110 banner covers well under half the page");
    assert.ok(banner && (banner.imageCoverage ?? 0) > 0 && (banner.imageCoverage ?? 1) < 0.5);
    assert.equal(styled.warnings.length, 0);
  },
);

test("pages without a page-image measurement keep neutral wording", () => {
  const pages = [
    { index: 1, lowText: true, text: "" },
    { index: 2, lowText: true, text: "" },
    { index: 3, lowText: false, text: "正文" },
  ];
  const merged = mergePdfPageImages(pages, [{ index: 1, hasImage: true, imageCoverage: 0.8 }]);
  assert.equal(merged[0].hasImage, true);
  assert.equal(merged[1].hasImage, undefined, "page 2 was not measured");
  assert.equal(merged[2].hasImage, undefined);
  const wording = pdfWording({
    parserId: pdfParser.id,
    pageCount: 3,
    chars: 2,
    pages: merged,
    extractedPages: 3,
  });
  assert.match(wording.summary.zh, /第 2 页几乎没有文字（可能是整页图片），未识别（不做 OCR）$/);
  assert.equal(
    wording.warnings[0].message,
    "第 1 页主要是图片，未识别文字（不做 OCR）；第 2 页几乎没有可提取的文字，可能是整页图片或扫描件；当前版本不做文字识别（OCR），这几页的内容 Agent 读不到",
  );
});
