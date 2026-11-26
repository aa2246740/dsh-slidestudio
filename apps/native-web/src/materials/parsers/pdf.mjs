/**
 * `pdf-unpdf-v4` — PDF documents through unpdf (bundled pdfjs). Text is
 * extracted per page up to 300 pages; vector style hints inspect only the
 * first 30 pages with image decoding disabled, honouring q/Q graphics-state
 * save/restore. A page with fewer than 20 characters is flagged as low-text;
 * its image wording is upgraded later by the render child. This parser does no
 * OCR and never invents text. Encrypted files are rejected before pdf.js sees
 * them by scanning the raw bytes for the trailer's standard-security `/Encrypt`
 * reference — pdf.js would otherwise silently open files with an empty user
 * password.
 */
import { MaterialRejection } from "../zip-guard.mjs";
import { extractPdfTables } from "../pdf-tables.mjs";
import { extractPdfStyleProfile, PDF_DOCUMENT_OPTIONS } from "../pdf-style-hints.mjs";
import { pdfWording } from "../pdf-wording.mjs";

const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";
const ENCRYPTED_MESSAGE = "文件已加密（设有打开密码），无法读取；请取消密码后再上传";

/** Architecture limit: text extraction covers at most 300 pages. */
export const MAX_PDF_PAGES = 300;
/** A page with fewer characters than this is flagged as low-text. */
export const LOW_TEXT_CHARS = 20;

/** Standard-security-handler reference, e.g. `/Encrypt 6 0 R`, in the trailer. */
const ENCRYPT_REF = /\/Encrypt\s+\d+\s+\d+\s+R/;

/** @type {Promise<typeof import("unpdf")>|undefined} */
let unpdfModule;

/** unpdf loads lazily so text/csv/xlsx/docx/image jobs never pay for pdfjs. */
async function loadUnpdf() {
  try {
    unpdfModule ??= /** @type {Promise<typeof import("unpdf")>} */ (import("unpdf"));
    return await unpdfModule;
  } catch {
    throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
  }
}

/**
 * pdf.js failure names become stable rejections with Chinese reasons.
 * @param {unknown} error
 * @returns {MaterialRejection}
 */
export function classifyPdfError(error) {
  const name = /** @type {{name?: string, message?: string}} */ (error)?.name ?? "";
  const message = /** @type {{message?: string}} */ (error)?.message ?? "";
  if (name === "PasswordException" || /password/i.test(message)) {
    return new MaterialRejection("encrypted", ENCRYPTED_MESSAGE);
  }
  return new MaterialRejection("corrupt", CORRUPT_MESSAGE);
}

export const pdfParser = {
  id: "pdf-unpdf-v4",
  engine: "unpdf (pdfjs)",
  /** @type {"document"} */
  kind: "document",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @param {{unpdf?: typeof import("unpdf")}} [deps] test seam: a wrapped unpdf module;
   *   the parse worker passes none and the real module loads lazily
   * @returns {Promise<import("../derivative.mjs").ParserResult<object>>}
   */
  async parse({ bytes }, deps = {}) {
    if (ENCRYPT_REF.test(Buffer.from(bytes).toString("latin1"))) {
      throw new MaterialRejection("encrypted", ENCRYPTED_MESSAGE);
    }
    const unpdf = deps.unpdf ?? (await loadUnpdf());
    let proxy;
    try {
      proxy = await unpdf.getDocumentProxy(new Uint8Array(bytes), PDF_DOCUMENT_OPTIONS);
    } catch (error) {
      throw classifyPdfError(error);
    }
    const pageCount = /** @type {{numPages: number}} */ (proxy).numPages;
    try {
      /** @type {{code: string, message: string}[]} */
      const warnings = [];
      const pageLimit = Math.min(pageCount, MAX_PDF_PAGES);
      if (pageCount > MAX_PDF_PAGES) {
        warnings.push({
          code: "page-limit",
          message: `PDF 共 ${pageCount} 页，超过 ${MAX_PDF_PAGES} 页上限，仅提取前 ${MAX_PDF_PAGES} 页的文字；其余页面未读取`,
        });
      }

      const extracted = await unpdf.extractText(/** @type {any} */ (proxy), { mergePages: false });
      const pageTexts = Array.isArray(extracted.text) ? extracted.text : [];
      // Table reconstruction (CAP-32) runs on the same proxy before it is destroyed.
      // Contained and best effort: an empty list just means no table was found.
      const tables = await extractPdfTables({ unpdf, proxy, pageLimit });
      let chars = 0;
      /** @type {{index:number,chars:number,lowText:boolean,text:string}[]} */
      const pages = [];
      for (let i = 0; i < pageLimit; i += 1) {
        const text = pageTexts[i] ?? "";
        const pageChars = Array.from(text).length;
        chars += pageChars;
        pages.push({ index: i + 1, chars: pageChars, lowText: pageChars < LOW_TEXT_CHARS, text });
      }
      // Image coverage is not measured here: pdf.js decodes every image it paints,
      // which belongs in the isolated render child. Low-text pages therefore carry
      // neutral wording until the render result upgrades them (see pdf-wording.mjs).
      const wording = pdfWording({
        parserId: this.id,
        pageCount,
        chars,
        pages,
        extractedPages: pageLimit,
        tables: tables.length,
      });
      warnings.push(...wording.warnings);
      const lowTextCount = pages.filter((page) => page.lowText).length;
      const styleProfile = await extractPdfStyleProfile({ unpdf, proxy, pageCount });

      return {
        payload: {
          pageCount,
          pages,
          chars,
          tables,
          renderState: "queued",
          renderedPages: [],
          ...(styleProfile ? { styleProfile } : {}),
        },
        status: lowTextCount || pageCount > MAX_PDF_PAGES ? "partial" : "ok",
        summary: wording.summary,
        warnings,
        truncated:
          pageCount > MAX_PDF_PAGES
            ? {
                applied: true,
                reason: "page-limit",
                limits: { maxPages: MAX_PDF_PAGES, pageCount },
              }
            : { applied: false },
      };
    } finally {
      await /** @type {{loadingTask: {destroy: () => Promise<void>}}} */ (proxy).loadingTask.destroy();
    }
  },
};
