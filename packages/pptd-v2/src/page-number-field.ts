/**
 * The `pageNumber` text field. Text marked `content.field: "pageNumber"` shows its page's own
 * number and the deck's page count when it is drawn or exported. The stored text keeps the
 * tokens, so a copy in another page or a later save never bakes in one page's number.
 */

/** Replaced by the page's 1-based position. */
export const PAGE_NUMBER_TOKEN = "{page}";

/** Replaced by the deck's page count. PowerPoint has no total-page field, so export writes it as text. */
export const PAGE_COUNT_TOKEN = "{pages}";

/**
 * `text` with both tokens filled for the page at `pageIndex` (0-based) of `pageCount` pages.
 * Other text, including other braces, is returned unchanged.
 */
export function fillPageNumberTokens(text: string, pageIndex: number, pageCount: number): string {
  return text
    .split(PAGE_COUNT_TOKEN)
    .join(String(pageCount))
    .split(PAGE_NUMBER_TOKEN)
    .join(String(pageIndex + 1));
}
