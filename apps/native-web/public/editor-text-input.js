/** Native text input ownership and rich-range selection, shared by editor shortcuts and toolbars.
 * @typedef {import("@open-slidestudio/pptd-v2").RichTextRun} RichTextRun
 * @typedef {Document & {caretPositionFromPoint?: (x: number, y: number) => {offsetNode: Node, offset: number} | null}} CaretDocument
 */

/** @param {readonly RichTextRun[] | null | undefined} runs @param {number} start @param {number} end @param {keyof RichTextRun} key */
export function rangeHasStyle(runs, start, end, key) {
  let cursor = 0;
  let saw = false;
  for (const run of runs || []) {
    const rs = cursor;
    const re = cursor + String(run.text || "").length;
    cursor = re;
    const lo = Math.max(start, rs);
    const hi = Math.min(end, re);
    if (lo >= hi) continue;
    saw = true;
    if (!run[key]) return false;
  }
  return saw;
}

/** @param {HTMLElement} node */
export function selectNodeText(node) {
  node.focus();
  try {
    document.execCommand("selectAll");
  } catch {
    /* fall through to Range */
  }
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && node.contains(sel.anchorNode)) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** @param {Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">} ev */
export function isEditTypeKey(ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  if (ev.key === "Backspace" || ev.key === "Delete" || ev.key === "Enter") return true;
  return ev.key.length === 1;
}

/** @param {HTMLElement} node @param {Pick<MouseEvent, "clientX" | "clientY">} ev */
export function placeCaretAtPoint(node, ev) {
  const sel = window.getSelection();
  if (!sel) return;
  /** @type {Range | null} */
  let range = null;
  const caretDocument = /** @type {CaretDocument} */ (document);
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
  } else if (caretDocument.caretPositionFromPoint) {
    const pos = caretDocument.caretPositionFromPoint(ev.clientX, ev.clientY);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (range && node.contains(range.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  sel.collapseToEnd();
}
