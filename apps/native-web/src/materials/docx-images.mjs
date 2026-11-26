/**
 * Embedded-image candidates of a parsed DOCX. The parser already resolved
 * each picture through the document relationships; this reads the media
 * parts through the zip guard (declared-size checks first, inflate capped by
 * the declaration) under a per-image and a total byte cap.
 */
import path from "node:path";
import { readCentralDirectory, readZipEntry } from "./zip-guard.mjs";

const DOCX_IMAGE_LIMITS = Object.freeze({
  maxImages: 40,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
});

/**
 * @typedef {{paragraph: number}|{table: number, row: number, column: number}} DocxPosition
 * @typedef {{name: string, bytes: Buffer, position: DocxPosition}} DocxImageCandidate
 * @typedef {{candidates: DocxImageCandidate[], found: number, limitReached: boolean,
 *   skipped: {tooLarge: number, unreadable: number}}} DocxImageGathering
 */

/**
 * @param {{bytes: Uint8Array, stem: string,
 *   images: {part: string, paragraph?: number, table?: number, row?: number, column?: number}[],
 *   limits?: Partial<typeof DOCX_IMAGE_LIMITS>}} input
 * @returns {DocxImageGathering}
 */
export function gatherDocxImages({ bytes, stem, images, limits: override }) {
  const limits = { ...DOCX_IMAGE_LIMITS, ...override };
  const entries = new Map(readCentralDirectory(bytes).map((entry) => [entry.name, entry]));
  /** @type {DocxImageCandidate[]} */
  const candidates = [];
  const skipped = { tooLarge: 0, unreadable: 0 };
  let totalBytes = 0;
  for (const image of images) {
    if (candidates.length >= limits.maxImages) break;
    const entry = entries.get(image.part);
    if (!entry) {
      skipped.unreadable += 1;
      continue;
    }
    if (entry.uncompressedSize > limits.maxImageBytes || totalBytes + entry.uncompressedSize > limits.maxTotalBytes) {
      skipped.tooLarge += 1;
      continue;
    }
    let data;
    try {
      data = Buffer.from(readZipEntry(bytes, entry));
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    totalBytes += data.length;
    candidates.push({
      name: `${stem}-${path.posix.basename(image.part)}`,
      bytes: data,
      position: positionOf(image),
    });
  }
  return {
    candidates,
    found: images.length,
    limitReached: images.length > limits.maxImages,
    skipped,
  };
}

/**
 * Where a listed picture sits: its body paragraph, or its table cell.
 * @param {{paragraph?: number, table?: number, row?: number, column?: number}} image
 * @returns {DocxPosition}
 */
function positionOf(image) {
  if (image.table === undefined) return { paragraph: image.paragraph ?? 0 };
  return { table: image.table, row: image.row ?? 0, column: image.column ?? 0 };
}
