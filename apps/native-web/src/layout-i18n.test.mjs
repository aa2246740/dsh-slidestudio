import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { LAYOUT_I18N } from "../public/layout-i18n.js";
import { LAYOUT_DEFINITION_MISSING, LAYOUT_MASTER_REFUSAL } from "../public/layout-edit-turn.js";
import { STALE_PAGE_TARGET } from "../public/work-agent-scope.js";

// Every Chinese source key the layout modules translate has English copy: in the layout slice, or
// already in the shared dictionary (the few common words below).
const SHARED_KEYS = new Set(["取消", "保存", "删除", "版式", "无法发送", STALE_PAGE_TARGET]);

/** @param {string} file */
function translatedLiterals(file) {
  const source = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
  return [...source.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => /** @type {string} */ (match[1]));
}

test("every layout string the modules translate has an English entry", () => {
  const keys = [
    ...translatedLiterals("layout-mode.js"),
    ...translatedLiterals("layout-edit-turn.js"),
    "版式里不能放图表/表格",
    "已撤销母版『{name}』的修改",
    "已撤销版式『{name}』的修改",
    LAYOUT_MASTER_REFUSAL,
    LAYOUT_DEFINITION_MISSING,
  ];
  assert.ok(keys.length > 20);
  const missing = keys.filter((key) => !SHARED_KEYS.has(key) && !(key in LAYOUT_I18N));
  assert.deepEqual(missing, []);
});

test("English copy keeps every placeholder of its Chinese key", () => {
  for (const [key, english] of Object.entries(LAYOUT_I18N)) {
    const names = (/** @type {string} */ text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(english), names(key), key);
    assert.ok(english.trim(), `${key} has copy`);
  }
});
