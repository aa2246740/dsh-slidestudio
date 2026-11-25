import { PAGE_COUNT_TOKEN, type PptdElement, type PptdProject, type TextElement } from "@open-slidestudio/pptd-v2";
import { encodeXmlName } from "./export-fill.js";
import { slideNumberRuns } from "./export-slide-number.js";

/*
 * The `pageNumber` field on a page (ruling 138). A text box on a page, marked `content.field`
 * "pageNumber", shows that page's own number in its exported slide. `{page}` becomes a slide-number
 * field cached with the number, and `{pages}` is the deck's page count, written as static text and
 * reported as static-page-count. The text box is named by its element ID so the patch can find it.
 * Copies of master and layout text are not handled here; their carriers write the placeholder.
 */

export type PageNumberPatch = {
  /** 0-based index of the page's slide. */
  slideIndex: number;
  /** The text box's element ID, written as its shape name. */
  objectName: string;
  /** The page's own 1-based number, cached in the field. */
  pageNumber: number;
  pageCount: number;
};

export type PageNumberNote = {
  slideIndex: number;
  elementId: string;
  kind: "static-page-count";
  reason: string;
};

/** True for any text element that is marked to show the page number, whatever its owner. */
export function isPageNumberText(element: PptdElement): element is TextElement {
  return element.elementType === "text" && (element as TextElement).content?.field === "pageNumber";
}

/** True for a page's own number text box. A copy of a master or layout element is never one. */
export function isPageOwnNumber(element: PptdElement): element is TextElement {
  return element.inherited === undefined && isPageNumberText(element);
}

/** The patch that writes a page's own number into its text box at `slideIndex`. */
export function pageNumberPatchFor(element: TextElement, slideIndex: number, pageCount: number): PageNumberPatch {
  return {
    slideIndex,
    objectName: element.elementId,
    pageNumber: slideIndex + 1,
    pageCount,
  };
}

/** Writes each patched text box's own number. A box that was not written is an export error. */
export function applyPageNumberPatches(xml: string, patches: readonly PageNumberPatch[]): string {
  return patches.reduce((next, patch) => patchPageNumber(next, patch), xml);
}

function patchPageNumber(xml: string, patch: PageNumberPatch): string {
  const name = encodeXmlName(patch.objectName);
  const chunks = xml.split(/(?=<p:sp>)/);
  let found = false;
  const next = chunks.map((chunk) => {
    if (!chunk.startsWith("<p:sp>")) return chunk;
    const nv = chunk.match(/<p:cNvPr\b[^>]*>/)?.[0] ?? "";
    if (!nv.includes(`name="${name}"`)) return chunk;
    found = true;
    // A chunk runs to the next `<p:sp>`, so a table or picture after the box is inside it. Only
    // the matched shape's own text is patched.
    const end = chunk.indexOf("</p:sp>") + "</p:sp>".length;
    return slideNumberRuns(chunk.slice(0, end), patch.pageCount, String(patch.pageNumber)) + chunk.slice(end);
  });
  if (!found) throw new Error(`page number ${patch.objectName} missing from slide xml`);
  return next.join("");
}

/**
 * One note for each page's own number text that shows `{pages}`. The total is written as text, so
 * PowerPoint keeps it after pages are added or removed, until the deck is exported again.
 */
export function pageNumberNotes(pages: PptdProject["pages"]): PageNumberNote[] {
  const pageCount = pages.length;
  return pages.flatMap(({ page }, slideIndex) =>
    page.elements
      .filter((element): element is TextElement => isPageOwnNumber(element))
      .filter((element) => element.content.text.includes(PAGE_COUNT_TOKEN))
      .map((element) => ({
        slideIndex,
        elementId: element.elementId,
        kind: "static-page-count" as const,
        reason: `第 ${slideIndex + 1} 页中的 ${PAGE_COUNT_TOKEN} 导出为固定的 ${pageCount} 页；PowerPoint 没有总页数域，之后增减页面需要重新导出`,
      })),
  );
}
