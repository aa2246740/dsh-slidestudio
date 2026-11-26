import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  acquireProjectLease,
  readProjectLease,
  type PostTurnHook,
  type SlideToolDefinition,
} from "@open-slidestudio/slides-tools";
import { PiAiLlmPort } from "./llm-port-pi-ai.js";
import { createSlidesRuntime } from "./runtime.js";
import { RUNTIME_SESSION_REL } from "./session-store.js";
import { lastResultData, pageArgs, ScriptedLlm, tempDir, testPresentation, waitFor } from "./testkit.js";
import { adaptSlideTool, SerialGate } from "./tool-adapter.js";
import { AGENT_TRACE_REL } from "./trace-projection.js";
import { ASSISTANT_QUESTIONS_REL } from "./user-question.js";

process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = "/nonexistent/slides-runtime-hardening/runtime.mjs";

const call = (name: string, args: Record<string, unknown> = {}) => ({ calls: [{ name, args }] });
const readText = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

test("lease boundary: refused pre-turn, mid-turn bind, preemption, and second constructor write zero bytes", async () => {
  const dataRoot = tempDir("lease-boundary");
  const { runtime: seed } = (() => {
    const llm = new ScriptedLlm([() => call("open_project", { title: "边界" }), () => ({ text: "ok" })]);
    return {
      runtime: createSlidesRuntime({
        llm,
        dataRoot,
        toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
      }),
    };
  })();
  assert.equal((await seed.prompt("建项目")).status, "completed");
  const project = seed.binding!;
  const sessionFile = path.join(project.projectRoot, RUNTIME_SESSION_REL);
  const traceFile = path.join(project.projectRoot, AGENT_TRACE_REL);

  // 1. Pre-turn lease refusal writes zero bytes and runs zero hooks.
  assert.equal(acquireProjectLease(project.projectRoot, { kind: "editor-human", ownerId: "editor-human:e1" }).ok, true);
  const beforeSession = readText(sessionFile);
  const beforeTrace = readText(traceFile);
  let hookCalls = 0;
  const hook: PostTurnHook = { name: "spy", run: async () => void (hookCalls += 1) };
  const blocked = createSlidesRuntime({
    llm: new ScriptedLlm([() => ({ text: "unreachable" })]),
    dataRoot,
    project,
    postTurnHooks: [hook],
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const refused = await blocked.prompt("不应落盘");
  assert.equal(refused.fault?.code, "lease-conflict");
  assert.equal(hookCalls, 0);
  assert.equal(readText(sessionFile), beforeSession, "refused turn writes nothing to session log");
  assert.equal(readText(traceFile), beforeTrace, "refused turn writes nothing to trace");

  // 2. Mid-turn bind on an editor-held project flushes zero buffered rows.
  const midBind = createSlidesRuntime({
    llm: new ScriptedLlm([() => call("open_project", { title: "边界" }), () => ({ text: "unreachable" })]),
    dataRoot,
    postTurnHooks: [hook],
    toolDeps: {
      presentation: testPresentation(),
      editorBaseUrl: "http://127.0.0.1:9",
      projects: {
        open: () => ({
          created: false,
          projectId: project.projectId,
          projectRoot: project.projectRoot,
          displayRoot: project.projectRoot,
          design: { kind: "self-directed" },
        }),
      },
    },
  });
  const midRefused = await midBind.prompt("中途绑定");
  assert.equal(midRefused.fault?.code, "lease-conflict");
  assert.equal(hookCalls, 0);
  assert.equal(readText(sessionFile), beforeSession, "failed mid-turn bind flushes nothing to session log");
  assert.equal(readText(traceFile), beforeTrace, "failed mid-turn bind flushes nothing to trace");
});

test("editor preemption skips hooks and post-preemption log writes; second runtime constructor never mutates live turn", async () => {
  const dataRoot = tempDir("preempt-clean");
  const question = { questions: [{ id: "q1", question: "风格？", options: [{ label: "稳重" }] }] };
  let hookCalls = 0;
  const hook: PostTurnHook = { name: "spy", run: async () => void (hookCalls += 1) };
  const rt = createSlidesRuntime({
    llm: new ScriptedLlm([
      () => call("open_project", { title: "活跃" }),
      () => call("ask_user_question", question),
      () => ({ text: "完成" }),
    ]),
    dataRoot,
    caller: { kind: "mcp", id: "mcp:active-run" },
    userQuestions: true,
    lease: { heartbeatMs: 20 },
    postTurnHooks: [hook],
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const pending = rt.prompt("提问并等待");
  await waitFor(() => rt.listQuestions().some((q) => q.status === "pending"));
  const project = rt.binding!;
  const sessionFile = path.join(project.projectRoot, RUNTIME_SESSION_REL);
  const traceFile = path.join(project.projectRoot, AGENT_TRACE_REL);
  const questionsFile = path.join(project.projectRoot, ASSISTANT_QUESTIONS_REL);
  const snapSession = readText(sessionFile);
  const snapTrace = readText(traceFile);
  const snapQuestions = readText(questionsFile);

  // Constructing a second runtime against the live project must be strictly read-only.
  const observer = createSlidesRuntime({
    llm: new ScriptedLlm([() => ({ text: "unused" })]),
    dataRoot,
    project,
    userQuestions: true,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  assert.equal(observer.recovery?.interruptedTurn, 1);
  assert.equal(readText(sessionFile), snapSession, "constructor must not append interrupted turn/end");
  assert.equal(readText(traceFile), snapTrace, "constructor must not write interrupted trace row");
  assert.equal(readText(questionsFile), snapQuestions, "constructor must not mark live question interrupted");

  // Editor preempts the MCP runtime: no hooks run, no fault/turn/end or question rewrite hits disk.
  assert.equal(
    acquireProjectLease(project.projectRoot, { kind: "editor-human", ownerId: "editor-human:tab" }).ok,
    true,
  );
  const snapAfterPreempt = { s: readText(sessionFile), t: readText(traceFile), q: readText(questionsFile) };
  const res = await pending;
  assert.equal(res.fault?.code, "lease-preempted-by-editor");
  assert.equal(hookCalls, 0, "post-turn hook must not run after editor preemption");
  assert.equal(readText(sessionFile), snapAfterPreempt.s, "no session records written after preemption");
  assert.equal(readText(traceFile), snapAfterPreempt.t, "no trace rows written after preemption");
  assert.equal(readText(questionsFile), snapAfterPreempt.q, "no question rows mutated after preemption");
  assert.equal(readProjectLease(project.projectRoot).holder?.ownerId, "editor-human:tab");
});

test("provider 429 echoing an API key never persists the key into runtime-session.v1.jsonl or trace", async () => {
  const secretKey = "key-echo-test-fixture-9876543210";
  const server = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
    res.end(JSON.stringify({ error: { message: `rate limited for credential ${secretKey}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: listenPort } = server.address() as { port: number };
  try {
    const dataRoot = tempDir("secret-leak");
    const seed = createSlidesRuntime({
      llm: new ScriptedLlm([() => call("open_project", { title: "脱敏" }), () => ({ text: "ok" })]),
      dataRoot,
      toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
    });
    assert.equal((await seed.prompt("初始化")).status, "completed");
    const project = seed.binding!;
    await seed.dispose();

    const port = new PiAiLlmPort({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${listenPort}/v1`,
      modelId: "local-model",
      apiKey: secretKey,
      contextWindow: 32_000,
      maxTokens: 2_000,
      maxRetries: 0,
    });
    const rt = createSlidesRuntime({
      llm: port,
      dataRoot,
      project,
      rateLimit: { maxAttempts: 0 },
      toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
    });
    const result = await rt.prompt("触发 429");
    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.fault?.detail ?? "", new RegExp(secretKey));
    const sessionDump = readText(path.join(project.projectRoot, RUNTIME_SESSION_REL));
    const traceDump = readText(path.join(project.projectRoot, AGENT_TRACE_REL));
    assert.doesNotMatch(sessionDump, new RegExp(secretKey), "API key must not enter runtime-session.v1.jsonl");
    assert.doesNotMatch(traceDump, new RegExp(secretKey), "API key must not enter agent-trace.jsonl");
  } finally {
    server.close();
  }
});

test("tool-adapter rejects already-aborted calls and preserves serial order across uncooperative timeouts", async () => {
  const serial = new SerialGate();
  const order: string[] = [];
  let releaseFirst!: () => void;
  let firstSignalAbortedAfterTimeout = false;
  const firstDef: SlideToolDefinition = {
    name: "slow_tool",
    description: "ignores abort until released",
    inputSchema: { type: "object", properties: {} },
    readOnly: false,
    render: "json",
    async execute(_args, ctx) {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      firstSignalAbortedAfterTimeout = ctx.signal?.aborted === true;
      order.push("first:end");
      return { data: { ok: true } };
    },
  };
  let secondRan = false;
  const secondDef: SlideToolDefinition = {
    name: "second_tool",
    description: "must wait for first to settle",
    inputSchema: { type: "object", properties: {} },
    readOnly: false,
    render: "json",
    async execute() {
      secondRan = true;
      order.push("second:run");
      return { data: { ok: true } };
    },
  };
  const ctx = {
    caller: { kind: "hub-run" as const, id: "hub-run:s" },
    sessionId: "s",
    binding: () => ({ projectId: "p", projectRoot: "/tmp/unused" }),
    acceptsImages: () => true,
    timeoutMs: 30,
    serial,
    onInvalidArgs: () => undefined,
    deferDelivery: () => undefined,
  };
  const firstTool = adaptSlideTool(firstDef, ctx);
  const secondTool = adaptSlideTool(secondDef, { ...ctx, timeoutMs: 300 });

  // 1. Pre-aborted signal must not invoke the tool at all.
  const preAborted = new AbortController();
  preAborted.abort();
  const abortedRes = await secondTool.execute("c0", {}, preAborted.signal);
  assert.equal(abortedRes.isError, true);
  assert.equal(secondRan, false, "already-aborted call must not execute");

  // 2. First tool times out after 30ms while ignoring abort; second tool must wait until first settles.
  const timedOut = await firstTool.execute("c1", {});
  assert.equal(timedOut.isError, true);
  assert.match(JSON.stringify(timedOut.content), /tool_timeout/);
  const secondPromise = secondTool.execute("c2", {});
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(secondRan, false, "second tool must not run while timed-out first tool is unsettled");
  releaseFirst();
  const secondRes = await secondPromise;
  assert.equal(secondRes.isError, undefined);
  assert.equal(firstSignalAbortedAfterTimeout, true, "timed-out tool signal was aborted to revoke write authority");
  assert.deepEqual(order, ["first:start", "first:end", "second:run"]);
});

test("image delivery receipt runs only when transformContext retains the image in the outgoing model request", async () => {
  const { inspectCapabilities } = await import("@open-slidestudio/presentation-run");
  const { prepareFixturePageImage } = await import("@open-slidestudio/presentation-run/testkit");
  const validPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(72, 1)]);
  const mainModelCaps = () =>
    inspectCapabilities({ ready: true, modelInputModalities: ["text", "image"], rasterReady: true });
  const runCase = async (maxImages: number) => {
    const dataRoot = tempDir(`img-deliver-${maxImages}`);
    let sawImageInNextRequest = false;
    const base = testPresentation();
    const presentation = {
      ...base,
      async execute(
        command: { readonly name: string; readonly args: Record<string, unknown> },
        ctx: Parameters<typeof base.execute>[1],
      ) {
        if (command.name !== "render_page") return base.execute(command, ctx);
        const pageId = String(command.args.pageId ?? "p01");
        const binding = JSON.parse(
          fs.readFileSync(path.join(ctx.projectRoot, "_agent", "presentation-run.v1.json"), "utf8"),
        ) as { contextEpochId?: string };
        const pngRel = path.join("_agent", "rasters", `${pageId}.png`);
        fs.mkdirSync(path.join(ctx.projectRoot, "_agent", "rasters"), { recursive: true });
        fs.writeFileSync(path.join(ctx.projectRoot, pngRel), validPng);
        const deliveryToken = prepareFixturePageImage(ctx.projectRoot, pageId, {
          commandId: ctx.toolCallId,
          contextEpochId: binding.contextEpochId ?? "epoch-1",
        });
        return {
          name: "render_page",
          ok: true,
          summary: "rendered",
          detail: "rendered",
          payload: { pageId, src: pngRel, deliveryToken },
        };
      },
    };
    const llm = new ScriptedLlm([
      () => call("open_project", { title: "图片交付" }),
      () => call("list_references"),
      (context) => {
        const payload = lastResultData(context, "list_references").payload as {
          missingReferenceChunks: { sourceId: string; chunkIndex: number }[];
        };
        return { calls: payload.missingReferenceChunks.map((chunk) => ({ name: "read_reference", args: chunk })) };
      },
      () =>
        call("commit_design", {
          slidePlan: [{ pageId: "p01", title: "标题 p01", layoutFamily: "content", exhibits: [], purpose: "cover" }],
        }),
      () =>
        call("write_todo", {
          items: [{ pageId: "p01", title: "标题 p01", layoutFamily: "content", exhibits: ["none"] }],
        }),
      () => call("write_page", pageArgs("p01")),
      () => call("render_page", { pageId: "p01" }),
      (context) => {
        sawImageInNextRequest = context.messages.some(
          (m) => m.role === "toolResult" && m.toolName === "render_page" && m.content.some((b) => b.type === "image"),
        );
        return { text: sawImageInNextRequest ? "seen" : "stripped" };
      },
    ]);
    const runtimeRef = createSlidesRuntime({
      llm,
      dataRoot,
      contextBudget: { maxImages },
      toolDeps: { presentation, capabilities: mainModelCaps, editorBaseUrl: "http://127.0.0.1:9" },
    });
    const res = await runtimeRef.prompt("渲染并检查");
    assert.equal(res.status, "completed", JSON.stringify(res.fault));
    const ledger = fs.readFileSync(path.join(runtimeRef.binding!.projectRoot, "_agent", "run-ledger.v1.json"), "utf8");
    const emitted = ledger.includes("image-content-emitted");
    return { sawImageInNextRequest, emitted };
  };

  const stripped = await runCase(0);
  assert.equal(stripped.sawImageInNextRequest, false, "maxImages: 0 strips image from outgoing request");
  assert.equal(stripped.emitted, false, "stripped image must NOT record image-content-emitted");

  const kept = await runCase(2);
  assert.equal(kept.sawImageInNextRequest, true, "maxImages: 2 retains image in outgoing request");
  assert.equal(kept.emitted, true, "delivered image MUST record image-content-emitted");
});

test("structured CONTEXT_WINDOW_EXCEEDED without matching text retries once; trace seq continues across restart", async () => {
  const dataRoot = tempDir("overflow-seq");
  const llm1 = new ScriptedLlm([
    () => call("open_project", { title: "序号" }),
    () => ({ failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "err 400", status: 400 } }),
    () => ({ text: "压缩重试成功" }),
  ]);
  const rt1 = createSlidesRuntime({
    llm: llm1,
    dataRoot,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const first = await rt1.prompt("触发结构化超窗");
  assert.equal(first.status, "completed");
  assert.equal(first.text, "压缩重试成功");
  assert.equal(llm1.requests.length, 3, "structured CONTEXT_WINDOW_EXCEEDED must trigger retry");
  const project = rt1.binding!;
  await rt1.dispose();

  const traceFile = path.join(project.projectRoot, AGENT_TRACE_REL);
  const rows1 = readText(traceFile)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { seq: number });
  const maxBeforeRestart = rows1.at(-1)!.seq;
  assert.ok(maxBeforeRestart >= 1);

  const rt2 = createSlidesRuntime({
    llm: new ScriptedLlm([() => ({ text: "重启后继续" })]),
    dataRoot,
    project,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  assert.equal((await rt2.prompt("第二轮")).status, "completed");
  const rows2 = readText(traceFile)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { seq: number });
  const added = rows2.slice(rows1.length);
  assert.equal(added[0]!.seq, maxBeforeRestart + 1, "trace seq must continue monotonically across restarts");
});
