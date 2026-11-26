/**
 * The PDF page JPEGs of a document material: the store file naming shared
 * with the render queue, verification of the derivative's `renderedPages`
 * descriptor, and the project-side replacement that never leaves stale
 * pages behind. Extraction keeps `material-store.ts` at its module budget.
 */
import fs from "node:fs";
import path from "node:path";
import { inputSha256 } from "./material-input.js";

export type RenderedPageBytes = Readonly<{ index: number; bytes: Buffer }>;

/** Store file written by the PDF render queue: `<id>.page-<n>.jpg` beside the original. */
export function renderedPageStoreFile(attachmentsDir: string, id: string, index: number): string {
  return path.join(attachmentsDir, `${id}.page-${index}.jpg`);
}

/** A bounded, boundary-checked store read; throws a Chinese MaterialVerificationError. */
export type ReadStoreFile = (file: string) => Buffer;

/**
 * Page JPEGs listed by the derivative `renderedPages` descriptor. A page whose
 * file is missing or whose bytes no longer match the descriptor is omitted, so
 * `view_material {page}` reports it as unavailable instead of sending it.
 */
export function verifiedRenderedPages(
  attachmentsDir: string,
  id: string,
  derivative: Record<string, unknown>,
  readStoreFile: ReadStoreFile,
): readonly RenderedPageBytes[] {
  const document = derivative.document;
  const entries =
    document && typeof document === "object" && !Array.isArray(document)
      ? (document as Record<string, unknown>).renderedPages
      : undefined;
  if (!Array.isArray(entries)) return [];
  const pages: RenderedPageBytes[] = [];
  for (const raw of entries) {
    const entry = raw as Record<string, unknown> | null;
    const index = entry?.index;
    if (
      !Number.isSafeInteger(index) ||
      typeof index !== "number" ||
      entry?.file !== `page-${index}.jpg` ||
      typeof entry.sha256 !== "string"
    ) {
      continue;
    }
    try {
      const bytes = readStoreFile(renderedPageStoreFile(attachmentsDir, id, index));
      if (inputSha256(bytes) === entry.sha256) pages.push({ index, bytes });
    } catch {
      // Missing or unreadable page images are not sent; the text record stays valid.
    }
  }
  return pages;
}

/** Replace the material's page JPEGs so a later render never leaves stale pages behind. */
export function writeRenderedPages(dir: string, pages: readonly RenderedPageBytes[]): void {
  for (const entry of fs.readdirSync(dir)) {
    if (/^page-\d+\.jpg$/.test(entry)) fs.rmSync(path.join(dir, entry), { force: true });
  }
  for (const page of pages) {
    fs.writeFileSync(path.join(dir, `page-${page.index}.jpg`), page.bytes);
  }
}
