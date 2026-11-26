/**
 * Chinese low-text wording for PDF pages, shared by the parser (neutral wording
 * at parse time) and the render store (upgrade once page images are measured).
 *
 * 「主要是图片」 needs operator-list evidence that embedded images cover at least
 * half of the page (DECISIONS #13). Parsing never decodes images, so a low-text
 * page keeps the neutral M2 wording until the render child reports `hasImage`.
 */
import { buildSummaryZh } from "./summary.mjs";

/**
 * @typedef {{index:number, lowText?:boolean, hasImage?:boolean, imageCoverage?:number}} PdfPageFacts
 */

/** @param {PdfPageFacts[]} pages */
export function pdfLowTextGroups(pages) {
  const lowText = pages.filter((page) => page.lowText === true);
  return {
    lowTextPages: lowText.map((page) => page.index),
    lowTextImagePages: lowText.filter((page) => page.hasImage === true).map((page) => page.index),
    lowTextBlankPages: lowText.filter((page) => page.hasImage === false).map((page) => page.index),
    lowTextUnknownImagePages: lowText.filter((page) => page.hasImage === undefined).map((page) => page.index),
  };
}

/** @param {ReturnType<typeof pdfLowTextGroups>} groups */
export function scannedPagesMessage(groups) {
  /** @param {number[]} pages @param {string} phrase */
  const group = (pages, phrase) => {
    if (!pages.length) return "";
    const list =
      pages.length > 10 ? `${pages.slice(0, 10).join("、")} 等 ${pages.length} 页` : `${pages.join("、")} 页`;
    return `第 ${list}${phrase}`;
  };
  const phrases = [
    group(groups.lowTextImagePages, "主要是图片，未识别文字（不做 OCR）"),
    group(groups.lowTextBlankPages, "几乎没有文字"),
    group(groups.lowTextUnknownImagePages, "几乎没有可提取的文字，可能是整页图片或扫描件；当前版本不做文字识别（OCR）"),
  ].filter(Boolean);
  return `${phrases.join("；")}，这几页的内容 Agent 读不到`;
}

/**
 * Summary sentence plus the `scanned-pages` warning (absent when no page is low-text).
 * @param {{parserId:string, pageCount:number, chars:number, pages:PdfPageFacts[], extractedPages:number, tables?:number}} input
 * @returns {{summary:{zh:string,facts:Record<string,unknown>}, warnings:{code:string,message:string}[]}}
 */
export function pdfWording({ parserId, pageCount, chars, pages, extractedPages, tables = 0 }) {
  const groups = pdfLowTextGroups(pages);
  const summary = buildSummaryZh({
    parserId,
    pageCount,
    chars,
    tables,
    ...groups,
    extractedPages,
  });
  const warnings = groups.lowTextPages.length ? [{ code: "scanned-pages", message: scannedPagesMessage(groups) }] : [];
  return { summary, warnings };
}

/**
 * Apply page-image measurements from the render child. Pages without a
 * measurement keep their previous state (unknown stays neutral).
 * @param {PdfPageFacts[]} pages
 * @param {unknown} pageImages
 * @returns {PdfPageFacts[]}
 */
export function mergePdfPageImages(pages, pageImages) {
  const byIndex = new Map((Array.isArray(pageImages) ? pageImages : []).map((entry) => [entry.index, entry]));
  return pages.map((page) => {
    const measured = byIndex.get(page.index);
    if (!measured) return page;
    return {
      ...page,
      hasImage: measured.hasImage === true,
      imageCoverage: Number(measured.imageCoverage) || 0,
    };
  });
}
