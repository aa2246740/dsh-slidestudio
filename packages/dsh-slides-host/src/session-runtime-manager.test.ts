import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createPresentationRun } from "@open-slidestudio/presentation-run";
import type { RuntimeTurnResult } from "@open-slidestudio/slides-runtime";
import { acquireProjectLease, readProjectLease } from "@open-slidestudio/slides-tools";
import { appendAgentTrace } from "./agent-trace.js";
import { readAgentError } from "./agent-fault.js";
import { recordConversationMessage } from "./assistant-conversation.js";
import type { DshGenerateOptionsLike, DshStreamChunk } from "./dsh-llm-port.js";
import { REPO_ROOT } from "./host-test-fixtures.js";
import { markInterruptedTurn, recoverSessionOnActivation } from "./interruption.js";
import { userTurnMessage } from "./session-handle.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";
import { SliceSessionStore } from "./slice-session.js";

const SPEC = { providerId: "scripted", modelId: "scripted-1", inputModalities: ["text" as const] };

function reply(text: string): AsyncIterable<DshStreamChunk> {
  return (async function* () {
    yield { type: "block-end", index: 0, block: { type: "text", text } } as DshStreamChunk;
    yield { type: "finish", reason: { kind: "stop" } } as DshStreamChunk;
  })();
}

function harness(gated = false) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-"));
  const store = new SliceSessionStore(workspace);
  const { binding } = store.openProject({
    dshSessionId: "s1",
    title: "Manager",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "scripted-1" },
  });
  const root = store.resolveRoot(binding);
  const requests: DshGenerateOptionsLike[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const results: RuntimeTurnResult[] = [];
  const statuses: string[] = [];
  const manager = new SessionRuntimeManager({
    store,
    presentation: createPresentationRun({ repoRoot: REPO_ROOT }),
    editorBaseUrl: "http://127.0.0.1:9",
    llm: {
      stream(options) {
        requests.push(options);
        if (!gated) return reply(`reply ${requests.length}`);
        return (async function* () {
          await gate;
          yield* reply(`reply ${requests.length}`);
        })();
      },
    },
    resolveLimits: async () => ({ contextWindow: 64_000, maxTokens: 2_048 }),
    onTurnEnd: (_id, result) => results.push(result),
    onStatus: (_id, status) => statuses.push(status),
  });
  return { store, root, manager, requests, results, statuses, open };
}

async function idle(manager: SessionRuntimeManager): Promise<void> {
  for (let i = 0; i < 400 && manager.running("s1"); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.running("s1"), false);
}

describe("session runtime manager", () => {
  it("rebuilds an idle runtime when the conversation leaves discussion mode, keeping the transcript", async () => {
    const { root, manager, requests, results } = harness();
    recordConversationMessage(root, "先讨论", "discuss");
    await manager.open("s1", SPEC);
    manager.handle("s1")!.followup(userTurnMessage("讨论一下结构"));
    await idle(manager);
    const discussTools = new Set((requests[0]!.tools ?? []).map((tool) => tool.name));
    assert.equal(discussTools.has("write_page"), false, "discussion is read-only");

    recordConversationMessage(root, "开始制作", "generate");
    manager.enqueue("s1", { kind: "prompt", text: "开始制作" });
    await idle(manager);
    const produceTools = new Set((requests[1]!.tools ?? []).map((tool) => tool.name));
    assert.equal(produceTools.has("write_page"), true, "the rebuilt runtime offers the produce tool set");
    assert.equal(produceTools.has("web_search"), false, "function web_search stays off Hub runs");
    assert.equal(produceTools.has("open_in_editor"), false);
    assert.ok(requests[1]!.messages.length >= 3, "history was recovered from the runtime session log");
    assert.deepEqual(
      results.map((result) => result.status),
      ["completed", "completed"],
    );
    await manager.dispose();
  });

  it("queues a steer sent before the turn starts and drops turns stopped before they start", async () => {
    const { manager, requests, results, statuses, open } = harness(true);
    await manager.open("s1", SPEC);
    manager.enqueue("s1", { kind: "prompt", text: "第一轮" });
    manager.handle("s1")!.steer(userTurnMessage("顺便加一页"));
    for (let i = 0; i < 200 && requests.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    await idle(manager);
    const users = requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content));
    assert.ok(
      users.some((text) => text.includes("顺便加一页")),
      "the steer reached the model",
    );

    manager.enqueue("s1", { kind: "prompt", text: "第二轮" });
    assert.equal(await manager.stop("s1", 1_000), true);
    await idle(manager);
    assert.equal(results.at(-1)!.fault?.code, "operator-stop");
    assert.equal(statuses.at(-1), "idle");
    await manager.dispose();
  });

  it("resume falls back to the continuation prompt when the transcript is already settled", async () => {
    const { manager, requests } = harness();
    await manager.open("s1", SPEC);
    manager.enqueue("s1", { kind: "prompt", text: "开始" });
    await idle(manager);
    manager.enqueue("s1", { kind: "resume", fallbackText: "Continue the same Hub session." });
    await idle(manager);
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]!.messages.at(-1)), /Continue the same Hub session/);
    await manager.dispose();
  });

  it("contains throwing onTurnEnd callbacks without unhandled rejections and still transitions to idle", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-throw-"));
    const store = new SliceSessionStore(workspace);
    store.openProject({
      dshSessionId: "s1",
      title: "Throw",
      design: { kind: "self-directed" },
      provider: { providerId: "scripted", modelId: "scripted-1" },
    });
    const statuses: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const manager = new SessionRuntimeManager({
      store,
      presentation: createPresentationRun({ repoRoot: REPO_ROOT }),
      editorBaseUrl: "http://127.0.0.1:9",
      llm: { stream: () => reply("ok") },
      resolveLimits: async () => ({ contextWindow: 64_000, maxTokens: 2_048 }),
      onTurnEnd: () => {
        throw new Error("corrupt deck.pptd");
      },
      onStatus: (_id, status) => statuses.push(status),
    });
    try {
      await manager.open("s1", SPEC);
      manager.enqueue("s1", { kind: "prompt", text: "hi" });
      await idle(manager);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(unhandled, [], "throwing settlement callback must not emit unhandledRejection");
      assert.equal(statuses.at(-1), "idle");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await manager.dispose();
    }
  });

  it("clears pi-agent-core steeringQueue on operator stop so cancelled steers never replay in the next turn", async () => {
    const { manager, requests, open } = harness(true);
    await manager.open("s1", SPEC);
    manager.enqueue("s1", { kind: "prompt", text: "第一轮" });
    for (let i = 0; i < 200 && requests.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    manager.steer("s1", "已取消的纠偏指令");
    const stopPromise = manager.stop("s1", 1_000);
    open();
    assert.equal(await stopPromise, true);
    await idle(manager);

    manager.enqueue("s1", { kind: "prompt", text: "全新一轮" });
    await idle(manager);
    const secondTurnMessages = JSON.stringify(requests.at(-1)!.messages);
    assert.doesNotMatch(secondTurnMessages, /已取消的纠偏指令/);
    assert.match(secondTurnMessages, /全新一轮/);
    await manager.dispose();
  });

  it("runs read-only discussion turns without acquiring or conflicting with an active editor lease", async () => {
    const { root, manager, results } = harness();
    recordConversationMessage(root, "先聊聊", "discuss");
    assert.equal(acquireProjectLease(root, { kind: "editor-human", ownerId: "editor-human:tab1" }).ok, true);
    await manager.open("s1", SPEC);
    manager.enqueue("s1", { kind: "prompt", text: "聊聊结构" });
    await idle(manager);
    assert.equal(results.at(-1)?.status, "completed");
    assert.equal(readProjectLease(root).holder?.ownerId, "editor-human:tab1");
    await manager.dispose();
  });

  it("seeds turn numbering past existing pre-cutover agent-trace.jsonl turns to avoid id collisions", async () => {
    const { root, manager, results } = harness();
    appendAgentTrace(root, [
      { id: "turn:3", at: "2026-10-01T00:00:00.000Z", turn: 3, kind: "turn", name: "turn", status: "complete" },
    ]);
    await manager.open("s1", SPEC);
    manager.enqueue("s1", { kind: "prompt", text: "升级后继续" });
    await idle(manager);
    assert.equal(results.at(-1)?.turn, 4);
    await manager.dispose();
  });

  it("releases writer lease and clears running state on session log I/O failure, and catches async callback rejections", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-io-"));
    const store = new SliceSessionStore(workspace);
    const { binding } = store.openProject({
      dshSessionId: "s1",
      title: "IOFailure",
      design: { kind: "self-directed" },
      provider: { providerId: "scripted", modelId: "scripted-1" },
    });
    const root = store.resolveRoot(binding);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const manager = new SessionRuntimeManager({
      store,
      presentation: createPresentationRun({ repoRoot: REPO_ROOT }),
      editorBaseUrl: "http://127.0.0.1:9",
      llm: { stream: () => reply("ok") },
      resolveLimits: async () => ({ contextWindow: 64_000, maxTokens: 2_048 }),
      onTurnEnd: async () => {
        throw new Error("async onTurnEnd rejection");
      },
      onStatus: async () => {
        throw new Error("async onStatus rejection");
      },
    });
    try {
      await manager.open("s1", SPEC);
      manager.enqueue("s1", { kind: "prompt", text: "first" });
      await idle(manager);
      const logPath = path.join(root, "_agent", "runtime-session.v1.jsonl");
      fs.renameSync(logPath, `${logPath}.saved`);
      fs.mkdirSync(logPath);
      manager.enqueue("s1", { kind: "prompt", text: "second after log replaced with directory" });
      await idle(manager);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(manager.running("s1"), false);
      assert.equal(manager.runtime("s1")?.running, false);
      assert.equal(readProjectLease(root).active, false, "writer lease must be released even when log write fails");
      assert.deepEqual(unhandled, [], "async callback rejections must not become unhandledRejection");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await manager.dispose();
    }
  });

  it("serializes two independent discussion runtimes without disturbing an active editor writer lease", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-discuss-race-"));
    const store = new SliceSessionStore(workspace);
    const { binding } = store.openProject({
      dshSessionId: "s1",
      title: "DiscussRace",
      design: { kind: "self-directed" },
      provider: { providerId: "scripted", modelId: "scripted-1" },
    });
    const root = store.resolveRoot(binding);
    recordConversationMessage(root, "先聊聊", "discuss");
    assert.equal(acquireProjectLease(root, { kind: "editor-human", ownerId: "editor-human:tab1" }).ok, true);
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const firstGate = new Promise<void>((resolve) => (release = resolve));
    const firstResults: RuntimeTurnResult[] = [];
    const secondResults: RuntimeTurnResult[] = [];
    const first = new SessionRuntimeManager({
      store,
      presentation: createPresentationRun({ repoRoot: REPO_ROOT }),
      editorBaseUrl: "http://127.0.0.1:9",
      llm: {
        stream: () =>
          (async function* () {
            started();
            await firstGate;
            yield* reply("first reply");
          })(),
      },
      resolveLimits: async () => ({ contextWindow: 64_000, maxTokens: 2_048 }),
      onTurnEnd: (_id, result) => firstResults.push(result),
    });
    const second = new SessionRuntimeManager({
      store,
      presentation: createPresentationRun({ repoRoot: REPO_ROOT }),
      editorBaseUrl: "http://127.0.0.1:9",
      llm: { stream: () => reply("second reply") },
      resolveLimits: async () => ({ contextWindow: 64_000, maxTokens: 2_048 }),
      onTurnEnd: (_id, result) => secondResults.push(result),
    });
    try {
      await first.open("s1", SPEC);
      first.enqueue("s1", { kind: "prompt", text: "first discussion" });
      await firstStarted;
      await second.open("s1", SPEC);
      second.enqueue("s1", { kind: "prompt", text: "second concurrent discussion" });
      await idle(second);
      assert.equal(secondResults.at(-1)?.fault?.code, "lease-conflict");
      release();
      await idle(first);
      assert.equal(firstResults.at(-1)?.status, "completed");
      assert.equal(readProjectLease(root).holder?.ownerId, "editor-human:tab1");
      const logRows = fs
        .readFileSync(path.join(root, "_agent", "runtime-session.v1.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: number; type: string; reason?: { kind: string } });
      const seqs = logRows.map((row) => row.seq);
      assert.equal(new Set(seqs).size, seqs.length, "session log seq numbers must remain strictly unique");
      assert.deepEqual(
        logRows.filter((row) => row.type === "turn/end").map((row) => row.reason?.kind),
        ["completed"],
      );
      const traceRows = fs
        .readFileSync(path.join(root, "_agent", "agent-trace.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: number });
      const traceSeqs = traceRows.map((row) => row.seq);
      assert.equal(new Set(traceSeqs).size, traceSeqs.length, "trace seq numbers must remain strictly unique");
    } finally {
      release();
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it("rolls back writer lease if acquiring runtime-turn.lease.v1.json hits a disk error", async () => {
    const { root, manager, results, requests } = harness();
    fs.mkdirSync(path.join(root, "_agent", "runtime-turn.lease.v1.json"), { recursive: true });
    await manager.open("s1", SPEC);
    manager.enqueue("s1", { kind: "prompt", text: "trigger turn lease EISDIR" });
    await idle(manager);
    assert.equal(results.at(-1)?.status, "failed");
    assert.equal(requests.length, 0);
    await manager.dispose();
    assert.equal(readProjectLease(root).active, false, "writer lease must be rolled back on turn-lease I/O error");
  });

  it("prevents activation recovery and state polling from interrupting an active live turn", async () => {
    const { root, manager, results, requests, open } = harness(true);
    await manager.open("s1", SPEC);
    manager.enqueue("s1", { kind: "prompt", text: "live produce turn" });
    for (let i = 0; i < 200 && requests.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(readProjectLease(root).active, true);
    assert.equal(recoverSessionOnActivation(root, "s1"), false);
    assert.equal(markInterruptedTurn(root), false);
    assert.equal(readProjectLease(root).active, true, "live writer lease must stay active");
    assert.equal(readAgentError(root), undefined, "live turn must not be marked host-interrupted");
    open();
    await idle(manager);
    assert.equal(results.at(-1)?.status, "completed");
    await manager.dispose();
  });
});
