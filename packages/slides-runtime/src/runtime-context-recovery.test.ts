import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ContextProjectionStats } from "./context-budget.js";
import { CALIBRATION_BOUNDS } from "./token-estimate.js";
import { MAX_TOKENS_NUDGE, SUMMARY_SEED_HEADER } from "./runtime-recovery.js";
import { createSlidesRuntime } from "./runtime.js";
import type { SlidesRuntimeOptions } from "./runtime-config.js";
import type { RuntimeEvent } from "./runtime-support.js";
import { RUNTIME_SESSION_REL } from "./session-store.js";
import { ScriptedLlm, tempDir, testPresentation, type ScriptStep } from "./testkit.js";

process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = "/nonexistent/slides-runtime-context-recovery/runtime.mjs";

const toolDeps = () => ({ presentation: testPresentation(), editorBaseUrl: "http://127.0.0.1:9" });
const call = (name: string, args: Record<string, unknown> = {}) => ({ calls: [{ name, args }] });
const truncated = (thinking = "推理".repeat(200)) => ({ truncated: { thinking } });

function runtimeFor(steps: readonly ScriptStep[], extra: Partial<SlidesRuntimeOptions> = {}, route = {}) {
  const llm = new ScriptedLlm(steps, route);
  const dataRoot = tempDir("ctx-recovery");
  const runtime = createSlidesRuntime({ llm, dataRoot, toolDeps: toolDeps(), ...extra });
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return { llm, runtime, events, dataRoot };
}

type Row = { type: string; message?: { role?: string; stopReason?: string; content?: unknown } };
const sessionRows = (projectRoot: string): Row[] =>
  fs
    .readFileSync(path.join(projectRoot, RUNTIME_SESSION_REL), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
const roles = (messages: readonly unknown[]) => messages.map((message) => (message as { role?: string }).role);

test("a thinking reply cut off by max tokens is stripped, effort steps down and the turn auto-continues", async () => {
  const { llm, runtime, events } = runtimeFor(
    [() => call("open_project", { title: "截断" }), () => truncated(), () => truncated(), () => ({ text: "完成" })],
    { thinkingLevel: "max" },
  );
  const result = await runtime.prompt("生成");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "完成");
  assert.equal(llm.requests.length, 4);
  const retries = events.filter((event) => event.type === "max-tokens/retry");
  assert.deepEqual(
    retries.map((event) => (event.type === "max-tokens/retry" ? [event.attempt, event.thinkingLevel] : [])),
    [
      [1, "high"],
      [2, "medium"],
    ],
  );
  assert.deepEqual(
    llm.requests.map((request) => request.options?.reasoning),
    ["max", "max", "high", "medium"],
  );
  for (const request of llm.requests.slice(2)) {
    const messages = request.context.messages as { stopReason?: string; content?: unknown }[];
    assert.ok(!messages.some((message) => message.stopReason === "length"), "truncated replies never reach the model");
    assert.equal(messages.at(-1)?.content, MAX_TOKENS_NUDGE);
  }
  assert.ok(!runtime.messages.some((message) => (message as { stopReason?: string }).stopReason === "length"));
  const rows = sessionRows(runtime.binding!.projectRoot);
  assert.equal(rows.filter((row) => row.message?.stopReason === "length").length, 2, "the session log keeps them");
  assert.equal(rows.filter((row) => row.type === "turn/start").length, 1, "retries stay inside one turn");
  await runtime.prompt("下一轮");
  assert.equal(llm.requests.at(-1)?.options?.reasoning, "max", "the configured effort returns on the next turn");
  await runtime.dispose();
});

test("max-tokens auto-continue is bounded and ends the turn with status max-tokens", async () => {
  const { llm, runtime } = runtimeFor(
    [() => truncated(), () => truncated(), () => truncated(), () => ({ text: "x" })],
    {
      thinkingLevel: "high",
    },
  );
  const result = await runtime.prompt("生成");
  assert.equal(result.status, "max-tokens");
  assert.equal(llm.requests.length, 3, "two automatic continuations, then stop");
  const disabled = runtimeFor([() => truncated(), () => ({ text: "x" })], { maxTokensAutoRetries: 0 });
  assert.equal((await disabled.runtime.prompt("生成")).status, "max-tokens");
  assert.equal(disabled.llm.requests.length, 1);
  await runtime.dispose();
  await disabled.runtime.dispose();
});

test("a window too small for the protected context fails before dispatch with context-window-too-small", async () => {
  const { llm, runtime } = runtimeFor([() => ({ text: "不应发送" })], {}, { contextWindow: 6_000, maxTokens: 2_000 });
  const result = await runtime.prompt("做一份复盘");
  assert.equal(result.status, "failed");
  assert.equal(result.fault?.code, "context-window-too-small");
  assert.match(result.fault?.detail ?? "", /64k/);
  assert.equal(llm.requests.length, 0, "no request is sent and maxTokens is never clamped to 1024");
  await runtime.dispose();
});

function fakeReferenceTool(): AgentTool {
  return {
    name: "read_reference",
    label: "Read reference",
    description: "Read one reference chunk (test double).",
    parameters: { type: "object", properties: { chunk: { type: "number" } } } as never,
    async execute(_id, params) {
      const chunk = (params as { chunk?: number }).chunk ?? 0;
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, chunk, text: "参考".repeat(100) }) }],
        details: undefined,
      };
    },
  };
}

test("read_reference results that reach the model untruncated are reported once after the request", async () => {
  const delivered: string[][] = [];
  const parallel = { calls: [0, 1, 2].map((chunk) => ({ name: "read_reference", args: { chunk } })) };
  const { llm, runtime } = runtimeFor([() => parallel, () => ({ text: "读完" }), () => ({ text: "再答" })], {
    excludeTools: new Set(["read_reference"]),
    extraTools: [fakeReferenceTool()],
    contextBudget: { onDeliveredReferences: (ids) => delivered.push([...ids]) },
  });
  assert.equal((await runtime.prompt("读参考")).status, "completed");
  assert.equal(delivered.length, 1, "reported once, after the request that carried them");
  assert.equal(delivered[0]!.length, 3);
  const sentIds = (llm.requests[1]!.context.messages as { toolCallId?: string }[])
    .map((message) => message.toolCallId)
    .filter(Boolean);
  assert.deepEqual([...delivered[0]!].sort(), [...sentIds].sort());
  await runtime.prompt("继续");
  assert.equal(delivered.length, 1, "already delivered ids are not reported again");
  await runtime.dispose();
});

test("provider usage calibrates later projections and request estimates", async () => {
  const seen: ContextProjectionStats[] = [];
  const { runtime } = runtimeFor([() => ({ text: "一", usage: { input: 50_000_000 } }), () => ({ text: "二" })], {
    contextBudget: { hooks: { onProjection: (stats) => seen.push(stats) } },
  });
  await runtime.prompt("第一轮");
  assert.equal(runtime.calibration.multiplier, CALIBRATION_BOUNDS.max);
  await runtime.prompt("第二轮");
  assert.equal(seen[0]!.calibration, 1);
  assert.equal(seen.at(-1)!.calibration, CALIBRATION_BOUNDS.max);
  await runtime.dispose();
});

test("a summary-seeded runtime starts from a fresh context while the session log stays append-only", async () => {
  const first = runtimeFor([() => call("open_project", { title: "摘要" }), () => ({ text: "第一版完成" })]);
  await first.runtime.prompt("生成十页");
  const project = first.runtime.binding!;
  await first.runtime.dispose();
  const before = fs.readFileSync(path.join(project.projectRoot, RUNTIME_SESSION_REL), "utf8");

  const llm = new ScriptedLlm([() => ({ text: "评审完成" }), () => ({ text: "按摘要继续" })]);
  const seeded = createSlidesRuntime({
    llm,
    dataRoot: first.dataRoot,
    project,
    toolDeps: toolDeps(),
    initialSummaryContext: "已完成 10 页；第 3 页待修改。",
  });
  assert.equal((await seeded.prompt("评审第 3 页")).status, "completed");
  const sent = llm.requests[0]!.context.messages as { role?: string; content?: unknown }[];
  assert.ok(!sent.some((message) => message.role === "assistant"), "no raw generation history is replayed");
  assert.deepEqual(
    roles(sent).filter((role) => role !== "system"),
    ["user", "user"],
  );
  assert.match(
    String(sent.find((message) => message.role === "user")?.content),
    new RegExp(SUMMARY_SEED_HEADER.slice(0, 6)),
  );
  const after = fs.readFileSync(path.join(project.projectRoot, RUNTIME_SESSION_REL), "utf8");
  assert.ok(after.startsWith(before) && after.length > before.length, "the log only grows");

  const reseed = await seeded.prompt({ text: "换模型后继续", seedFromSummary: "摘要 v2" });
  assert.equal(reseed.status, "completed");
  const second = llm.requests[1]!.context.messages as { role?: string; content?: unknown }[];
  assert.ok(!second.some((message) => message.role === "assistant"), "a per-turn seed drops the previous turn too");
  assert.match(String(second.find((message) => message.role === "user")?.content), /摘要 v2/);
  await seeded.dispose();
});

test("max-tokens step-down skips reasoning efforts not supported by the active model", async () => {
  const { llm, runtime, events } = runtimeFor(
    [() => truncated(), () => truncated(), () => ({ text: "已恢复" })],
    { thinkingLevel: "high" },
    { reasoningEffort: "high", supportedReasoningEfforts: ["low", "high"] },
  );
  const result = await runtime.prompt("生成");
  assert.equal(result.status, "completed");
  assert.deepEqual(
    events
      .filter((event) => event.type === "max-tokens/retry")
      .map((event) => (event.type === "max-tokens/retry" ? event.thinkingLevel : "")),
    ["low", "off"],
  );
  assert.deepEqual(
    llm.requests.map((request) => request.options?.reasoning),
    ["high", "low", undefined],
  );
  await runtime.dispose();

  const binary = runtimeFor(
    [() => truncated(), () => ({ text: "关闭思考后完成" })],
    { thinkingLevel: "high" },
    { reasoningEffort: "high", supportedReasoningEfforts: ["high"] },
  );
  assert.equal((await binary.runtime.prompt("生成")).status, "completed");
  assert.deepEqual(
    binary.llm.requests.map((request) => request.options?.reasoning),
    ["high", undefined],
  );
  await binary.runtime.dispose();
});
