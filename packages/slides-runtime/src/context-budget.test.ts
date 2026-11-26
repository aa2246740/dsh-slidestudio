import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  clampMaxTokens,
  contextBudgetTokens,
  ContextBudget,
  isContextOverflowMessage,
  projectContext,
  type ContextBudgetOptions,
} from "./context-budget.js";
import { DEEP_ELISION, IMAGE_OFFLOADED, REASONING_ELISION } from "./context-compaction.js";
import { attachLlmFailure, emptyUsage } from "./llm-port.js";
import { estimateMessagesTokens, estimateTextTokens } from "./token-estimate.js";
import { streamWithBudget } from "./runtime-config.js";
import { ScriptedLlm } from "./testkit.js";

const now = 1_700_000_000_000;

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "m",
    usage: emptyUsage(),
    stopReason: "toolUse",
    timestamp: now,
    ...extra,
  };
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall" as const, id, name, arguments: args as never };
}

function result(id: string, name: string, text: string, image?: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [
      { type: "text", text },
      ...(image ? [{ type: "image" as const, data: image, mimeType: "image/png" }] : []),
    ],
    isError: false,
    timestamp: now,
  } as AgentMessage;
}

/** system, user, then `steps` read_page steps each with a large JSON result and an image. */
function transcript(steps: number, resultChars = 6_000): AgentMessage[] {
  const messages: AgentMessage[] = [
    { role: "system", content: "系统提示：你是幻灯片导演。", timestamp: now },
    { role: "user", content: "做一份十页的季度复盘", timestamp: now },
    assistant([call("plan", "write_todo", { items: [{ pageId: "p01" }] })]),
    result("plan", "write_todo", JSON.stringify({ outcome: "committed", items: [{ pageId: "p01" }] })),
  ];
  for (let index = 0; index < steps; index += 1) {
    messages.push(
      assistant([
        { type: "thinking", thinking: `第${index}步的推理`.repeat(80) },
        { type: "text", text: `检查第 ${index} 页` },
        call(`r${index}`, "read_page", { id: `p${index}` }),
      ]),
      result(
        `r${index}`,
        "read_page",
        JSON.stringify({ ok: true, pageId: `p${index}`, body: "x".repeat(resultChars) }),
        "QUJD".repeat(500),
      ),
    );
  }
  return messages;
}

const base: ContextBudgetOptions = { contextWindow: 200_000, maxOutputTokens: 8_000 };

test("CJK-aware token estimation counts ideographs individually and Latin text per ~4 bytes", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("季度复盘"), 4);
  assert.equal(estimateTextTokens("abcdefgh"), 2);
  assert.equal(estimateTextTokens("复盘 review"), 2 + Math.ceil(" review".length / 4));
  assert.ok(estimateTextTokens("。，！".repeat(10)) === 30, "full-width punctuation is CJK");
});

test("under budget the projection is verbatim apart from image limits", () => {
  const messages = transcript(2, 100);
  const { messages: projected, stats } = projectContext(messages, base);
  assert.equal(stats.tier, 0);
  assert.equal(stats.overBudget, false);
  assert.deepEqual(projected, messages);
  assert.notEqual(projected, messages, "the input is never mutated in place");
});

test("old tool results are shortened then summarized while protected anchors stay verbatim", () => {
  const messages = transcript(12);
  const tier2 = projectContext(messages, { ...base, minimumTier: 2 }).stats.projectedTokens;
  assert.ok(tier2 < estimateMessagesTokens(messages), "tier 2 already shortens long items");
  const options = { ...base, contextWindow: tier2 - 1 + 8_000 + 4_096 };
  const { messages: projected, stats } = projectContext(messages, options);
  assert.equal(stats.tier, 3);
  assert.ok(stats.projectedTokens < stats.rawTokens);
  assert.deepEqual(projected[0], messages[0], "system prompt is verbatim");
  assert.deepEqual(projected[1], messages[1], "user instruction is verbatim");
  assert.deepEqual(projected[3], messages[3], "the latest plan anchor (write_todo) is verbatim");
  assert.deepEqual(projected.at(-1), messages.at(-1), "the latest tool result is verbatim");
  assert.deepEqual(projected.at(-2), messages.at(-2), "the latest assistant action is verbatim");
  const oldResult = projected[5] as { content: { text: string }[] };
  assert.match(oldResult.content[0]!.text, /^\[历史工具结果已摘要\] read_page/);
  assert.match(oldResult.content[0]!.text, /"pageId":"p0"/, "the summary keeps identity fields");
  const oldAssistant = projected[4] as { content: { type: string; thinking?: string }[] };
  assert.equal(oldAssistant.content[0]!.thinking, REASONING_ELISION);
  assert.equal(projected.length, messages.length, "no message is ever removed");
  const ids = (list: AgentMessage[]) => list.map((message) => (message as { toolCallId?: string }).toolCallId ?? "");
  assert.deepEqual(ids(projected), ids(messages), "tool-call pairing survives");
});

test("tier 4 reduces old prose to placeholders when summaries are not enough", () => {
  const messages = transcript(14);
  const tier3 = projectContext(messages, { ...base, minimumTier: 3 }).stats.projectedTokens;
  const { messages: projected, stats } = projectContext(messages, {
    ...base,
    contextWindow: tier3 - 1 + 8_000 + 4_096,
  });
  assert.equal(stats.tier, 4);
  const oldAssistant = projected[4] as { content: { type: string; text?: string }[] };
  assert.equal(oldAssistant.content.find((block) => block.type === "text")?.text, DEEP_ELISION);
});

test("images are offloaded by count, byte budget and recency; recent protected images stay", () => {
  const messages = transcript(6, 50);
  const { messages: projected, stats } = projectContext(messages, { ...base, maxImages: 2, keepImageSteps: 3 });
  assert.equal(stats.imagesOffloaded, 4);
  const images = projected.flatMap(
    (message) =>
      ((message as { content?: unknown }).content as { type: string }[]).filter?.((block) => block.type === "image") ??
      [],
  );
  assert.equal(images.length, 2);
  const lastResult = projected.at(-1) as { content: { type: string }[] };
  assert.ok(
    lastResult.content.some((block) => block.type === "image"),
    "the newest render stays",
  );
  const firstResult = projected[5] as { content: { type: string; text?: string }[] };
  assert.equal(firstResult.content.at(-1)?.text, IMAGE_OFFLOADED);
  const bytes = projectContext(messages, { ...base, maxImages: 10, maxImageBytes: 2_100 });
  assert.equal(bytes.stats.imagesOffloaded, 5, "only one 2000-byte image fits the byte budget");
});

test("GatewayCompat and ContextBudgetHooks extend the projection; defaults impose nothing", () => {
  const messages = transcript(4, 50);
  const gated = projectContext(messages, { ...base, gateway: { maxImagesPerRequest: 1 } });
  assert.equal(gated.stats.imagesOffloaded, 3);
  const seen: number[] = [];
  const hooked = projectContext(messages, {
    ...base,
    hooks: {
      beforeProjection: (input) => input.slice(0, 2),
      afterProjection: (output, stats) => [...output, { role: "user", content: `tier ${stats.tier}`, timestamp: now }],
      onProjection: (stats) => seen.push(stats.rawTokens),
    },
  });
  assert.equal(hooked.messages.length, 3);
  assert.equal((hooked.messages[2] as { content: string }).content, "tier 0");
  assert.equal(seen.length, 1);
  assert.equal(contextBudgetTokens({ ...base, gateway: { maxRequestTokens: 50_000 } }), 50_000 - 8_000 - 4_096);
  const overflow = {
    ...(assistant([]) as AssistantMessage),
    stopReason: "error" as const,
    errorMessage: "gateway says 413",
  };
  assert.equal(isContextOverflowMessage(overflow), false);
  assert.equal(
    isContextOverflowMessage(overflow, undefined, { isOverflowError: (m) => /413/.test(m.errorMessage ?? "") }),
    true,
  );
  const standard = { ...overflow, errorMessage: "This model's maximum context length is 8192 tokens" };
  assert.equal(isContextOverflowMessage(standard), true);
  const structured = attachLlmFailure(
    { ...(assistant([]) as AssistantMessage), stopReason: "error" as const, errorMessage: "err 400" },
    { code: "CONTEXT_WINDOW_EXCEEDED", message: "err 400", status: 400 },
  );
  assert.equal(isContextOverflowMessage(structured), true);
});

test("maxTokens is clamped to the remaining context window", () => {
  assert.equal(clampMaxTokens({ contextWindow: 32_000, inputTokens: 1_000, requested: 8_000 }), 8_000);
  assert.equal(clampMaxTokens({ contextWindow: 32_000, inputTokens: 28_000, requested: 8_000 }), 2_976);
  assert.equal(
    clampMaxTokens({ contextWindow: 32_000, inputTokens: 31_990, requested: 1_000 }),
    10,
    "never exceeds the remaining window when only 10 tokens remain",
  );
  assert.equal(
    clampMaxTokens({ contextWindow: 32_000, inputTokens: 40_000, requested: 8_000 }),
    1,
    "never requests 1024 output tokens when the window is already full",
  );
  const llm = new ScriptedLlm([() => ({ text: "ok" })], { contextWindow: 20_000, maxTokens: 16_000 });
  const stream = streamWithBudget(llm, () => ({ contextWindow: 20_000, maxOutputTokens: 16_000 }));
  void stream(llm.model, { messages: [{ role: "user", content: "字".repeat(9_000), timestamp: now }] } as never, {
    maxTokens: 16_000,
  });
  assert.equal(llm.requests[0]!.options?.maxTokens, 20_000 - (9_000 + 4) - 1_024);
});

test("ContextBudget escalates its floor tier after an overflow and never throws from transform", async () => {
  const budget = new ContextBudget(() => base);
  const messages = transcript(2, 50);
  assert.deepEqual(await budget.transform(messages), messages);
  assert.equal(budget.escalate(), true);
  assert.equal(budget.tier, 1);
  const shorter = await budget.transform(messages);
  assert.equal(budget.lastProjection?.tier, 1);
  assert.equal(shorter.length, messages.length);
  while (budget.escalate()) {
    /* climb to the strongest tier */
  }
  assert.equal(budget.tier, 4);
  budget.reset();
  assert.equal(budget.tier, 0);
  const broken = new ContextBudget(() => {
    throw new Error("bad options");
  });
  assert.deepEqual(await broken.transform(messages), messages, "a failing projection falls back to the raw transcript");
});
