import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ContextBudget, contextBudgetTokens, projectContext, type ContextBudgetOptions } from "./context-budget.js";
import { PAGE_RECEIPT_LABEL } from "./context-working-set.js";
import { emptyUsage } from "./llm-port.js";
import { CALIBRATION_BOUNDS, estimateMessagesTokens, TokenCalibration } from "./token-estimate.js";

const now = 1_700_000_000_000;
type Msg = AgentMessage;

function assistant(content: AssistantMessage["content"]): Msg {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "m",
    usage: emptyUsage(),
    stopReason: "toolUse",
    timestamp: now,
  };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: args as never,
});

function result(id: string, name: string, payload: unknown, image?: string, isError = false): Msg {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
      ...(image ? [{ type: "image" as const, data: image, mimeType: "image/png" }] : []),
    ],
    isError,
    timestamp: now,
  } as Msg;
}

function writeArgs(pageId: string, size = 6_000) {
  return { id: pageId, pageType: "content", elements: [{ elementId: "body", text: "页面正文".repeat(size / 4) }] };
}

/** A realistic generation replay: design, plan, then `pages` pages of write/render/review. */
function generation(pages: number, writeSize = 6_000): Msg[] {
  const messages: Msg[] = [
    { role: "system", content: "系统提示：你是幻灯片导演。", timestamp: now },
    { role: "user", content: "根据参考资料做一份季度复盘", timestamp: now },
    assistant([call("design", "commit_design", { family: "corporate", tokens: "色板".repeat(300) })]),
    result("design", "commit_design", { ok: true, outcome: "committed", contract: "设计契约".repeat(200) }),
    assistant([call("todo", "write_todo", { items: Array.from({ length: pages }, (_, i) => ({ pageId: `p${i}` })) })]),
    result("todo", "write_todo", { ok: true, outcome: "committed" }),
  ];
  for (let page = 0; page < pages; page += 1) {
    const id = `p${page}`;
    messages.push(
      assistant([
        { type: "thinking", thinking: `第${page}页的思路`.repeat(60) },
        call(`w${page}`, "write_page", writeArgs(id, writeSize)),
      ]),
      result(`w${page}`, "write_page", { ok: true, pageId: id, revision: 1 }),
      assistant([call(`r${page}`, "render_page", { id })]),
      result(`r${page}`, "render_page", { ok: true, pageId: id, layout: "x".repeat(2_000) }, "QUJD".repeat(400)),
      assistant([call(`v${page}`, "review_page", { id })]),
      result(`v${page}`, "review_page", { ok: true, pageId: id, verdict: "pass", notes: "评审意见".repeat(150) }),
    );
  }
  return messages;
}

const options = (contextWindow: number, extra: Partial<ContextBudgetOptions> = {}): ContextBudgetOptions => ({
  contextWindow,
  maxOutputTokens: 8_192,
  ...extra,
});

const toolCallIds = (list: Msg[]) => list.map((message) => (message as { toolCallId?: string }).toolCallId ?? "");
const textOf = (message: Msg | undefined) =>
  ((message as { content?: { type: string; text?: string }[] })?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

test("32k/64k/128k/200k replays fit the budget and keep anchors, pairing and the latest step verbatim", () => {
  const messages = generation(20);
  for (const window of [32_000, 64_000, 128_000, 200_000]) {
    const { messages: projected, stats } = projectContext(messages, options(window));
    assert.equal(
      stats.overBudget,
      false,
      `${window}: projection fits (${stats.projectedTokens}/${stats.budgetTokens})`,
    );
    assert.equal(stats.insufficientWindow, false, `${window}: the anchors fit`);
    assert.equal(projected.length, messages.length, `${window}: no message removed`);
    assert.deepEqual(toolCallIds(projected), toolCallIds(messages), `${window}: tool pairing survives`);
    assert.deepEqual(projected.slice(0, 2), messages.slice(0, 2), `${window}: system and user verbatim`);
    assert.deepEqual(projected[3], messages[3], `${window}: design contract verbatim`);
    assert.deepEqual(projected[5], messages[5], `${window}: plan anchor verbatim`);
    assert.deepEqual(projected.slice(-2), messages.slice(-2), `${window}: latest step verbatim`);
    assert.equal(stats.budgetTokens, contextBudgetTokens(options(window)));
    if (window <= 64_000) assert.equal(stats.workingSet, true, `${window}: small windows use the working set`);
    if (window === 200_000) assert.equal(stats.tier, 0, "200k stays append-only");
  }
});

test("all parallel read_reference results of the latest step survive the strongest tier", () => {
  const messages = generation(6);
  const ids = Array.from({ length: 11 }, (_, index) => `ref${index}`);
  messages.push(assistant(ids.map((id, chunk) => call(id, "read_reference", { referenceId: "brief", chunk }))));
  for (const [chunk, id] of ids.entries()) {
    messages.push(result(id, "read_reference", { ok: true, chunk, text: "参考资料正文".repeat(300) }));
  }
  const { messages: projected, stats } = projectContext(messages, options(48_000, { minimumTier: 4 }));
  assert.equal(stats.tier, 4);
  assert.deepEqual(
    projected.slice(-11),
    messages.slice(-11),
    "no reference chunk is truncated before the model sees it",
  );
  const olderRender = projected.findIndex((message) => (message as { toolCallId?: string }).toolCallId === "r0");
  assert.notDeepEqual(projected[olderRender], messages[olderRender], "older results still compact");
});

test("online calibration scales estimates from real usage within bounds", () => {
  const calibration = new TokenCalibration();
  calibration.recordRequest(1_000);
  assert.equal(calibration.observeUsage({ input: 1_300, cacheRead: 200 }), 1.5);
  calibration.recordRequest(1_000);
  assert.equal(calibration.observeUsage({ input: 50_000 }), CALIBRATION_BOUNDS.max);
  calibration.recordRequest(1_000);
  assert.equal(calibration.observeUsage({ input: 10 }), CALIBRATION_BOUNDS.min);
  assert.equal(calibration.observeUsage({ input: 999 }), CALIBRATION_BOUNDS.min, "no pending request, no change");
  calibration.recordRequest(1_000);
  assert.equal(calibration.observeUsage(emptyUsage()), CALIBRATION_BOUNDS.min, "zero usage is ignored");
  assert.equal(calibration.apply(100), 70);

  const messages = generation(10);
  const raw = estimateMessagesTokens(messages);
  const plain = projectContext(messages, options(128_000)).stats;
  const calibrated = projectContext(messages, options(128_000, { tokenMultiplier: 1.6 })).stats;
  assert.equal(plain.rawTokens, raw);
  assert.equal(calibrated.rawTokens, Math.ceil(raw * 1.6));
  assert.equal(calibrated.calibration, 1.6);
  assert.ok(calibrated.tier >= plain.tier, "a denser tokenizer compacts at least as hard");
  assert.equal(calibrated.overBudget, false);
  assert.equal(projectContext(messages, options(128_000, { tokenMultiplier: 9 })).stats.calibration, 1.8);
});

test("escalate() selects the lowest tier that really reduces the projection", async () => {
  const messages = generation(3, 40_000);
  const budget = new ContextBudget(() => options(200_000, { cacheFirstMinWindow: Number.POSITIVE_INFINITY }));
  await budget.transform(messages);
  const before = budget.lastProjection!;
  assert.equal(before.tier, 0);
  assert.equal(budget.escalate(), true);
  assert.equal(budget.tier, 1, "items over 32 KB make tier 1 effective");
  await budget.transform(messages);
  assert.ok(budget.lastProjection!.projectedTokens < before.projectedTokens);

  const small = generation(2, 400);
  const second = new ContextBudget(() => options(200_000, { cacheFirstMinWindow: Number.POSITIVE_INFINITY }));
  await second.transform(small);
  const prior = second.lastProjection!.projectedTokens;
  assert.equal(second.escalate(), true);
  assert.equal(second.tier, 2, "tier 1 is a no-op when every item is below 32 KB");
  await second.transform(small);
  assert.ok(second.lastProjection!.projectedTokens < prior);
});

test("protected anchors that cannot fit are reported as an insufficient window", () => {
  const messages: Msg[] = [
    { role: "system", content: "系统提示".repeat(4_000), timestamp: now },
    { role: "user", content: "做一份复盘", timestamp: now },
  ];
  const { stats } = projectContext(messages, options(16_000, { minimumTier: 4 }));
  assert.equal(stats.insufficientWindow, true);
  assert.ok(stats.protectedTokens > stats.budgetTokens);
  assert.equal(projectContext(messages, options(64_000)).stats.insufficientWindow, false);
});

test("older write_page calls for a page collapse to identity metadata in the projection only", () => {
  const messages = generation(2, 400);
  messages.push(
    assistant([call("w0b", "write_page", writeArgs("p0", 800))]),
    result("w0b", "write_page", { ok: false, error: "VALIDATION", detail: "bounds" }, undefined, true),
    assistant([call("w0c", "write_page", writeArgs("p0", 800))]),
    result("w0c", "write_page", { ok: true, pageId: "p0", revision: 2 }),
    assistant([call("r0c", "render_page", { id: "p0" })]),
    result("r0c", "render_page", { ok: true, pageId: "p0" }),
  );
  const snapshot = structuredClone(messages);
  const { messages: projected, stats } = projectContext(messages, options(128_000));
  const argsOf = (list: Msg[], id: string) =>
    list
      .flatMap((message) => {
        const content = (message as { content?: unknown }).content;
        return (Array.isArray(content) ? content : []) as { id?: string; arguments?: unknown }[];
      })
      .find((block) => block.id === id)?.arguments;
  assert.deepEqual(argsOf(projected, "w0"), { id: "p0", superseded: true });
  assert.deepEqual(argsOf(projected, "w0b"), { id: "p0", superseded: true }, "superseded failed attempts collapse too");
  assert.deepEqual(argsOf(projected, "w0c"), writeArgs("p0", 800), "the newest write stays verbatim");
  assert.deepEqual(argsOf(projected, "w1"), writeArgs("p1", 400), "other pages are untouched");
  assert.equal(stats.supersededCalls, 2);
  assert.deepEqual(messages, snapshot, "the durable transcript is never mutated");
});

test("the small-window working set keeps the active page and design contract, receipts the rest", () => {
  const messages = generation(12);
  const { messages: projected, stats } = projectContext(messages, options(64_000));
  assert.equal(stats.workingSet, true);
  assert.ok(stats.pageReceipts > 0);
  const byCall = (id: string) => projected.find((message) => (message as { toolCallId?: string }).toolCallId === id);
  assert.match(textOf(byCall("v0")), new RegExp(`^\\${PAGE_RECEIPT_LABEL} p0 review_page`));
  assert.ok(!textOf(byCall("v0")).includes("\n"), "receipts are one line");
  const last = 11;
  for (const id of [`w${last}`, `r${last}`, `v${last}`]) {
    assert.deepEqual(
      byCall(id),
      messages.find((message) => (message as { toolCallId?: string }).toolCallId === id),
    );
  }
  const blocks = (message: Msg) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) ? (content as { id?: string; type: string }[]) : [];
  };
  const writeCall = projected.find((message) => blocks(message).some((block) => block.id === `w${last}`));
  assert.deepEqual(writeCall, messages[messages.length - 6], "the active page's latest write is verbatim");
  assert.deepEqual(projected[3], messages[3], "design contract anchor is verbatim");
  const images = projected.flatMap((message) => blocks(message).filter((block) => block.type === "image"));
  assert.ok(images.length <= 2, "small-window image defaults apply");
  const forcedOff = projectContext(messages, options(64_000, { workingSet: false })).stats;
  assert.equal(forcedOff.workingSet, false);
});

test("200k windows keep an append-only prefix (>= 95% stable) until 75% of the budget", () => {
  const full = generation(24);
  const opts = options(200_000);
  let previous: Msg[] | undefined;
  let stable = 0;
  let compared = 0;
  for (let length = 8; length <= full.length; length += 2) {
    const { messages: projected, stats } = projectContext(full.slice(0, length), opts);
    if (stats.rawTokens > stats.budgetTokens * 0.75) break;
    assert.equal(stats.cacheFirstHold, true);
    assert.equal(stats.tier, 0);
    if (previous) {
      for (const [index, message] of previous.entries()) {
        compared += 1;
        if (JSON.stringify(message) === JSON.stringify(projected[index])) stable += 1;
      }
    }
    previous = projected;
  }
  assert.ok(compared > 500, "the replay grows long enough to matter");
  assert.ok(stable / compared >= 0.95, `prefix stability ${(stable / compared).toFixed(3)}`);
  const beyond = projectContext(generation(24), options(200_000, { cacheFirstThreshold: 0.1 })).stats;
  assert.equal(beyond.cacheFirstHold, false, "past the threshold the normal compaction resumes");
});
