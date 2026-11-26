import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectCapabilities } from "@open-slidestudio/presentation-run";
import { prepareFixturePageImage } from "@open-slidestudio/presentation-run/testkit";
import { acquireProjectLease, readProjectLease, type PostTurnHook } from "@open-slidestudio/slides-tools";
import { createSlidesRuntime } from "./runtime.js";
import { RUNTIME_SESSION_REL, RuntimeSessionStore } from "./session-store.js";
import { lastResultData, pageArgs, ScriptedLlm, tempDir, testPresentation, waitFor } from "./testkit.js";
import { AGENT_TRACE_REL } from "./trace-projection.js";
import { ASSISTANT_QUESTIONS_REL } from "./user-question.js";

const call = (name: string, args: Record<string, unknown> = {}) => ({ calls: [{ name, args }] });
const readJsonl = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test("mid-hook editor takeover blocks subsequent post-turn hooks and turns the result into lease-preempted", async () => {
  const dataRoot = tempDir("hook-preempt");
  let hook2Ran = false;
  const hooks: PostTurnHook[] = [
    {
      name: "first-hook",
      async run(ctx) {
        assert.ok(ctx.signal, "hook receives the turn abort signal");
        assert.equal(
          acquireProjectLease(ctx.projectRoot, { kind: "editor-human", ownerId: "editor-human:h1" }).ok,
          true,
        );
      },
    },
    {
      name: "second-hook",
      async run(ctx) {
        hook2Ran = true;
        fs.writeFileSync(path.join(ctx.projectRoot, "_agent", "should-not-exist.txt"), "nope");
      },
    },
  ];
  const rt = createSlidesRuntime({
    llm: new ScriptedLlm([() => call("open_project", { title: "钩子抢占" }), () => ({ text: "完成" })]),
    dataRoot,
    caller: { kind: "mcp", id: "mcp:hook-preempt" },
    postTurnHooks: hooks,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const result = await rt.prompt("执行");
  const root = rt.binding!.projectRoot;
  assert.equal(hook2Ran, false, "second hook must not run after editor preemption during first hook");
  assert.equal(fs.existsSync(path.join(root, "_agent", "should-not-exist.txt")), false);
  assert.equal(result.status, "paused");
  assert.equal(result.fault?.code, "lease-preempted-by-editor");
  assert.equal(readProjectLease(root).holder?.ownerId, "editor-human:h1");
});

test("runtime constructed while another writer is active refreshes from disk on lease acquire and never uses stale recovery", async () => {
  const dataRoot = tempDir("fresh-recovery");
  const question = { questions: [{ id: "q1", question: "标题风格？", options: [{ label: "正式" }] }] };
  const rtA = createSlidesRuntime({
    llm: new ScriptedLlm([
      () => call("open_project", { title: "接力" }),
      () => call("ask_user_question", question),
      () => ({ text: "A 的最终回复" }),
    ]),
    dataRoot,
    userQuestions: true,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const turnA = rtA.prompt("第一轮");
  await waitFor(() => rtA.listQuestions().some((q) => q.status === "pending"));
  const project = rtA.binding!;

  // Construct B while A is still mid-turn; B sees open turn 1 in constructor snapshot.
  let sawAReply = false;
  const rtB = createSlidesRuntime({
    llm: new ScriptedLlm([
      (ctx) => {
        sawAReply = ctx.messages.some(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "text" && b.text.includes("A 的最终回复")),
        );
        return { text: "B 收到" };
      },
    ]),
    dataRoot,
    project,
    userQuestions: true,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });

  // A completes cleanly and releases lease.
  rtA.answerQuestion(rtA.listQuestions()[0]!.id, { answers: [{ id: "q1", selected: ["正式"] }] });
  assert.equal((await turnA).status, "completed");

  // B now acquires lease: must NOT append interrupted for turn 1 and MUST see A's final reply.
  const resB = await rtB.prompt("第二轮");
  assert.equal(resB.status, "completed");
  assert.equal(resB.turn, 2);
  assert.equal(sawAReply, true, "B's context must include A's final reply refreshed from disk");
  const session = readJsonl(path.join(project.projectRoot, RUNTIME_SESSION_REL));
  const interrupted = session.filter(
    (r) => r.type === "turn/end" && (r.reason as { kind?: string } | undefined)?.kind === "interrupted",
  );
  assert.equal(interrupted.length, 0, "completed turn 1 must not be marked interrupted");
});

test("two concurrent in-process runtimes reusing the same caller.id cannot overlap or clobber each other's lease", async () => {
  const dataRoot = tempDir("same-caller");
  const sharedCaller = { kind: "hub-run" as const, id: "hub-run:shared-id" };
  const question = { questions: [{ id: "q1", question: "确认？", options: [{ label: "是" }] }] };
  const rtA = createSlidesRuntime({
    llm: new ScriptedLlm([
      () => call("open_project", { title: "同身份" }),
      () => call("ask_user_question", question),
      () => ({ text: "A 完成" }),
    ]),
    dataRoot,
    caller: sharedCaller,
    userQuestions: true,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const turnA = rtA.prompt("A 开始");
  await waitFor(() => rtA.listQuestions().some((q) => q.status === "pending"));
  const project = rtA.binding!;
  const questionsFile = path.join(project.projectRoot, ASSISTANT_QUESTIONS_REL);
  const questionsBefore = fs.readFileSync(questionsFile, "utf8");

  const rtB = createSlidesRuntime({
    llm: new ScriptedLlm([() => ({ text: "B 不应运行" })]),
    dataRoot,
    project,
    caller: sharedCaller,
    userQuestions: true,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const refused = await rtB.prompt("B 尝试并发进入");
  assert.equal(refused.status, "paused");
  assert.equal(refused.fault?.code, "lease-conflict");
  assert.equal(fs.readFileSync(questionsFile, "utf8"), questionsBefore, "A's pending question must stay intact");
  assert.equal(readProjectLease(project.projectRoot).holder?.ownerId, sharedCaller.id, "A's lease must stay held");

  rtA.answerQuestion(rtA.listQuestions()[0]!.id, { answers: [{ id: "q1", selected: ["是"] }] });
  assert.equal((await turnA).status, "completed");
  assert.equal(readProjectLease(project.projectRoot).holder, undefined);
});

test("aborted turn skips image delivery receipt even when an uncooperative LLM ignores abort and returns stop", async () => {
  const dataRoot = tempDir("abort-image");
  const validPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(72, 1)]);
  const mainModelCaps = () =>
    inspectCapabilities({ ready: true, modelInputModalities: ["text", "image"], rasterReady: true });
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
  let releaseLlm!: () => void;
  let waitingOnImageRequest = false;
  const llm = new ScriptedLlm([
    () => call("open_project", { title: "取消图片" }),
    () => call("list_references"),
    (ctx) => {
      const payload = lastResultData(ctx, "list_references").payload as {
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
    async () => {
      waitingOnImageRequest = true;
      await new Promise<void>((resolve) => {
        releaseLlm = resolve;
      });
      return { text: "late stop ignoring abort" };
    },
  ]);
  const rt = createSlidesRuntime({
    llm,
    dataRoot,
    toolDeps: { presentation, capabilities: mainModelCaps, editorBaseUrl: "http://127.0.0.1:9" },
  });
  const pending = rt.prompt("渲染");
  await waitFor(() => waitingOnImageRequest);
  rt.abort();
  releaseLlm();
  const res = await pending;
  assert.equal(res.status, "aborted");
  const ledger = fs.readFileSync(path.join(rt.binding!.projectRoot, "_agent", "run-ledger.v1.json"), "utf8");
  assert.equal(ledger.includes("image-content-emitted"), false, "aborted turn must not record image-content-emitted");
});

test("sequential A -> B -> A lease handoff keeps session and trace seq strictly monotonic", async () => {
  const dataRoot = tempDir("aba-seq");
  const rtA = createSlidesRuntime({
    llm: new ScriptedLlm([
      () => call("open_project", { title: "交错序号" }),
      () => ({ text: "A1" }),
      () => ({ text: "A2" }),
    ]),
    dataRoot,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  assert.equal((await rtA.prompt("第一轮")).status, "completed");
  const project = rtA.binding!;
  const rtB = createSlidesRuntime({
    llm: new ScriptedLlm([() => ({ text: "B1" })]),
    dataRoot,
    project,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  assert.equal((await rtB.prompt("第二轮")).status, "completed");
  assert.equal((await rtA.prompt("第三轮")).status, "completed");

  const sessionSeqs = readJsonl(path.join(project.projectRoot, RUNTIME_SESSION_REL)).map((r) => Number(r.seq));
  const traceSeqs = readJsonl(path.join(project.projectRoot, AGENT_TRACE_REL)).map((r) => Number(r.seq));
  for (let i = 1; i < sessionSeqs.length; i += 1) {
    assert.ok(sessionSeqs[i]! > sessionSeqs[i - 1]!, `session seq regressed: ${JSON.stringify(sessionSeqs)}`);
  }
  for (let i = 1; i < traceSeqs.length; i += 1) {
    assert.ok(traceSeqs[i]! > traceSeqs[i - 1]!, `trace seq regressed: ${JSON.stringify(traceSeqs)}`);
  }
});

test("stale PID fails closed without writing or releasing when another PID takes over the same caller.id after TTL expiry", async () => {
  const dataRoot = tempDir("pid-takeover");
  const sharedCaller = { kind: "hub-run" as const, id: "hub-run:same-id-cross-pid" };
  let releaseLlm!: () => void;
  let waiting = false;
  const rt = createSlidesRuntime({
    llm: new ScriptedLlm([
      () => call("open_project", { title: "跨进程接管" }),
      async () => {
        waiting = true;
        await new Promise<void>((resolve) => {
          releaseLlm = resolve;
        });
        return { text: "旧进程迟到回复" };
      },
    ]),
    dataRoot,
    caller: sharedCaller,
    lease: { ttlMs: 30, heartbeatMs: 60_000 },
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  const pending = rt.prompt("开始");
  await waitFor(() => waiting);
  const root = rt.binding!.projectRoot;
  // Wait for TTL expiry, then let another live PID (PID 1 / init, or 2 if pid===1) take over the same ownerId.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const otherPid = process.pid === 1 ? 2 : 1;
  const taken = acquireProjectLease(root, {
    kind: sharedCaller.kind,
    ownerId: sharedCaller.id,
    pid: otherPid,
    ttlMs: 60_000,
  });
  assert.equal(taken.ok, true);
  const sessionBefore = fs.readFileSync(path.join(root, RUNTIME_SESSION_REL), "utf8");
  releaseLlm();
  const res = await pending;
  assert.equal(res.status, "paused");
  assert.equal(res.fault?.code, "writer-lease-lost");
  assert.equal(fs.readFileSync(path.join(root, RUNTIME_SESSION_REL), "utf8"), sessionBefore);
  assert.equal(readProjectLease(root).holder?.pid, otherPid, "new PID's active lease must stay intact");
});

test("resume() on a previously constructed runtime syncs fresh disk state before validating resumability", async () => {
  const dataRoot = tempDir("stale-resume");
  const llmA = new ScriptedLlm([
    () => call("open_project", { title: "恢复同步" }),
    () => ({ text: "第一轮完成" }),
    () => ({ hang: true }),
  ]);
  const rtA = createSlidesRuntime({
    llm: llmA,
    dataRoot,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  assert.equal((await rtA.prompt("第一轮")).status, "completed");
  const project = rtA.binding!;
  // Construct B right after Turn 1 completed (B's constructor snapshot ends with assistant message).
  const rtB = createSlidesRuntime({
    llm: new ScriptedLlm([() => ({ text: "B 恢复成功" })]),
    dataRoot,
    project,
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  // A starts Turn 2 and aborts, leaving a resumable user prompt on disk.
  const turn2 = rtA.prompt("第二轮被中止");
  await waitFor(() => llmA.requests.length >= 3);
  rtA.abort();
  assert.equal((await turn2).status, "aborted");
  // B must sync fresh from disk under lease and resume Turn 2 cleanly instead of throwing "nothing to resume".
  const resumed = await rtB.resume();
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.turn, 3);
});

test("editor preemption during post-turn subscriber still surfaces lease-preempted-by-editor on prompt() and turn/end", async () => {
  const dataRoot = tempDir("post-turn-sub");
  const rt = createSlidesRuntime({
    llm: new ScriptedLlm([() => call("open_project", { title: "订阅抢占" }), () => ({ text: "完成" })]),
    dataRoot,
    caller: { kind: "mcp", id: "mcp:post-turn-sub" },
    postTurnHooks: [{ name: "noop", async run() {} }],
    toolDeps: { presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" },
  });
  let endStatus: string | undefined;
  let endFault: string | undefined;
  rt.subscribe((ev) => {
    if (ev.type === "post-turn" && rt.binding) {
      acquireProjectLease(rt.binding.projectRoot, { kind: "editor-human", ownerId: "editor-human:sub" });
    }
    if (ev.type === "turn/end") {
      endStatus = ev.result.status;
      endFault = ev.result.fault?.code;
    }
  });
  const result = await rt.prompt("执行");
  assert.equal(result.status, "paused");
  assert.equal(result.fault?.code, "lease-preempted-by-editor");
  assert.equal(endStatus, "paused");
  assert.equal(endFault, "lease-preempted-by-editor");
  assert.equal(readProjectLease(rt.binding!.projectRoot).holder?.ownerId, "editor-human:sub");
});

test("aborting during first image delivery receipt propagates ctx.signal and cancels subsequent image receipts", async () => {
  const dataRoot = tempDir("mid-delivery-abort");
  const validPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(72, 1)]);
  const mainModelCaps = () =>
    inspectCapabilities({ ready: true, modelInputModalities: ["text", "image"], rasterReady: true });
  const base = testPresentation();
  let releaseFirstReceipt!: () => void;
  let firstReceiptWaiting = false;
  let firstReceiptSawAbortedSignal = false;
  const committedTokens: string[] = [];
  const presentation = {
    ...base,
    async execute(
      command: { readonly name: string; readonly args: Record<string, unknown> },
      ctx: Parameters<typeof base.execute>[1],
    ) {
      if (command.name === "_mark_image_emitted") {
        const token = String(command.args.deliveryToken ?? "");
        if (committedTokens.length === 0 && !firstReceiptWaiting) {
          firstReceiptWaiting = true;
          await new Promise<void>((resolve) => {
            releaseFirstReceipt = resolve;
          });
          firstReceiptSawAbortedSignal = ctx.abortSignal.aborted;
          const gated = ctx.runAuthorizedWrite?.(() => "committed");
          if (gated && !gated.ok)
            return { name: command.name, ok: false, summary: "aborted", detail: "aborted", payload: {} };
        }
        committedTokens.push(token);
        return { name: command.name, ok: true, summary: "marked", detail: "marked", payload: {} };
      }
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
    () => call("open_project", { title: "双图取消" }),
    () => call("list_references"),
    (ctx) => {
      const payload = lastResultData(ctx, "list_references").payload as {
        missingReferenceChunks: { sourceId: string; chunkIndex: number }[];
      };
      return { calls: payload.missingReferenceChunks.map((chunk) => ({ name: "read_reference", args: chunk })) };
    },
    () =>
      call("commit_design", {
        slidePlan: [
          { pageId: "p01", title: "标题 p01", layoutFamily: "content", exhibits: [], purpose: "cover" },
          { pageId: "p02", title: "标题 p02", layoutFamily: "content", exhibits: [], purpose: "content" },
        ],
      }),
    () =>
      call("write_todo", {
        items: [
          { pageId: "p01", title: "标题 p01", layoutFamily: "content", exhibits: ["none"] },
          { pageId: "p02", title: "标题 p02", layoutFamily: "content", exhibits: ["none"] },
        ],
      }),
    () => call("write_page", pageArgs("p01")),
    () => call("write_page", pageArgs("p02")),
    () => call("render_page", { pageId: "p01" }),
    () => call("render_page", { pageId: "p02" }),
    () => ({ text: "两张图都看完了" }),
  ]);
  const rt = createSlidesRuntime({
    llm,
    dataRoot,
    toolDeps: { presentation, capabilities: mainModelCaps, editorBaseUrl: "http://127.0.0.1:9" },
  });
  const pending = rt.prompt("渲染两页");
  await waitFor(() => firstReceiptWaiting);
  rt.abort();
  releaseFirstReceipt();
  const res = await pending;
  assert.equal(res.status, "aborted");
  assert.equal(firstReceiptSawAbortedSignal, true, "first delivery hook must see ctx.signal aborted immediately");
  assert.deepEqual(committedTokens, [], "neither the aborted first receipt nor the second receipt may commit");
});

test("RuntimeSessionStore handles cross-diagnostic cycles without RangeError and preserves replayState.diagnostics signatures", () => {
  const root = tempDir("diag-cycle");
  const store = new RuntimeSessionStore();
  store.attach(root);
  const longSig = "C".repeat(320);
  const shared = { sig: longSig };
  const diagReplay: Record<string, unknown> = {
    type: "slides-runtime/dsh-replay-state",
    timestamp: Date.now(),
    details: { replayState: { diagnostics: [shared, shared] } },
  };
  const diagOther: Record<string, unknown> = {
    type: "other/diag",
    timestamp: Date.now(),
    details: { back: diagReplay },
  };
  (diagReplay.details as Record<string, unknown>).peer = diagOther;
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    diagnostics: [diagReplay, diagOther],
    timestamp: Date.now(),
  };
  assert.equal(store.append({ type: "message", turn: 1, message: msg as never }), true);
  const [record] = readJsonl(path.join(root, RUNTIME_SESSION_REL));
  const savedDiags = (record!.message as { diagnostics: { details: { replayState?: { diagnostics: unknown[] } } }[] })
    .diagnostics;
  assert.doesNotMatch(JSON.stringify(savedDiags[0]), /\[redacted binary data\]/);
  assert.deepEqual(savedDiags[0]!.details.replayState?.diagnostics, [{ sig: longSig }, { sig: longSig }]);
  assert.equal(savedDiags.length, 2);
});
