/**
 * What one PDF page says about its pictures, read from the operator list that image
 * extraction decodes anyway: pdf.js caches it per page, so asking for the geometry first
 * costs nothing extra and `unpdf.extractImages` finds it ready.
 */
import { imagePaints, pageGeometry } from "./pdf-image-paints.mjs";

/** @param {typeof import("unpdf")} unpdf @returns {Promise<Map<number, string>>} */
export async function operatorNames(unpdf) {
  const { OPS } = await unpdf.getResolvedPDFJS();
  return new Map(Object.entries(OPS).map(([name, operator]) => [operator, name]));
}

/**
 * Characters of a page, counted the way the text parser counts them (so "little text"
 * means the same here and in its low-text flag).
 * @param {any} page
 */
async function pageTextLength(page) {
  const content = await page.getTextContent();
  const text = /** @type {{str?: string, hasEOL?: boolean}[]} */ (content.items)
    .filter((item) => item.str != null)
    .map((item) => item.str + (item.hasEOL ? "\n" : ""))
    .join("");
  return Array.from(text).length;
}

/**
 * @param {{proxy: object, pageNumber: number, names: Map<number, string>}} input
 * @returns {Promise<{coverage: (key: string|undefined) => number,
 *   textLength: () => Promise<number>, release: () => void}>}
 */
export async function pageImageFacts({ proxy, pageNumber, names }) {
  /** @type {Map<string, number>} */
  const coverage = new Map();
  /** @type {any} */
  let page;
  try {
    page = await /** @type {{getPage: (n: number) => Promise<any>}} */ (proxy).getPage(pageNumber);
    const geometry = pageGeometry(page);
    if (geometry) {
      const operatorList = await page.getOperatorList();
      for (const paint of imagePaints(operatorList, names, geometry.matrix)) {
        if (!paint.key) continue;
        const share = Math.min(1, paint.area / geometry.area);
        coverage.set(paint.key, Math.max(coverage.get(paint.key) ?? 0, share));
      }
    }
  } catch {
    // The extraction that follows reports an unreadable page; with no geometry no
    // picture is taken for a page scan.
  }
  /** @type {Promise<number>|undefined} */
  let length;
  return {
    /** Frees what pdf.js holds for this page (its decoded images above all). */
    release: () => {
      try {
        page?.cleanup?.();
      } catch {
        // A page that cannot be cleaned up is released when the document closes.
      }
    },
    coverage: (key) => (key ? (coverage.get(key) ?? 0) : 0),
    textLength: () =>
      (length ??= (async () => {
        try {
          return page ? await pageTextLength(page) : Number.POSITIVE_INFINITY;
        } catch {
          return Number.POSITIVE_INFINITY;
        }
      })()),
  };
}
