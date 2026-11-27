/**
 * Host-neutral context budget for pi-agent-core's `transformContext` hook.
 * Projects a detached copy of the transcript under a token budget derived
 * from the model window: system prompts, user instructions, signed replay, the
 * latest assistant action, every tool result of the latest assistant step and
 * the latest plan / delivery anchors stay verbatim; superseded page writes
 * shrink to identity metadata; older tool results are shortened, then
 * summarized, then reduced to placeholders; images are offloaded by count and
 * byte budget. Small windows switch to a page working set; large windows stay
 * append-only (cache-first) until they near the budget. Messages are never
 * removed, so tool-call pairing survives.
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
import {
  applyWorkingSet,
  DEFAULT_DESIGN_TOOLS,
  DEFAULT_PAGE_TOOLS,
  DEFAULT_SUPERSEDABLE_TOOLS,
  planWorkingSet,
  pruneSupersededCalls,
  WORKING_SET_MAX_WINDOW,
} from "./context-working-set.js";
import { readLlmFailure } from "./llm-port.js";
import {
  CALIBRATION_BOUNDS,
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "./token-estimate.js";

export const DEFAULT_RESERVE_TOKENS = 4_096;
/** Default safety reserve as a share of the request window (never below `DEFAULT_RESERVE_TOKENS`). */
export const DEFAULT_RESERVE_RATIO = 0.12;
export const MIN_ANSWER_TOKENS = 1_024;
/** Room a page write needs; below it the window is reported as insufficient. */
export const MIN_WRITE_ANSWER_TOKENS = 4_096;
export const CACHE_FIRST_MIN_WINDOW = 180_000;
export const CACHE_FIRST_THRESHOLD = 0.75;
export const CONTEXT_WINDOW_TOO_SMALL_CODE = "CONTEXT_WINDOW_TOO_SMALL";
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
  /** Calibration multiplier applied to the offline estimates. */
  readonly calibration: number;
  /** Estimated tokens of the messages the budget never compacts. */
  readonly protectedTokens: number;
  /** Protected anchors alone do not fit: no compaction tier can make this request fit. */
  readonly insufficientWindow: boolean;
  readonly supersededCalls: number;
  readonly workingSet: boolean;
  readonly pageReceipts: number;
  /** Large-window append-only hold: no prefix mutation below the cache-first threshold. */
  readonly cacheFirstHold: boolean;
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
  /** Safety reserve; defaults to `max(4096, 12% of the request window)`. */
  readonly reserveTokens?: number;
  readonly imageTokenEstimate?: number;
  /** Online calibration multiplier for offline estimates (bounded to [0.7, 1.8]). */
  readonly tokenMultiplier?: number;
  /** Extra most-recent tool results kept verbatim beyond the latest step's results. */
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
  /** Tools whose older calls for the same page collapse once a newer call exists. */
  readonly supersedableTools?: readonly string[];
  /** Page-scoped tools tracked by the working set. */
  readonly pageTools?: readonly string[];
  /** Design-contract tools whose latest successful result the working set anchors. */
  readonly designTools?: readonly string[];
  /** Read-reference tools whose untruncated delivery is reported. */
  readonly referenceTools?: readonly string[];
  /** Force the working set on/off; unset means automatic for small windows at tier >= 2. */
  readonly workingSet?: boolean;
  readonly workingSetMaxWindow?: number;
  /** Windows at least this large stay append-only below `cacheFirstThreshold` of the budget. */
  readonly cacheFirstMinWindow?: number;
  readonly cacheFirstThreshold?: number;
  /** Room the answer needs after protected anchors; defaults to 4096. */
  readonly minAnswerTokens?: number;
  /** Optional minimum context window required before dispatching any request (e.g. 60_000 for full deck produce). */
  readonly minContextWindow?: number;
  /** Called after a request is sent with read-reference call ids that reached the model untruncated. */
  readonly onDeliveredReferences?: (callIds: readonly string[]) => void;
  /** Start compaction at this tier (raised after a provider overflow). */
  readonly minimumTier?: number;
  readonly gateway?: GatewayCompat;
  readonly hooks?: ContextBudgetHooks;
};

/** Window a request may use: the model window under any gateway request cap. */
export function requestWindow(options: Pick<ContextBudgetOptions, "contextWindow" | "gateway">): number {
  return Math.min(options.contextWindow, options.gateway?.maxRequestTokens ?? Number.POSITIVE_INFINITY);
}

/** Default safety reserve for a request window. */
export function defaultReserveTokens(window: number): number {
  return Math.max(DEFAULT_RESERVE_TOKENS, Math.floor(window * DEFAULT_RESERVE_RATIO));
}

/** Cap the output reservation used when sizing the input budget so high-maxTokens 64k models retain input room. */
function reservedOutputTokens(window: number, maxOutputTokens: number): number {
  const cap = Math.max(8_192, Math.floor(window * 0.25));
  return Math.min(maxOutputTokens, cap);
}

/** Input token budget left after the answer, the reserve and gateway caps. */
export function contextBudgetTokens(options: ContextBudgetOptions): number {
  const window = requestWindow(options);
  const reserve = options.reserveTokens ?? defaultReserveTokens(window);
  return Math.max(0, Math.floor(window - reservedOutputTokens(window, options.maxOutputTokens) - reserve));
}

/** Bounded calibration multiplier. */
export function boundedMultiplier(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 1;
  return Math.min(CALIBRATION_BOUNDS.max, Math.max(CALIBRATION_BOUNDS.min, value));
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

/** Tool-call ids of the most recent assistant message that issued tool calls. */
function latestStepCallIds(messages: readonly AgentMessage[]): Set<string> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (roleOf(message) !== "assistant") continue;
    const ids = blocksOf(message)
      .filter((block) => block.type === "toolCall")
      .map((block) => String(block.id));
    if (ids.length) return new Set(ids);
  }
  return new Set();
}

type Anchors = { readonly protectedIndices: Set<number>; readonly failedCalls: Set<string> };

function protectAnchors(messages: readonly AgentMessage[], options: ContextBudgetOptions): Anchors {
  const protectedIndices = new Set<number>();
  const failedCalls = new Set<string>();
  const calls = toolCallsById(messages);
  const latestStep = latestStepCallIds(messages);
  const anchorTools = new Set([
    ...(options.planTools ?? DEFAULT_PLAN_TOOLS),
    ...(options.deliveryTools ?? DEFAULT_DELIVERY_TOOLS),
  ]);
  const anchored = new Set<string>();
  const keepResults = options.keepRecentResults ?? 1;
  let recentResults = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const role = roleOf(message);
    if (role === "system" || role === "user" || hasSignedReplay(message)) protectedIndices.add(index);
    if (role !== "toolResult") continue;
    const record = message as unknown as { toolCallId?: unknown; toolName?: unknown };
    const callId = String(record.toolCallId);
    const failed = isFailedToolResult(message);
    if (failed) failedCalls.add(callId);
    if (recentResults < keepResults || latestStep.has(callId)) protectedIndices.add(index);
    recentResults += 1;
    const name = String(record.toolName ?? calls.get(callId)?.name ?? "");
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

type Steps = { readonly steps: number[]; readonly latest: number };

function stepIndexes(messages: readonly AgentMessage[]): Steps {
  let step = -1;
  const steps = messages.map((message) => {
    if (roleOf(message) === "assistant") step += 1;
    return step;
  });
  return { steps, latest: step };
}

type ImagePolicy = { readonly maxImages: number; readonly maxBytes: number; readonly keepSteps: number };

/**
 * Image limits. Count and byte caps always apply (payload safety); a
 * cache-first hold drops only the step-recency rule so earlier images are not
 * offloaded merely because newer steps arrived. Working sets default to
 * 1 step / 2 images.
 */
function imagePolicy(options: ContextBudgetOptions, hold: boolean, workingSet: boolean): ImagePolicy {
  const gatewayCount = options.gateway?.maxImagesPerRequest ?? Number.POSITIVE_INFINITY;
  const gatewayBytes = options.gateway?.maxImageBytesPerRequest ?? Number.POSITIVE_INFINITY;
  const defaultSteps = hold ? Number.POSITIVE_INFINITY : workingSet ? 1 : 3;
  return {
    maxImages: Math.min(options.maxImages ?? (workingSet ? 2 : 8), gatewayCount),
    maxBytes: Math.min(options.maxImageBytes ?? 12 * 1024 * 1024, gatewayBytes),
    keepSteps: options.keepImageSteps ?? defaultSteps,
  };
}

function enforceImageBudget(messages: AgentMessage[], anchors: Anchors, steps: Steps, policy: ImagePolicy): number {
  let count = 0;
  let bytes = 0;
  let offloaded = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const recent = anchors.protectedIndices.has(index) || steps.steps[index]! > steps.latest - policy.keepSteps;
    const blocks = blocksOf(message);
    offloaded += offloadImages(message, (blockIndex) => {
      const block = blocks[blockIndex]!;
      const size = typeof block.data === "string" ? block.data.length : 0;
      const fits = recent && count + 1 <= policy.maxImages && bytes + size <= policy.maxBytes;
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

type Projection = { readonly messages: AgentMessage[]; readonly stats: ContextProjectionStats };

type Pass = {
  readonly messages: AgentMessage[];
  readonly anchors: Anchors;
  readonly steps: Steps;
  readonly imageTokens: number;
  readonly multiplier: number;
  readonly budget: number;
};

/** Apply compaction tiers until the calibrated estimate fits; returns the tier reached and raw tokens. */
function compactTiers(
  pass: Pass,
  options: ContextBudgetOptions,
  startTokens: number,
): { tier: number; tokens: number } {
  const { messages, anchors, steps, imageTokens } = pass;
  const minimumTier = Math.max(0, Math.min(4, Math.floor(options.minimumTier ?? 0)));
  const keepSteps = options.keepRecentSteps ?? 4;
  let tokens = startTokens;
  let tier = 0;
  for (const plan of tierPlans(options, anchors.failedCalls)) {
    if (Math.ceil(tokens * pass.multiplier) <= pass.budget && plan.tier > minimumTier) break;
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
  return { tier, tokens };
}

function essentialProtectedTokens(pass: Pass): number {
  let latestUser = -1;
  let latestAssistant = -1;
  for (let i = pass.messages.length - 1; i >= 0; i -= 1) {
    const role = roleOf(pass.messages[i]!);
    if (latestUser === -1 && role === "user") latestUser = i;
    if (latestAssistant === -1 && role === "assistant") latestAssistant = i;
  }
  let tokens = 0;
  for (const index of pass.anchors.protectedIndices) {
    const role = roleOf(pass.messages[index]!);
    if (role === "assistant" && index !== latestAssistant) continue;
    if (role === "user" && index !== latestUser) continue;
    tokens += estimateMessageTokens(pass.messages[index]!, pass.imageTokens);
  }
  return Math.ceil(tokens * pass.multiplier);
}

function isCacheFirstHold(options: ContextBudgetOptions, calibratedRaw: number, budget: number): boolean {
  if ((options.minimumTier ?? 0) > 0) return false;
  if (requestWindow(options) < (options.cacheFirstMinWindow ?? CACHE_FIRST_MIN_WINDOW)) return false;
  return calibratedRaw <= budget * (options.cacheFirstThreshold ?? CACHE_FIRST_THRESHOLD);
}

function projectOnce(start: readonly AgentMessage[], options: ContextBudgetOptions, workingSet: boolean): Projection {
  const imageTokens = options.imageTokenEstimate ?? DEFAULT_IMAGE_TOKEN_ESTIMATE;
  const multiplier = boundedMultiplier(options.tokenMultiplier);
  const messages = structuredClone(start) as AgentMessage[];
  const budget = contextBudgetTokens(options);
  const rawTokens = Math.ceil(estimateMessagesTokens(messages, imageTokens) * multiplier);
  const hold = !workingSet && isCacheFirstHold(options, rawTokens, budget);
  const anchors = protectAnchors(messages, options);
  const plan = workingSet
    ? planWorkingSet(messages, {
        pageTools: new Set(options.pageTools ?? DEFAULT_PAGE_TOOLS),
        designTools: new Set(options.designTools ?? DEFAULT_DESIGN_TOOLS),
      })
    : undefined;
  for (const index of plan?.protect ?? []) anchors.protectedIndices.add(index);
  const steps = stepIndexes(messages);
  const pass: Pass = { messages, anchors, steps, imageTokens, multiplier, budget };
  const imagesOffloaded = enforceImageBudget(messages, anchors, steps, imagePolicy(options, hold, workingSet));
  const supersedable = new Set(options.supersedableTools ?? DEFAULT_SUPERSEDABLE_TOOLS);
  const supersededCalls = hold ? 0 : pruneSupersededCalls(messages, anchors.protectedIndices, supersedable);
  const pageReceipts = plan ? applyWorkingSet(messages, plan, anchors.protectedIndices) : 0;
  const compacted = compactTiers(pass, options, estimateMessagesTokens(messages, imageTokens));
  const projectedTokens = Math.ceil(compacted.tokens * multiplier);
  const protectedTokens = essentialProtectedTokens(pass);
  const window = requestWindow(options);
  const answerRoom = window - protectedTokens;
  const tooSmall = options.minContextWindow !== undefined && window < options.minContextWindow;
  const stats: ContextProjectionStats = {
    budgetTokens: budget,
    rawTokens,
    projectedTokens,
    tier: compacted.tier,
    imagesOffloaded,
    overBudget: projectedTokens > budget,
    calibration: multiplier,
    protectedTokens,
    insufficientWindow:
      tooSmall || protectedTokens > budget || answerRoom < (options.minAnswerTokens ?? MIN_WRITE_ANSWER_TOKENS),
    supersededCalls,
    workingSet,
    pageReceipts,
    cacheFirstHold: hold,
  };
  return { messages, stats };
}

function autoWorkingSet(options: ContextBudgetOptions): boolean {
  return (
    options.workingSet === undefined &&
    requestWindow(options) <= (options.workingSetMaxWindow ?? WORKING_SET_MAX_WINDOW)
  );
}

/** Project `messages` under the budget. Pure apart from hooks; the input array is never mutated. */
export function projectContext(input: readonly AgentMessage[], options: ContextBudgetOptions): Projection {
  const start = options.hooks?.beforeProjection?.([...input]) ?? [...input];
  let projected = projectOnce(start, options, options.workingSet === true);
  if (autoWorkingSet(options) && projected.stats.tier >= 2) projected = projectOnce(start, options, true);
  options.hooks?.onProjection?.(projected.stats);
  const messages = options.hooks?.afterProjection?.(projected.messages, projected.stats) ?? projected.messages;
  return { messages, stats: projected.stats };
}

/**
 * Stateful budget bound to one route. `transform` is the `transformContext`
 * hook (never throws); `escalate` raises the minimum tier after a provider
 * overflow so the retry sends a smaller projection.
 */
export class ContextBudget {
  private minimumTier = 0;
  private last?: ContextProjectionStats;
  private lastInput?: readonly AgentMessage[];

  constructor(private readonly options: () => ContextBudgetOptions) {}

  get lastProjection(): ContextProjectionStats | undefined {
    return this.last;
  }

  get tier(): number {
    return this.minimumTier;
  }

  /**
   * Raise the floor to the lowest tier above the current one that actually
   * shrinks the last projection, skipping no-op tiers. When no stronger tier
   * reduces it, jump straight to the strongest tier so a single retry still
   * happens. Returns false once the strongest tier is already in force.
   */
  escalate(): boolean {
    const floor = Math.max(this.minimumTier, this.last?.tier ?? 0);
    if (floor >= 4) return false;
    this.minimumTier = this.reducingTier(floor) ?? (this.last && this.lastInput ? 4 : floor + 1);
    return true;
  }

  /** Lowest tier above `floor` whose projection of the last input is smaller than the last projection. */
  private reducingTier(floor: number): number | undefined {
    const last = this.last;
    const input = this.lastInput;
    if (!last || !input) return undefined;
    try {
      const options = this.options();
      const hooks = options.hooks ? { ...options.hooks, onProjection: undefined } : undefined;
      for (let tier = floor + 1; tier <= 4; tier += 1) {
        const { stats } = projectContext(input, { ...options, hooks, minimumTier: tier });
        if (stats.projectedTokens < last.projectedTokens) return tier;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  reset(): void {
    this.minimumTier = 0;
  }

  readonly transform = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    try {
      this.lastInput = [...messages];
      const projected = projectContext(messages, { ...this.options(), minimumTier: this.minimumTier });
      this.last = projected.stats;
      return projected.messages;
    } catch {
      this.last = undefined;
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
  const failure = readLlmFailure(message);
  if (failure?.code === CONTEXT_WINDOW_TOO_SMALL_CODE) return false;
  if (gateway?.isOverflowError?.(message)) return true;
  if (failure && /CONTEXT_(?:WINDOW|BUDGET|HISTORY)/i.test(failure.code)) return true;
  if (isContextOverflow(message, contextWindow)) return true;
  return /context[_ -]?(?:window|length)[_ -]?(?:exceeded|overflow)|maximum context length|CONTEXT_WINDOW_EXCEEDED|上下文.*(?:超出|超过|已满)/i.test(
    message.errorMessage ?? "",
  );
}
