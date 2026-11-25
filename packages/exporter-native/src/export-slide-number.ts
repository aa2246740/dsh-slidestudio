import { PAGE_COUNT_TOKEN, PAGE_NUMBER_TOKEN } from "@open-slidestudio/pptd-v2";

/*
 * Slide-number fields in the text of a slide, master or layout part (M5b; ruling 138). A text run
 * whose text holds `{page}` is split so that the token becomes a slide-number field, and `{pages}`
 * becomes the deck's page count as plain text. A master or layout caches PowerPoint's own
 * placeholder glyph in the field. A page caches its own number, so every reader shows that number.
 */

/** The placeholder PowerPoint itself stores as the text of a slide-number field. */
const SLIDE_NUMBER_GLYPH = "‹#›";
const SLIDE_NUMBER_FIELD_ID = "{7F2B4C1E-3A5D-4E8B-9C61-2D0A8F6B1E37}";
/** A text run whose text may hold tokens. Its run properties are kept for every piece. */
const TEXT_RUN = /<a:r>(<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>)?<a:t>([^<]*)<\/a:t><\/a:r>/g;

/**
 * Splits the page-number tokens out of the text runs of `xml`. `{pages}` becomes `pageCount` as
 * text. `{page}` becomes a slide-number field whose cached text is `cached`, which defaults to the
 * placeholder glyph.
 */
export function slideNumberRuns(xml: string, pageCount: number, cached: string = SLIDE_NUMBER_GLYPH): string {
  return xml.replace(TEXT_RUN, (run, props: string | undefined, text: string) => {
    if (!text.includes(PAGE_NUMBER_TOKEN) && !text.includes(PAGE_COUNT_TOKEN)) return run;
    const rPr = props ?? "";
    const pieces = text.split(PAGE_COUNT_TOKEN).join(String(pageCount)).split(PAGE_NUMBER_TOKEN);
    return pieces
      .map((piece, index) => {
        const field = index > 0 ? slideNumberField(rPr, cached) : "";
        return `${field}${piece ? `<a:r>${rPr}<a:t>${piece}</a:t></a:r>` : ""}`;
      })
      .join("");
  });
}

function slideNumberField(rPr: string, cached: string): string {
  return `<a:fld id="${SLIDE_NUMBER_FIELD_ID}" type="slidenum">${rPr}<a:t>${cached}</a:t></a:fld>`;
}
