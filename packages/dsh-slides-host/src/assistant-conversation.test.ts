import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readConversation,
  recordConversationMessage,
  discussionOnly,
  DISCUSSION_TOOLS,
  discussionInstruction,
} from "./assistant-conversation.js";
import { sessionProduceToolAllowlist } from "./produce-tool-policy.js";
import { SliceSessionStore } from "./slice-session.js";

it("keeps two conversation turns after reopening and redacts credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slides-chat-"));
  try {
    recordConversationMessage(root, "先帮我想一个大纲", "discuss");
    recordConversationMessage(root, "使用 api_key=not-a-real-key", "discuss");
    assert.equal(discussionOnly(root), true);
    const loaded = readConversation(root);
    assert.equal(loaded.messages.length, 2);
    assert.notEqual(loaded.messages[0]!.id, loaded.messages[1]!.id);
    assert.equal(loaded.messages[1]!.text.includes("not-a-real-key"), false);
    recordConversationMessage(root, "开始生成", "generate");
    assert.equal(discussionOnly(root), false);
    assert.equal(readConversation(root).messages.length, 3);
    fs.writeFileSync(path.join(root, "_agent", "assistant-conversation.v1.json"), "invalid");
    assert.throws(() => discussionOnly(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("exposes read-only tools for discussion even after a fresh session-store load", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slides-chat-tools-"));
  try {
    const store = new SliceSessionStore(workspaceRoot);
    const provider = { providerId: "test", modelId: "test", ready: true };
    const opened = store.openProject({
      dshSessionId: "chat-test",
      title: "Chat",
      design: { kind: "self-directed" },
      provider,
    });
    const root = store.resolveRoot(opened.binding);
    recordConversationMessage(root, "讨论一下", "discuss");
    const reloaded = new SliceSessionStore(workspaceRoot);
    reloaded.rebuild();
    const allowed = sessionProduceToolAllowlist({ store: reloaded, provider }, "chat-test");
    assert.equal(allowed, DISCUSSION_TOOLS);
    for (const name of [
      "write_page",
      "edit_elements",
      "compose_deck",
      "write_todo",
      "generate_image",
      "open_project",
      "export_deck",
    ])
      assert.equal(allowed.has(name), false, name);
    assert.equal(allowed.has("read_page"), true);
    recordConversationMessage(root, "修改当前页", "edit");
    assert.equal(sessionProduceToolAllowlist({ store: reloaded, provider }, "chat-test").has("write_page"), true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

it("discussion instructions preserve user intent and do not claim a write", () => {
  const text = discussionInstruction("有什么建议？", "第1页：cover");
  assert.match(text, /只讨论/);
  assert.match(text, /第1页：cover/);
  assert.match(text, /<user_request>有什么建议？<\/user_request>/);
});

it("returns the same durable review acknowledgement after reopening", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slides-review-ack-"));
  try {
    const message = recordConversationMessage(root, "批注 1：标题红色", "edit", "receipt-1");
    assert.deepEqual(readConversation(root).messages[0], message);
    assert.equal(message.reviewSubmissionId, "receipt-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
