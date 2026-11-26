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
import { clampMaxTokens, type ContextBudgetOptions } from "./context-budget.js";
import { failedStream, type LlmPort } from "./llm-port.js";
import { localProjectPort } from "./local-project-port.js";
import type { PersistentProductSnapshot } from "./progress-snapshot.js";
import { ProgressGuard, type ProductProgressConfig } from "./progress-guard.js";
import type { RuntimeFault } from "./faults.js";
import { WriterLeaseKeeper, type LeaseMode } from "./lease-keeper.js";
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
  const adapted = createSlideTools(deps, options.excludeTools ? { exclude: options.excludeTools } : {}).map((def) =>
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
): StreamFn {
  return (model, context, streamOptions) => {
    if (streamOptions?.signal?.aborted) {
      return failedStream(model, { code: "ABORTED", message: "the run was aborted before the request" }, true);
    }
    onRequestMessages?.(context.messages);
    const options = budget();
    const inputTokens = estimateMessagesTokens(context.messages, options.imageTokenEstimate);
    const requested = streamOptions?.maxTokens ?? llm.route.maxTokens;
    const window = Math.min(options.contextWindow, options.gateway?.maxRequestTokens ?? Number.POSITIVE_INFINITY);
    const maxTokens = clampMaxTokens({ contextWindow: window, inputTokens, requested });
    return llm.stream(model, context, { ...streamOptions, maxTokens });
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
