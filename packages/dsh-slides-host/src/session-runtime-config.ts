/**
 * Builds one session's `SlidesAgentRuntime`: the DSH LLM route served by
 * `DshLlmPort` (`ctx.llm` + `ctx.attachments`), the canonical slide tools over
 * a `SliceSessionStore`-backed project port, the Hub tool policy and the
 * `hub-run:<sessionId>` writer-lease identity.
 */
import {
  recordReferenceDeliveredByCommandId,
  REFERENCE_DELIVERY_ENV,
  REFERENCE_DELIVERY_FLAG_ENV,
  type ModelInputModality,
  type PresentationRun,
} from "@open-slidestudio/presentation-run";
import {
  createSlidesRuntime,
  defaultSystemPrompt,
  type ContextBudgetOptions,
  type LlmInputModality,
  type LlmRoute,
  type SlidesAgentRuntime,
} from "@open-slidestudio/slides-runtime";
import { readProjectLease, withProjectLeaseLock, type SlideProjectPort } from "@open-slidestudio/slides-tools";
import { discussionOnly } from "./assistant-conversation.js";
import { DshLlmPort, type DshAttachmentService, type DshLlmService } from "./dsh-llm-port.js";
import {
  CONVERSATION_INTERACTION_TEXT,
  excludedToolsFor,
  includedToolsFor,
  sessionProduceCapabilities,
  sessionProduceToolAllowlist,
  toolSetKey,
  type SessionPolicyDeps,
} from "./produce-tool-policy.js";
import type { SliceSessionStore } from "./slice-session.js";

/** The provider/model a session runs on, as accepted by the roster. */
type ThinkingLevel = NonNullable<LlmRoute["reasoningEffort"]>;

export type SessionRouteSpec = {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort?: string;
  readonly inputModalities: readonly ModelInputModality[];
};

export type RouteLimits = { readonly contextWindow: number; readonly maxTokens: number };

export const DEFAULT_ROUTE_LIMITS: RouteLimits = { contextWindow: 128_000, maxTokens: 8_192 };

export type SessionRuntimeDeps = {
  readonly store: SliceSessionStore;
  readonly presentation: PresentationRun;
  readonly editorBaseUrl: string;
  readonly llm: DshLlmService;
  readonly attachments?: DshAttachmentService;
  /** Re-bind hosted media credentials before web/image tools. */
  readonly ensureMediaEnv?: () => void;
  readonly lease?: { readonly ttlMs?: number; readonly heartbeatMs?: number };
  readonly toolTimeoutMs?: number;
};

export type BuiltSessionRuntime = {
  readonly runtime: SlidesAgentRuntime;
  readonly key: string;
};

export type BuildSessionRuntimeOptions = {
  readonly initialSummaryContext?: string;
};

function parseBoolEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return undefined;
}

/** Hub default matches `config/feature-flags.json` (`reference_delivery_confirmation: true`). */
export function resolveReferenceDeliveryConfirmation(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolEnv(env[REFERENCE_DELIVERY_ENV]) ?? parseBoolEnv(env[REFERENCE_DELIVERY_FLAG_ENV]) ?? true;
}

/** Cap high reasoning efforts on low-maxTokens routes so thinking does not starve tool calls. */
export function capReasoningEffortForMaxTokens(effort: string | undefined, maxTokens: number): string | undefined {
  if (!effort || effort === "off" || effort === "minimal" || effort === "low") return effort;
  if (maxTokens <= 8_192 && ["max", "xhigh", "high", "medium"].includes(effort)) return "low";
  if (maxTokens <= 16_384 && ["max", "xhigh", "high"].includes(effort)) return "medium";
  return effort;
}

type RuntimeContextBudgetConfig = Partial<Omit<ContextBudgetOptions, "contextWindow" | "maxOutputTokens">>;

/** Minimum context window accepted for full deck production (32k/48k fail pre-flight cleanly). */
export const MIN_PRODUCE_CONTEXT_WINDOW = 60_000;

/** Window-tiered budget policy: <60k early reject on produce, 64k-96k working set, 128k balanced, >=180k cache-first. */
export function contextBudgetForLimits(
  limits: RouteLimits,
  onDeliveredReferences?: (callIds: readonly string[]) => void,
  options: { readonly discuss?: boolean } = {},
): RuntimeContextBudgetConfig {
  const delivery = onDeliveredReferences ? { onDeliveredReferences } : {};
  const floor = options.discuss ? {} : { minContextWindow: MIN_PRODUCE_CONTEXT_WINDOW };
  if (limits.contextWindow < MIN_PRODUCE_CONTEXT_WINDOW) {
    return { workingSet: true, keepImageSteps: 1, maxImages: 2, minAnswerTokens: 4_096, ...floor, ...delivery };
  }
  if (limits.contextWindow <= 96_000) {
    return { workingSet: true, keepImageSteps: 1, maxImages: 2, ...floor, ...delivery };
  }
  if (limits.contextWindow <= 160_000) {
    return { keepImageSteps: 2, maxImages: 4, ...floor, ...delivery };
  }
  return { cacheFirstMinWindow: 180_000, cacheFirstThreshold: 0.75, ...floor, ...delivery };
}

export function routeKey(spec: SessionRouteSpec): string {
  return [spec.providerId, spec.modelId, spec.reasoningEffort ?? "", spec.inputModalities.join("+")].join("|");
}

export function llmRouteFor(spec: SessionRouteSpec, limits: RouteLimits): LlmRoute {
  const inputModalities = spec.inputModalities.filter(
    (modality): modality is LlmInputModality => modality === "text" || modality === "image",
  );
  const effort = capReasoningEffortForMaxTokens(spec.reasoningEffort, limits.maxTokens);
  return {
    providerId: spec.providerId,
    modelId: spec.modelId,
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    inputModalities: inputModalities.length ? inputModalities : ["text"],
    // DSH reasoning effort ids are opaque adapter values passed straight through.
    ...(effort ? { reasoningEffort: effort as ThinkingLevel } : {}),
  };
}

function policyDeps(deps: SessionRuntimeDeps, spec: SessionRouteSpec): SessionPolicyDeps {
  return {
    store: deps.store,
    provider: {
      providerId: spec.providerId,
      modelId: spec.modelId,
      ready: true,
      modelInputModalities: spec.inputModalities,
    },
  };
}

/** Project port backed by the Hub session store, so bindings stay in `slice-session.json`. */
export function sliceProjectPort(store: SliceSessionStore, spec: SessionRouteSpec): SlideProjectPort {
  return {
    peekExisting(ctx) {
      const binding = store.bindingFor(ctx.sessionId ?? ctx.caller.id);
      return binding ? store.resolveRoot(binding) : undefined;
    },
    open({ ctx, title }) {
      const opened = store.openProject({
        dshSessionId: ctx.sessionId ?? ctx.caller.id,
        title,
        design: { kind: "self-directed" },
        provider: { providerId: spec.providerId, modelId: spec.modelId },
      });
      return {
        created: opened.created,
        projectId: opened.binding.projectRoot,
        projectRoot: store.resolveRoot(opened.binding),
        displayRoot: opened.binding.projectRoot,
        design: opened.binding.design,
      };
    },
    rollbackCreated(projectRoot, ctx) {
      store.evictCreatedProject(ctx.sessionId ?? ctx.caller.id, projectRoot);
    },
  };
}

function confirmDeliveredReferences(
  presentation: PresentationRun,
  projectRoot: string,
  sessionId: string,
  callIds: readonly string[],
): void {
  const ownerId = `hub-run:${sessionId}`;
  const active = readProjectLease(projectRoot);
  if (!active.active || active.holder?.ownerId !== ownerId) return;
  withProjectLeaseLock(projectRoot, () => {
    const current = readProjectLease(projectRoot);
    if (!current.active || current.holder?.ownerId !== ownerId) return;
    const contextEpochId = presentation.epochFor(sessionId);
    for (const callId of callIds) {
      recordReferenceDeliveredByCommandId(projectRoot, { contextEpochId }, callId);
    }
  });
}

/** Per-turn runtime shape: route, visible tool set and discussion mode. */
export function sessionRuntimeKey(deps: SessionRuntimeDeps, sessionId: string, spec: SessionRouteSpec): string {
  const binding = deps.store.bindingFor(sessionId);
  const root = binding ? deps.store.resolveRoot(binding) : undefined;
  const discuss = root ? discussionOnly(root) : false;
  const allowed = sessionProduceToolAllowlist(policyDeps(deps, spec), sessionId);
  const included = includedToolsFor(allowed);
  const excluded = excludedToolsFor(allowed);
  return `${routeKey(spec)}#${discuss ? "discuss" : "produce"}#+${toolSetKey(included)}#-${toolSetKey(excluded)}`;
}

export function buildSessionRuntime(
  deps: SessionRuntimeDeps,
  sessionId: string,
  spec: SessionRouteSpec,
  limits: RouteLimits,
  options: BuildSessionRuntimeOptions = {},
): BuiltSessionRuntime {
  const binding = deps.store.bindingFor(sessionId);
  if (!binding) throw new Error(`unknown slides session ${sessionId}`);
  const projectRoot = deps.store.resolveRoot(binding);
  const policy = policyDeps(deps, spec);
  const discuss = discussionOnly(projectRoot);
  const allowed = sessionProduceToolAllowlist(policy, sessionId);
  const included = includedToolsFor(allowed);
  const excluded = excludedToolsFor(allowed);
  const confirmDelivery = resolveReferenceDeliveryConfirmation();
  const onDeliveredReferences = confirmDelivery
    ? (callIds: readonly string[]) => confirmDeliveredReferences(deps.presentation, projectRoot, sessionId, callIds)
    : undefined;
  const cwd = deps.store.slicesRoot();
  const runtime = createSlidesRuntime({
    llm: new DshLlmPort({
      llm: deps.llm,
      ...(deps.attachments ? { attachments: deps.attachments } : {}),
      route: llmRouteFor(spec, limits),
    }),
    sessionId,
    caller: { kind: "hub-run", id: `hub-run:${sessionId}` },
    project: { projectId: binding.projectRoot, projectRoot },
    toolDeps: {
      presentation: deps.presentation,
      editorBaseUrl: deps.editorBaseUrl,
      capabilities: (ctx) => sessionProduceCapabilities(policy, ctx.sessionId),
      ...(deps.ensureMediaEnv ? { ensureMediaEnv: deps.ensureMediaEnv } : {}),
      projects: sliceProjectPort(deps.store, spec),
      confirmReferenceDelivery: confirmDelivery,
    },
    systemPrompt: `${defaultSystemPrompt(cwd)}\n\n${CONVERSATION_INTERACTION_TEXT}`,
    workingDirectory: cwd,
    ...(included.size ? { includeTools: included } : {}),
    excludeTools: excluded,
    contextBudget: contextBudgetForLimits(limits, onDeliveredReferences, { discuss }),
    ...(options.initialSummaryContext ? { initialSummaryContext: options.initialSummaryContext } : {}),
    userQuestions: true,
    // The host's RateLimitResumeController owns the disk-persisted 429 wait,
    // resume and provider failover; the loop must not retry a second time.
    rateLimit: { maxAttempts: 0 },
    ...(discuss
      ? { guards: { progress: false as const }, lease: { ...(deps.lease ?? {}), mode: "session" as const } }
      : deps.lease
        ? { lease: deps.lease }
        : {}),
    ...(deps.toolTimeoutMs ? { toolTimeoutMs: deps.toolTimeoutMs } : {}),
  });
  return {
    runtime,
    key: `${routeKey(spec)}#${discuss ? "discuss" : "produce"}#+${toolSetKey(included)}#-${toolSetKey(excluded)}`,
  };
}
