import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fillPageNumberTokens, PAGE_COUNT_TOKEN, PAGE_NUMBER_TOKEN } from "./page-number-field.js";

/*
 * The pageNumber field fills `{page}` with the page's own 1-based number and `{pages}` with the
 * deck's page count. Any other text, including other braces, comes back unchanged.
 */

describe("pageNumber field tokens", () => {
  it("fills {page} with the 1-based page and {pages} with the page count", () => {
    assert.equal(fillPageNumberTokens("第 {page} 页 / 共 {pages} 页", 1, 24), "第 2 页 / 共 24 页");
    assert.equal(fillPageNumberTokens("{page}", 0, 3), "1");
  });

  it("fills every occurrence of a token", () => {
    assert.equal(fillPageNumberTokens("{page}-{page}/{pages}", 4, 9), "5-5/9");
  });

  it("leaves text without the exact tokens unchanged", () => {
    for (const text of ["{Page}", "{ page }", "{pag}", "{{page", "{pages-1}", "共 3 页", ""]) {
      assert.equal(fillPageNumberTokens(text, 2, 5), text);
    }
  });

  it("names the token spellings the editor and the exporter share", () => {
    assert.equal(PAGE_NUMBER_TOKEN, "{page}");
    assert.equal(PAGE_COUNT_TOKEN, "{pages}");
  });
});
