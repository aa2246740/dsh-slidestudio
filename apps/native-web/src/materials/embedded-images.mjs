/**
 * Pictures embedded in a DOCX or PDF become image materials of their own
 * (`image-sharp-v1` records stamped with `image.origin`, a Chinese origin
 * note and their own style profile), so the host places, views, plans and
 * exports them exactly like uploaded images. The document derivative lists
 * them under `document.embeddedImages` with their ids.
 *
 * Every candidate is size-limited and decoded completely before it is
 * accepted. Nothing here may fail the document: an extraction problem is a
 * warning on a document that stays `parsed`.
 */
import fs from "node:fs";
import path from "node:path";
import { PARSER_IDS } from "./derivative.mjs";
import { gatherDocxImages } from "./docx-images.mjs";
import { openRegistration } from "./embedded-register.mjs";
import { startPdfImages } from "./pdf-images-start.mjs";
import { embeddedWarnings } from "./embedded-warnings.mjs";
import { loadSharp } from "./optional-decoder.mjs";

/** Where a picture sits: a PDF page, a DOCX body paragraph, or a DOCX table cell (table, row
 * and column, all 1-based; the table is numbered in document order).
 * @typedef {{paragraph?: number, page?: number, table?: number, row?: number, column?: number}} EmbeddedPosition */
/**
 * @typedef {{id: string, name: string, size: number, kind: "image", status: "parsed",
 *   parser: string, summary: {zh: string}, warnings: {code: string, message: string}[],
 *   needsVision: boolean, origin: "docx"|"pdf", note: string,
 *   position: EmbeddedPosition, width?: number, height?: number,
 *   sha256: string}} EmbeddedImageEntry
 * @typedef {{version: number, origin: "docx"|"pdf", found: number, countComplete: boolean,
 *   kept: number, limit: number, skipped: Record<string, number>, failed?: boolean,
 *   unavailable?: boolean, timingsMs?: {gather: number, register: number},
 *   images: EmbeddedImageEntry[]}} EmbeddedImagesSection
 */

/** Bump together with any change of the stored `document.embeddedImages` shape, or of which
 * pictures a document keeps (a record stored under older rules is parsed once more).
 * 3: DOCX pictures inside table cells are kept, with their table position.
 * 4: DOCX content inside content controls and customXml (rows, cells and blocks) is read: its
 *    pictures are kept and its text joins the document, and a row's gridBefore columns count
 *    toward the column of its pictures. */
export const EMBEDDED_IMAGES_VERSION = 4;
const EMBEDDED_IMAGE_LIMIT = 40;
/** Registering children is bounded so a picture-heavy file cannot stall the upload. */
const EMBEDDED_REGISTER_BUDGET_MS = 25_000;
const EMBEDDED_MAX_PIXELS = 16_000_000;

/** sharp's default failOn: a picture with any decode warning is not accepted.
 * @param {Buffer} bytes */
async function decodesCompletely(bytes) {
  const sharp = await loadSharp();
  if (!sharp) return false;
  try {
    const decoded = await sharp(bytes, { limitInputPixels: EMBEDDED_MAX_PIXELS })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return decoded.info.width > 0 && decoded.info.height > 0 && decoded.data.length > 0;
  } catch {
    return false;
  }
}

/** @param {import("./derivative.mjs").Derivative} derivative */
export function hostsEmbeddedImages(derivative) {
  return (
    derivative.kind === "document" &&
    (derivative.parser?.id === PARSER_IDS.docx || derivative.parser?.id === PARSER_IDS.pdf)
  );
}

/** Older records have no section (or an older shape) and are parsed once more.
 * @param {import("../attachments.mjs").StoredDerivative} derivative */
export function embeddedImagesCurrent(derivative) {
  return !hostsEmbeddedImages(derivative) || derivative.document?.embeddedImages?.version === EMBEDDED_IMAGES_VERSION;
}

/**
 * The child records a stored parent lists: the pictures of a DOCX or PDF, or the
 * members of an image pack.
 * @param {import("../attachments.mjs").StoredDerivative} derivative
 * @returns {{id?: unknown}[]}
 */
function listedChildren(derivative) {
  const embedded = derivative.document?.embeddedImages?.images;
  if (Array.isArray(embedded)) return embedded;
  const members = derivative.image?.pack?.images;
  return derivative.parser?.id === PARSER_IDS.imagePack && Array.isArray(members) ? members : [];
}

/**
 * A listed child whose files are gone would make the parent hand out dead ids,
 * so such a parent is not reused.
 * @param {import("../attachments.mjs").AttachmentStore} store
 * @param {import("../attachments.mjs").StoredRecord} record
 */
export function listedChildrenIntact(store, record) {
  for (const child of listedChildren(record.derivative)) {
    try {
      const files = store.paths(String(child.id));
      if (![files.original, files.derivative, files.metadata].every((file) => fs.existsSync(file))) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * @typedef {import("./embedded-register.mjs").Candidate} Candidate
 * @typedef {{candidates: Candidate[], found: number, countComplete: boolean,
 *   skipped: Record<string, number>, timedOut?: boolean, stopped?: "memory"|"time",
 *   pagesScanned?: number}} Gathering
 */

/**
 * Read the pictures of a PDF. Those of each page are handed to `push` as soon as the
 * child has finished the page, so registration can start while later pages are still
 * being read; the gathering itself holds only what a runner did not stream.
 * @param {{extraction: ReturnType<typeof startPdfImages>, name: string,
 *   push: (candidates: Candidate[]) => void}} input
 * @returns {Promise<Gathering>}
 */
async function gatherPdf({ extraction, name, push }) {
  const stem = path.parse(name).name;
  /** @param {import("./pdf-images.mjs").PdfImage} image @returns {Candidate} */
  const candidateOf = (image) => ({
    name: `${stem}-p${image.page}-${image.order}.${image.format === "jpeg" ? "jpg" : "png"}`,
    bytes: Buffer.from(image.bytes),
    position: { page: image.page },
  });
  let streamed = 0;
  const unfollow = extraction.follow((images) => {
    streamed += images.length;
    push(images.map(candidateOf));
  });
  /** @type {import("./pdf-images-run.mjs").PdfImageRunResult} */
  let result;
  try {
    result = await extraction.result;
  } finally {
    unfollow();
  }
  return {
    candidates: result.images.slice(streamed).map(candidateOf),
    found: result.qualifying,
    countComplete: result.countComplete,
    skipped: { ...result.skipped },
    timedOut: result.timedOut,
    stopped: result.stopped,
    pagesScanned: result.pagesScanned,
  };
}

/**
 * @param {{bytes: Uint8Array, name: string,
 *   derivative: import("../attachments.mjs").StoredDerivative}} input
 * @returns {Gathering}
 */
function gatherDocx({ bytes, name, derivative }) {
  const gathered = gatherDocxImages({
    bytes,
    stem: path.parse(name).name,
    images: derivative.document?.images ?? [],
  });
  return {
    candidates: gathered.candidates,
    found: gathered.found,
    countComplete: true,
    skipped: { ...gathered.skipped },
  };
}

/**
 * Extract, verify and register the embedded pictures of one parsed document,
 * then record them on its derivative (section + warnings). Returns the ids of
 * the child records so the caller can discard them if the parent loses a
 * dedupe race.
 * PDF pictures need `pdfImages` (the child-process runner); without one the section
 * is recorded as unavailable and nothing is claimed about the file's pictures. `extraction`
 * is a run the caller already began, so the parse and the picture reading overlap.
 * @param {{store: import("../attachments.mjs").AttachmentStore,
 *   pool: import("./parse-pool.mjs").ParsePool,
 *   pdfImages?: import("./pdf-images-run.mjs").PdfImageRunner,
 *   extraction?: ReturnType<typeof startPdfImages>, name: string,
 *   bytes: Uint8Array, derivative: import("../attachments.mjs").StoredDerivative,
 *   now?: () => number}} input
 * @returns {Promise<{createdIds: string[]}>}
 */
export async function attachEmbeddedImages({
  store,
  pool,
  pdfImages,
  extraction,
  name,
  bytes,
  derivative,
  now = Date.now,
}) {
  const origin = derivative.parser?.id === PARSER_IDS.docx ? "docx" : "pdf";
  /** @type {Record<string, number>} */
  const skipped = {};
  /** @param {string} key @param {number} [count] */
  const bump = (key, count = 1) => {
    if (count > 0) skipped[key] = (skipped[key] ?? 0) + count;
  };
  if (origin === "pdf" && !pdfImages) {
    derivative.document = {
      ...derivative.document,
      embeddedImages: {
        version: EMBEDDED_IMAGES_VERSION,
        origin,
        found: 0,
        countComplete: false,
        kept: 0,
        limit: EMBEDDED_IMAGE_LIMIT,
        skipped: {},
        unavailable: true,
        images: [],
      },
    };
    return { createdIds: [] };
  }
  const registration = openRegistration({
    store,
    pool,
    parent: { materialId: derivative.materialId, name },
    origin,
    limit: EMBEDDED_IMAGE_LIMIT,
    budgetMs: EMBEDDED_REGISTER_BUDGET_MS,
    now,
    bump,
    verify: origin === "docx" ? decodesCompletely : undefined,
  });
  /** @type {Gathering} */
  let gathering;
  const gatherStarted = now();
  try {
    gathering =
      origin === "docx"
        ? gatherDocx({ bytes, name, derivative })
        : await gatherPdf({
            extraction: extraction ?? startPdfImages(/** @type {NonNullable<typeof pdfImages>} */ (pdfImages), bytes),
            name,
            push: registration.push,
          });
  } catch (error) {
    // Pictures registered while the pages were still being read do not outlive a failed
    // extraction: the document is left with none.
    registration.close();
    const partial = await registration.done.catch(() => ({
      createdIds: /** @type {string[]} */ ([]),
    }));
    for (const id of partial.createdIds) store.delete(id);
    const reason = error instanceof Error && error.message ? error.message : "提取失败";
    derivative.document = {
      ...derivative.document,
      embeddedImages: {
        version: EMBEDDED_IMAGES_VERSION,
        origin,
        found: 0,
        countComplete: false,
        kept: 0,
        limit: EMBEDDED_IMAGE_LIMIT,
        skipped: {},
        failed: true,
        images: [],
      },
    };
    derivative.warnings = [
      ...derivative.warnings,
      {
        code: "embedded-images-failed",
        message: `文档已识别，但里面的图片没有提取成功（${reason}）；文字内容仍可使用，需要图片请另存后单独上传`,
      },
    ];
    return { createdIds: [] };
  }
  for (const [key, count] of Object.entries(gathering.skipped)) bump(key, count);

  const gathered = now();
  registration.push(gathering.candidates);
  registration.close();
  const { images, createdIds } = await registration.done;

  /** @type {EmbeddedImagesSection} */
  const section = {
    version: EMBEDDED_IMAGES_VERSION,
    origin,
    found: gathering.found,
    countComplete: gathering.countComplete,
    kept: images.length,
    limit: EMBEDDED_IMAGE_LIMIT,
    skipped,
    timingsMs: { gather: gathered - gatherStarted, register: now() - gathered },
    images,
  };
  derivative.document = { ...derivative.document, embeddedImages: section };
  derivative.warnings = [
    ...derivative.warnings,
    ...embeddedWarnings({
      section,
      timedOut: gathering.timedOut === true,
      stopped: gathering.stopped,
      pagesScanned: gathering.pagesScanned,
    }),
  ];
  return { createdIds };
}
