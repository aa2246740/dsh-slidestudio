/** Runtime options, tool assembly and the budget-aware stream wrapper. */
import type { AgentTool, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelPolicyProfile } from "@open-slidestudio/presentation-run";
import {
  createSlideTools,
  SLIDES_DIRECTOR_PERSONA,
  type PostTurnHook,
  type SlideCaller,
  type SlideProjectPort,
  type SlideToolRuntimeDeps,
} from "@open-slidestudio/slides-tools";
import {
  boundedMultiplier,
  clampMaxTokens,
  requestWindow,
  type ContextBudgetOptions,
  type ContextProjectionStats,
} from "./context-budget.js";
import { failedStream, type LlmPort } from "./llm-port.js";
import { localProjectPort } from "./local-project-port.js";
import type { PersistentProductSnapshot } from "./progress-snapshot.js";
import { ProgressGuard, type ProductProgressConfig } from "./progress-guard.js";
import type { RuntimeFault } from "./faults.js";
import { WriterLeaseKeeper, type LeaseMode } from "./lease-keeper.js";
import { insufficientWindowFailure } from "./runtime-recovery.js";
import { observingPort, piAiSchemaValidator } from "./runtime-support.js";
import { estimateMessagesTokens } from "./token-estimate.js";
import { adaptSlideTool, SerialGate, type ProjectBinding, type RuntimeToolArgsError } from "./tool-adapter.js";
import { askUserQuestionTool, type QuestionBroker } from "./user-question.js";

export type SlidesRuntimeOptions = {
  readonly llm: LlmPort;
  readonly sessionId?: string;
  /** Lease/receipt identity; defaults to `{ kind: "hub-run", id: "hub-run:<sessionId>" }`. */
  readonly caller?: SlideCaller;
  /** Tool runtime dependencies. Without `projects`, `dataRoot` enables the standalone project port. */
  readonly toolDeps: Omit<SlideToolRuntimeDeps, "projects"> & { readonly projects?: SlideProjectPort };
  readonly dataRoot?: string;
  /** Already-bound project: its session log is recovered and the run continues there. */
  readonly project?: ProjectBinding;
  readonly systemPrompt?: string;
  /** Substituted for `{{cwd}}` in the default persona. */
  readonly workingDirectory?: string;
  readonly includeTools?: ReadonlySet<string>;
  readonly excludeTools?: ReadonlySet<string>;
  readonly extraTools?: readonly AgentTool[];
  /** Enable the built-in `ask_user_question` suspension tool (interactive hosts only). */
  readonly userQuestions?: boolean;
  readonly policy?: ModelPolicyProfile;
  readonly postTurnHooks?: readonly PostTurnHook[];
  readonly contextBudget?: Partial<Omit<ContextBudgetOptions, "contextWindow" | "maxOutputTokens">>;
  readonly guards?: {
    readonly progress?: ProductProgressConfig | false;
    readonly sampleProgress?: (projectRoot: string) => PersistentProductSnapshot;
  };
  readonly lease?: { readonly mode?: LeaseMode; readonly ttlMs?: number; readonly heartbeatMs?: number } | false;
  readonly toolTimeoutMs?: number;
  readonly rateLimit?: {
    readonly maxAttempts?: number;
    /** Injected for tests; resolves false when aborted. */
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  };
  readonly persistImages?: boolean;
  readonly thinkingLevel?: ThinkingLevel;
  /** Auto-continue attempts per turn after a reply hits the output limit without a tool call (default 2). */
  readonly maxTokensAutoRetries?: number;
  /** Nudge injected before such an auto-continue. */
  readonly maxTokensNudge?: string;
  /**
   * Start from a fresh context seeded with this compact disk summary instead of
   * replaying the recovered raw history. The session log stays append-only.
   */
  readonly initialSummaryContext?: string;
};

/** Optional request-time hooks of `streamWithBudget`. */
export type StreamBudgetHooks = {
  /** Stats of the projection that produced this request; an insufficient window fails before dispatch. */
  readonly projection?: () => ContextProjectionStats | undefined;
  /** Uncalibrated input estimate of the dispatched request (feeds online calibration). */
  readonly onEstimate?: (estimatedTokens: number) => void;
  /** Active thinking level; when `"off"`, explicitly clears `reasoning` on the stream options. */
  readonly thinkingLevel?: () => ThinkingLevel;
};

export type ToolAssembly = {
  readonly caller: SlideCaller;
  readonly sessionId: string;
  readonly policy: ModelPolicyProfile;
  readonly questions?: QuestionBroker;
  readonly binding: () => ProjectBinding | undefined;
  readonly onBind: (binding: ProjectBinding) => void;
  readonly onInvalidArgs: (callId: string, error: RuntimeToolArgsError) => void;
  readonly deferDelivery: (callId: string, hook: () => Promise<void>) => void;
  readonly turnSignal: () => AbortSignal | undefined;
};

export function defaultSystemPrompt(cwd: string | undefined): string {
  return SLIDES_DIRECTOR_PERSONA.split("{{cwd}}").join(cwd ?? process.cwd());
}

function projectPortFor(options: SlidesRuntimeOptions, assembly: ToolAssembly): SlideProjectPort | undefined {
  if (options.toolDeps.projects) return observingPort(options.toolDeps.projects, assembly.onBind);
  if (!options.dataRoot) return undefined;
  return localProjectPort({
    dataRoot: options.dataRoot,
    editorBaseUrl: options.toolDeps.editorBaseUrl,
    presentation: options.toolDeps.presentation,
    sessionId: assembly.sessionId,
    route: () => options.llm.route,
    onBind: assembly.onBind,
    current: assembly.binding,
  });
}

/** Canonical slide tools (plus optional question and extra tools) adapted for pi-agent-core. */
export function buildRuntimeTools(options: SlidesRuntimeOptions, assembly: ToolAssembly): AgentTool[] {
  const projects = projectPortFor(options, assembly);
  const deps: SlideToolRuntimeDeps = {
    validateSchema: piAiSchemaValidator,
    ...options.toolDeps,
    ...(projects ? { projects } : {}),
  };
  const serial = new SerialGate();
  const acceptsImages = () => options.llm.route.inputModalities.includes("image");
  const adapted = createSlideTools(deps, {
    ...(options.includeTools ? { include: options.includeTools } : {}),
    ...(options.excludeTools ? { exclude: options.excludeTools } : {}),
  }).map((def) =>
    adaptSlideTool(def, {
      caller: assembly.caller,
      sessionId: assembly.sessionId,
      binding: assembly.binding,
      acceptsImages,
      serial,
      onInvalidArgs: assembly.onInvalidArgs,
      deferDelivery: assembly.deferDelivery,
      turnSignal: assembly.turnSignal,
      ...(options.toolTimeoutMs ? { timeoutMs: options.toolTimeoutMs } : {}),
      ...(assembly.policy.maxToolResultChars ? { maxResultChars: assembly.policy.maxToolResultChars } : {}),
    }),
  );
  return [
    ...adapted,
    ...(assembly.questions ? [askUserQuestionTool(assembly.questions)] : []),
    ...(options.extraTools ?? []),
  ];
}

/** Wrap the port's stream so `maxTokens` never exceeds what the window leaves after the input. */
export function streamWithBudget(
  llm: LlmPort,
  budget: () => ContextBudgetOptions,
  onRequestMessages?: (messages: readonly import("@earendil-works/pi-agent-core").AgentMessage[]) => void,
  hooks: StreamBudgetHooks = {},
): StreamFn {
  return (model, context, streamOptions) => {
    if (streamOptions?.signal?.aborted) {
      return failedStream(model, { code: "ABORTED", message: "the run was aborted before the request" }, true);
    }
    const options = budget();
    const window = requestWindow(options);
    const stats = hooks.projection?.();
    if (stats?.insufficientWindow) return failedStream(model, insufficientWindowFailure(stats, window));
    onRequestMessages?.(context.messages);
    const estimated = estimateMessagesTokens(context.messages, options.imageTokenEstimate);
    hooks.onEstimate?.(estimated);
    const inputTokens = Math.ceil(estimated * boundedMultiplier(options.tokenMultiplier));
    const requested = streamOptions?.maxTokens ?? llm.route.maxTokens;
    const maxTokens = clampMaxTokens({ contextWindow: window, inputTokens, requested });
    const nextOptions = {
      ...streamOptions,
      maxTokens,
      ...(hooks.thinkingLevel?.() === "off" ? { reasoning: undefined } : {}),
    };
    return llm.stream(model, context, nextOptions);
  };
}

export function progressGuardFor(options: SlidesRuntimeOptions): ProgressGuard | undefined {
  const guards = options.guards;
  if (guards?.progress === false) return undefined;
  return new ProgressGuard({
    config: guards?.progress ?? {},
    ...(guards?.sampleProgress ? { sample: guards.sampleProgress } : {}),
  });
}

export function leaseKeeperFor(
  options: SlidesRuntimeOptions,
  caller: SlideCaller,
  onLost: (fault: RuntimeFault) => void,
): WriterLeaseKeeper | undefined {
  const lease = options.lease;
  if (lease === false) return undefined;
  return new WriterLeaseKeeper({
    caller,
    ...(lease?.mode ? { mode: lease.mode } : {}),
    ...(lease?.ttlMs ? { ttlMs: lease.ttlMs } : {}),
    ...(lease?.heartbeatMs ? { heartbeatMs: lease.heartbeatMs } : {}),
    onLost,
  });
}
