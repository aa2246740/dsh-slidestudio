import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type AttachmentStore from "@deepseek-ai/dsh-attachment";
import type LlmRuntime from "@deepseek-ai/dsh-llm";
import {
  normalizeContext,
  type AssistantMessageEvent,
  type Message,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createSlidesRuntime, readLlmFailure, registerSecret, type LlmRoute } from "@open-slidestudio/slides-runtime";
import { createPresentationRun } from "@open-slidestudio/presentation-run";
import {
  DSH_ATTACHMENTS_UNAVAILABLE,
  DshLlmPort,
  type DshAttachmentService,
  type DshGenerateOptions,
  type DshGenerateOptionsLike,
  type DshLlmService,
  type DshStreamChunk,
} from "./dsh-llm-port.js";

// Compile-time contract: real DSH LlmRuntime and AttachmentStore must satisfy DshLlmPort without casts.
export function assertRealDshServiceAssignability(llm: LlmRuntime, attachments: AttachmentStore): DshLlmPort {
  const llmService: DshLlmService = llm;
  const attachmentService: DshAttachmentService = attachments;
  return new DshLlmPort({ llm: llmService, attachments: attachmentService, route: ROUTE });
}

const ROUTE: LlmRoute = {
  providerId: "llm-pi-ai",
  modelId: "test-model",
  contextWindow: 64_000,
  maxTokens: 4_000,
  inputModalities: ["text", "image"],
  reasoningEffort: "medium",
};

type Script = (options: DshGenerateOptionsLike) => AsyncIterable<DshStreamChunk>;

function fakeLlm(script: Script) {
  const requests: DshGenerateOptions[] = [];
  return {
    requests,
    llm: {
      stream(options: DshGenerateOptionsLike) {
        requests.push(options as DshGenerateOptions);
        return script(options);
      },
    },
  };
}

function chunks(list: readonly DshStreamChunk[]): Script {
  return async function* () {
    for (const chunk of list) yield chunk;
  };
}

function savingAttachments() {
  const saved: { mediaType: string; bytes: number }[] = [];
  const attachments: DshAttachmentService = {
    async saveImage(input) {
      saved.push({ mediaType: input.mediaType, bytes: input.data.byteLength });
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 2,
        height: 2,
      };
    },
  };
  return { saved, attachments };
}

const now = Date.now();

function context(
  messages: Message[],
  systemPrompt = "你是导演",
  tools = [{ name: "read_page", description: "读页", parameters: { type: "object" } }],
) {
  return normalizeContext({ systemPrompt, tools, messages });
}

async function collect(port: DshLlmPort, messages: Message[], options?: SimpleStreamOptions) {
  const stream = await port.stream(port.model, context(messages), options);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, final: await stream.result() };
}

const user = (content: Message["content"] & unknown): Message => ({ role: "user", content, timestamp: now }) as Message;

test("text and reasoning chunks become text_* / thinking_* events with usage and stop", async () => {
  const { llm, requests } = fakeLlm(
    chunks([
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "先想" },
      { type: "reasoning-delta", index: 0, text: "一下" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "先想一下" } },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "你好" },
      { type: "block-end", index: 1, block: { type: "text", text: "你好！" } },
      { type: "usage", usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 40, reasoningTokens: 3 } },
      { type: "finish", reason: { kind: "stop" } },
    ]),
  );
  const port = new DshLlmPort({ llm, route: ROUTE, temperature: 0.2 });
  const { events, final } = await collect(port, [user("打个招呼")], { maxTokens: 900 });
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ],
  );
  assert.equal(final.stopReason, "stop");
  assert.deepEqual(final.content, [
    { type: "thinking", thinking: "先想一下" },
    { type: "text", text: "你好！" },
  ]);
  assert.equal(final.usage.input, 120);
  assert.equal(final.usage.cacheRead, 40);
  assert.equal(final.usage.reasoning, 3);
  assert.equal(final.usage.totalTokens, 168);
  const request = requests[0]!;
  assert.equal(request.provider, "llm-pi-ai");
  assert.equal(request.model, "test-model");
  assert.equal(request.system, "你是导演");
  assert.equal(request.reasoningEffort, "medium");
  assert.equal(request.temperature, 0.2);
  assert.equal(request.maxTokens, 900);
  assert.deepEqual(request.tools, [{ name: "read_page", description: "读页", parameters: { type: "object" } }]);
  assert.deepEqual(request.messages, [{ role: "user", content: [{ type: "text", text: "打个招呼" }] }]);
});

test("tool-call deltas are concatenated and parsed; finish tool-calls maps to toolUse; bad JSON is flagged", async () => {
  const { llm } = fakeLlm(
    chunks([
      { type: "tool-call-delta", index: 0, id: "call-1", name: "write_page", argumentsDelta: '{"id":"p0' },
      { type: "tool-call-delta", index: 0, id: "call-1", argumentsDelta: '1","title":"标题"}' },
      { type: "tool-call-delta", index: 1, id: "call-2", name: "read_page", argumentsDelta: '{"id":' },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]),
  );
  const port = new DshLlmPort({ llm, route: ROUTE });
  const { events, final } = await collect(port, [user("写")]);
  assert.equal(final.stopReason, "toolUse");
  assert.equal(events.filter((event) => event.type === "toolcall_delta").length, 3);
  assert.deepEqual(final.content[0], {
    type: "toolCall",
    id: "call-1",
    name: "write_page",
    arguments: { id: "p01", title: "标题" },
  });
  const broken = final.content[1] as { arguments: unknown; argumentsError?: string };
  assert.deepEqual(broken.arguments, {});
  assert.match(broken.argumentsError ?? "", /not valid JSON/);
});

test("a block-end tool call carries the authoritative arguments; max-tokens maps to length", async () => {
  const { llm } = fakeLlm(
    chunks([
      { type: "block-start", index: 0, blockType: "tool-call" },
      { type: "tool-call-delta", index: 0, id: "c", name: "read_page", argumentsDelta: '{"id":"x' },
      {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id: "c", name: "read_page", arguments: '{"id":"p02"}' },
      },
      { type: "finish", reason: { kind: "max-tokens" } },
    ]),
  );
  const { final } = await collect(new DshLlmPort({ llm, route: ROUTE }), [user("读")]);
  assert.equal(final.stopReason, "length");
  assert.deepEqual((final.content[0] as { arguments: unknown }).arguments, { id: "p02" });
});

test("history is converted: assistant tool calls, tool results and inline images promoted once via attachments", async () => {
  const { llm, requests } = fakeLlm(chunks([{ type: "finish", reason: { kind: "stop" } }]));
  const { saved, attachments } = savingAttachments();
  const port = new DshLlmPort({ llm, attachments, route: ROUTE });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
  const history: Message[] = [
    user([
      { type: "text", text: "看图" },
      { type: "image", data: png, mimeType: "image/png" },
    ]),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想" },
        { type: "toolCall", id: "t1", name: "render_page", arguments: { id: "p01" } },
      ],
      api: "dsh-llm",
      provider: "llm-pi-ai",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: now,
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "render_page",
      content: [
        { type: "text", text: "{}" },
        { type: "image", data: png, mimeType: "image/png" },
      ],
      isError: true,
      timestamp: now,
    },
  ];
  await collect(port, history);
  await collect(port, history);
  assert.equal(saved.length, 1, "identical image bytes are saved once per port");
  const [first, assistant, tool] = requests[1]!.messages;
  assert.deepEqual(first, {
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png", bytes: 7, width: 2, height: 2 } },
    ],
  });
  assert.equal(assistant!.role, "assistant");
  assert.deepEqual((assistant as { source: unknown }).source, {
    kind: "model",
    provider: "llm-pi-ai",
    model: "test-model",
  });
  assert.deepEqual((assistant as { content: readonly unknown[] }).content[1], {
    type: "tool-call",
    id: "t1",
    name: "render_page",
    arguments: '{"id":"p01"}',
  });
  assert.equal(tool!.role, "tool");
  assert.equal((tool as { toolCallId: string }).toolCallId, "t1");
  assert.equal((tool as { isError?: boolean }).isError, true);
  assert.deepEqual((tool as { source: unknown }).source, { kind: "tool", callId: "t1" });
});

test("an inline image without the attachments service fails closed before any DSH request", async () => {
  const { llm, requests } = fakeLlm(chunks([{ type: "finish", reason: { kind: "stop" } }]));
  const port = new DshLlmPort({ llm, route: ROUTE });
  const { final } = await collect(port, [user([{ type: "image", data: "AAAA", mimeType: "image/png" }])]);
  assert.equal(final.stopReason, "error");
  assert.equal(readLlmFailure(final)?.code, DSH_ATTACHMENTS_UNAVAILABLE);
  assert.equal(requests.length, 0);
});

test("failures keep code, status, Retry-After and request id; aborts and transport errors are structured", async () => {
  const failing = fakeLlm(
    chunks([
      { type: "text-delta", index: 0, text: "部分" },
      {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            code: "RATE_LIMIT",
            message: "429 Too Many Requests",
            status: 429,
            providerRetryAfterMs: 12_000,
            requestId: "req-9",
          },
        },
      },
    ]),
  );
  const failed = (await collect(new DshLlmPort({ llm: failing.llm, route: ROUTE }), [user("x")])).final;
  assert.equal(failed.stopReason, "error");
  assert.deepEqual(readLlmFailure(failed), {
    code: "RATE_LIMIT",
    message: "429 Too Many Requests",
    status: 429,
    retryAfterMs: 12_000,
    requestId: "req-9",
  });
  assert.equal((failed.content[0] as { text: string }).text, "部分", "partial output survives");

  const aborted = fakeLlm(
    chunks([{ type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "cancelled" } } }]),
  );
  assert.equal(
    (await collect(new DshLlmPort({ llm: aborted.llm, route: ROUTE }), [user("x")])).final.stopReason,
    "aborted",
  );

  const throwing = fakeLlm(async function* () {
    yield { type: "text-delta", index: 0, text: "a" } as DshStreamChunk;
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  });
  const thrown = (await collect(new DshLlmPort({ llm: throwing.llm, route: ROUTE }), [user("x")])).final;
  assert.equal(readLlmFailure(thrown)?.code, "ECONNRESET");

  const truncated = fakeLlm(chunks([{ type: "text-delta", index: 0, text: "a" }]));
  assert.equal(
    readLlmFailure((await collect(new DshLlmPort({ llm: truncated.llm, route: ROUTE }), [user("x")])).final)?.code,
    "STREAM_INCOMPLETE",
  );

  const controller = new AbortController();
  const hanging = fakeLlm(async function* (options) {
    await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
    yield* [];
  });
  const pending = collect(new DshLlmPort({ llm: hanging.llm, route: ROUTE }), [user("x")], {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hanging.requests[0]!.signal, controller.signal, "the abort signal reaches ctx.llm.stream");
  controller.abort();
  assert.equal((await pending).final.stopReason, "aborted");
});

test("SlidesAgentRuntime runs over DshLlmPort and classifies a DSH 429 as provider-rate-limit", async () => {
  const { llm } = fakeLlm(
    chunks([
      {
        type: "finish",
        reason: {
          kind: "error",
          failure: { code: "RATE_LIMIT", message: "busy", status: 429, providerRetryAfterMs: 1_000 },
        },
      },
    ]),
  );
  const runtime = createSlidesRuntime({
    llm: new DshLlmPort({ llm, route: ROUTE }),
    toolDeps: { presentation: createPresentationRun(), editorBaseUrl: "http://127.0.0.1:9" },
    rateLimit: { maxAttempts: 0 },
  });
  const result = await runtime.prompt("你好");
  assert.equal(result.status, "failed");
  assert.equal(result.fault?.code, "provider-rate-limit");
  assert.equal(result.fault?.retryAfterMs, 1_000);
});

test("finish.replayState round-trips into the next turn, preserves long signatures, scrubs registered secrets, and sums cached tokens", async () => {
  const secret = "replay-registered-secret-88776655";
  registerSecret(secret);
  const longSig = "A".repeat(320);
  const shared = { note: `echo ${secret}` };
  const cyclic: Record<string, unknown> = { label: `token ${secret}` };
  cyclic.self = cyclic;
  const envelope = {
    response: { id: "resp-42", left: shared, right: shared, cyclic },
    blocks: [{ sig: longSig }],
  };
  let turn = 0;
  const { llm, requests } = fakeLlm(async function* () {
    turn += 1;
    if (turn === 1) {
      yield { type: "text-delta", index: 0, text: "第一轮" };
      yield {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 20 },
      };
      yield { type: "finish", reason: { kind: "stop" }, replayState: envelope };
      return;
    }
    yield { type: "text-delta", index: 0, text: "第二轮" };
    yield { type: "finish", reason: { kind: "stop" } };
  });
  const port = new DshLlmPort({ llm, route: ROUTE });
  const first = await collect(port, [user("先回答")]);
  assert.equal(first.final.usage.totalTokens, 65, "input(10) + output(5) + cacheRead(30) + cacheWrite(20)");
  const diagText = JSON.stringify(first.final.diagnostics);
  assert.doesNotMatch(diagText, new RegExp(secret), "secret scrubbed across shared and cyclic references in-memory");
  await collect(port, [user("先回答"), first.final, user("继续")]);
  const assistantMsg = requests[1]!.messages.find((m) => m.role === "assistant") as
    { source: { replayState?: Record<string, unknown> } } | undefined;
  assert.deepEqual(assistantMsg?.source.replayState, {
    response: {
      id: "resp-42",
      left: { note: "echo [redacted]" },
      right: { note: "echo [redacted]" },
      cyclic: { label: "token [redacted]", self: "[circular]" },
    },
    blocks: [{ sig: longSig }],
  });
});

test("cyclic replayState in a bound SlidesAgentRuntime persists assistant reply cleanly to session and trace logs", async () => {
  const secret = "cyclic-bound-secret-77665544";
  registerSecret(secret);
  const longSig = "B".repeat(320);
  const shared = { note: `shared ${secret}`, sig: longSig };
  const nodeA: Record<string, unknown> = { name: `A ${secret}` };
  const nodeB: Record<string, unknown> = { name: `B ${secret}`, next: nodeA };
  nodeA.next = nodeB;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cyclic-replay-"));
  const projectRoot = path.join(dataRoot, "proj-1");
  fs.mkdirSync(projectRoot, { recursive: true });
  const { llm } = fakeLlm(
    chunks([
      { type: "text-delta", index: 0, text: "已保存的助手回复" },
      {
        type: "finish",
        reason: { kind: "stop" },
        replayState: {
          diagnostics: [shared, shared],
          fromA: nodeA,
          fromB: nodeB,
        },
      },
    ]),
  );
  const rt1 = createSlidesRuntime({
    llm: new DshLlmPort({ llm, route: ROUTE }),
    dataRoot,
    project: { projectId: "proj-1", projectRoot },
    toolDeps: { presentation: createPresentationRun(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const res = await rt1.prompt("请回复一次");
  assert.equal(res.status, "completed");
  const sessionText = fs.readFileSync(path.join(projectRoot, "_agent", "runtime-session.v1.jsonl"), "utf8");
  const traceText = fs.readFileSync(path.join(projectRoot, "_agent", "agent-trace.jsonl"), "utf8");
  assert.doesNotMatch(sessionText, new RegExp(secret));
  assert.match(sessionText, /已保存的助手回复/);
  assert.doesNotMatch(sessionText, /\[redacted binary data\]/);
  assert.match(traceText, /已保存的助手回复/);
  const rows = sessionText
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          message?: { role?: string; diagnostics?: { details?: { replayState?: unknown } }[] };
        },
    );
  const assistantRow = rows.find((r) => r.type === "message" && r.message?.role === "assistant");
  const savedReplay = assistantRow?.message?.diagnostics?.[0]?.details?.replayState as {
    diagnostics: { note: string; sig: string }[];
    fromA: { name: string; next: { name: string; next: string } };
    fromB: { name: string; next: { name: string; next: string } };
  };
  assert.deepEqual(savedReplay.diagnostics, [
    { note: "shared [redacted]", sig: longSig },
    { note: "shared [redacted]", sig: longSig },
  ]);
  assert.deepEqual(savedReplay.fromA, { name: "A [redacted]", next: { name: "B [redacted]", next: "[circular]" } });
  assert.deepEqual(savedReplay.fromB, { name: "B [redacted]", next: { name: "A [redacted]", next: "[circular]" } });
  // Reconstructing a fresh runtime must recover the completed assistant reply and refuse resume().
  const rt2 = createSlidesRuntime({
    llm: new DshLlmPort({ llm, route: ROUTE }),
    dataRoot,
    project: { projectId: "proj-1", projectRoot },
    toolDeps: { presentation: createPresentationRun(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  assert.equal(rt2.messages.at(-1)?.role, "assistant");
  await assert.rejects(() => rt2.resume(), /nothing to resume/);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
