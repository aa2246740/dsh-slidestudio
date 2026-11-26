import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import * as clipboard from "../public/editor-clipboard.js";

test("clipboard decoding preserves opaque object markers and rejects non-string payloads", () => {
  assert.deepEqual(clipboard.decodeClipboardContent({ token: "other-tab", plain: "对象" }), {
    token: "other-tab",
    plain: "对象",
  });
  assert.deepEqual(clipboard.decodeClipboardContent({ plain: "课程说明" }), {
    token: "",
    plain: "课程说明",
  });
  for (const value of [null, [], "text", { token: {} }, { plain: false }])
    assert.throws(() => clipboard.decodeClipboardContent(value), TypeError);
});

test("clipboard HTML keeps markers escaped and projects markup to plain text only", () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = { document: globalThis.document, DOMParser: globalThis.DOMParser };
  globalThis.document = dom.window.document;
  globalThis.DOMParser = /** @type {typeof DOMParser} */ (/** @type {{DOMParser?: unknown}} */ (dom.window).DOMParser);
  try {
    const html = clipboard.clipboardHtml({ token: 'token"<>', plain: "<标题>" });
    assert.equal(clipboard.clipboardTokenFromHtml(html), 'token"<>');
    assert.equal(
      clipboard.clipboardPlainText({
        getData: (type) => (type === "text/html" ? "<b>课程</b><p>说明</p>" : ""),
      }),
      "课程说明",
    );
    assert.equal(clipboard.clipboardTokenFromHtml("<p>普通文字</p>"), "");
  } finally {
    globalThis.document = previous.document;
    globalThis.DOMParser = previous.DOMParser;
    dom.window.close();
  }
});
