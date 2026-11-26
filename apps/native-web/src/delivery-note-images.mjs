/**
 * Image lines of the 「资料使用情况」 card: one line per uploaded image with the
 * page it ended up on or the reason it was left out. Read-only over
 * `delivery-provenance.v1.json`; nothing here decides what an image is for.
 */
import { array, compactPageRanges, pagePositions, record, text } from "./delivery-note-shared.mjs";

export { compactPageRanges };

const FILENAME_BASIS_NOTE = "按文件名和你的描述分配，未看画面";

/** @param {string[]} placed @param {Map<string, number>} positions */
function placementText(placed, positions) {
  const numbers = placed.flatMap((pageId) => {
    const position = positions.get(pageId);
    return position ? [position] : [];
  });
  if (numbers.length) return `第 ${compactPageRanges(numbers)} 页`;
  return placed.join("、");
}

/** @param {string} use @param {string} where @param {string} reason */
function imageStatus(use, where, reason) {
  if (use === "excluded") return `不使用：${reason || "没有写明原因"}`;
  if (use === "style-reference") return `只作风格参考，没有放进页面${reason ? `（${reason}）` : ""}`;
  if (use === "unused" || !where) return "没有用在任何页面，也没有说明原因";
  if (use === "background") return `作为${where}的背景`;
  if (use === "logo") return `作为 Logo 放在${where}`;
  return `放在${where}`;
}

/**
 * @param {unknown} images `provenance.images`
 * @param {unknown} pages `provenance.pages`, in deck order
 * @returns {{lines: string[], ids: Set<string>}} one line per image and the ids they cover
 */
export function imageUsageLines(images, pages) {
  const positions = pagePositions(pages);
  /** @type {string[]} */
  const lines = [];
  const ids = new Set();
  for (const value of array(images)) {
    const image = record(value);
    const id = text(image.materialId);
    if (!id) continue;
    ids.add(id);
    const name = text(image.name) || id;
    const placed = array(image.placed).map(text).filter(Boolean);
    const use = text(image.use);
    const status = imageStatus(use, placementText(placed, positions), text(image.reason));
    const note = text(image.basis) === "vision" || use === "unused" ? "" : `；${FILENAME_BASIS_NOTE}`;
    lines.push(`图片：${name} — ${status}${note}。`);
  }
  return { lines, ids };
}
