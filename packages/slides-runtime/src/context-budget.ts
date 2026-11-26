/**
 * Host-neutral context budget for pi-agent-core's `transformContext` hook.
 * Projects a detached copy of the transcript under a token budget derived
 * from the model window: system prompts, user instructions, signed replay, the
 * latest assistant action, the most recent tool results and the latest plan /
 * delivery anchors stay verbatim; older tool results are shortened, then
 * summarized, then reduced to placeholders; images are offloaded by count and
 * byte budget. Messages are never removed, so tool-call pairing survives.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  blocksOf,
  isFailedToolResult,
  offloadImages,
  roleOf,
  trimMessage,
  type TrimPlan,
} from "./context-compaction.js";
import { readLlmFailure } from "./llm-port.js";
import { DEFAULT_IMAGE_TOKEN_ESTIMATE, estimateMessageTokens, estimateMessagesTokens } from "./token-estimate.js";

export const DEFAULT_RESERVE_TOKENS = 4_096;
export const MIN_ANSWER_TOKENS = 1_024;
const DEFAULT_MAX_ITEM_CHARS = 32 * 1024;
const DEFAULT_PLAN_TOOLS = ["commit_design", "write_todo"];
const DEFAULT_DELIVERY_TOOLS = ["compose_deck", "export_deck"];

/** Optional gateway constraints (OpenAI-compatible proxies, local servers). Defaults impose none. */
export type GatewayCompat = {
  readonly maxImagesPerRequest?: number;
  readonly maxImageBytesPerRequest?: number;
  /** Hard ceiling below the model window, e.g. a proxy's request token cap. */
  readonly maxRequestTokens?: number;
  /** Extra provider-specific overflow recognition. */
  readonly isOverflowError?: (message: AssistantMessage) => boolean;
};

export type ContextProjectionStats = {
  readonly budgetTokens: number;
  readonly rawTokens: number;
  readonly projectedTokens: number;
  readonly tier: number;
  readonly imagesOffloaded: number;
  readonly overBudget: boolean;
};

/** Extension seam for overlays; core ships none. Hooks must not throw. */
export type ContextBudgetHooks = {
  readonly beforeProjection?: (messages: AgentMessage[]) => AgentMessage[];
  readonly afterProjection?: (messages: AgentMessage[], stats: ContextProjectionStats) => AgentMessage[];
  readonly onProjection?: (stats: ContextProjectionStats) => void;
};

export type ContextBudgetOptions = {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reserveTokens?: number;
  readonly imageTokenEstimate?: number;
  /** Most recent tool results kept verbatim. */
  readonly keepRecentResults?: number;
  /** Steps (assistant messages) whose prose survives tier 4. */
  readonly keepRecentSteps?: number;
  /** Steps whose images survive the image budget. */
  readonly keepImageSteps?: number;
  readonly maxImages?: number;
  readonly maxImageBytes?: number;
  readonly maxItemChars?: number;
  readonly planTools?: readonly string[];
  readonly deliveryTools?: readonly string[];
  /** Start compaction at this tier (raised after a provider overflow). */
  readonly minimumTier?: number;
  readonly gateway?: GatewayCompat;
  readonly hooks?: ContextBudgetHooks;
};

/** Input token budget left after the answer, the reserve and gateway caps. */
export function contextBudgetTokens(options: ContextBudgetOptions): number {
  const window = Math.min(options.contextWindow, options.gateway?.maxRequestTokens ?? Number.POSITIVE_INFINITY);
  return Math.max(0, Math.floor(window - options.maxOutputTokens - (options.reserveTokens ?? DEFAULT_RESERVE_TOKENS)));
}

type ToolCallInfo = { readonly name: string; readonly index: number };

function toolCallsById(messages: readonly AgentMessage[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  messages.forEach((message, index) => {
    if (roleOf(message) !== "assistant") return;
    for (const block of blocksOf(message)) {
      if (block.type === "toolCall") calls.set(String(block.id), { name: String(block.name), index });
    }
  });
  return calls;
}

function hasSignedReplay(message: AgentMessage): boolean {
  return blocksOf(message).some(
    (block) => Boolean(block.textSignature) || Boolean(block.thoughtSignature) || Boolean(block.thinkingSignature),
  );
}

type Anchors = { readonly protectedIndices: Set<number>; readonly failedCalls: Set<string> };

function protectAnchors(messages: readonly AgentMessage[], options: ContextBudgetOptions): Anchors {
  const protectedIndices = new Set<number>();
  const failedCalls = new Set<string>();
  const calls = toolCallsById(messages);
  const anchorTools = new Set([
    ...(options.planTools ?? DEFAULT_PLAN_TOOLS),
    ...(options.deliveryTools ?? DEFAULT_DELIVERY_TOOLS),
  ]);
  const anchored = new Set<string>();
  const keepResults = options.keepRecentResults ?? 2;
  let recentResults = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const role = roleOf(message);
    if (role === "system" || role === "user" || hasSignedReplay(message)) protectedIndices.add(index);
    if (role !== "toolResult") continue;
    const record = message as unknown as { toolCallId?: unknown; toolName?: unknown };
    const failed = isFailedToolResult(message);
    if (failed) failedCalls.add(String(record.toolCallId));
    if (recentResults < keepResults) protectedIndices.add(index);
    recentResults += 1;
    const name = String(record.toolName ?? calls.get(String(record.toolCallId))?.name ?? "");
    if (anchorTools.has(name) && !failed && !anchored.has(name)) {
      anchored.add(name);
      protectedIndices.add(index);
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (roleOf(messages[index]!) !== "assistant") continue;
    protectedIndices.add(index);
    break;
  }
  return { protectedIndices, failedCalls };
}

function stepIndexes(messages: readonly AgentMessage[]): { steps: number[]; latest: number } {
  let step = -1;
  const steps = messages.map((message) => {
    if (roleOf(message) === "assistant") step += 1;
    return step;
  });
  return { steps, latest: step };
}

function enforceImageBudget(
  messages: AgentMessage[],
  anchors: Anchors,
  steps: { steps: number[]; latest: number },
  options: ContextBudgetOptions,
): number {
  const maxImages = Math.min(options.maxImages ?? 8, options.gateway?.maxImagesPerRequest ?? Number.POSITIVE_INFINITY);
  const maxBytes = Math.min(
    options.maxImageBytes ?? 12 * 1024 * 1024,
    options.gateway?.maxImageBytesPerRequest ?? Number.POSITIVE_INFINITY,
  );
  const keepSteps = options.keepImageSteps ?? 3;
  let count = 0;
  let bytes = 0;
  let offloaded = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const recent = anchors.protectedIndices.has(index) || steps.steps[index]! > steps.latest - keepSteps;
    const blocks = blocksOf(message);
    offloaded += offloadImages(message, (blockIndex) => {
      const block = blocks[blockIndex]!;
      const size = typeof block.data === "string" ? block.data.length : 0;
      const fits = recent && count + 1 <= maxImages && bytes + size <= maxBytes;
      if (fits) {
        count += 1;
        bytes += size;
      }
      return fits;
    });
  }
  return offloaded;
}

function tierPlans(options: ContextBudgetOptions, failedCalls: ReadonlySet<string>): TrimPlan[] {
  const limit = options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS;
  return [
    { tier: 1, limit, failedCalls },
    { tier: 2, limit: 1_024, failedCalls },
    { tier: 3, limit: 512, failedCalls },
    { tier: 4, limit: 0, failedCalls },
  ];
}

/** Project `messages` under the budget. Pure apart from hooks; the input array is never mutated. */
export function projectContext(
  input: readonly AgentMessage[],
  options: ContextBudgetOptions,
): { readonly messages: AgentMessage[]; readonly stats: ContextProjectionStats } {
  const imageTokens = options.imageTokenEstimate ?? DEFAULT_IMAGE_TOKEN_ESTIMATE;
  const start = options.hooks?.beforeProjection?.([...input]) ?? [...input];
  const messages = structuredClone(start);
  const budget = contextBudgetTokens(options);
  const rawTokens = estimateMessagesTokens(messages, imageTokens);
  const anchors = protectAnchors(messages, options);
  const steps = stepIndexes(messages);
  const imagesOffloaded = enforceImageBudget(messages, anchors, steps, options);
  let tokens = estimateMessagesTokens(messages, imageTokens);
  let tier = 0;
  const minimumTier = Math.max(0, Math.min(4, Math.floor(options.minimumTier ?? 0)));
  const keepSteps = options.keepRecentSteps ?? 4;
  for (const plan of tierPlans(options, anchors.failedCalls)) {
    if (tokens <= budget && plan.tier > minimumTier) break;
    tier = plan.tier;
    for (let index = 0; index < messages.length; index += 1) {
      if (anchors.protectedIndices.has(index)) continue;
      const old = steps.steps[index]! <= steps.latest - keepSteps;
      if (plan.tier >= 3 && !old) continue;
      const before = estimateMessageTokens(messages[index]!, imageTokens);
      trimMessage(messages[index]!, plan);
      tokens += estimateMessageTokens(messages[index]!, imageTokens) - before;
    }
  }
  const stats: ContextProjectionStats = {
    budgetTokens: budget,
    rawTokens,
    projectedTokens: tokens,
    tier,
    imagesOffloaded,
    overBudget: tokens > budget,
  };
  options.hooks?.onProjection?.(stats);
  return { messages: options.hooks?.afterProjection?.(messages, stats) ?? messages, stats };
}

/**
 * Stateful budget bound to one route. `transform` is the `transformContext`
 * hook (never throws); `escalate` raises the minimum tier after a provider
 * overflow so the retry sends a smaller projection.
 */
export class ContextBudget {
  private minimumTier = 0;
  private last?: ContextProjectionStats;

  constructor(private readonly options: () => ContextBudgetOptions) {}

  get lastProjection(): ContextProjectionStats | undefined {
    return this.last;
  }

  get tier(): number {
    return this.minimumTier;
  }

  /** Raise the floor tier; returns false once the strongest tier is already in force. */
  escalate(): boolean {
    if (this.minimumTier >= 4) return false;
    this.minimumTier = Math.max(this.minimumTier, this.last?.tier ?? 0) + 1;
    return true;
  }

  reset(): void {
    this.minimumTier = 0;
  }

  readonly transform = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    try {
      const projected = projectContext(messages, { ...this.options(), minimumTier: this.minimumTier });
      this.last = projected.stats;
      return projected.messages;
    } catch {
      return messages;
    }
  };
}

/** Fit `requested` output tokens into what the window leaves after the estimated input. */
export function clampMaxTokens(input: {
  readonly contextWindow: number;
  readonly inputTokens: number;
  readonly requested: number;
  readonly reserveTokens?: number;
  readonly minTokens?: number;
}): number {
  const remaining = Math.max(0, Math.floor(input.contextWindow - input.inputTokens));
  const hardCap = Math.min(input.requested, Math.max(1, remaining));
  if (remaining <= 0) return hardCap;
  const room = Math.floor(remaining - (input.reserveTokens ?? MIN_ANSWER_TOKENS));
  const floor = Math.min(hardCap, input.minTokens ?? MIN_ANSWER_TOKENS);
  return Math.max(floor, Math.min(hardCap, room));
}

/** Whether a failed assistant message reports a context-window overflow. */
export function isContextOverflowMessage(
  message: AssistantMessage,
  contextWindow?: number,
  gateway?: GatewayCompat,
): boolean {
  if (message.stopReason !== "error") return false;
  if (gateway?.isOverflowError?.(message)) return true;
  const failure = readLlmFailure(message);
  if (failure && /CONTEXT_(?:WINDOW|BUDGET|HISTORY)/i.test(failure.code)) return true;
  if (isContextOverflow(message, contextWindow)) return true;
  return /context[_ -]?(?:window|length)[_ -]?(?:exceeded|overflow)|maximum context length|CONTEXT_WINDOW_EXCEEDED|上下文.*(?:超出|超过|已满)/i.test(
    message.errorMessage ?? "",
  );
}
