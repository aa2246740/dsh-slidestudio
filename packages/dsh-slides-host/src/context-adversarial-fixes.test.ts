/**
 * Regression tests for Wave-3 adversarial findings across context budget,
 * disk-summary seeding, recovery classification, follow-up attachments,
 * and delivery confirmation boundaries.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPresentationRun,
  inspectProjectCapabilities,
  inspectProjectExecution,
} from "@open-slidestudio/presentation-run";
import { contextBudgetTokens, projectContext } from "@open-slidestudio/slides-runtime";
import { isUnrecoverableFault } from "./agent-fault.js";
import { recordConversationMessage } from "./assistant-conversation.js";
import { hasPersistedDeckHistory, recordAcceptedTurnAttachments } from "./context-summary.js";
import type { DshGenerateOptions, DshLlmService, DshStreamChunk } from "./dsh-llm-port.js";
import { HostModels } from "./host-models.js";
import { sessionHasAttachments, sessionProduceToolAllowlist } from "./produce-tool-policy.js";
import { writeSliceRuntime } from "./runtime.js";
import { capReasoningEffortForMaxTokens, llmRouteFor } from "./session-runtime-config.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";
import { SliceSessionStore } from "./slice-session.js";

function repoRoot(): string {
  let dir = process.cwd();
  while (!fs.existsSync(path.join(dir, "vendor", "open-kimi-ppt"))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function scriptedLlm(turns: readonly (readonly DshStreamChunk[])[]): {
  llm: DshLlmService;
  requests: DshGenerateOptions[];
} {
  const requests: DshGenerateOptions[] = [];
  let cursor = 0;
  const llm: DshLlmService = {
    async *stream(options: DshGenerateOptions) {
      requests.push(options);
      const chunks = turns[Math.min(cursor++, turns.length - 1)] ?? [];
      for (const chunk of chunks) yield chunk;
    },
  };
  return { llm, requests };
}

test("0-page first-turn failure preserves full initialMessage across model switch instead of clipping to summary", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-adv-0page-"));
  const store = new SliceSessionStore(workspace);
  const presentation = createPresentationRun({ repoRoot: repoRoot() });
  const sessionId = "sess-0page";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Zero Page Switch",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "tiny-32k" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  writeSliceRuntime(projectRoot, {
    brief: "完整需求".repeat(200),
    design: { kind: "self-directed" },
    editorBaseUrl: "http://127.0.0.1:9",
    strictExecution: true,
  });
  await presentation.open({
    projectRoot,
    sessionId,
    brief: "完整需求".repeat(200),
    editorBaseUrl: "http://127.0.0.1:9",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "tiny-32k" },
  });

  const { llm, requests } = scriptedLlm([
    [
      { type: "text-delta", index: 0, text: "已收到完整首轮提示与附件。" },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);
  let resolveIdle!: () => void;
  let idlePromise = new Promise<void>((r) => {
    resolveIdle = r;
  });
  let currentWindow = 32_768;
  const manager = new SessionRuntimeManager({
    store,
    presentation,
    editorBaseUrl: "http://127.0.0.1:9",
    llm,
    resolveLimits: async () => ({ contextWindow: currentWindow, maxTokens: 8_192 }),
    onStatus: (_id, status) => {
      if (status === "idle") resolveIdle();
    },
  });

  const fullInitialMessage = `You are the DSH SlideStudio director. ${"详细业务数据段落。".repeat(80)}\nDocument format: Slides 16:9, 960 x 540 pixels.\n<editor_attachments>{"id":"att-1","text":"FULL_ATTACHMENT_BODY_TOKEN"}</editor_attachments>`;
  await manager.open(sessionId, { providerId: "scripted", modelId: "tiny-32k", inputModalities: ["text"] });
  manager.enqueue(sessionId, { kind: "prompt", text: fullInitialMessage });
  await idlePromise;
  assert.equal(requests.length, 0, "32k window fails pre-flight");
  assert.equal(
    hasPersistedDeckHistory(projectRoot),
    false,
    "failed 0-page turn must not count as summarizable history",
  );

  // Switch to a 128k model and resume: full initialMessage (directorBrief, canvas size, attachment) must survive intact.
  idlePromise = new Promise<void>((r) => {
    resolveIdle = r;
  });
  currentWindow = 131_072;
  store.updateProvider(sessionId, { providerId: "scripted", modelId: "big-128k" });
  manager.markSeedOnNextTurn(sessionId, "model-switch");
  await manager.open(sessionId, { providerId: "scripted", modelId: "big-128k", inputModalities: ["text"] });
  manager.enqueue(sessionId, { kind: "resume", fallbackText: "继续生成" });
  await idlePromise;

  assert.equal(requests.length, 1);
  const sent = JSON.stringify(requests[0]!.messages);
  assert.match(sent, /FULL_ATTACHMENT_BODY_TOKEN/);
  assert.match(sent, /960 x 540 pixels/);
  assert.doesNotMatch(sent, /会话摘要/);
  await manager.dispose();
});

test("pending model-switch seed is not consumed by a read-only discussion turn", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-adv-discuss-"));
  const store = new SliceSessionStore(workspace);
  const presentation = createPresentationRun({ repoRoot: repoRoot() });
  const sessionId = "sess-discuss";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Discuss Preserve",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "m1" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  writeSliceRuntime(projectRoot, {
    brief: "讨论后制作",
    design: { kind: "self-directed" },
    editorBaseUrl: "http://127.0.0.1:9",
    strictExecution: true,
  });
  const { llm, requests } = scriptedLlm([
    [
      { type: "text-delta", index: 0, text: "第一轮完整回复内容" },
      { type: "finish", reason: { kind: "stop" } },
    ],
    [
      { type: "text-delta", index: 0, text: "讨论回复" },
      { type: "finish", reason: { kind: "stop" } },
    ],
    [
      { type: "text-delta", index: 0, text: "制作回复" },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);
  let resolveIdle!: () => void;
  let idle = new Promise<void>((r) => {
    resolveIdle = r;
  });
  const manager = new SessionRuntimeManager({
    store,
    presentation,
    editorBaseUrl: "http://127.0.0.1:9",
    llm,
    resolveLimits: async () => ({ contextWindow: 131_072, maxTokens: 8_192 }),
    onStatus: (_id, status) => {
      if (status === "idle") resolveIdle();
    },
  });
  await manager.open(sessionId, { providerId: "scripted", modelId: "m1", inputModalities: ["text"] });
  manager.enqueue(sessionId, { kind: "prompt", text: "先聊一下结构" });
  await idle;

  // Switch model while entering discussion mode -> discussion keeps full history, seed stays armed for next produce turn.
  recordConversationMessage(projectRoot, "先讨论提纲", "discuss");
  store.updateProvider(sessionId, { providerId: "scripted", modelId: "m2" });
  manager.markSeedOnNextTurn(sessionId, "model-switch");
  await manager.open(sessionId, { providerId: "scripted", modelId: "m2", inputModalities: ["text"] });
  idle = new Promise<void>((r) => {
    resolveIdle = r;
  });
  manager.enqueue(sessionId, { kind: "prompt", text: "你觉得分几部分好？" });
  await idle;
  assert.match(JSON.stringify(requests[1]!.messages), /第一轮完整回复内容/);

  // Next turn returns to generate mode -> pending model-switch seed now triggers.
  recordConversationMessage(projectRoot, "开始制作", "generate");
  idle = new Promise<void>((r) => {
    resolveIdle = r;
  });
  manager.enqueue(sessionId, { kind: "prompt", text: "开始制作" });
  await idle;
  assert.match(JSON.stringify(requests[2]!.messages), /会话摘要/);
  await manager.dispose();
});

test("64k model with high maxTokens (32k) and long signed-thinking sessions do not false-trip insufficientWindow", () => {
  const budget64k32k = contextBudgetTokens({ contextWindow: 65_536, maxOutputTokens: 32_768 });
  assert.ok(budget64k32k >= 40_000, `expected >= 40k input budget on 64k/32k model, got ${budget64k32k}`);

  type Msg = Parameters<typeof projectContext>[0][number];
  const messages: Msg[] = [
    { role: "system", content: "S".repeat(12_000), timestamp: 1 } as Msg,
    { role: "user", content: "生成 12 页经营月报", timestamp: 2 } as Msg,
  ];
  // 14 historical assistant turns carrying signed thinking blocks
  for (let i = 0; i < 14; i += 1) {
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "T".repeat(6_000), thinkingSignature: `sig-${i}` },
        { type: "text", text: `完成第 ${i + 1} 步` },
      ],
      api: "dsh-llm",
      provider: "anthropic",
      model: "claude",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 10 + i,
    } as unknown as Msg);
  }
  const { stats } = projectContext(messages, {
    contextWindow: 65_536,
    maxOutputTokens: 32_768,
    minContextWindow: 60_000,
  });
  assert.equal(stats.insufficientWindow, false, "old signed assistant turns must not trigger CONTEXT_WINDOW_TOO_SMALL");
});

test("context-window-too-small projects as paused + resolve recovery and follow-up attachments unlock material tools", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-adv-exec-"));
  const store = new SliceSessionStore(workspace);
  const sessionId = "sess-exec";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Exec Fault",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "small-32k" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  const fault = { code: "context-window-too-small", detail: "模型上下文窗口过小" };
  assert.equal(isUnrecoverableFault(fault), true);

  const execution = inspectProjectExecution({
    root: projectRoot,
    agentBusy: false,
    retryScheduled: false,
    capability: inspectProjectCapabilities(projectRoot),
    terminalFault: {
      code: fault.code,
      message: fault.detail,
      phase: "failed",
      recoverable: !isUnrecoverableFault(fault),
    },
    binding: { provider: { providerId: "scripted", modelId: "small-32k" }, design: { kind: "self-directed" } },
  });
  assert.equal(execution.status.kind, "paused");
  assert.equal(execution.recovery.kind, "resolve");

  // Follow-up turn attachments unlock material tools on an initially 0-attachment project.
  const deps = { store, provider: { providerId: "scripted", modelId: "m", ready: true } };
  assert.equal(sessionHasAttachments(projectRoot), false);
  assert.equal(sessionProduceToolAllowlist(deps, sessionId).has("read_material"), false);
  recordAcceptedTurnAttachments(projectRoot, [{ id: "att-followup-1", name: "q3.csv" }]);
  assert.equal(sessionHasAttachments(projectRoot), true);
  assert.equal(sessionProduceToolAllowlist(deps, sessionId).has("read_material"), true);
});

test("capReasoningEffortForMaxTokens and HostModels.routeLimits never emit an unsupported effort tier", async () => {
  // Models without "medium" (e.g. glm-5.4 / grok-4.7 binary or low+high tiers) must never be capped to "medium".
  assert.equal(capReasoningEffortForMaxTokens("high", 16_384, ["low", "high"]), "low");
  assert.equal(capReasoningEffortForMaxTokens("high", 16_384, ["high"]), undefined);
  assert.equal(capReasoningEffortForMaxTokens("high", 16_384, ["off", "high"]), "off");
  assert.equal(capReasoningEffortForMaxTokens("high", 8_192, ["minimal", "high"]), "minimal");
  assert.equal(capReasoningEffortForMaxTokens("high", 32_768, ["low", "high"]), "high");
  assert.equal(capReasoningEffortForMaxTokens("high", 32_768, []), undefined);

  const models = new HostModels(
    {
      listProviders: () => [{ id: "air-cpa-chat" }],
      listModels: async () => [{ id: "glm-5.4", name: "GLM 5.4", inputModalities: ["text"] }],
      resolveModelInfo: async () => ({
        inputModalities: ["text"],
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 16_384,
        reasoning: { efforts: [{ id: "low" }, { id: "high" }] },
      }),
    },
    { dshHome: os.tmpdir(), personal: true },
  );
  const limits = await models.routeLimits({
    providerId: "air-cpa-chat",
    modelId: "glm-5.4",
    reasoningEffort: "high",
    inputModalities: ["text"],
  });
  assert.deepEqual(limits.supportedEfforts, ["low", "high"]);
  const route = llmRouteFor(
    { providerId: "air-cpa-chat", modelId: "glm-5.4", reasoningEffort: "high", inputModalities: ["text"] },
    limits,
  );
  assert.equal(route.reasoningEffort, "low");
  assert.deepEqual(route.supportedReasoningEfforts, ["low", "high"]);
});
