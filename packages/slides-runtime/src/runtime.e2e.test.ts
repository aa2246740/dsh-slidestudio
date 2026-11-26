import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderFixturePage } from "@open-slidestudio/presentation-run/testkit";
import { acquireProjectLease, readProjectLease } from "@open-slidestudio/slides-tools";
import { createSlidesRuntime, type RuntimeEvent, type SlidesAgentRuntime } from "./runtime.js";
import { RUNTIME_SESSION_REL } from "./session-store.js";
import { AGENT_TRACE_REL } from "./trace-projection.js";
import { PiAiConfigError, PiAiLlmPort } from "./llm-port-pi-ai.js";
import { readLlmFailure } from "./llm-port.js";
import {
  lastResultData,
  pageArgs,
  ScriptedLlm,
  tempDir,
  testPresentation,
  waitFor,
  type ScriptStep,
} from "./testkit.js";

// No browser runs: rasters are the synthetic ones the presentation-run testkit records.
process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = "/nonexistent/slides-runtime-test/runtime.mjs";

const IDS = ["p01", "p02"];

function runtimeFor(
  dataRoot: string,
  steps: readonly ScriptStep[],
  extra: Partial<Parameters<typeof createSlidesRuntime>[0]> = {},
) {
  const llm = new ScriptedLlm(steps);
  const runtime = createSlidesRuntime({
    llm,
    dataRoot,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
    ...extra,
  });
  return { llm, runtime };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ calls: [{ name, args }] });

function rootOf(runtime: SlidesAgentRuntime): string {
  const root = runtime.binding?.projectRoot;
  assert.ok(root, "project is bound");
  return root;
}

function produceSteps(runtime: () => SlidesAgentRuntime): ScriptStep[] {
  const plan = IDS.map((pageId, index) => ({
    pageId,
    title: `标题 ${pageId}`,
    layoutFamily: "content",
    exhibits: [],
    purpose: index ? "evidence" : "cover",
  }));
  return [
    () => call("open_project", { title: "季度复盘" }),
    () => call("list_references"),
    (context) => {
      const payload = lastResultData(context, "list_references").payload as {
        missingReferenceChunks: { sourceId: string; chunkIndex: number }[];
      };
      assert.ok(payload.missingReferenceChunks.length > 0);
      return { calls: payload.missingReferenceChunks.map((chunk) => ({ name: "read_reference", args: chunk })) };
    },
    () => call("commit_design", { slidePlan: plan }),
    () =>
      call("write_todo", {
        items: IDS.map((pageId) => ({ pageId, title: `标题 ${pageId}`, layoutFamily: "content", exhibits: ["none"] })),
      }),
    () => call("write_page", pageArgs("p01")),
    () => {
      renderFixturePage(rootOf(runtime()), "p01");
      return call("write_page", pageArgs("p02"));
    },
    () => {
      renderFixturePage(rootOf(runtime()), "p02");
      return call("review_pages");
    },
    () => call("compose_deck", { title: "季度复盘" }),
    () => call("export_deck"),
    () => ({ text: "已完成导出。" }),
  ];
}

test("offline produce chain through the core loop: open -> references -> plan -> write -> review -> compose -> export", async () => {
  const dataRoot = tempDir("chain");
  const ref: { runtime?: SlidesAgentRuntime } = {};
  const { runtime } = runtimeFor(
    dataRoot,
    produceSteps(() => ref.runtime!),
  );
  ref.runtime = runtime;
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  const result = await runtime.prompt("做一份季度复盘，两页。");
  assert.equal(result.status, "completed", JSON.stringify(result.fault));
  assert.equal(result.text, "已完成导出。");
  const root = rootOf(runtime);
  for (const name of ["open_project", "list_references", "read_reference", "commit_design", "write_todo"]) {
    assert.ok(result.toolNames.includes(name), name);
  }
  const exported = lastResultData({ messages: runtime.messages } as never, "export_deck");
  const payload = exported.payload as {
    src: string;
    report: { ok: boolean; slideCount: number; nativeCoverage: number };
  };
  assert.equal(payload.report.ok, true);
  assert.equal(payload.report.slideCount, 2);
  assert.equal(payload.report.nativeCoverage, 1, "the export is natively editable");
  assert.ok(fs.existsSync(path.join(root, payload.src)), "the exported artifact exists");
  const failedResults = runtime.messages.filter(
    (message) => (message as { role?: string }).role === "toolResult" && (message as { isError?: boolean }).isError,
  );
  assert.deepEqual(failedResults, [], "no tool failed in the scripted chain");

  const session = fs
    .readFileSync(path.join(root, RUNTIME_SESSION_REL), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(session[0].type, "turn/start", "records buffered before open_project are flushed");
  assert.equal(session.at(-1).type, "turn/end");
  assert.equal(session.at(-1).reason.kind, "completed");
  const trace = fs
    .readFileSync(path.join(root, AGENT_TRACE_REL), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(trace.some((row) => row.kind === "tool" && row.name === "export_deck"));
  assert.ok(trace.some((row) => row.kind === "result" && row.status === "complete"));
  assert.equal(trace.at(-1).id, "turn:1");
  assert.equal(trace.at(-1).status, "complete");
  assert.equal(readProjectLease(root).holder, undefined, "the writer lease is released at turn end");
  assert.ok(events.some((event) => event.type === "turn/end"));
});

test("ask_user_question suspends, resumes on answer, reports cancel, and honors abort", async () => {
  const dataRoot = tempDir("questions");
  const question = { questions: [{ id: "tone", question: "风格？", options: [{ label: "简洁" }, { label: "活泼" }] }] };
  const { runtime, llm } = runtimeFor(
    dataRoot,
    [
      () => call("open_project", { title: "提问" }),
      () => call("ask_user_question", question),
      (context) => ({ text: `收到：${JSON.stringify(lastResultData(context, "ask_user_question").answers)}` }),
      () => call("ask_user_question", question),
      (context) => ({ text: `取消：${String(lastResultData(context, "ask_user_question").error)}` }),
      () => call("ask_user_question", question),
    ],
    { userQuestions: true },
  );
  const first = runtime.prompt("先问我风格");
  await waitFor(() => runtime.listQuestions().some((row) => row.status === "pending"));
  const pending = runtime.listQuestions().find((row) => row.status === "pending")!;
  const file = path.join(rootOf(runtime), "_agent", "assistant-questions.v1.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[0].status, "pending", "the question is persisted");
  assert.throws(() => runtime.answerQuestion(pending.id, { answers: [{ id: "tone", selected: ["未提供"] }] }));
  runtime.answerQuestion(pending.id, { answers: [{ id: "tone", selected: ["简洁"] }] });
  const answered = await first;
  assert.equal(answered.status, "completed");
  assert.match(answered.text ?? "", /简洁/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[0].status, "answered");

  const second = runtime.prompt("再问一次");
  await waitFor(() => runtime.listQuestions().some((row) => row.status === "pending"));
  runtime.cancelQuestion(runtime.listQuestions().find((row) => row.status === "pending")!.id);
  assert.match((await second).text ?? "", /ASK_CANCELLED/);

  const third = runtime.prompt("第三次");
  await waitFor(() => runtime.listQuestions().some((row) => row.status === "pending"));
  runtime.abort();
  const aborted = await third;
  assert.equal(aborted.status, "aborted");
  assert.equal(runtime.listQuestions().at(-1)?.status, "cancelled", "abort settles the waiting question");
  assert.equal(llm.requests.length, 6, "no model request after the abort");
});

test("session log survives a truncated tail and an unclosed turn, and the run resumes", async () => {
  const dataRoot = tempDir("recover");
  const { runtime } = runtimeFor(dataRoot, [
    () => call("open_project", { title: "恢复" }),
    () => ({ text: "第一轮完成" }),
  ]);
  assert.equal((await runtime.prompt("第一轮")).status, "completed");
  const project = runtime.binding!;
  await runtime.dispose();
  const log = path.join(project.projectRoot, RUNTIME_SESSION_REL);
  const user = { role: "user", content: "第二轮", timestamp: Date.now() };
  const toolCall = { type: "toolCall", id: "dangling-1", name: "list_references", arguments: {} };
  const assistant = {
    role: "assistant",
    content: [toolCall],
    api: "scripted",
    provider: "scripted",
    model: "m",
    usage: {},
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  fs.appendFileSync(
    log,
    [
      JSON.stringify({ v: 1, seq: 90, at: "x", type: "turn/start", turn: 2 }),
      JSON.stringify({ v: 1, seq: 91, at: "x", type: "message", turn: 2, message: user }),
      JSON.stringify({ v: 1, seq: 92, at: "x", type: "message", turn: 2, message: assistant }),
      '{"v":1,"seq":93,"type":"mess',
    ].join("\n"),
  );
  const { runtime: revived, llm } = runtimeFor(dataRoot, [() => ({ text: "已续跑" })], { project });
  assert.equal(revived.recovery?.interruptedTurn, 2);
  assert.equal(revived.recovery?.truncatedTail, true);
  const repaired = revived.messages.find((message) => (message as { toolCallId?: string }).toolCallId === "dangling-1");
  assert.ok(repaired, "the dangling tool call received an interrupted result");
  const resumed = await revived.resume();
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.turn, 3);
  assert.equal(resumed.text, "已续跑");
  assert.ok(
    llm.requests[0]!.context.messages.some((message) => message.role === "user" && message.content === "第一轮"),
  );
  const records = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  assert.ok(records.some((row) => row.type === "turn/end" && row.turn === 2 && row.reason.kind === "interrupted"));
  assert.equal(records.at(-1).type, "turn/end");
});

test("writer lease: acquired per turn, renewed by heartbeat, lost to an editor takeover, released on abort", async () => {
  const dataRoot = tempDir("lease");
  let leaseSeen: ReturnType<typeof readProjectLease> | undefined;
  let gotRoot = "";
  const { runtime } = runtimeFor(
    dataRoot,
    [
      () => call("open_project", { title: "租约" }),
      () => {
        gotRoot = rootOf(runtimeRef);
        leaseSeen = readProjectLease(gotRoot);
        return { hang: true };
      },
    ],
    { lease: { heartbeatMs: 20, ttlMs: 60_000 } },
  );
  const runtimeRef = runtime;
  const lost: RuntimeEvent[] = [];
  runtime.subscribe((event) => event.type === "lease/lost" && lost.push(event));
  const run = runtime.prompt("写");
  await waitFor(() => Boolean(leaseSeen));
  assert.equal(leaseSeen?.holder?.ownerId, runtime.caller.id);
  const renewedAt = leaseSeen?.holder?.renewedAt;
  await waitFor(() => readProjectLease(gotRoot).holder?.renewedAt !== renewedAt);
  const takeover = acquireProjectLease(gotRoot, {
    kind: "editor-human",
    ownerId: "editor-human:tab",
    now: Date.now() + 120_000,
  });
  assert.equal(takeover.ok, true);
  const result = await run;
  assert.equal(result.status, "paused");
  assert.equal(result.fault?.code, "writer-lease-lost");
  assert.equal(lost.length, 1);
  assert.equal(
    readProjectLease(gotRoot).holder?.ownerId,
    "editor-human:tab",
    "the editor lease is never released by the run",
  );

  const { runtime: second } = runtimeFor(dataRoot, [() => ({ text: "不会执行" })], { project: runtime.binding! });
  const refused = await second.prompt("再写");
  assert.equal(refused.status, "paused", "a turn without the lease fails closed before any model call");
  assert.equal(refused.fault?.code, "lease-conflict");
});

test("an MCP-kind caller is preempted by the editor and fails closed; abort releases its lease", async () => {
  const dataRoot = tempDir("preempt");
  let root = "";
  const { runtime } = runtimeFor(
    dataRoot,
    [
      () => call("open_project", { title: "抢占" }),
      () => {
        root = rootOf(runtimeRef);
        return { hang: true };
      },
    ],
    { caller: { kind: "mcp", id: "mcp:runtime-test" }, lease: { heartbeatMs: 20 } },
  );
  const runtimeRef = runtime;
  const run = runtime.prompt("写");
  await waitFor(() => Boolean(root));
  assert.equal(acquireProjectLease(root, { kind: "editor-human", ownerId: "editor-human:t" }).ok, true);
  const result = await run;
  assert.equal(result.fault?.code, "lease-preempted-by-editor");

  const { runtime: other } = runtimeFor(tempDir("abort"), [
    () => call("open_project", { title: "中止" }),
    () => ({ hang: true }),
  ]);
  const pending = other.prompt("写");
  await waitFor(() => Boolean(other.binding) && readProjectLease(other.binding!.projectRoot).holder !== undefined);
  other.abort();
  assert.equal((await pending).status, "aborted");
  assert.equal(readProjectLease(other.binding!.projectRoot).holder, undefined, "abort releases the lease");
});

test("steer() injects a user message after the current step; abort() stops a hanging request", async () => {
  const dataRoot = tempDir("steer");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { runtime, llm } = runtimeFor(dataRoot, [
    async () => {
      await gate;
      return call("open_project", { title: "转向" });
    },
    (context) => {
      const steered = context.messages.some((message) => message.role === "user" && message.content === "改成三页");
      return { text: steered ? "已按转向调整" : "未见转向" };
    },
    () => ({ hang: true }),
  ]);
  const run = runtime.prompt("两页");
  await waitFor(() => llm.requests.length === 1);
  runtime.steer("改成三页");
  release();
  assert.equal((await run).text, "已按转向调整");
  const hanging = runtime.prompt("继续");
  await waitFor(() => llm.requests.length === 3);
  runtime.abort();
  const stopped = await hanging;
  assert.equal(stopped.status, "aborted");
  assert.equal(stopped.fault?.code, "operator-stop");
});

test("PiAiLlmPort constructs offline and maps transport failures to structured errors", async () => {
  assert.throws(
    () =>
      new PiAiLlmPort({
        kind: "openai-compatible",
        baseUrl: "not a url",
        modelId: "m",
        contextWindow: 8000,
        maxTokens: 1000,
      }),
    PiAiConfigError,
  );
  const port = new PiAiLlmPort({
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:9/v1",
    modelId: "local-model",
    apiKey: "sk-test-local-0123456789",
    contextWindow: 32_000,
    maxTokens: 2_000,
    inputModalities: ["text"],
    maxRetries: 0,
  });
  assert.equal(port.route.providerId, "openai-compatible");
  assert.equal(port.model.api, "openai-completions");
  const { normalizeContext } = await import("@earendil-works/pi-ai");
  const stream = await port.stream(
    port.model,
    normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
    { maxTokens: 10 },
  );
  const final = await stream.result();
  assert.equal(final.stopReason, "error");
  const failure = readLlmFailure(final);
  assert.ok(failure, "the failure is structured");
  assert.doesNotMatch(JSON.stringify(final), /sk-test-local-0123456789/, "the API key never appears in the failure");
});

test("PiAiLlmPort maps a loopback 429 with Retry-After to a structured rate-limit failure", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: listenPort } = server.address() as { port: number };
  try {
    const port = new PiAiLlmPort({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${listenPort}/v1`,
      modelId: "local-model",
      apiKey: "sk-loopback-test-0123456789",
      contextWindow: 32_000,
      maxTokens: 2_000,
      maxRetries: 0,
    });
    const { normalizeContext } = await import("@earendil-works/pi-ai");
    const stream = await port.stream(
      port.model,
      normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
      {},
    );
    const failure = readLlmFailure(await stream.result());
    assert.equal(failure?.status, 429);
    assert.equal(failure?.code, "RATE_LIMIT");
    assert.equal(failure?.retryAfterMs, 7_000);
    const { classifyLlmFailure } = await import("./faults.js");
    assert.equal(classifyLlmFailure(failure!).code, "provider-rate-limit");
  } finally {
    server.close();
  }
});

test("429 backoff honors Retry-After and resumes; a provider overflow escalates the budget once and retries", async () => {
  const waits: number[] = [];
  const { runtime, llm } = runtimeFor(
    tempDir("retry"),
    [
      () => ({ failure: { code: "RATE_LIMIT", message: "slow down", status: 429, retryAfterMs: 2_500 } }),
      () => ({ failure: { code: "RATE_LIMIT", message: "slow down", status: 429 } }),
      () => ({ text: "限流后恢复" }),
      () => ({ failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "maximum context length exceeded" } }),
      () => ({ text: "压缩后恢复" }),
      () => ({ failure: { code: "AUTH", message: "401 invalid api key", status: 401 } }),
    ],
    { rateLimit: { maxAttempts: 3, sleep: async (ms) => (waits.push(ms), true) } },
  );
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  const limited = await runtime.prompt("一");
  assert.equal(limited.status, "completed");
  assert.equal(limited.text, "限流后恢复");
  assert.deepEqual(waits, [2_500, 30_000], "Retry-After first, then the second backoff step");
  assert.equal(
    runtime.messages.filter((message) => (message as { stopReason?: string }).stopReason === "error").length,
    0,
    "failed replies are dropped before continuing",
  );
  const overflow = await runtime.prompt("二");
  assert.equal(overflow.text, "压缩后恢复");
  assert.ok(events.some((event) => event.type === "context/escalate"));
  const auth = await runtime.prompt("三");
  assert.equal(auth.status, "failed");
  assert.equal(auth.fault?.code, "provider-auth");
  assert.equal(llm.requests.length, 6, "a hard auth failure is not retried");
});
