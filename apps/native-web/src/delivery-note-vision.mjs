/**
 * 「请核对」 lines of the 「资料使用情况」 card (VAL-IMG-012): one line per number a
 * page states that the vision model read off an image and no read file states.
 * Read-only over `delivery-provenance.v1.json`; the host decides what counts.
 */
import { array, record, text } from "./delivery-note-shared.mjs";

/**
 * @param {unknown} pages `provenance.pages`, in deck order
 * @returns {string[]} one line per vision-read value, numbered by deck position
 */
export function visionValueLines(pages) {
  /** @type {string[]} */
  const lines = [];
  array(pages).forEach((value, index) => {
    const page = record(value);
    const values = array(page.visionValues);
    for (const item of values) {
      const entry = record(item);
      const figure = text(entry.value);
      if (!figure || entry.basis !== "vision-read") continue;
      lines.push(`第 ${index + 1} 页的 ${figure} 是看图识别的，未经文件校验，请核对。`);
    }
  });
  return lines;
}
