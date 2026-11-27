/**
 * Offline deterministic multi-window replay benchmark and integration suite
 * across 32k, 64k, 128k and 200k context windows, covering:
 * - 32k early reject (`context-window-too-small`, zero requests dispatched)
 * - 64k working-set mode, superseded write pruning, low-maxTokens effort cap,
 *   and delivery-confirmed reference accounting
 * - 128k balanced multi-slide headroom
 * - 200k cache-first prefix stability (>= 95% identical adjacent prefix below 75%)
 * - comment-edit and model-switch disk-summary seeding vs full history replay
 * - produce tool schema byte budgets with and without attachments
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
import { createPresentationRun, inspectRunLedger, readRunLedger } from "@open-slidestudio/presentation-run";
import { estimateMessagesTokens, projectContext, type ContextBudgetOptions } from "@open-slidestudio/slides-runtime";

type AgentMessage = Parameters<typeof projectContext>[0][number];
import { createSlideTools, slideToolSetSchemaBytes } from "@open-slidestudio/slides-tools";
import { isPauseFault } from "./agent-fault.js";
import { recordConversationMessage } from "./assistant-conversation.js";
import { buildDiskContextSummary } from "./context-summary.js";
import type { DshGenerateOptions, DshLlmService, DshStreamChunk } from "./dsh-llm-port.js";
import { excludedToolsFor, includedToolsFor, sessionProduceToolAllowlist } from "./produce-tool-policy.js";
import { writeSliceRuntime } from "./runtime.js";
import {
  buildSessionRuntime,
  capReasoningEffortForMaxTokens,
  contextBudgetForLimits,
  llmRouteFor,
} from "./session-runtime-config.js";
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

function toolCallChunks(index: number, id: string, name: string, args: Record<string, unknown>): DshStreamChunk[] {
  const raw = JSON.stringify(args);
  return [
    { type: "block-start", index, blockType: "tool-call" },
    { type: "tool-call-delta", index, id, name, argumentsDelta: raw },
    { type: "block-end", index, block: { type: "tool-call", id, name, arguments: raw } },
  ];
}

function syntheticSlideTranscript(pageCount: number, systemChars = 48_000): AgentMessage[] {
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const system = createInitialSystemMessage("S".repeat(systemChars), []);
  const messages: AgentMessage[] = [
    ...(system ? [system] : []),
    { role: "user", content: "生成一份 2026 年 Q3 区域零售经营月报，突出门店效率与现金流改善。", timestamp: 1 },
  ];
  let ts = 2;
  const pushCall = (id: string, name: string, args: Record<string, unknown>, resultText: string, isError = false) => {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      api: "dsh-llm",
      provider: "scripted",
      model: "m",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: ts++,
    } as unknown as AgentMessage);
    messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: resultText }],
      isError,
      timestamp: ts++,
    } as unknown as AgentMessage);
  };
  pushCall(
    "call-design",
    "commit_design",
    { items: [] },
    JSON.stringify({
      ok: true,
      designContract: {
        kind: "design-contract.v1",
        designSystemId: "work/warm-jade-annual-report",
        palette: { background: "#F7F4EE", accent: "#1F6E5A" },
      },
    }),
  );
  for (let i = 1; i <= pageCount; i += 1) {
    const pageId = `${i}_slide`;
    const bigElements = Array.from({ length: 8 }, (_, idx) => ({
      elementId: `p${i}_e${idx}`,
      elementType: "text",
      bounds: [40, 40 + idx * 50, 860, 42],
      content: { text: `第 ${i} 页指标说明条目 ${idx}：${"经营数据与门店效率分析。".repeat(8)}` },
    }));
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      pushCall(
        `call-write-${i}-${attempt}`,
        "write_page",
        { id: pageId, attempt, elements: bigElements },
        JSON.stringify({
          outcome: attempt === 1 ? "rejected" : "written",
          pageId,
          revision: attempt,
          layoutStatus: attempt === 1 ? "fail" : "pass",
          detail: attempt === 1 ? "overflow on text box" : `saved ${pageId} cleanly`,
        }),
        attempt === 1,
      );
    }
  }
  return messages;
}

test("32k window rejects pre-flight with context-window-too-small and dispatches zero requests", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-replay-32k-"));
  const store = new SliceSessionStore(workspace);
  const presentation = createPresentationRun({ repoRoot: repoRoot() });
  const sessionId = "sess-32k";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "32k Test",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "small-32k" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  writeSliceRuntime(projectRoot, {
    brief: "32k 窗口测试",
    design: { kind: "self-directed" },
    editorBaseUrl: "http://127.0.0.1:9",
    strictExecution: true,
  });
  await presentation.open({
    projectRoot,
    sessionId,
    brief: "32k 窗口测试",
    editorBaseUrl: "http://127.0.0.1:9",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "small-32k" },
  });
  const { llm, requests } = scriptedLlm([
    [
      { type: "text-delta", index: 0, text: "unreachable" },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);
  const built = buildSessionRuntime(
    { store, presentation, editorBaseUrl: "http://127.0.0.1:9", llm },
    sessionId,
    { providerId: "scripted", modelId: "small-32k", inputModalities: ["text"] },
    { contextWindow: 32_768, maxTokens: 8_192 },
  );
  const result = await built.runtime.prompt("生成一份 10 页经营月报，含趋势图表和区域对比表。".repeat(20));
  assert.equal(requests.length, 0, "32k insufficient window must fail before hitting the provider");
  assert.equal(result.status, "failed");
  assert.equal(result.fault?.code, "context-window-too-small");
  assert.equal(isPauseFault(result.fault!), true);
  await built.runtime.dispose();
});

test("64k / 128k / 200k replay meets tiered budget, working-set, effort cap and cache-first prefix stability", () => {
  // Low-maxTokens effort caps
  assert.equal(capReasoningEffortForMaxTokens("high", 8_192), "low");
  assert.equal(capReasoningEffortForMaxTokens("xhigh", 8_192), "low");
  assert.equal(capReasoningEffortForMaxTokens("medium", 8_192), "low");
  assert.equal(capReasoningEffortForMaxTokens("off", 8_192), "off");
  assert.equal(capReasoningEffortForMaxTokens("high", 16_384), "medium");
  assert.equal(capReasoningEffortForMaxTokens("low", 16_384), "low");
  assert.equal(capReasoningEffortForMaxTokens("high", 32_768), "high");
  const cappedRoute = llmRouteFor(
    { providerId: "intranet", modelId: "local-64k", reasoningEffort: "high", inputModalities: ["text"] },
    { contextWindow: 65_536, maxTokens: 8_192 },
  );
  assert.equal(cappedRoute.reasoningEffort, "low");

  // 64k working-set replay on 6-slide deck (with superseded writes)
  const deck6 = syntheticSlideTranscript(6, 52_000);
  const opts64k: ContextBudgetOptions = {
    contextWindow: 65_536,
    maxOutputTokens: 8_192,
    ...contextBudgetForLimits({ contextWindow: 65_536, maxTokens: 8_192 }),
  };
  const proj64k = projectContext(deck6, opts64k);
  assert.equal(proj64k.stats.workingSet, true);
  assert.equal(proj64k.stats.insufficientWindow, false);
  assert.ok(
    proj64k.stats.supersededCalls >= 5,
    `expected superseded write pruning, got ${proj64k.stats.supersededCalls}`,
  );
  assert.ok(
    proj64k.stats.pageReceipts >= 5,
    `expected completed pages collapsed to receipts, got ${proj64k.stats.pageReceipts}`,
  );
  assert.ok(
    proj64k.stats.projectedTokens <= proj64k.stats.budgetTokens,
    `64k projected ${proj64k.stats.projectedTokens} exceeded budget ${proj64k.stats.budgetTokens}`,
  );

  // 128k balanced replay on 12-slide deck
  const deck12 = syntheticSlideTranscript(12, 56_000);
  const opts128k: ContextBudgetOptions = {
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    ...contextBudgetForLimits({ contextWindow: 131_072, maxTokens: 16_384 }),
  };
  const proj128k = projectContext(deck12, opts128k);
  assert.equal(proj128k.stats.insufficientWindow, false);
  assert.ok(
    proj128k.stats.projectedTokens <= proj128k.stats.budgetTokens,
    `128k projected ${proj128k.stats.projectedTokens} exceeded budget ${proj128k.stats.budgetTokens}`,
  );

  // 200k cache-first prefix stability across consecutive steps below 75% threshold
  const opts200k: ContextBudgetOptions = {
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    ...contextBudgetForLimits({ contextWindow: 200_000, maxTokens: 16_384 }),
  };
  const stepA = syntheticSlideTranscript(5, 56_000);
  const stepB = syntheticSlideTranscript(6, 56_000);
  const projA = projectContext(stepA, opts200k);
  const projB = projectContext(stepB, opts200k);
  assert.equal(projA.stats.cacheFirstHold, true);
  assert.equal(projB.stats.cacheFirstHold, true);
  let identical = 0;
  for (let i = 0; i < projA.messages.length; i += 1) {
    if (JSON.stringify(projA.messages[i]) === JSON.stringify(projB.messages[i])) identical += 1;
  }
  const stability = identical / projA.messages.length;
  assert.ok(stability >= 0.95, `200k cache-first prefix stability was ${(stability * 100).toFixed(1)}% (< 95%)`);
});

test("64k runtime confirms parallel read_reference delivery via onDeliveredReferences", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-replay-refdel-"));
  const store = new SliceSessionStore(workspace);
  const presentation = createPresentationRun({ repoRoot: repoRoot() });
  const sessionId = "sess-refdel";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Delivery Confirm",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "m-128k" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  const provider = {
    providerId: "scripted",
    modelId: "m-128k",
    ready: true,
    modelInputModalities: ["text"] as const,
  };
  writeSliceRuntime(projectRoot, {
    brief: "测试投递确认",
    design: { kind: "self-directed" },
    editorBaseUrl: "http://127.0.0.1:9",
    strictExecution: true,
  });
  await presentation.open({
    projectRoot,
    sessionId,
    brief: "测试投递确认",
    editorBaseUrl: "http://127.0.0.1:9",
    design: { kind: "self-directed" },
    provider,
  });
  const initialMissing = inspectRunLedger(projectRoot, presentation.epochFor(sessionId)).missingReferenceChunks;
  assert.ok(initialMissing.length >= 2);
  const firstTwo = initialMissing.slice(0, 2);

  const { llm } = scriptedLlm([
    [
      ...toolCallChunks(0, "call-ref-0", "read_reference", {
        sourceId: firstTwo[0]!.sourceId,
        chunkIndex: firstTwo[0]!.chunkIndex,
      }),
      ...toolCallChunks(1, "call-ref-1", "read_reference", {
        sourceId: firstTwo[1]!.sourceId,
        chunkIndex: firstTwo[1]!.chunkIndex,
      }),
      { type: "finish", reason: { kind: "tool-calls" } },
    ],
    [
      { type: "text-delta", index: 0, text: "已读取两个核心参考分段。" },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);

  const built = buildSessionRuntime(
    { store, presentation, editorBaseUrl: "http://127.0.0.1:9", llm },
    sessionId,
    { providerId: "scripted", modelId: "m-128k", inputModalities: ["text"] },
    { contextWindow: 131_072, maxTokens: 8_192 },
  );
  const res = await built.runtime.prompt("开始读取核心参考资料");
  assert.equal(res.status, "completed");
  const ledger = readRunLedger(projectRoot);
  assert.ok(ledger);
  const preparedCount = ledger.facts.filter((fact) => fact.type === "reference.chunk-prepared").length;
  const returnedCount = ledger.facts.filter((fact) => fact.type === "reference.chunk-returned").length;
  assert.equal(preparedCount, 2, "delivery confirmation records chunk-prepared before model sees chunk");
  assert.equal(returnedCount, 2, "onDeliveredReferences promotes both untruncated chunks to chunk-returned");
  await built.runtime.dispose();
});

test("comment-edit and model-switch disk-summary seeding cut input tokens >= 60% while keeping log append-only", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-replay-seed-"));
  const store = new SliceSessionStore(workspace);
  const presentation = createPresentationRun({ repoRoot: repoRoot() });
  const sessionId = "sess-seed";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Summary Seed",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "m1" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  writeSliceRuntime(projectRoot, {
    brief: "制作 2026 Q3 经营月报，重点展示营收增速与华东区域门店效率。",
    design: { kind: "self-directed" },
    editorBaseUrl: "http://127.0.0.1:9",
    strictExecution: true,
  });
  recordConversationMessage(projectRoot, "制作 2026 Q3 经营月报，重点展示营收增速与华东区域门店效率。", "generate");
  recordConversationMessage(projectRoot, "请把第 2 页 KPI 卡片字号调大并加深标题对比度。", "edit");

  const rawTranscript = syntheticSlideTranscript(6, 0);
  const rawTokens = estimateMessagesTokens(rawTranscript);
  const summary = buildDiskContextSummary(projectRoot, { targetPageIds: ["2_kpi"], reason: "comment-edit" });
  assert.ok(summary.length < 2_500);
  assert.match(summary, /2026 Q3 经营月报/);
  assert.match(summary, /2_kpi/);

  const seededTokens = estimateMessagesTokens([
    { role: "user", content: summary, timestamp: 1 },
    { role: "user", content: "把第 2 页 KPI 标题字号调大到 28px", timestamp: 2 },
  ]);
  const reduction = 1 - seededTokens / rawTokens;
  assert.ok(reduction >= 0.6, `expected >= 60% token reduction on comment turn, got ${(reduction * 100).toFixed(1)}%`);

  // End-to-end manager test: turn 1 populates raw log, model switch triggers markSeedOnNextTurn, turn 2 starts seeded while log stays append-only.
  const { llm, requests } = scriptedLlm([
    [
      { type: "text-delta", index: 0, text: "初稿说明：".repeat(600) },
      { type: "finish", reason: { kind: "stop" } },
    ],
    [
      { type: "text-delta", index: 0, text: "已按新模型完成局部修订。" },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);
  let resolveDone!: () => void;
  let donePromise = new Promise<void>((r) => {
    resolveDone = r;
  });
  const manager = new SessionRuntimeManager({
    store,
    presentation,
    editorBaseUrl: "http://127.0.0.1:9",
    llm,
    resolveLimits: async () => ({ contextWindow: 131_072, maxTokens: 8_192 }),
    onStatus: (_id, status) => {
      if (status === "idle") resolveDone();
    },
  });
  await manager.open(sessionId, { providerId: "scripted", modelId: "m1", inputModalities: ["text"] });
  manager.enqueue(sessionId, { kind: "prompt", text: "第一轮生成长内容" });
  await donePromise;

  const logPath = path.join(projectRoot, "_agent", "runtime-session.v1.jsonl");
  const linesAfterTurn1 = fs.readFileSync(logPath, "utf8").trim().split("\n").length;

  donePromise = new Promise<void>((r) => {
    resolveDone = r;
  });
  store.updateProvider(sessionId, { providerId: "scripted", modelId: "m2" });
  manager.markSeedOnNextTurn(sessionId, "model-switch");
  await manager.open(sessionId, { providerId: "scripted", modelId: "m2", inputModalities: ["text"] });
  manager.enqueue(sessionId, { kind: "resume", fallbackText: "继续完成修订" });
  await donePromise;

  assert.equal(requests.length, 2);
  const turn2Text = JSON.stringify(requests[1]!.messages);
  assert.match(turn2Text, /会话摘要/);
  assert.doesNotMatch(
    turn2Text,
    /初稿说明：初稿说明：/,
    "model-switch turn must not replay turn-1 raw verbose assistant output",
  );
  const linesAfterTurn2 = fs.readFileSync(logPath, "utf8").trim().split("\n").length;
  assert.ok(linesAfterTurn2 > linesAfterTurn1, "runtime-session.v1.jsonl stays strictly append-only");
  await manager.dispose();
});

test("host produce allowlist stays within schema budgets with and without attachments", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-replay-schema-"));
  const store = new SliceSessionStore(workspace);
  const sessionId = "sess-schema";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Schema Budget",
    design: { kind: "self-directed" },
    provider: { providerId: "scripted", modelId: "m" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  const deps = { store, provider: { providerId: "scripted", modelId: "m", ready: true } };

  const withoutAttachments = sessionProduceToolAllowlist(deps, sessionId);
  const visibleWithout = [...withoutAttachments].filter((name) => name !== "ask_user_question");
  const bytesWithout = slideToolSetSchemaBytes(visibleWithout);
  assert.ok(bytesWithout <= 66 * 1024, `without attachments schema bytes ${bytesWithout} > 66 KiB`);
  assert.equal(includedToolsFor(withoutAttachments).has("patch_page_elements"), true);
  assert.equal(excludedToolsFor(withoutAttachments).has("write_layout"), true);
  assert.equal(excludedToolsFor(withoutAttachments).has("read_material"), true);

  // Add generation attachment -> material tools return and stay <= 72 KiB
  fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "generation-input.v1.json"),
    JSON.stringify({ version: 1, attachments: [{ id: "att-1", name: "report.md" }] }),
  );
  const withAttachments = sessionProduceToolAllowlist(deps, sessionId);
  const visibleWith = [...withAttachments].filter((name) => name !== "ask_user_question");
  const bytesWith = slideToolSetSchemaBytes(visibleWith);
  assert.ok(bytesWith <= 72 * 1024, `with attachments schema bytes ${bytesWith} > 72 KiB`);
  assert.equal(withAttachments.has("read_material"), true);
  assert.equal(withAttachments.has("write_layout"), false);

  // Confirm createSlideTools exposes patch_page_elements via includeTools
  const tools = createSlideTools(
    { presentation: createPresentationRun({ repoRoot: repoRoot() }), editorBaseUrl: "http://127.0.0.1:9" },
    { include: includedToolsFor(withoutAttachments), exclude: excludedToolsFor(withoutAttachments) },
  );
  const names = new Set(tools.map((tool) => tool.name));
  assert.equal(names.has("patch_page_elements"), true);
  assert.equal(names.has("write_layout"), false);
  assert.equal(names.has("read_material"), false);
  assert.ok(
    toToolDeclaration({
      name: "patch_page_elements",
      description: "",
      parameters: tools.find((t) => t.name === "patch_page_elements")!.inputSchema as never,
    }),
  );
});
