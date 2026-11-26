import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { conversationPageCount } from "./conversation-requirements.js";
import { composeBodyRules, requestedPageCountFromBrief } from "./compose-ir.js";

test("a later page-count answer updates compose without inventing a default", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slides-requirements-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "_agent", "assistant-conversation.v1.json");
  fs.mkdirSync(path.dirname(file));
  const brief = "做一份城市观星 PPT，先问我需要几页";
  assert.equal(conversationPageCount(root), undefined);
  assert.equal(composeBodyRules(brief).minPages, 1);
  const messages = [
    { mode: "discuss", text: brief },
    { mode: "generate", text: "两页" },
    { mode: "edit", text: "把第 2 页的标题改短" },
    { mode: "discuss", text: "如果做 8 页怎么样？先别改" },
    { mode: "generate", text: "继续完成生成" },
  ];
  const write = () => fs.writeFileSync(file, JSON.stringify({ version: 1, messages }));
  write();
  assert.equal(composeBodyRules(brief, undefined, conversationPageCount(root)).minPages, 2);
  messages.push({ mode: "generate", text: "5页" });
  write();
  assert.equal(conversationPageCount(root), 5);
  messages.push({ mode: "generate", text: "再加两页" });
  write();
  assert.equal(conversationPageCount(root), 5, "incremental pages do not reset the total to two");
  messages.push({ mode: "generate", text: "总共十二页" });
  write();
  assert.equal(composeBodyRules("原定 4 页", undefined, conversationPageCount(root)).minPages, 12);
  fs.writeFileSync(file, "{");
  assert.throws(() => conversationPageCount(root), "a corrupt accepted record cannot silently relax validation");
});

test("a bare digit reply is ambiguous and never rewrites the page total", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slides-requirements-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "_agent", "assistant-conversation.v1.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ version: 1, messages: [{ mode: "generate", text: "5" }] }));
  assert.equal(conversationPageCount(root), undefined, "a lone '5' may answer a plan choice, not a page total");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      messages: [
        { mode: "generate", text: "两页" },
        { mode: "generate", text: "5" },
      ],
    }),
  );
  assert.equal(conversationPageCount(root), 2, "the last explicit total still wins");
});

test("Chinese totals and short replies do not confuse ordinal or component pages", () => {
  for (const [text, count] of [
    ["两页", 2],
    ["两页即可：封面和总结", 2],
    ["请做十二页", 12],
    ["共二十六页", 26],
    ["页数：三十", 30],
    ["一百零二页", 102],
  ] as const) {
    assert.equal(requestedPageCountFromBrief(text), count, text);
  }
  assert.equal(requestedPageCountFromBrief("约 6 页"), undefined, "an approximate total is not a legacy minimum");
  for (const text of ["第2页", "第12页", "第二页", "封面之后分三部分，每部分一页章节；收尾一页总结", "不知道几页"]) {
    assert.equal(requestedPageCountFromBrief(text), undefined, text);
  }
  assert.equal(composeBodyRules("教学课件", undefined, 0).minPages, 1);
});
