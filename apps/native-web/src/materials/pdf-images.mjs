/**
 * Embedded-image extraction for PDFs (`unpdf.extractImages` + sharp encode).
 *
 * Runs in its own child process (`pdf-images-child.mjs`), never inside the text
 * parse: pdf.js only decodes images when `maxImageSize` allows it (the text/style
 * parse opens the document with `maxImageSize: 1`), and every image of a page is
 * decoded at once, so native memory can reach several hundred MB on a photo-heavy
 * page; that must not grow the sidecar. Everything here is bounded:
 * a minimum edge (icons and rules are not material), a per-image and a total
 * encoded-byte cap, a pixel cap that pdf.js enforces while decoding, a page
 * cap and a wall-clock budget that ends the scan early instead of timing out. The scan also
 * ends as soon as one more distinct usable picture shows there are more than it keeps.
 */
import crypto from "node:crypto";
import { loadOptionalNative, optionalNativeAvailable } from "../optional-native.mjs";
import { decorationReason } from "./pdf-image-decoration.mjs";
import { operatorNames, pageImageFacts } from "./pdf-image-scan.mjs";
import { MaterialRejection } from "./zip-guard.mjs";

const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";
const ENCRYPT_REF = /\/Encrypt\s+\d+\s+\d+\s+R/;
/** Typed degradation when the optional image encoder is not installed. */
export const PDF_IMAGES_UNAVAILABLE_CODE = "images-unavailable";
const UNAVAILABLE_MESSAGE = "当前环境未安装图片处理组件，PDF 内嵌图片未提取；文字内容仍可使用";

export const PDF_IMAGE_LIMITS = Object.freeze({
  /** Both edges must reach this many pixels. */
  minEdge: 64,
  maxImages: 40,
  maxPages: 120,
  /** pdf.js skips decoding anything larger; also bounds the sharp raw input. */
  maxPixels: 16_000_000,
  /** Longer edge kept; slides never need more, and it bounds parse time and storage. */
  maxEdge: 2560,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
  /** A PNG above this is re-encoded as JPEG when the picture has no alpha. */
  pngPreferredBytes: 1.5 * 1024 * 1024,
  budgetMs: 8_000,
  /** A picture painted over at least this share of its page ... */
  scanCoverage: 0.85,
  /** ... on a page with fewer characters than this is a scan of the page. The text parser's
   * low-text bar (`LOW_TEXT_CHARS`), kept here so the child does not load the parser. */
  scanMaxChars: 20,
  /** Pages between two clearings of the document-wide caches (fonts, shared images). */
  fullCleanupEvery: 10,
});

/** @typedef {{[K in keyof typeof PDF_IMAGE_LIMITS]: number}} PdfImageLimits */

/**
 * @typedef {{page: number, order: number, width: number, height: number,
 *   format: "png"|"jpeg", bytes: Buffer}} PdfImage
 * @typedef {{small: number, tooLarge: number, duplicate: number, unreadable: number,
 *   pageScan: number, strip: number, faint: number, flat: number}} PdfImageSkips
 * @typedef {{images: PdfImage[], qualifying: number, countComplete: boolean,
 *   pagesScanned: number, pageCount: number, skipped: PdfImageSkips,
 *   timedOut: boolean}} PdfImageExtraction
 * @typedef {{page: number, images: PdfImage[], qualifying: number, pagesScanned: number,
 *   skipped: PdfImageSkips}} PdfPageProgress
 */

/** @returns {PdfImageSkips} */
export const emptyPdfImageSkips = () => ({
  small: 0,
  tooLarge: 0,
  duplicate: 0,
  unreadable: 0,
  pageScan: 0,
  strip: 0,
  faint: 0,
  flat: 0,
});

/** Identical pixels hash alike whatever page or object they came from; hashing the decoded
 * bitmap lets a repeated logo skip its PNG encode.
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number, channels: number}} bitmap */
function bitmapDigest({ data, width, height, channels }) {
  return crypto.createHash("sha256").update(`${width}x${height}x${channels}:`).update(data).digest("hex");
}

/** True when the optional image encoder (`sharp`) can be loaded in this process. */
export function pdfImagesAvailable() {
  return optionalNativeAvailable("sharp");
}

/**
 * Encode one decoded pdf.js bitmap, shrunk to `maxEdge`. PNG keeps line art and
 * transparency exact; photographs that would make a heavy PNG go to JPEG instead. Level 3
 * takes about half the time of level 6 for roughly 7 % more bytes (measured on a 29-page
 * deck export), and the encode sits on the upload's critical path.
 * @param {(input: Buffer, options?: object) => any} sharp
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number, channels: number}} image
 * @param {PdfImageLimits} limits
 * @returns {Promise<{format: "png"|"jpeg", bytes: Buffer, width: number, height: number}|undefined>}
 */
async function encodeBitmap(sharp, image, limits) {
  const input = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const raw = { width: image.width, height: image.height, channels: image.channels };
  const open = () => {
    const pipeline = sharp(input, { raw, limitInputPixels: limits.maxPixels });
    return Math.max(image.width, image.height) > limits.maxEdge
      ? pipeline.resize(limits.maxEdge, limits.maxEdge, { fit: "inside" })
      : pipeline;
  };
  const hasAlpha = image.channels === 4;
  const png = await open().png({ compressionLevel: 3 }).toBuffer({ resolveWithObject: true });
  const size = { width: png.info.width, height: png.info.height };
  if (png.data.length <= limits.pngPreferredBytes || (hasAlpha && png.data.length <= limits.maxImageBytes)) {
    return { format: "png", bytes: png.data, ...size };
  }
  const jpeg = await open()
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer();
  if (jpeg.length <= limits.maxImageBytes) return { format: "jpeg", bytes: jpeg, ...size };
  return undefined;
}

/**
 * @typedef {{images: PdfImage[], seen: Set<string>, skipped: PdfImageSkips,
 *   qualifying: number, totalBytes: number, enough: boolean}} ScanState
 * @typedef {{data: Uint8ClampedArray|Uint8Array, width: number, height: number,
 *   channels: number, key?: string}} DecodedBitmap
 */

/**
 * Why a decoded bitmap is not material, or its pixel digest when it qualifies.
 * @param {DecodedBitmap} bitmap
 * @param {Awaited<ReturnType<typeof pageImageFacts>>} facts
 * @param {PdfImageLimits} limits @param {Set<string>} seen
 * @returns {Promise<{skip: keyof PdfImageSkips}|{digest: string}>}
 */
async function screenBitmap(bitmap, facts, limits, seen) {
  if (bitmap.width < limits.minEdge || bitmap.height < limits.minEdge) return { skip: "small" };
  // A picture that fills a page with hardly any text is the scan of that page, which
  // the page render already shows; it is not material to place on a slide.
  if (facts.coverage(bitmap.key) >= limits.scanCoverage && (await facts.textLength()) < limits.scanMaxChars) {
    return { skip: "pageScan" };
  }
  const decoration = decorationReason(bitmap);
  if (decoration) return { skip: decoration };
  const digest = bitmapDigest(bitmap);
  return seen.has(digest) ? { skip: "duplicate" } : { digest };
}

/**
 * Encode one qualifying bitmap within the per-image and total byte caps.
 * @param {(input: Buffer, options?: object) => any} sharp @param {DecodedBitmap} bitmap
 * @param {PdfImageLimits} limits @param {ScanState} state
 */
async function encodeWithinCaps(sharp, bitmap, limits, state) {
  let encoded;
  try {
    encoded = await encodeBitmap(sharp, bitmap, limits);
  } catch {
    state.skipped.unreadable += 1;
    return undefined;
  }
  if (!encoded || state.totalBytes + encoded.bytes.length > limits.maxTotalBytes) {
    state.skipped.tooLarge += 1;
    return undefined;
  }
  return encoded;
}

/**
 * Decode, screen and keep the pictures of one page.
 * @param {{unpdf: typeof import("unpdf"), sharp: (input: Buffer, options?: object) => any,
 *   proxy: object, page: number, names: Map<number, string>,
 *   limits: PdfImageLimits, state: ScanState}} input
 */
async function scanPage({ unpdf, sharp, proxy, page, names, limits, state }) {
  const facts = await pageImageFacts({ proxy, pageNumber: page, names });
  /** @type {Awaited<ReturnType<typeof unpdf.extractImages>>} */
  let found = [];
  try {
    found = await unpdf.extractImages(/** @type {any} */ (proxy), page);
  } catch {
    state.skipped.unreadable += 1;
  }
  let order = 0;
  for (const bitmap of found) {
    const verdict = await screenBitmap(bitmap, facts, limits, state.seen);
    if ("skip" in verdict) {
      state.skipped[verdict.skip] += 1;
      continue;
    }
    state.qualifying += 1;
    if (state.images.length >= limits.maxImages) {
      // The next distinct usable picture past the limit settles that the document has
      // more than it keeps; counting the rest would decode every remaining page for a number.
      state.enough = true;
      break;
    }
    const encoded = await encodeWithinCaps(sharp, bitmap, limits, state);
    if (!encoded) continue;
    state.seen.add(verdict.digest);
    state.totalBytes += encoded.bytes.length;
    order += 1;
    state.images.push({ page, order, ...encoded });
  }
  // Decoded bitmaps of finished pages must not pile up across a long document. Clearing
  // only the page keeps the parsed fonts for the next one.
  facts.release();
}

/** @param {{cleanup?: () => Promise<void>}} proxy */
async function clearDocumentCaches(proxy) {
  try {
    await proxy.cleanup?.();
  } catch {
    // Whatever cannot be cleaned up is released when the document closes.
  }
}

/**
 * `onPage` receives the pictures kept from each finished page together with the running
 * counters, so a caller that is stopped early still holds everything found so far.
 * @param {{unpdf: typeof import("unpdf"), sharp: (input: Buffer, options?: object) => any,
 *   proxy: {numPages: number, cleanup?: () => Promise<void>},
 *   limits?: Partial<PdfImageLimits>, now?: () => number,
 *   onPage?: (progress: PdfPageProgress) => void|Promise<void>}} input
 * @returns {Promise<PdfImageExtraction>}
 */
export async function extractPdfImages({ unpdf, sharp, proxy, limits: override, now = Date.now, onPage }) {
  const limits = { ...PDF_IMAGE_LIMITS, ...override };
  const started = now();
  /** @type {ScanState} */
  const state = {
    images: [],
    seen: new Set(),
    skipped: emptyPdfImageSkips(),
    qualifying: 0,
    totalBytes: 0,
    enough: false,
  };
  const pageCount = proxy.numPages;
  const lastPage = Math.min(pageCount, limits.maxPages);
  const names = await operatorNames(unpdf);
  let pagesScanned = 0;
  let timedOut = false;

  for (let page = 1; page <= lastPage && !state.enough; page += 1) {
    if (now() - started > limits.budgetMs) {
      timedOut = true;
      break;
    }
    const keptBefore = state.images.length;
    await scanPage({ unpdf, sharp, proxy, page, names, limits, state });
    pagesScanned += 1;
    // The document-wide caches (fonts, shared images) are cleared now and then.
    if (page % limits.fullCleanupEvery === 0) await clearDocumentCaches(proxy);
    await onPage?.({
      page,
      images: state.images.slice(keptBefore),
      qualifying: state.qualifying,
      pagesScanned,
      skipped: { ...state.skipped },
    });
  }
  const countComplete = !timedOut && !state.enough && pageCount <= lastPage;
  const { images, qualifying, skipped } = state;
  return { images, qualifying, countComplete, pagesScanned, pageCount, skipped, timedOut };
}

/**
 * Open the PDF with image decoding enabled (pixel-capped) and extract. Encrypted
 * or unreadable files fail like the text parser does.
 * Without the optional image encoder the job fails with the typed
 * `images-unavailable` code (never a crash); `sharp` may be injected by tests.
 * @param {Uint8Array} bytes
 * @param {{onPage?: (progress: PdfPageProgress) => void|Promise<void>,
 *   sharp?: ((input: Buffer, options?: object) => any)|null}} [hooks]
 * @returns {Promise<PdfImageExtraction>}
 */
export async function runPdfImagesJob(bytes, { onPage, sharp: injected } = {}) {
  if (ENCRYPT_REF.test(Buffer.from(bytes).toString("latin1"))) {
    throw new MaterialRejection("encrypted", "文件已加密（设有打开密码），无法读取；请取消密码后再上传");
  }
  const sharp = injected ?? (await loadOptionalNative("sharp"));
  if (!sharp) throw new MaterialRejection(PDF_IMAGES_UNAVAILABLE_CODE, UNAVAILABLE_MESSAGE);
  let unpdf;
  let proxy;
  try {
    unpdf = await import("unpdf");
    // Passed through a variable so the unpdf option type does not reject isEvalSupported.
    const documentOptions = { isEvalSupported: false, maxImageSize: PDF_IMAGE_LIMITS.maxPixels };
    proxy = await unpdf.getDocumentProxy(new Uint8Array(bytes), documentOptions);
  } catch {
    throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
  }
  try {
    return await extractPdfImages({ unpdf, sharp, proxy, onPage });
  } finally {
    await /** @type {{loadingTask?: {destroy?: () => Promise<void>}}} */ (proxy).loadingTask?.destroy?.();
  }
}
