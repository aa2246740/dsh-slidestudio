import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { launchPinnedChromium } from "../../../scripts/lib/pinned-playwright.mjs";
/** @typedef {typeof import("../public/rich-text-editor.js")} RichEditor */
/** @typedef {typeof import("../public/rich-text-color.js")} RichColor */
/** The part of the Playwright page these checks drive. @typedef {{evaluate: Function}} BrowserPage */

/** @param {(page: BrowserPage) => Promise<void>} run */
async function withEditor(run) {
  const source = fs.readFileSync(new URL("../public/rich-text-editor.js", import.meta.url));
  const colorSource = fs.readFileSync(new URL("../public/rich-text-color.js", import.meta.url));
  const server = http.createServer((req, res) => {
    if (req.url === "/rich-text-editor.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(source);
    } else if (req.url === "/rich-text-color.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(colorSource);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        '<!doctype html><div id="editor" contenteditable></div><div id="outside">Outside</div>' +
          '<script type="module">import * as editor from "/rich-text-editor.js"; window.richEditor = editor;</script>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  let browser;
  try {
    browser = await launchPinnedChromium({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}/`);
    await page.waitForFunction(() =>
      Boolean(/** @type {{richEditor?: RichEditor}} */ (/** @type {unknown} */ (window)).richEditor),
    );
    await run(page);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("rich text preserves mixed-script styles and escapes document text", async () => {
  await withEditor(async (page) => {
    const result = await page.evaluate(async () => {
      const editor = /** @type {{richEditor: RichEditor}} */ (/** @type {unknown} */ (window)).richEditor;
      const root = /** @type {HTMLElement} */ (document.getElementById("editor"));
      editor.fillNodeFromRuns(root, [
        { text: 'A&B <标题> "例"\n第二行', fontSize: 18, color: "#123456", bold: true },
        { text: " normal", italic: true, underline: true },
      ]);
      return { html: editor.serializeEditNode(root), children: root.children.length };
    });
    assert.equal(result.children, 2);
    assert.equal(
      result.html,
      '<p><span style="font-size:18px;color:#123456;font-weight:700">A&amp;B &lt;标题&gt; &quot;例&quot;</span></p>' +
        '<p><span style="font-size:18px;color:#123456;font-weight:700">第二行</span><span style="font-style:italic;text-decoration:underline"> normal</span></p>',
    );
  });
});

test("rich text selection offsets survive paragraph rendering and DOM changes", async () => {
  await withEditor(async (page) => {
    const result = await page.evaluate(async () => {
      const editor = /** @type {{richEditor: RichEditor}} */ (/** @type {unknown} */ (window)).richEditor;
      const root = /** @type {HTMLElement} */ (document.getElementById("editor"));
      const ranges = [];
      for (const [start, end] of [
        [0, 5],
        [6, 9],
        [2, 8],
      ]) {
        editor.fillNodeFromRuns(root, [{ text: "Alpha\n第二行", bold: true }]);
        const first = editor.setSelectionByPlainOffsets(root, start, end);
        const before = editor.editingSelectionOffsets(root);
        editor.fillNodeFromRuns(root, [{ text: "Alpha\n第二行", italic: true }]);
        const restored = before ? editor.setSelectionByPlainOffsets(root, before.start, before.end) : false;
        ranges.push({ first, restored, range: editor.editingSelectionOffsets(root) });
      }
      return ranges;
    });
    assert.deepEqual(result, [
      { first: true, restored: true, range: { start: 0, end: 5 } },
      { first: true, restored: true, range: { start: 6, end: 9 } },
      { first: true, restored: true, range: { start: 2, end: 8 } },
    ]);
  });
});

test("empty rich text paragraphs remain real newlines in serialization and selection", async () => {
  await withEditor(async (page) => {
    const result = await page.evaluate(async () => {
      const editor = /** @type {{richEditor: RichEditor}} */ (/** @type {unknown} */ (window)).richEditor;
      const root = /** @type {HTMLElement} */ (document.getElementById("editor"));
      const cases = [];
      /** @type {[string, number, number][]} */
      const inputs = [
        ["Alpha\n\nEnd", 7, 10],
        ["\nAlpha", 1, 6],
        ["Alpha\n", 0, 6],
      ];
      for (const [text, start, end] of inputs) {
        editor.fillNodeFromRuns(root, [{ text }]);
        editor.setSelectionByPlainOffsets(root, start, end);
        cases.push({
          html: editor.serializeEditNode(root),
          range: editor.editingSelectionOffsets(root),
        });
      }
      return cases;
    });
    assert.deepEqual(result, [
      { html: "<p>Alpha</p><p></p><p>End</p>", range: { start: 7, end: 10 } },
      { html: "<p></p><p>Alpha</p>", range: { start: 1, end: 6 } },
      { html: "<p>Alpha</p><p></p>", range: { start: 0, end: 6 } },
    ]);
  });
});

test("rich text ignores outside or collapsed selections and handles plain inline text", async () => {
  await withEditor(async (page) => {
    const result = await page.evaluate(async () => {
      const editor = /** @type {{richEditor: RichEditor}} */ (/** @type {unknown} */ (window)).richEditor;
      const root = /** @type {HTMLElement} */ (document.getElementById("editor"));
      const outside = /** @type {HTMLElement} */ (document.getElementById("outside"));
      editor.appendTextRuns(root, [{ text: "<script>&中文" }]);
      const plain = editor.serializeEditNode(root);
      editor.setSelectionByPlainOffsets(outside, 0, 3);
      const foreign = editor.editingSelectionOffsets(root);
      editor.setSelectionByPlainOffsets(root, 2, 2);
      const collapsed = editor.editingSelectionOffsets(root);
      return { plain, foreign, collapsed, scriptCount: root.querySelectorAll("script").length };
    });
    assert.deepEqual(result, {
      plain: "&lt;script&gt;&amp;中文",
      foreign: null,
      collapsed: null,
      scriptCount: 0,
    });
  });
});
