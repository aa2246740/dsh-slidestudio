/**
 *  Browser editing of PPTD rich text. Paragraphs and Range offsets share one newline model, so toolbar changes can restore the same text selection.
 * @typedef {import("@open-slidestudio/pptd-v2").RichTextRun} RichTextRun
 * @typedef {Omit<RichTextRun, "text">} RunStyle
 * @typedef {{node: Node, offset: number}} DomPoint
 * @typedef {{kind: "text", node: Text, text: string, style: RunStyle, start: number}
 * | {kind: "break", node: Node, offset: number, start: number}} TextToken
 */
import { cssColorToHex } from "./rich-text-color.js";

/** @param {HTMLElement} span @param {RunStyle} run */
function applyRunStyleToSpan(span, run) {
  if (run.fontSize) span.style.fontSize = `${run.fontSize}px`;
  if (run.color) span.style.color = run.color;
  if (run.bold) span.style.fontWeight = "700";
  if (run.italic) span.style.fontStyle = "italic";
  if (run.underline) span.style.textDecoration = "underline";
}

/** @param {HTMLElement} node @param {readonly RichTextRun[]} runs */
export function appendTextRuns(node, runs) {
  for (const run of runs) {
    const span = node.ownerDocument.createElement("span");
    span.textContent = run.text;
    applyRunStyleToSpan(span, run);
    node.append(span);
  }
}

/** @param {unknown} value */
export function escapeHtmlText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** @param {RunStyle} style */
function styleToCss(style) {
  const parts = [];
  if (style.fontSize != null) parts.push(`font-size:${style.fontSize}px`);
  if (style.color) parts.push(`color:${style.color}`);
  if (style.bold) parts.push("font-weight:700");
  if (style.italic) parts.push("font-style:italic");
  if (style.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

/** @param {RunStyle} style */
function runStyleKey(style) {
  return JSON.stringify({
    fontSize: style.fontSize ?? null,
    color: style.color ?? null,
    bold: Boolean(style.bold),
    italic: Boolean(style.italic),
    underline: Boolean(style.underline),
  });
}

/** @param {Node | null} node @returns {node is HTMLElement} */
function isRichBlock(node) {
  return node instanceof HTMLElement && /^(DIV|P|LI|H[1-6])$/.test(node.tagName);
}

/** @param {HTMLElement} element @returns {RunStyle} */
function readInlineStyle(element) {
  /** @type {RunStyle} */
  const out = {};
  const style = element.style;
  const fontSize = parseFloat(style.fontSize);
  if (fontSize) out.fontSize = fontSize;
  // A colour with no #RRGGBB reading is dropped: the run then inherits the colour around it.
  const color = cssColorToHex(style.color);
  if (color) out.color = color;
  const weight = style.fontWeight;
  if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) out.bold = true;
  if (style.fontStyle === "italic" || style.fontStyle === "oblique") out.italic = true;
  if ((style.textDecorationLine || style.textDecoration || "").includes("underline")) out.underline = true;
  const tag = element.tagName;
  if (tag === "B" || tag === "STRONG") out.bold = true;
  if (tag === "I" || tag === "EM") out.italic = true;
  if (tag === "U") out.underline = true;
  return out;
}

/** @param {readonly RichTextRun[]} runs */
function splitRunsToParas(runs) {
  /** @type {RichTextRun[]} */
  let current = [];
  const paragraphs = [current];
  for (const run of runs) {
    for (const [index, part] of run.text.split("\n").entries()) {
      if (index > 0) {
        current = [];
        paragraphs.push(current);
      }
      if (part) current.push({ ...run, text: part });
    }
  }
  return paragraphs;
}

/** @param {HTMLElement} node @param {readonly RichTextRun[]} runs */
export function fillNodeFromRuns(node, runs) {
  node.replaceChildren();
  for (const paragraph of splitRunsToParas(runs)) {
    const div = node.ownerDocument.createElement("div");
    if (!paragraph.length) div.append(node.ownerDocument.createElement("br"));
    else appendTextRuns(div, paragraph);
    node.append(div);
  }
}

/** @param {Node} node @param {HTMLElement} root */
function isIgnorableRootWs(node, root) {
  if (node.nodeType !== Node.TEXT_NODE || node.parentNode !== root) return false;
  const text = node.nodeValue || "";
  return Boolean(text) && !text.trim();
}

/** @param {Node} node @param {HTMLElement} root */
function isPlaceholderBr(node, root) {
  if (!(node instanceof HTMLElement) || node.tagName !== "BR") return false;
  const parent = node.parentNode;
  if (parent === root || !isRichBlock(parent)) return false;
  for (const child of parent.childNodes) {
    if (child === node) continue;
    if (child.nodeType === Node.TEXT_NODE && child.nodeValue) return false;
    if (child instanceof Element && child.tagName !== "BR") return false;
  }
  return true;
}

/** One traversal defines paragraph text and its DOM coordinates, including
 * empty blocks. A placeholder BR is not an additional newline.
 * @param {HTMLElement} root @returns {TextToken[]} */
function projectRichText(root) {
  /** @type {TextToken[]} */
  const tokens = [];
  let length = 0;
  let paragraphHasText = false;
  let blockEnded = false;
  /** @param {Node} node @param {number} offset */
  const newline = (node, offset) => {
    tokens.push({ kind: "break", node, offset, start: length });
    length += 1;
    paragraphHasText = false;
    blockEnded = false;
  };
  /** @param {Node} node @param {RunStyle} style */
  const walk = (node, style) => {
    if (node instanceof Text) {
      if (isIgnorableRootWs(node, root) || !node.data) return;
      if (blockEnded) newline(node, 0);
      tokens.push({ kind: "text", node, text: node.data, style, start: length });
      length += node.data.length;
      paragraphHasText = true;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      if (!isPlaceholderBr(node, root)) {
        const parent = node.parentNode || root;
        newline(parent, Array.from(parent.childNodes).indexOf(node) + 1);
      }
      return;
    }
    const block = isRichBlock(node);
    if (block) {
      if (blockEnded || paragraphHasText) newline(node, 0);
      blockEnded = false;
    }
    const next = { ...style, ...readInlineStyle(node) };
    for (const child of node.childNodes) walk(child, next);
    if (block) blockEnded = true;
  };
  for (const child of root.childNodes) walk(child, {});
  return tokens;
}

/** @param {HTMLElement} root */
export function serializeEditNode(root) {
  /** @type {Array<{text: string, style: RunStyle}>} */
  let current = [];
  const paragraphs = [current];
  const newline = () => {
    current = [];
    paragraphs.push(current);
  };
  /** @param {string} text @param {RunStyle} style */
  const pushText = (text, style) => {
    if (!text) return;
    const last = current.at(-1);
    if (last && runStyleKey(last.style) === runStyleKey(style)) last.text += text;
    else current.push({ text, style: { ...style } });
  };
  for (const token of projectRichText(root)) {
    if (token.kind === "break") newline();
    else pushText(token.text, token.style);
  }
  const joined = paragraphs.map((paragraph) => paragraph.map((run) => run.text).join("")).join("\n");
  const hasStyle = paragraphs.some((paragraph) =>
    paragraph.some(({ style }) => style.bold || style.italic || style.underline || style.color || style.fontSize),
  );
  if (!hasStyle && !joined.includes("\n")) return escapeHtmlText(joined);
  return paragraphs
    .map((paragraph) => {
      const inner = paragraph
        .map(({ text, style }) => {
          const css = styleToCss(style);
          const escaped = escapeHtmlText(text);
          return css ? `<span style="${css}">${escaped}</span>` : escaped;
        })
        .join("");
      return `<p>${inner}</p>`;
    })
    .join("");
}

/** @param {TextToken[]} tokens @param {Node} container @param {number} offset */
function pointToPlainOffset(tokens, container, offset) {
  const position = container.ownerDocument?.createRange();
  if (!position) return 0;
  position.setStart(container, offset);
  position.collapse(true);
  let count = 0;
  for (const token of tokens) {
    if (token.kind === "text" && token.node === container) return token.start + offset;
    const marker = position.cloneRange();
    marker.setStart(token.node, token.kind === "text" ? 0 : token.offset);
    marker.collapse(true);
    const comparison = position.compareBoundaryPoints(Range.START_TO_START, marker);
    if (comparison < 0) return token.start;
    if (comparison === 0 && token.kind === "break") return token.start + 1;
    count = token.start + (token.kind === "text" ? token.text.length : 1);
  }
  return count;
}

/** @param {HTMLElement} root @param {TextToken[]} tokens
 * @param {number} target @returns {DomPoint} */
function plainOffsetToPoint(root, tokens, target) {
  /** @type {DomPoint} */
  let last = { node: root, offset: 0 };
  for (const token of tokens) {
    if (token.kind === "text") {
      if (target <= token.start + token.text.length)
        return { node: token.node, offset: Math.max(0, target - token.start) };
      last = { node: token.node, offset: token.text.length };
    } else {
      if (target <= token.start) return last;
      last = { node: token.node, offset: token.offset };
      if (target === token.start + 1) return last;
    }
  }
  return last;
}

/** @param {HTMLElement | null} node */
export function editingSelectionOffsets(node) {
  if (!node) return null;
  const selection = node.ownerDocument.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const inside = node === range.commonAncestorContainer || node.contains(range.commonAncestorContainer);
  if (!inside || range.collapsed) return null;
  const tokens = projectRichText(node);
  const start = pointToPlainOffset(tokens, range.startContainer, range.startOffset);
  const end = pointToPlainOffset(tokens, range.endContainer, range.endOffset);
  if (start === end) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** @param {HTMLElement} node @param {number} start @param {number} end */
export function setSelectionByPlainOffsets(node, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return false;
  const tokens = projectRichText(node);
  const a = plainOffsetToPoint(node, tokens, start);
  const b = plainOffsetToPoint(node, tokens, end);
  const range = node.ownerDocument.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return false;
  }
  const selection = node.ownerDocument.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
