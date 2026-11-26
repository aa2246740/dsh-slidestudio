import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import { isEditTypeKey, rangeHasStyle, selectNodeText } from "../public/editor-text-input.js";

test("text shortcut ownership excludes modified keys but retains destructive text input", () => {
  /** @param {string} value @param {Partial<KeyboardEvent>} [modifiers] */
  const key = (value, modifiers = {}) => ({
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...modifiers,
  });
  for (const value of ["a", "中", "Backspace", "Delete", "Enter"]) {
    assert.equal(isEditTypeKey(key(value)), true);
  }
  for (const value of ["ArrowLeft", "Escape", "Shift"]) {
    assert.equal(isEditTypeKey(key(value)), false);
  }
  for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
    assert.equal(isEditTypeKey(key("a", { [modifier]: true })), false);
  }
});

test("rich range toggles require the same style across every overlapping run", () => {
  const runs = [
    { text: "First", bold: true },
    { text: " ", italic: true },
    { text: "第二", bold: true },
  ];
  assert.equal(rangeHasStyle(runs, 0, 5, "bold"), true);
  assert.equal(rangeHasStyle(runs, 4, 7, "bold"), false);
  assert.equal(rangeHasStyle(runs, 6, 8, "bold"), true);
  assert.equal(rangeHasStyle(runs, 5, 6, "italic"), true);
  assert.equal(rangeHasStyle(runs, 9, 12, "bold"), false);
  assert.equal(rangeHasStyle(runs, 0, 0, "bold"), false);
  assert.equal(rangeHasStyle(undefined, 0, 1, "bold"), false);
});

test("select-all fallback focuses and selects only the requested text node", () => {
  const dom = new JSDOM('<div id="before">Before</div><div id="edit" tabindex="0">Hello 世界</div>');
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.document = dom.window.document;
  const win = /** @type {Window & typeof globalThis} */ (/** @type {unknown} */ (dom.window));
  globalThis.window = win;
  try {
    const node = dom.window.document.getElementById("edit");
    assert.ok(node);
    selectNodeText(node);
    assert.equal(dom.window.document.activeElement, node);
    assert.equal(String(win.getSelection()), "Hello 世界");
  } finally {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
    dom.window.close();
  }
});
