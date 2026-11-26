/**
 * Builds one session's `SlidesAgentRuntime`: the DSH LLM route served by
 * `DshLlmPort` (`ctx.llm` + `ctx.attachments`), the canonical slide tools over
 * a `SliceSessionStore`-backed project port, the Hub tool policy and the
 * `hub-run:<sessionId>` writer-lease identity.
 */
import type { ModelInputModality, PresentationRun } from "@open-slidestudio/presentation-run";
import {
  createSlidesRuntime,
  defaultSystemPrompt,
  type LlmInputModality,
  type LlmRoute,
  type SlidesAgentRuntime,
} from "@open-slidestudio/slides-runtime";
import type { SlideProjectPort } from "@open-slidestudio/slides-tools";
import { discussionOnly } from "./assistant-conversation.js";
import { DshLlmPort, type DshAttachmentService, type DshLlmService } from "./dsh-llm-port.js";
import {
  CONVERSATION_INTERACTION_TEXT,
  excludedToolsFor,
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

export function routeKey(spec: SessionRouteSpec): string {
  return [spec.providerId, spec.modelId, spec.reasoningEffort ?? "", spec.inputModalities.join("+")].join("|");
}

export function llmRouteFor(spec: SessionRouteSpec, limits: RouteLimits): LlmRoute {
  const inputModalities = spec.inputModalities.filter(
    (modality): modality is LlmInputModality => modality === "text" || modality === "image",
  );
  return {
    providerId: spec.providerId,
    modelId: spec.modelId,
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    inputModalities: inputModalities.length ? inputModalities : ["text"],
    // DSH reasoning effort ids are opaque adapter values passed straight through.
    ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort as ThinkingLevel } : {}),
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

/** Per-turn runtime shape: route, visible tool set and discussion mode. */
export function sessionRuntimeKey(deps: SessionRuntimeDeps, sessionId: string, spec: SessionRouteSpec): string {
  const binding = deps.store.bindingFor(sessionId);
  const root = binding ? deps.store.resolveRoot(binding) : undefined;
  const discuss = root ? discussionOnly(root) : false;
  const excluded = excludedToolsFor(sessionProduceToolAllowlist(policyDeps(deps, spec), sessionId));
  return `${routeKey(spec)}#${discuss ? "discuss" : "produce"}#${toolSetKey(excluded)}`;
}

export function buildSessionRuntime(
  deps: SessionRuntimeDeps,
  sessionId: string,
  spec: SessionRouteSpec,
  limits: RouteLimits,
): BuiltSessionRuntime {
  const binding = deps.store.bindingFor(sessionId);
  if (!binding) throw new Error(`unknown slides session ${sessionId}`);
  const projectRoot = deps.store.resolveRoot(binding);
  const policy = policyDeps(deps, spec);
  const discuss = discussionOnly(projectRoot);
  const excluded = excludedToolsFor(sessionProduceToolAllowlist(policy, sessionId));
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
    },
    systemPrompt: `${defaultSystemPrompt(cwd)}\n\n${CONVERSATION_INTERACTION_TEXT}`,
    workingDirectory: cwd,
    excludeTools: excluded,
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
  return { runtime, key: `${routeKey(spec)}#${discuss ? "discuss" : "produce"}#${toolSetKey(excluded)}` };
}
