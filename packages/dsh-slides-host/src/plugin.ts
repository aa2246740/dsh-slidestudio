import { AssistantQuestions } from "./assistant-questions.js";
import {
  hideSlidesSessions,
  LegacySessionHider,
  slidesSessionMeta,
  type SlidesWorkspaceRegistry,
  type SlidesSessionHeader,
} from "./session-workspace.js";
import { cancelAgentOutsideAppend } from "./agent-cancel.js";
import { inferAssistantIntent } from "./assistant-intent.js";
import crypto from "node:crypto";
import { discussionInstruction, discussionOnly, recordConversationMessage } from "./assistant-conversation.js";
import { join as pathJoin, relative as pathRelative, resolve as pathResolve } from "node:path";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-tools";
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-attachment";
import type { Agent, ModelSelection, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import {
  createPresentationRun,
  buildCatalogDto,
  persistPresentationRunProvider,
  machineRuntimeReuse,
  provisionManagedRuntime,
  resolvePlaywrightRuntime,
  rasterRuntimeReady,
  type ModelInputModality,
} from "@open-slidestudio/presentation-run";
import {
  bindToolProviderToModelSelection,
  createSlidesProduceSetup,
} from "./produce-agent-setup.js";
import {
  reconcileSlidesAgentPlane,
  wireSlidesAgentPlaneForAgent,
  type AgentPresetProbe,
  type SlidesAgentPlaneDeps,
} from "./agent-plane.js";
import { writeSliceRuntime } from "./runtime.js";
import { assertGenerationRenderingReady } from "./hub-capability.js";
import { deckTitleFromBrief, SliceSessionStore } from "./slice-session.js";
import { handleProductRequest, handleSlidesRequest, turnTextWithAttachments, type SlidesHostRuntime } from "./routes.js";
import { redirectRootToProductHome } from "./product-proxy.js";
import {
  generationFormat, assertAttachmentBudget, attachmentDeliveryBlock, inputSha256, persistGenerationInput,
  type GenerationInputSnapshot,
} from "./generation-input.js";
import { appendAgentTrace, traceRowsFromSessionEvent } from "./agent-trace.js";
import { publishSessionLive, closeSessionLive } from "./session-live.js";
import { AgentStreamBridge } from "./stream-bridge.js";
import { markInterruptedTurn } from "./interruption.js";
import {
  AgentFaults,
  friendlyProviderCause,
  classifyAgentError,
  clearAgentError,
  clearRateLimitWait,
  isMinimaxCnFailoverFault,
  isOpenRouterFailoverFault,
  isWaitAndResumeFault,
  parseRetryAfterMs,
  readAgentError,
  readRateLimitWait,
  recordAgentError,
  writeRateLimitWait,
} from "./agent-fault.js";
import { RateLimitResumeController } from "./rate-limit-resume.js";
import {
  agentOptionsForRoute,
  assertSlidesGenerateReady,
  bindMinimaxCnKey,
  markGrokFailed,
  markMinimaxCnAuthFailed,
  markOpenRouterHardFailed,
  minimaxCnKeyPresent,
  modelForRoute,
  OPENROUTER_MINIMAX_FREE_MODEL,
  openrouterKeyPresent,
  resolveSlidesLlmRoute,
  SLIDES_LLM_DEFAULT_MODEL,
  SLIDES_LLM_PROVIDER,
} from "./args.js";
import { bindHomeKeys, connectionState, slidesProviderHasModel } from "./providers.js";
import {
  applyCatalogEnv,
  isAntigravityId,
  loadSlidesModelCatalog,
  modelInputModalities,
  reasoningEffortForModel,
  type RuntimeModelCatalog,
  type RuntimeModelInfo,
} from "./local-models.js";
import { assertIsolatedDshHome } from "./isolation.js";
import { assertMimoDesktopGateway } from "./local-models.js";
import {
  bindGrokImageEnv,
  readXaiImageSecret,
  readXaiLoginSnapshot,
  shouldFailoverGrok,
} from "./oauth-login.js";
import type { DesignDirective } from "./protocol.js";
import { directorBrief } from "./director-brief.js";
import { assertHubProduceGatesReady } from "./produce-gates.js";
import { beginAttempt } from "./session-transition.js";
import { loadToolSettingsIntoProcess } from "./tool-settings.js";
import { ToolInvalidArgsLoopGuard } from "./tool-loop-guard.js";
import {
  ProductProgressSessionGuard,
  type ProductProgressTrip,
} from "./product-progress-guard.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: {
      /** The listening port (set once the service has activated). */
      readonly port?: number;
      register(route: {
        kind: "exact" | "prefix";
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
      }): () => void;
    };
  }
}

export const name = "slides-host";
export const inject = ["tools", "webServer", "agents", "attachments", "llm"];

/**
 * Max time /slides/sessions/:id/stop waits for the agent to honour the cancel
 * before reporting the stop anyway — a hung turn must never keep the operator
 * control (and the busy flag that drives the editor's "正在中止" state) pending.
 */
const OPERATOR_STOP_IDLE_TIMEOUT_MS = 15_000;

export const Config = z.object({
  workspaceRoot: z.string().default(""),
  dataRoot: z.string().default(""),
  editorBaseUrl: z.string().default("http://127.0.0.1:55200"),
  /** Mounted inside the user's own DSH Host as a Personal feature. */
  personal: z.boolean().default(false),
});

export type SlidesHostConfig = {
  workspaceRoot?: string;
  dataRoot?: string;
  editorBaseUrl?: string;
  personal?: boolean;
};

export async function runModelSwitchTransaction(input: {
  apply: () => void;
  activate: () => void | Promise<void>;
  rollback: () => void;
}): Promise<void> {
  try {
    input.apply();
    await input.activate();
  } catch (error) {
    input.rollback();
    throw error;
  }
}

export function apply(ctx: Context, config: SlidesHostConfig = {}): void {
  const workspaceRoot = pathResolve(config.workspaceRoot?.trim() || process.cwd());
  const dataRoot = pathResolve(config.dataRoot?.trim() || workspaceRoot);
  // Personal mode runs inside the user's own Host: the ambient DSH_HOME
  // (normally ~/.dsh) is the right home — it already holds the user's OAuth
  // grants and model catalog, so the isolation check must not reject it.
  const profileHome = (ctx.get("profileContext") as { home?: string } | undefined)?.home;
  const configuredHome = (config.personal ? profileHome : undefined)
    || process.env.DSH_HOME?.trim() || pathResolve(workspaceRoot, ".dsh", "home");
  const dshHome = config.personal ? pathResolve(configuredHome) : assertIsolatedDshHome(configuredHome);
  const importedCatalog = loadSlidesModelCatalog(dshHome);
  if (importedCatalog) applyCatalogEnv(importedCatalog, process.env);
  const editorBaseUrl =
    config.editorBaseUrl?.trim() ||
    process.env.SLIDESTUDIO_EDITOR_URL ||
    "http://127.0.0.1:55200";
  process.env.SLIDESTUDIO_EDITOR_URL = editorBaseUrl;
  process.env.OPEN_SLIDESTUDIO_ROOT = workspaceRoot;
  // Render runtime: resolve an existing one first (repo .runtime, the managed
  // dir under the DSH data root, a healthy ~/.codex seed, or any playwright
  // already installed on this machine). When nothing works, provision the
  // pinned runtime into the managed dir in the background — packaged installs
  // must not depend on a Codex homedir or a manual setup step.
  const slidesStateDir = pathJoin(dshHome, "data", "dsh-slidestudio");
  const runtimeRoots = { repoRoot: workspaceRoot, homeDir: os.homedir(), stateDir: slidesStateDir };
  const runtimeResolution = resolvePlaywrightRuntime(process.env, runtimeRoots);
  if (runtimeResolution.ready) {
    process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtimeResolution.path;
  }
  let runtimeProvisionError: string | undefined;
  let runtimeProvision: Promise<void> | undefined;
  if (!runtimeResolution.ready && !process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME?.trim()) {
    // Point env-only lookups at the managed path so the raster port picks the
    // runtime up as soon as provisioning finishes writing it.
    process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtimeResolution.path;
    runtimeProvision = provisionManagedRuntime(slidesStateDir, {
      log: (message: string) => console.log(message),
      // A playwright module/browsers already on the machine saves the
      // matching download (e.g. the reporter's global playwright).
      reuse: machineRuntimeReuse(process.env, runtimeRoots),
    }).then(
      () => undefined,
      (error: unknown) => {
        runtimeProvisionError = error instanceof Error ? error.message : String(error);
        console.warn("[slides] playwright runtime auto-setup failed:", runtimeProvisionError);
        // Release the exclusive env pin so a later resolve can adopt a runtime
        // the user installs after this attempt failed.
        delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
      },
    );
  }
  const store = new SliceSessionStore(dataRoot);
  store.rebuild();
  const workspaceRegistry = () => ctx.get("workspaceRegistry") as SlidesWorkspaceRegistry | undefined;
  // Cold metadata reads do not resume old agents or send model requests.
  ctx.inject(["workspaceRegistry", "sessionQuery"] as never, async () => {
    const query = ctx.get("sessionQuery") as { listSessions(): Promise<{ header: SlidesSessionHeader }[]> };
    const result = await hideSlidesSessions(workspaceRegistry()!,
      (await query.listSessions()).map(row => row.header), new Set(store.rebuild().keys()),
      new Set([workspaceRoot, dataRoot]));
    for (const failure of result.failures) console.warn("[slides-host] hiding slides sessions:", failure);
  });
  const presentation = createPresentationRun({
    repoRoot: workspaceRoot,
  });
  for (const binding of store.rebuild().values()) {
    presentation.hydrate(store.resolveRoot(binding));
  }
  const questions = new AssistantQuestions(sessionId => {
    const binding = store.bindingFor(sessionId);
    return binding ? store.resolveRoot(binding) : undefined;
  });
  ctx.effect(() => () => questions.dispose());
  const live = new Map<Agent["id"], Agent>();
  const busy = new Set<string>();
  const legacyHider = new LegacySessionHider(workspaceRegistry, (id) => busy.has(id));
  const models = new Map<string, string>();
  const selections = new Map<string, ModelSelectionRef>();
  const efforts = new Map<string, string>();
  const faults = new AgentFaults();
  const openRouterFailingOver = new Set<string>();
  const toolLoopGuard = new ToolInvalidArgsLoopGuard();
  const productProgressGuard = new ProductProgressSessionGuard();
  bindHomeKeys(dshHome);
  loadToolSettingsIntoProcess(dshHome);
  bindMinimaxCnKey();
  const currentXai = () => readXaiLoginSnapshot(dshHome);
  const bindGrokProduce = () => {
    if (currentXai().status !== "signed-in") return;
    const secret = readXaiImageSecret(dshHome);
    if (secret) bindGrokImageEnv(process.env, secret);
  };
  bindGrokProduce();
  /**
   * Failure-derived provider health for the roster: a real call failure is the
   * only trustworthy resolvability signal — the stream adapter registry is not
   * the same map resolveModelInfo consults, so info-level probing lies.
   * "broken" hides the route (adapter/config cannot succeed on retry);
   * "degraded" keeps it listed with a warning (upstream may recover).
   */
  const providerHealth = new Map<string, { kind: "broken" | "degraded"; reason: string }>();
  const recordProviderFailure = (provider: string, detail: string): void => {
    const d = detail.slice(0, 200);
    const broken =
      /no adapter|NO_ADAPTER|adapter-error|UNSUPPORTED|not in the current provider roster|Cannot read propert|TypeError|undefined is not|no credential/i.test(d);
    providerHealth.set(provider, {
      kind: broken ? "broken" : "degraded",
      reason: friendlyProviderCause(d).replace(/[（）]/g, "")
        || (broken ? "该模型在当前环境不可用" : "上次调用失败"),
    });
  };
  /**
   * What DSH's registered adapters currently advertise, keyed by provider then
   * model id. Refresh for each request so settings and credential changes do
   * not leave stale selectable models. Keep the latest snapshot only for
   * synchronous tool assembly, never as a substitute for a fresh roster read.
   */
  let modelCatalogCache: RuntimeModelCatalog | undefined;
  let catalogRevision = 0;
  ctx.on("llm/adapters-updated", () => {
    modelCatalogCache = undefined;
    catalogRevision += 1;
    providerHealth.clear();
  });
  const listModelCatalog = async (): Promise<RuntimeModelCatalog> => {
    const revision = catalogRevision;
    const catalog = new Map<string, ReadonlyMap<string, RuntimeModelInfo>>();
    for (const provider of ctx.llm.listProviders()) {
      if (!config.personal && isAntigravityId(provider.id)) continue;
      const models = await ctx.llm.listModels(provider.id).catch(() => []);
      const byId = new Map<string, RuntimeModelInfo>();
      for (const model of models) {
        if (!model.id) continue;
        const info = await ctx.llm.resolveModelInfo(provider.id, model.id).catch(() => undefined);
        byId.set(model.id, {
          name: model.name || model.id,
          inputModalities: [...(info?.inputModalities ?? model.inputModalities ?? [])],
          efforts: info?.reasoning?.efforts.map((effort) => String(effort.id)) ?? [],
        });
      }
      catalog.set(provider.id, byId);
    }
    if (revision !== catalogRevision) return listModelCatalog();
    modelCatalogCache = catalog;
    return catalog;
  };
  const readyRoute = async (options: Parameters<typeof assertSlidesGenerateReady>[1]) =>
    assertSlidesGenerateReady(process.env, {
      ...options,
      ...(config.personal ? { managedCatalog: await listModelCatalog() } : {}),
    });
  const capabilityProvider = (
    providerId: string,
    modelId: string,
    ready: boolean,
    catalog?: RuntimeModelCatalog,
  ): {
    providerId: string;
    modelId: string;
    ready: boolean;
    modelInputModalities: readonly ModelInputModality[];
  } => {
    const modalities = modelInputModalities(dshHome, providerId, modelId, catalog ?? modelCatalogCache);
    return {
      providerId,
      modelId,
      ready,
      modelInputModalities: modalities ?? [],
    };
  };
  const assertRosterModel = async (providerId: string, modelId: string): Promise<RuntimeModelCatalog> => {
    const catalog = await listModelCatalog();
    if (config.personal ? !catalog.get(providerId)?.has(modelId) : !slidesProviderHasModel(dshHome, providerId, modelId, catalog)) {
      throw new Error(`generate model ${providerId}/${modelId} is not in the current provider roster`);
    }
    return catalog;
  };
  let runtime!: SlidesHostRuntime;
  const rateLimits = new RateLimitResumeController({
    now: () => Date.now(),
    schedule: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(timer) };
    },
    resume: async (sessionId) => {
      assertHubProduceGatesReady(workspaceRoot);
      if (rateLimits.isStopped(sessionId)) return;
      let agent = runtime.getAgent(sessionId);
      if (!agent) {
        await runtime.resumeAgent(sessionId);
        if (rateLimits.isStopped(sessionId)) return;
        agent = runtime.getAgent(sessionId);
      }
      const binding = store.bindingFor(sessionId);
      if (binding) {
        const root = store.resolveRoot(binding);
        clearAgentError(root);
        clearRateLimitWait(root);
        faults.clear(sessionId, root);
      }
      busy.add(sessionId);
      agent?.followup(
        createUserMessage({
          content: [
            {
              type: "text",
              text: "Continue the same Hub session after a provider wait. Never Gemini. Host did not paint leftover pages. Do not rewrite finished pages. Do not start a new session.",
            },
          ],
          source: { kind: "user" },
        }),
      );
    },
    resumeFailed: (sessionId, fault, error) => {
      busy.delete(sessionId);
      const binding = store.bindingFor(sessionId);
      faults.note(sessionId, fault, binding ? store.resolveRoot(binding) : undefined);
      console.warn(
        `[slides] rate-limit resume failed for session ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    },
    notePaused: (sessionId, fault, wait) => {
      const binding = store.bindingFor(sessionId);
      const root = binding ? store.resolveRoot(binding) : undefined;
      faults.note(sessionId, fault, root);
      if (root) {
        writeRateLimitWait(root, {
          attempt: wait.attempt,
          waitMs: wait.waitMs,
          nextRetryAt: wait.nextRetryAt,
          code: fault.code,
        });
      }
    },
  });
  const beginWaitAndResume = (
    sessionId: string,
    fault: ReturnType<typeof classifyAgentError>,
    raw?: unknown,
  ): boolean => {
    if (!isWaitAndResumeFault(fault)) return false;
    const retryAfterMs = parseRetryAfterMs(raw ?? fault.detail);
    return rateLimits.pauseAndResume(sessionId, fault, retryAfterMs);
  };

  const agentPlaneDeps: SlidesAgentPlaneDeps = (() => {
    const boot = resolveSlidesLlmRoute(process.env, { xai: currentXai(), home: dshHome });
    const connection = connectionState(dshHome);
    const provider = capabilityProvider(
      boot.provider,
      boot.model,
      connection.ready && connection.providerId === boot.provider && connection.model === boot.model,
    );
    return {
      store,
      presentation,
      workspaceRoot,
      editorBaseUrl,
      faults,
      provider,
      ensureGrokImageEnv: bindGrokProduce,
      attachments: {
        saveImage: (input) => ctx.attachments.saveImage(input),
      },
      questions,
    };
  })();
  // Slides-only surfaces live on the `slides` preset generation scope, so a
  // normal or Creator agent — even one carrying a stale store binding — keeps
  // its own tools, question routing and assembled request. Preset binding, not
  // the persisted binding, is the ownership evidence. Agents already live at
  // apply time (a hot reload) are swept up the same way, and re-wiring on an
  // already-wired generation is deduped by `wireSlidesAgentPlane`.
  // Preset membership is answered through the `agentPresets` service (and
  // the session projection): a Host may load a second registry module copy
  // for its bundles, whose module-local mount set stays empty to outside
  // importers. The service always resolves mounts in its own copy.
  const agentPresets = ctx.get("agentPresets") as AgentPresetProbe | undefined;
  const sessionProjections = ctx.get("sessionProjections") as
    | { stateOf?: (session: unknown, key: string) => string | null | undefined }
    | undefined;
  const wireAgentPlane = (agent: Agent): undefined => {
    try {
      wireSlidesAgentPlaneForAgent(agent, agentPlaneDeps, agentPresets, sessionProjections);
    } catch (error) {
      console.warn("[slides-host] failed to wire the slides agent plane", error);
    }
    return undefined;
  };
  ctx.on("agent/created", ({ agent }) => wireAgentPlane(agent));
  // A mid-session preset switch must re-route the plane: moving onto `slides`
  // wires it, moving away disposes it. `agent-preset/selected` is re-emitted
  // by the preset registry when the session event lands.
  ctx.on("agent-preset/selected" as never, ((sessionId: unknown, presetId: unknown) => {
    if (typeof presetId !== "string") return;
    const agent = ctx.agents.get(sessionId as never);
    if (!agent) return;
    try {
      reconcileSlidesAgentPlane(agent, agentPlaneDeps, agentPresets, sessionProjections);
    } catch (error) {
      console.warn("[slides-host] failed to reconcile the slides agent plane", error);
    }
  }) as never);
  for (const agent of ctx.agents.list()) wireAgentPlane(agent);

  const produceSetup = (
    provider: {
      providerId: string;
      modelId: string;
      ready: boolean;
      modelInputModalities: readonly ModelInputModality[];
    },
    reasoningEffort?: string,
  ): { setup: ReturnType<typeof createSlidesProduceSetup>; selection: ModelSelectionRef } => {
    const current: ModelSelection = {
      provider: provider.providerId,
      model: provider.modelId,
      ...(reasoningEffort ? { reasoningEffort: ReasoningEffortId(reasoningEffort) } : {}),
    };
    const selection: ModelSelectionRef = { current, assembled: undefined };
    const deps = bindToolProviderToModelSelection({
      store,
      presentation,
      workspaceRoot,
      editorBaseUrl,
      faults,
      provider,
      reasoningEffort,
      ensureGrokImageEnv: bindGrokProduce,
      attachments: {
        saveImage: (input) => ctx.attachments.saveImage(input),
      },
    }, selection, (selected) => capabilityProvider(selected.provider, selected.model, true));
    const setup = createSlidesProduceSetup(ctx, deps, selection, agentPlaneDeps);
    return { setup, selection };
  };

  /**
   * Shared failover: only fires while the session's bound provider is
   * `sourceProviderId`, resolves the target route before touching the binding,
   * rolls the binding back on failure, and always clears the in-flight marker.
   * The pause fault is cleared only after the resumed agent accepts a followup.
   */
  const beginFailover = (
    sessionId: string,
    fault: ReturnType<typeof classifyAgentError>,
    sourceProviderId: string | undefined,
    inflight: Set<string>,
    resolveTarget: () => { providerId: string; modelId: string } | undefined,
    reasonText: (target: { providerId: string; modelId: string }) => string,
  ): boolean => {
    const binding = store.bindingFor(sessionId);
    if (!binding || binding.provider.providerId !== sourceProviderId) return false;
    if (inflight.has(sessionId)) return true;
    const target = resolveTarget();
    if (!target) return false;
    inflight.add(sessionId);
    busy.add(sessionId);
    const root = store.resolveRoot(binding);
    const rollback = {
      providerId: binding.provider.providerId,
      modelId: binding.provider.modelId,
    };
    void (async () => {
      try {
        store.updateProvider(sessionId, {
          providerId: target.providerId,
          modelId: target.modelId,
        });
        models.set(sessionId, target.modelId);
        await runtime.resumeAgent(sessionId);
        clearAgentError(root);
        runtime.getAgent(sessionId)?.followup(
          createUserMessage({
            content: [{ type: "text", text: reasonText(target) }],
            source: { kind: "user" },
          }),
        );
        inflight.delete(sessionId);
      } catch {
        try {
          store.updateProvider(sessionId, rollback);
        } catch {
          /* binding rollback is best-effort; the fault note below still records the pause */
        }
        inflight.delete(sessionId);
        busy.delete(sessionId);
        faults.note(sessionId, fault, root);
      }
    })();
    return true;
  };

  const grokFailingOver = new Set<string>();
  const beginGrokFallback = (
    sessionId: string,
    fault: ReturnType<typeof classifyAgentError>,
  ): boolean => {
    const binding = store.bindingFor(sessionId);
    if (!shouldFailoverGrok(binding?.provider.providerId, fault)) return false;
    const applied = beginFailover(
      sessionId,
      fault,
      binding?.provider.providerId,
      grokFailingOver,
      () => {
        try {
          const next = assertSlidesGenerateReady(process.env, { xai: currentXai() });
          return { providerId: next.provider, modelId: next.model };
        } catch {
          return undefined;
        }
      },
      (target) =>
        `Grok returned ${fault.code}. Continue the same Hub session on ${target.providerId} ${target.modelId}. Never Gemini. Host did not paint leftover pages. Do not start a new session.`,
    );
    if (applied) markGrokFailed();
    return applied;
  };

  const beginOpenRouterFailover = (
    sessionId: string,
    fault: ReturnType<typeof classifyAgentError>,
  ): boolean => {
    const binding = store.bindingFor(sessionId);
    if (!isOpenRouterFailoverFault(fault)) return false;
    const applied = beginFailover(
      sessionId,
      fault,
      "minimax-cn",
      openRouterFailingOver,
      () =>
        openrouterKeyPresent()
          ? { providerId: "openrouter", modelId: OPENROUTER_MINIMAX_FREE_MODEL }
          : undefined,
      (target) =>
        `MiniMax China returned 401/403. Continue on OpenRouter MiniMax free (${target.modelId}). Never Gemini. Host did not paint leftover pages.`,
    );
    if (applied) markMinimaxCnAuthFailed();
    return applied;
  };

  const cnFailingOver = new Set<string>();
  const beginCnFailover = (
    sessionId: string,
    fault: ReturnType<typeof classifyAgentError>,
  ): boolean => {
    if (!isMinimaxCnFailoverFault(fault)) return false;
    const applied = beginFailover(
      sessionId,
      fault,
      "openrouter",
      cnFailingOver,
      () =>
        minimaxCnKeyPresent()
          ? { providerId: SLIDES_LLM_PROVIDER, modelId: SLIDES_LLM_DEFAULT_MODEL }
          : undefined,
      (target) =>
        `OpenRouter MiniMax free hard-failed. Continue on MiniMax China ${target.modelId}. Never Gemini. Host did not paint leftover pages.`,
    );
    if (applied) markOpenRouterHardFailed();
    return applied;
  };

  ctx.on("agent/error", ({ agent, error }) => {
    const binding = store.bindingFor(agent.id);
    const fault = classifyAgentError(error);
    if (beginGrokFallback(agent.id, fault)) return;
    if (beginWaitAndResume(agent.id, fault, error)) return;
    if (beginOpenRouterFailover(agent.id, fault)) return;
    if (beginCnFailover(agent.id, fault)) return;
    faults.note(
      agent.id,
      fault,
      binding ? store.resolveRoot(binding) : undefined,
    );
  });
  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "idle") busy.delete(agent.id);
    else busy.add(agent.id);
    if (status !== "idle") return;
    const binding = store.bindingFor(agent.id);
    if (!binding) return;
    legacyHider.onSettled(agent.id);
    const snap = store.inspect(agent.id);
    faults.settle(agent.id, store.resolveRoot(binding), snap.phase.kind);
    if (snap.phase.kind !== "paused" && !rateLimits.isWaiting(agent.id)) {
      rateLimits.onTurnSuccess(agent.id);
    }
  });
  // Match DSH SessionHistoryController's sanctioned cross-Agent listener.
  // Product binding filtering is mandatory: never infer ownership from busy state.
  const streamBridge = new AgentStreamBridge(publishSessionLive);
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    const sessionId = agent.session.id;
    if (!store.bindingFor(sessionId)) return;
    streamBridge.handleFrame(sessionId, frame);
  }, { global: true });
  ctx.on("agent/disposed", ({ agent }) => {
    streamBridge.disposeSession(agent.session.id);
    legacyHider.onSettled(agent.session.id);
  }, { global: true });
  ctx.effect(() => () => { streamBridge.dispose(); closeSessionLive(); });
  ctx.on("session/event", (session, event) => {
    const ev = event as {
      type?: string;
      data?: {
        turn?: number;
        step?: number;
        reason?: { kind?: string; error?: unknown };
      };
    };
    const binding = store.bindingFor(session.id);
    const liveRows = traceRowsFromSessionEvent(ev);
    if (binding) {
      try {
        appendAgentTrace(store.resolveRoot(binding), liveRows);
      } catch {
        /* trace is best-effort; generate must not die on a log write */
      }
    }
    if (binding && liveRows.length) {
      publishSessionLive(session.id, streamBridge.settle(session.id, liveRows));
    }
    const toolLoop = toolLoopGuard.observe(session.id, ev);
    let productProgress: ProductProgressTrip | undefined;
    if (binding && !discussionOnly(store.resolveRoot(binding))) {
      try {
        productProgress = productProgressGuard.observe(
          session.id,
          store.resolveRoot(binding),
          ev,
        );
      } catch {
        // Sampling is fail-open: an unreadable ledger/page must not create a
        // false no-progress pause in the active generation event callback.
      }
    } else if (ev.type === "turn/end") {
      productProgressGuard.reset(session.id);
    }
    const boundedTrip = toolLoop ?? productProgress;
    if (boundedTrip && binding) {
      const root = store.resolveRoot(binding);
      // faults.note (not bare recordAgentError) keeps the pause in `pending` so
      // settle() can clear it if this turn still completes — a tripped guard
      // whose cancel never landed must not leave a stale pause on disk.
      faults.note(session.id, { code: boundedTrip.code, detail: boundedTrip.detail }, root);
      const agent = live.get(session.id as Agent["id"]) ?? ctx.agents.get(session.id as Agent["id"]);
      if (agent) cancelAgentOutsideAppend(agent, session.id, boundedTrip.detail);
      else console.warn(`[slides] bounded trip ${boundedTrip.code} found no live agent for session ${session.id}`);
    }
    if (ev.type !== "turn/end" || ev.data?.reason?.kind !== "error") return;
    const fault = classifyAgentError(ev.data.reason.error);
    if (beginGrokFallback(session.id, fault)) return;
    if (beginWaitAndResume(session.id, fault, ev.data.reason.error)) return;
    if (beginOpenRouterFailover(session.id, fault)) return;
    if (beginCnFailover(session.id, fault)) return;
    faults.note(
      session.id,
      fault,
      binding ? store.resolveRoot(binding) : undefined,
    );
  });

  const runtimeHost: SlidesHostRuntime = {
    questions,
    store,
    workspaceRoot,
    dataRoot,
    dshHome,
    presentation,
    agentBusy(sessionId) {
      return busy.has(sessionId);
    },
    markBusy(sessionId) {
      busy.add(sessionId);
    },
    cancelRateLimitWait(sessionId) {
      rateLimits.onUserTurn(sessionId);
    },
    providerHealth(provider) {
      return providerHealth.get(provider);
    },
    listModelCatalog,
    managedModels: config.personal === true,
    async operatorStop(sessionId) {
      rateLimits.operatorStop(sessionId);
      const agent = runtime.getAgent(sessionId);
      try {
        if (agent) {
          agent.cancel({ kind: "user" });
          // Bound the idle wait: an abort signal a hung tool call never honors
          // (or a wake that re-arms the driver) would otherwise keep whenIdle
          // pending forever — /slides/sessions/:id/stop never answers, `busy`
          // never clears, and the editor is stuck on "正在中止" while the
          // state polls keep rewriting the run files. Stop reporting must not
          // depend on the kernel's abort actually landing.
          const timeout = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, OPERATOR_STOP_IDLE_TIMEOUT_MS);
            timer.unref?.();
          });
          await Promise.race([agent.whenIdle(), timeout]);
        }
      } finally {
        busy.delete(sessionId);
        const binding = store.bindingFor(sessionId);
        if (!binding) return;
        const root = store.resolveRoot(binding);
        clearRateLimitWait(root);
        recordAgentError(root, {
          code: "operator-stop",
          detail: "operator stopped the turn",
        });
      }
    },
    getAgent(sessionId) {
      const id = sessionId as Agent["id"];
      return live.get(id) ?? ctx.agents.get(id);
    },
    ensureSessionRunnable(sessionId) {
      return legacyHider.ensureRunnable(sessionId);
    },
    async resolveAssistantIntent(input) {
      const bound = input.sessionId ? store.bindingFor(input.sessionId)?.provider : undefined;
      const selected = input.modelSelection;
      const providerId = selected?.provider || bound?.providerId || "";
      try {
        const route = await readyRoute({
          xai: currentXai(), home: dshHome,
          provider: selected?.provider || bound?.providerId,
          model: selected?.model || bound?.modelId,
        });
        await assertRosterModel(route.provider, route.model);
        if (route.provider === "mimo-desktop") await assertMimoDesktopGateway(dshHome);
        // resolveModelInfo is only consulted for reasoning-effort support —
        // a provider that cannot answer the info query (pi-* adapters, partial
        // catalogs) must not take down the whole intent call when its stream
        // would have worked.
        const reasoningEffort = await ctx.llm.resolveModelInfo(route.provider, route.model)
          .then((info) => info.reasoning?.efforts.find((effort) => effort.id === "low")?.id)
          .catch(() => undefined);
        const intent = await inferAssistantIntent(options => ctx.llm.stream(options), { ...route, reasoningEffort }, input);
        providerHealth.delete(route.provider);
        return intent;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (providerId) recordProviderFailure(providerId, detail);
        // Provider/config failures (unresolved credentials, unknown roster
        // models, upstream errors) must surface as a retryable assistant error.
        // The raw cause goes to the server log — never raw JS internals like
        // "Cannot read properties of undefined" into the chat bubble.
        console.warn("[slides] assistant intent failed:", detail);
        throw new Error(`助手暂时未能处理这条请求，请重试或更换模型；输入内容已保留。${friendlyProviderCause(detail)}`);
      }
    },
    async createAgent(input) {
      if (runtimeProvision && !rasterRuntimeReady()) await runtimeProvision;
      assertGenerationRenderingReady(
        { render: rasterRuntimeReady() },
        input.conversationMode,
        runtimeProvisionError,
      );
      assertHubProduceGatesReady(workspaceRoot);
      bindGrokProduce();
      if (input.provider === "mimo-desktop") await assertMimoDesktopGateway(dshHome);
      const route = await readyRoute({
        xai: currentXai(),
        home: dshHome,
        provider: input.provider,
        model: input.model,
      });
      const format = generationFormat(input.kind, input.layout);
      const catalog = buildCatalogDto(workspaceRoot);
      const selectedStyle = input.designSystemId ? catalog.styles.find((style) => style.id === input.designSystemId) : undefined;
      if (input.designSystemId && !selectedStyle) throw new Error("selected design is not in the verified catalog");
      const attachments = input.attachments ?? [];
      assertAttachmentBudget(attachments);
      const sessionId = crypto.randomUUID() as Agent["id"];
      const model = modelForRoute(route, models.get(sessionId));
      const modelCatalog = await assertRosterModel(route.provider, model);
      const provider = capabilityProvider(route.provider, model, true, modelCatalog);
      const reasoningEffort = reasoningEffortForModel(
        dshHome,
        route.provider,
        model,
        input.reasoningEffort,
        modelCatalog,
      );
      const design: DesignDirective = selectedStyle
        ? { kind: "explicit-style", designSystemId: selectedStyle.id }
        : { kind: "self-directed" };
      const initialMessage = turnTextWithAttachments(
        `${input.conversationMode === "discuss" ? discussionInstruction(input.brief) : directorBrief(input.brief, input.designSystemId)}\n\nDocument format: Slides ${format.layout}, ${format.size[0]} x ${format.size[1]} pixels. Preserve this canvas size.`,
        attachments,
      );
      const opened = store.openProject({
        dshSessionId: sessionId, title: deckTitleFromBrief(input.brief), design, provider, size: format.size,
      });
      const projectRoot = store.resolveRoot(opened.binding);
      const snapshot: GenerationInputSnapshot = {
        version: 1, sessionId, acceptedAt: new Date().toISOString(), brief: input.brief, format,
        design: selectedStyle ? {
          kind: "explicit-style", designSystemId: selectedStyle.id,
          designSourceId: selectedStyle.designSourceId, designHash: selectedStyle.designHash,
        } : { kind: "self-directed" },
        model: { provider: route.provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
        attachments: attachments.map((attachment) => ({
          ...attachment, contentBlockSha256: inputSha256(attachmentDeliveryBlock(attachment)),
        })),
        initialMessage, initialMessageSha256: inputSha256(initialMessage),
      };
      persistGenerationInput(projectRoot, snapshot);
      recordConversationMessage(projectRoot, input.brief, input.conversationMode === "discuss" ? "discuss" : "generate");
      beginAttempt(projectRoot);
      writeSliceRuntime(projectRoot, { brief: input.brief, design, editorBaseUrl, strictExecution: true });
      await presentation.open({ projectRoot, sessionId, brief: input.brief, editorBaseUrl, design, provider });
      const prepared = produceSetup(provider, reasoningEffort);
      const handle = await ctx.agents.create({
        // Subagent origin keeps generation sessions out of every Work sidebar view.
        sessionId, meta: slidesSessionMeta(store.slicesRoot()),
        agentOptions: { ...agentOptionsForRoute(route), model }, setup: prepared.setup,
      });
      if (reasoningEffort) efforts.set(sessionId, reasoningEffort);
      selections.set(sessionId, prepared.selection);
      live.set(sessionId, handle.agent);
      busy.add(sessionId);
      handle.agent.followup(createUserMessage({
        content: [{ type: "text", text: initialMessage }], source: { kind: "user" },
      }));
      return { sessionId, projectPath: pathRelative(dataRoot, projectRoot) };
    },
    async resumeAgent(sessionId) {
      assertHubProduceGatesReady(workspaceRoot);
      bindGrokProduce();
      const boundProvider0 = store.bindingFor(sessionId)?.provider;
      if (boundProvider0?.providerId === "mimo-desktop") await assertMimoDesktopGateway(dshHome);
      const boundProvider = store.bindingFor(sessionId)?.provider;
      const requestedModel = models.get(sessionId) ?? boundProvider?.modelId;
      const route = await readyRoute({
        xai: currentXai(),
        home: dshHome,
        provider: boundProvider?.providerId,
        model: requestedModel,
      });
      const model = modelForRoute(route, requestedModel);
      const modelCatalog = await assertRosterModel(route.provider, model);
      const provider = capabilityProvider(route.provider, model, true, modelCatalog);
      store.updateProvider(sessionId, { providerId: route.provider, modelId: model });
      const resumed = store.bindingFor(sessionId);
      if (resumed) {
        const root = store.resolveRoot(resumed);
        persistPresentationRunProvider(root, provider);
        presentation.hydrate(root);
      }
      const prepared = produceSetup(
        provider,
        reasoningEffortForModel(dshHome, route.provider, model, efforts.get(sessionId), modelCatalog),
      );
      await legacyHider.ensureRunnable(sessionId);
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId as Agent["id"],
        agentOptions: { ...agentOptionsForRoute(route), model },
        setup: prepared.setup,
      });
      selections.set(sessionId, prepared.selection);
      live.set(sessionId as Agent["id"], handle.agent);
    },
    async switchModel(sessionId, model, provider, reasoningEffort) {
      const priorBinding = store.bindingFor(sessionId);
      if (!priorBinding) throw new Error(`unknown slides session ${sessionId}`);
      const providerId = provider?.trim() || priorBinding.provider.providerId;
      const requestedProvider = providerId || process.env.SLIDESTUDIO_LLM_PROVIDER?.trim() || "";
      const catalog = await assertRosterModel(requestedProvider, model);
      const route = await readyRoute({
        xai: currentXai(),
        home: dshHome,
        provider: providerId,
        model,
      });
      const selectedModel = modelForRoute(route, model);
      const agent = runtime.getAgent(sessionId);
      if (agent?.status === "running") {
        throw new Error(`cannot switch model for busy session ${sessionId}`);
      }
      const selection = agent ? selections.get(sessionId) : undefined;
      if (agent && !selection) {
        throw new Error(`live session ${sessionId} has no mutable model selection`);
      }
      const projectRoot = store.resolveRoot(priorBinding);
      const nextProvider = capabilityProvider(route.provider, selectedModel, true, catalog);
      const priorProvider = capabilityProvider(
        priorBinding.provider.providerId,
        priorBinding.provider.modelId,
        true,
      );
      const priorSelection = selection?.current;
      const priorModel = models.get(sessionId);
      const hadModel = models.has(sessionId);
      const priorEffort = efforts.get(sessionId);
      const effort = reasoningEffortForModel(
        dshHome, route.provider, selectedModel,
        reasoningEffort?.trim() || priorSelection?.reasoningEffort, catalog,
      );
      await runModelSwitchTransaction({
        apply: () => {
          models.set(sessionId, selectedModel);
          if (effort) efforts.set(sessionId, effort);
          else efforts.delete(sessionId);
          store.updateProvider(sessionId, { providerId: route.provider, modelId: selectedModel });
          if (!persistPresentationRunProvider(projectRoot, nextProvider)) {
            throw new Error(`presentation binding is missing for session ${sessionId}`);
          }
        },
        activate: async () => {
          if (selection) {
            if (effort) efforts.set(sessionId, effort);
            else efforts.delete(sessionId);
            selection.current = {
              provider: route.provider,
              model: selectedModel,
              ...(effort ? { reasoningEffort: effort } : {}),
            } as ModelSelection;
          } else {
            await runtime.resumeAgent(sessionId);
          }
        },
        rollback: () => {
          store.updateProvider(sessionId, priorBinding.provider);
          persistPresentationRunProvider(projectRoot, priorProvider);
          if (hadModel) models.set(sessionId, priorModel!);
          else models.delete(sessionId);
          if (priorEffort) efforts.set(sessionId, priorEffort);
          else efforts.delete(sessionId);
          if (selection) selection.current = priorSelection;
        },
      });
    },
  };
  runtime = runtimeHost;
  for (const [sessionId, binding] of store.rebuild()) {
    const snap = store.inspect(sessionId);
    if (snap.phase.kind !== "paused") continue;
    const root = store.resolveRoot(binding);
    const error = readAgentError(root);
    if (!error) continue;
    const fault = classifyAgentError({ code: error.code, message: error.detail });
    if (!isWaitAndResumeFault(fault)) continue;
    rateLimits.restore(sessionId, fault, readRateLimitWait(root));
  }
  // A Host restart kills every live agent before turn/end can land; without a
  // durable marker the projections keep reading an active turn forever. Mark
  // unclosed turns interrupted once, at activation, while nothing can be busy.
  for (const [sessionId, binding] of store.rebuild()) {
    try {
      if (markInterruptedTurn(store.resolveRoot(binding))) {
        console.warn(`[slides] marked interrupted generation turn for session ${sessionId}`);
      }
    } catch {
      /* best-effort: a corrupt trace must not block plugin activation */
    }
  }

  ctx.effect(() => {
    const handlers: Array<() => void> = [];
    // Personal mode exposes only the /slides API prefix on the shared Host
    // server. The root redirect and the legacy app/media/runtime/api proxy
    // mounts belong to the standalone product shell and are skipped here.
    const product = (req: IncomingMessage, res: ServerResponse) => {
      if (!handleProductRequest(runtime, req, res) && !res.headersSent) {
        res.writeHead(404);
        res.end("not found");
      }
    };
    if (!config.personal) {
      handlers.push(
        ctx.webServer.register({
          kind: "exact",
          path: "/",
          handler: (req, res) => {
            const connection = ctx.get("connection") as
              | { authorizeIndex?: (req: IncomingMessage, res: ServerResponse) => boolean }
              | undefined;
            redirectRootToProductHome(req, res, connection?.authorizeIndex?.bind(connection));
          },
        }),
      );
    }
    handlers.push(
      ctx.webServer.register({
        kind: "prefix",
        path: "/slides",
        handler: (req, res) => {
          if (config.personal) {
            const connection = ctx.get("connection") as
              | { requestRejection?: (req: IncomingMessage) => number | undefined }
              | undefined;
            const rejection = connection?.requestRejection?.(req);
            if (rejection !== undefined) {
              res.writeHead(rejection);
              res.end("Access denied");
              return;
            }
          }
          handleSlidesRequest(runtime, req, res);
        },
      }),
    );
    if (!config.personal) {
      handlers.push(
        ctx.webServer.register({
          kind: "prefix",
          path: "/app",
          handler: product,
        }),
      );
      handlers.push(
        ctx.webServer.register({
          kind: "prefix",
          path: "/media",
          handler: product,
        }),
      );
      handlers.push(
        ctx.webServer.register({
          kind: "prefix",
          path: "/runtime",
          handler: product,
        }),
      );
      // DSH client-connection already owns prefix /api. Exact /api/generate wins over it.
      handlers.push(
        ctx.webServer.register({
          kind: "exact",
          path: "/api/generate",
          handler: product,
        }),
      );
      handlers.push(
        ctx.webServer.register({
          kind: "exact",
          path: "/api/generate-status",
          handler: product,
        }),
      );
      handlers.push(
        ctx.webServer.register({
          kind: "prefix",
          path: "/api/pi",
          handler: product,
        }),
      );
    }
    return () => {
      for (const stop of handlers) stop();
    };
  });
}
