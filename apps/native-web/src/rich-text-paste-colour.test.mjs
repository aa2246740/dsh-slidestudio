import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { launchPinnedChromium } from "../../../scripts/lib/pinned-playwright.mjs";
/** @typedef {typeof import("../public/rich-text-editor.js")} RichEditor */
/** @typedef {typeof import("../public/rich-text-color.js")} RichColor */
/** The part of the Playwright page these checks drive. @typedef {{evaluate: Function}} BrowserPage */

const MODULES = new Set(["/rich-text-editor.js", "/rich-text-color.js"]);

/** Serves the editor modules from `public/` and an empty contenteditable page. */
/** @param {(page: BrowserPage) => Promise<void>} run */
async function withPasteEditor(run) {
  const server = http.createServer((req, res) => {
    if (MODULES.has(req.url ?? "")) {
      const file = new URL(`../public${req.url}`, import.meta.url);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      '<!doctype html><div id="editor" contenteditable></div>' +
        '<script type="module">import * as editor from "/rich-text-editor.js"; window.richEditor = editor;</script>' +
        '<script type="module">import * as color from "/rich-text-color.js"; window.richColor = color;</script>',
    );
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

/**
 * Pastes HTML the way a browser does: its own editing command inserts the fragment into the
 * focused contenteditable. The OS clipboard is not written. Returns the serialized commit.
 */
/** @param {BrowserPage} page @param {string} markup */
async function paste(page, markup) {
  return page.evaluate((/** @type {string} */ html) => {
    const root = /** @type {HTMLElement} */ (document.getElementById("editor"));
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    const selection = /** @type {Selection} */ (window.getSelection());
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertHTML", false, html);
    return {
      inserted,
      html: /** @type {{richEditor: RichEditor}} */ (/** @type {unknown} */ (window)).richEditor.serializeEditNode(
        root,
      ),
    };
  }, markup);
}

test("pasted named and functional colours are committed as #RRGGBB", async () => {
  await withPasteEditor(async (page) => {
    const result = await paste(
      page,
      '<span style="color:red">红</span>字' +
        '<span style="color:rgba(0,0,255,.5)">蓝</span>' +
        '<span style="color:rgb(100%, 0%, 0%)">百</span>' +
        '<span style="color:#0f0">绿</span>',
    );
    assert.equal(result.inserted, true);
    assert.equal(
      result.html,
      '<p><span style="color:#FF0000">红</span>字' +
        '<span style="color:#0000FF">蓝</span>' +
        '<span style="color:#FF0000">百</span>' +
        '<span style="color:#00FF00">绿</span></p>',
    );
  });
});

test("a pasted colour that cannot be parsed is dropped and the paste still succeeds", async () => {
  await withPasteEditor(async (page) => {
    const result = await paste(
      page,
      '<span style="color:transparent">透</span>字' +
        '<span style="color:oklch(0.6 0.2 30)">橙</span>' +
        '<span style="color:red">红</span>',
    );
    assert.equal(result.inserted, true);
    assert.equal(result.html, '<p>透字橙<span style="color:#FF0000">红</span></p>');
  });
});

test("the named colour table matches the browser's own colour parser", async () => {
  await withPasteEditor(async (page) => {
    const mismatches = await page.evaluate(() => {
      const color = /** @type {{richColor?: RichColor}} */ (/** @type {unknown} */ (window)).richColor;
      if (!color) throw new Error("/rich-text-color.js did not load");
      const { CSS_NAMED_COLOR_HEX, cssColorToHex } = color;
      const probe = document.createElement("span");
      document.body.append(probe);
      const bad = [];
      for (const [name, hex] of Object.entries(CSS_NAMED_COLOR_HEX)) {
        probe.style.color = name;
        const [red, green, blue] = (getComputedStyle(probe).color.match(/\d+/g) ?? []).map(Number);
        const browserHex = `#${[red, green, blue]
          .map((channel) => channel.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase()}`;
        if (browserHex !== hex || cssColorToHex(name) !== hex) bad.push({ name, hex, browserHex });
      }
      probe.remove();
      return bad;
    });
    assert.deepEqual(mismatches, []);
  });
});
