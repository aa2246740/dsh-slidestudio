import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, mock, test } from "node:test";
import * as realUnpdf from "unpdf";
import { pdfParser } from "./parsers/pdf.mjs";
import { pdfSample } from "./pdf-fixture-samples.mjs";

/** A real unpdf whose opened documents record every loading-task destroy. */
function trackedUnpdf() {
  /** @type {{destroy: ReturnType<typeof mock.fn>}[]} */
  const opened = [];
  /** @type {typeof realUnpdf} */
  const unpdf = {
    ...realUnpdf,
    getDocumentProxy: async (...args) => {
      const proxy = await realUnpdf.getDocumentProxy(...args);
      const destroy = mock.fn(proxy.loadingTask.destroy.bind(proxy.loadingTask));
      proxy.loadingTask.destroy = destroy;
      opened.push({ destroy });
      return proxy;
    },
  };
  return { unpdf, opened };
}

/** @param {string} name */
const source = (name) => fs.readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("pdf.js documents are released through their loading task", () => {
  test("the text parser destroys the loading task once the document is parsed", async () => {
    const { unpdf, opened } = trackedUnpdf();
    await pdfParser.parse({ name: "text.pdf", bytes: pdfSample("text.pdf") }, { unpdf });
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.destroy.mock.callCount(), 1);
  });

  test("the text parser still destroys it when parsing fails part-way", async () => {
    const { unpdf, opened } = trackedUnpdf();
    await assert.rejects(pdfParser.parse({ name: "garbage.pdf", bytes: pdfSample("garbage.pdf") }, { unpdf }));
    for (const document of opened) {
      assert.ok(document.destroy.mock.callCount() <= 1);
    }
  });

  test("no module calls the proxy's own destroy, which pdf.js does not have", () => {
    for (const file of ["./parsers/pdf.mjs", "./pdf-render-child.mjs", "./pdf-images.mjs"]) {
      const text = source(file);
      assert.doesNotMatch(text, /\(proxy\)\.destroy/, file);
      assert.match(text, /loadingTask\??\.destroy/, file);
    }
  });
});
