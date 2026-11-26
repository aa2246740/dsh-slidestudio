/**
 * Whole-page `write_page` argument guard: element fields must live inside
 * their owning element, never at page level. Extracted from domain-hands.ts
 * to keep that file inside its module budget.
 */

const MISPLACED_PAGE_STYLE_KEYS = new Set([
  "align",
  "bold",
  "color",
  "fill",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "item",
  "layoutRole",
  "letterSpacing",
  "line",
  "lineHeight",
  "position",
  "rect",
  "text",
  "value",
]);

export function requireWholePageWriteArgs(args: Record<string, unknown>): void {
  const misplaced = Object.keys(args)
    .filter((key) => MISPLACED_PAGE_STYLE_KEYS.has(key))
    .sort();
  if (!misplaced.length) return;
  throw new Error(
    `write_page received element fields at page level: ${misplaced.join(", ")}. ` +
      "write_page replaces the entire page; send one complete elements[] array for the page. " +
      "Put text, style, bounds, fill, line, alignment, and layoutRole inside their owning element.",
  );
}
