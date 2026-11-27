/**
 * In-turn recovery helpers for the runtime: thinking max-tokens auto-continue
 * (strip the truncated reply from the in-memory context, step the reasoning
 * effort down, nudge the model), the insufficient-window fault and
 * summary-seeded fresh contexts. The durable session log is never rewritten:
 * stripped replies stay in `runtime-session.v1.jsonl`.
 */
import type { Agent, AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelPolicyProfile } from "@open-slidestudio/presentation-run";
import {
  CONTEXT_WINDOW_TOO_SMALL_CODE,
  isContextOverflowMessage,
  type ContextBudget,
  type ContextProjectionStats,
} from "./context-budget.js";
import { classifyLlmFailure, rateLimitWaitMs } from "./faults.js";
import { readLlmFailure, type LlmFailure } from "./llm-port.js";
import type { SlidesRuntimeOptions } from "./runtime-config.js";
import { DEFAULT_REFERENCE_TOOLS, untruncatedResultCallIds } from "./context-working-set.js";
import {
  imageResultCallIds,
  lastAssistant,
  sleep,
  withoutTrailingFailure,
  type RuntimeEvent,
  type TurnState,
} from "./runtime-support.js";

export const DEFAULT_MAX_TOKENS_AUTO_RETRIES = 2;
export const MAX_TOKENS_NUDGE = "上一轮思考达到输出上限；请直接精简推理并立即调用下一步工具。";
export const SUMMARY_SEED_HEADER =
  "[会话摘要] 以下是从磁盘恢复的项目与会话摘要，用来替代早期的原始生成历史；需要细节时请用工具重新读取。";
/** Window the runtime recommends when the configured model window cannot hold the protected context. */
export const RECOMMENDED_CONTEXT_WINDOW = 64_000;

const STEP_DOWN: Readonly<Record<ThinkingLevel, ThinkingLevel>> = {
  max: "high",
  xhigh: "high",
  high: "medium",
  medium: "low",
  low: "off",
  minimal: "off",
  off: "off",
};

const EFFORT_DESC: readonly ThinkingLevel[] = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];

/** One reasoning-effort notch lower, skipping tiers absent from `supportedEfforts` when declared. */
export function stepDownThinking(level: ThinkingLevel, supportedEfforts?: readonly string[]): ThinkingLevel {
  const next = STEP_DOWN[level] ?? "off";
  if (supportedEfforts === undefined) return next;
  const supported = new Set(supportedEfforts);
  const start = EFFORT_DESC.indexOf(next);
  if (start < 0) return "off";
  for (let i = start; i < EFFORT_DESC.length; i += 1) {
    const candidate = EFFORT_DESC[i]!;
    if (candidate === "off" || supported.has(candidate)) return candidate;
  }
  return "off";
}

/** The trailing assistant reply stopped at the output limit without issuing any tool call. */
export function isTruncatedWithoutTools(message: AssistantMessage | undefined): boolean {
  if (!message || message.stopReason !== "length") return false;
  return !message.content.some((block) => block.type === "toolCall");
}

/** Remove the trailing truncated assistant reply from an in-memory transcript. */
export function withoutTrailingTruncation(messages: readonly AgentMessage[]): AgentMessage[] {
  const last = messages.at(-1) as AssistantMessage | undefined;
  return (last as { role?: unknown } | undefined)?.role === "assistant" && isTruncatedWithoutTools(last)
    ? messages.slice(0, -1)
    : [...messages];
}

export function maxTokensNudge(text = MAX_TOKENS_NUDGE): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

/** Structured LLM failure raised before dispatch when protected context cannot fit the window. */
export function insufficientWindowFailure(stats: ContextProjectionStats, contextWindow: number): LlmFailure {
  const belowRecommended = contextWindow < RECOMMENDED_CONTEXT_WINDOW;
  const detail = belowRecommended
    ? `模型上下文窗口过小（当前 ${contextWindow} tokens），不足以容纳完整演示文稿生成；请切换到上下文窗口不小于 ${RECOMMENDED_CONTEXT_WINDOW / 1000}k 的模型后重试。`
    : `模型上下文窗口不足：受保护的上下文约 ${stats.protectedTokens} tokens，可用输入预算仅 ${stats.budgetTokens} tokens` +
      `（当前窗口 ${contextWindow}）。请切换到更大上下文窗口的模型或开启新一轮会话后重试。`;
  return { code: CONTEXT_WINDOW_TOO_SMALL_CODE, message: detail };
}

/** User message carrying a compact disk summary that replaces replayed raw history. */
export function summarySeedMessage(summary: string): AgentMessage {
  return { role: "user", content: `${SUMMARY_SEED_HEADER}\n\n${summary.trim()}`, timestamp: Date.now() };
}

/** Fresh model context: the initial system header (prompt + tools) followed by the summary seed. */
export function seededContext(summary: string, systemPrompt: string, tools: readonly AgentTool[]): AgentMessage[] {
  const initial = createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration));
  return [...(initial ? [initial] : []), summarySeedMessage(summary)];
}

/** Report each read-reference call id once per runtime; returns the newly delivered ids. */
export function freshDeliveries(delivered: readonly string[], reported: Set<string>): string[] {
  const fresh = delivered.filter((id) => !reported.has(id));
  for (const id of fresh) reported.add(id);
  return fresh;
}

type BudgetConfig = SlidesRuntimeOptions["contextBudget"];

/** Remember which images and untruncated reference reads the dispatched request carries. */
export function trackOutgoing(
  turn: TurnState | undefined,
  outgoing: readonly AgentMessage[],
  budget: BudgetConfig,
): void {
  if (!turn) return;
  turn.inFlightImageCallIds = imageResultCallIds(outgoing);
  if (!budget?.onDeliveredReferences) return;
  const tools = new Set(budget.referenceTools ?? DEFAULT_REFERENCE_TOOLS);
  turn.inFlightReferenceCallIds = untruncatedResultCallIds(outgoing, tools);
}

/** Invoke `onDeliveredReferences` with ids not reported before (best effort, never throws). */
export function reportDeliveredReferences(
  callIds: readonly string[],
  reported: Set<string>,
  budget: BudgetConfig,
): void {
  const fresh = freshDeliveries(callIds, reported);
  if (!fresh.length) return;
  try {
    budget?.onDeliveredReferences?.(fresh);
  } catch {
    // Reference accounting is best effort.
  }
}

export type RecoveryContext = {
  readonly agent: Agent;
  readonly budget: ContextBudget;
  readonly options: SlidesRuntimeOptions;
  readonly policy: ModelPolicyProfile;
  readonly state: TurnState;
  readonly emit: (event: RuntimeEvent) => void;
};

type RecoveryCounters = { rate: number; overflowRetried: boolean; truncated: number };

/** Provider-overflow retry (one escalation per turn) and bounded 429 backoff; true when the turn continued. */
async function recoverError(
  ctx: RecoveryContext,
  last: AssistantMessage,
  counters: RecoveryCounters,
): Promise<boolean> {
  const { agent, options, state } = ctx;
  const fault = classifyLlmFailure(readLlmFailure(last) ?? { code: "UNKNOWN", message: "" }, ctx.policy);
  const overflow =
    fault.code === "context-overflow" ||
    isContextOverflowMessage(last, options.llm.route.contextWindow, options.contextBudget?.gateway);
  if (overflow && !counters.overflowRetried && ctx.budget.escalate()) {
    counters.overflowRetried = true;
    ctx.emit({ type: "context/escalate", tier: ctx.budget.tier });
  } else {
    if (fault.code !== "provider-rate-limit" || counters.rate >= (options.rateLimit?.maxAttempts ?? 3)) return false;
    const waitMs = rateLimitWaitMs(counters.rate, fault.retryAfterMs);
    counters.rate += 1;
    ctx.emit({ type: "rate-limit/wait", attempt: counters.rate, waitMs });
    if (!(await (options.rateLimit?.sleep ?? sleep)(waitMs, state.signal.signal))) return false;
  }
  agent.state.messages = withoutTrailingFailure(agent.state.messages);
  await agent.continue();
  return true;
}

/**
 * A reply cut off by the output limit before any tool call: drop it from the
 * model context, step reasoning down one notch, nudge and continue. The turn
 * stays the same turn, so progress guards see no extra turn boundary.
 */
async function recoverTruncation(ctx: RecoveryContext, counters: RecoveryCounters): Promise<boolean> {
  const { agent, options } = ctx;
  const last = agent.state.messages.at(-1) as AssistantMessage | undefined;
  const limit = Math.max(0, Math.floor(options.maxTokensAutoRetries ?? DEFAULT_MAX_TOKENS_AUTO_RETRIES));
  if (!isTruncatedWithoutTools(last) || counters.truncated >= limit) return false;
  counters.truncated += 1;
  const thinkingLevel = stepDownThinking(agent.state.thinkingLevel, options.llm.route.supportedReasoningEfforts);
  agent.state.thinkingLevel = thinkingLevel;
  agent.state.messages = withoutTrailingTruncation(agent.state.messages);
  ctx.emit({ type: "max-tokens/retry", attempt: counters.truncated, thinkingLevel });
  await agent.prompt(maxTokensNudge(options.maxTokensNudge));
  return true;
}

/** Drive every in-turn recovery until the turn settles. */
export async function recoverTurnFailures(ctx: RecoveryContext): Promise<void> {
  const counters: RecoveryCounters = { rate: 0, overflowRetried: false, truncated: 0 };
  for (;;) {
    const last = lastAssistant(ctx.agent.state.messages);
    if (!last || ctx.state.fault || ctx.state.signal.signal.aborted) return;
    let continued = false;
    if (last.stopReason === "length") continued = await recoverTruncation(ctx, counters);
    else if (last.stopReason === "error") continued = await recoverError(ctx, last, counters);
    if (!continued) return;
  }
}

/** Run deferred image-delivery receipts for results that reached the model. */
export async function flushImageDeliveries(
  turn: TurnState,
  delivered: Iterable<string>,
  canWrite: () => boolean,
): Promise<void> {
  for (const callId of delivered) {
    if (turn.signal.signal.aborted || Boolean(turn.fault)) break;
    const hook = turn.deliveries.get(callId);
    if (!hook) continue;
    turn.deliveries.delete(callId);
    if (!canWrite()) break;
    try {
      await hook();
    } catch {
      // Delivery receipts are best effort; the image already reached the model.
    }
  }
}
