/**
 * DSH SlideStudio host: a thin channel over four DSH services — `webServer`
 * (routes), `connection` (Personal-mode request authorization, optional),
 * `llm` (model roster + `DshLlmPort` streaming) and `attachments` (image
 * promotion for vision turns). Every slide session runs on
 * `@open-slidestudio/slides-runtime`'s `SlidesAgentRuntime`; no DSH agent,
 * tool registry, preset, session journal or workspace service is used.
 */
import os from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createPresentationRun, machineRuntimeReuse } from "@open-slidestudio/presentation-run";
import { AgentFaults, friendlyProviderCause } from "./agent-fault.js";
import { inferAssistantIntent, type AssistantIntentInput } from "./assistant-intent.js";
import { AssistantQuestions } from "./assistant-questions.js";
import { assertSlidesGenerateReady, bindMinimaxCnKey, minimaxCnKeyPresent, openrouterKeyPresent } from "./args.js";
import { resolveUserDshHome } from "./dsh-home.js";
import type { DshAttachmentService, DshLlmService } from "./dsh-llm-port.js";
import { HostModels, type HostLlmCatalog } from "./host-models.js";
import { recoverSessionsOnActivation } from "./interruption.js";
import { assertIsolatedDshHome } from "./isolation.js";
import { applyCatalogEnv, assertMimoDesktopGateway, loadSlidesModelCatalog } from "./local-models.js";
import { bindGrokImageEnv, readXaiImageSecret, readXaiLoginSnapshot } from "./oauth-login.js";
import { assertHubProduceGatesReady } from "./produce-gates.js";
import { redirectRootToProductHome } from "./product-proxy.js";
import { bindHomeKeys } from "./providers.js";
import { handleProductRequest, handleSlidesRequest, type SlidesHostRuntime } from "./routes.js";
import { RuntimeStreamBridge } from "./runtime-stream-bridge.js";
import { createRuntimeProvisionController } from "./runtime-provision.js";
import { SessionCommands } from "./session-commands.js";
import { closeSessionLive, publishSessionLive } from "./session-live.js";
import { SessionRecovery } from "./session-recovery.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";
import { withSessionTransition } from "./session-transition.js";
import { SliceSessionStore } from "./slice-session.js";
import { loadToolSettingsIntoProcess } from "./tool-settings.js";

export { runModelSwitchTransaction } from "./model-switch.js";
export const name = "slides-host";
/** The host's required DSH services; `connection` is read optionally through `ctx.get`. */
export const inject = ["webServer", "llm", "attachments"];

/** The DSH 4-service thin shell: every other service is out of the server surface. */
export const DSH_THIN_SHELL_SERVICES = ["webServer", "connection", "llm", "attachments"] as const;

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
  /** Personal mode: the user's DSH home (default: `DSH_HOME`, else `~/.dsh`). */
  dshHome?: string;
  operatorStopTimeoutMs?: number;
  writerLeaseHeartbeatMs?: number;
  writerLeaseTtlMs?: number;
};

type WebRoute = {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
};

/** The four thin services, typed structurally so DSH 0.2.0-rc.2 and 0.2.2-rc.5 both satisfy them. */
export type SlidesHostServices = {
  readonly webServer: { readonly port?: number; register(route: WebRoute): () => void };
  readonly llm: HostLlmCatalog & DshLlmService;
  readonly attachments?: DshAttachmentService;
};

type ConnectionLike = {
  authorizeIndex?: (req: IncomingMessage, res: ServerResponse) => boolean;
  requestRejection?: (req: IncomingMessage) => number | undefined;
};

type HostCtx = Pick<Context, "effect" | "on" | "get">;

function resolveHome(config: SlidesHostConfig, workspaceRoot: string): string {
  // Personal mode runs inside the user's own Host: its DSH home already holds
  // the user's OAuth grants and model catalog, so isolation must not reject it.
  if (config.personal) return pathResolve(config.dshHome?.trim() || resolveUserDshHome());
  return assertIsolatedDshHome(process.env.DSH_HOME?.trim() || pathResolve(workspaceRoot, ".dsh", "home"));
}

function renderRuntime(workspaceRoot: string, dshHome: string) {
  // Resolve an existing render runtime first; otherwise provision the pinned
  // one into the managed dir in the background.
  const stateDir = pathJoin(dshHome, "data", "dsh-slidestudio");
  const roots = { repoRoot: workspaceRoot, homeDir: os.homedir(), stateDir };
  const provision = createRuntimeProvisionController({
    env: process.env,
    roots,
    stateDir,
    explicitOverride: process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME?.trim() || "",
    provisionOptions: { log: (message: string) => console.log(message), reuse: machineRuntimeReuse(process.env, roots) },
  });
  if (provision.snapshot().phase === "failed") void provision.start();
  return provision;
}

function registerRoutes(
  ctx: HostCtx,
  services: SlidesHostServices,
  runtime: SlidesHostRuntime,
  personal: boolean,
): void {
  const connection = () => ctx.get("connection" as never) as ConnectionLike | undefined;
  ctx.effect(() => {
    const stops: Array<() => void> = [];
    const register = (route: WebRoute) => stops.push(services.webServer.register(route));
    const product = (req: IncomingMessage, res: ServerResponse) => {
      if (!handleProductRequest(runtime, req, res) && !res.headersSent) {
        res.writeHead(404);
        res.end("not found");
      }
    };
    register({
      kind: "prefix",
      path: "/slides",
      handler: (req, res) => {
        // Personal mode shares the user's Host server: its connection service
        // authorizes every /slides request before any session state is read.
        const rejection = personal ? connection()?.requestRejection?.(req) : undefined;
        if (rejection !== undefined) {
          res.writeHead(rejection);
          res.end("Access denied");
          return;
        }
        handleSlidesRequest(runtime, req, res);
      },
    });
    // The root redirect and legacy proxy mounts belong to the standalone shell.
    if (!personal) {
      register({
        kind: "exact",
        path: "/",
        handler: (req, res) => {
          const authorize = connection()?.authorizeIndex;
          redirectRootToProductHome(req, res, authorize?.bind(connection()));
        },
      });
      for (const path of ["/app", "/media", "/runtime", "/api/pi"]) register({ kind: "prefix", path, handler: product });
      // DSH client-connection owns prefix /api; exact routes win over it.
      for (const path of ["/api/generate", "/api/generate-status"]) register({ kind: "exact", path, handler: product });
    }
    return () => {
      for (const stop of stops) stop();
    };
  });
}

export function apply(ctx: Context, config: SlidesHostConfig = {}): void {
  const services = ctx as unknown as SlidesHostServices;
  const workspaceRoot = pathResolve(config.workspaceRoot?.trim() || process.cwd());
  const dataRoot = pathResolve(config.dataRoot?.trim() || workspaceRoot);
  const dshHome = resolveHome(config, workspaceRoot);
  const personal = config.personal === true;
  const importedCatalog = loadSlidesModelCatalog(dshHome);
  if (importedCatalog) applyCatalogEnv(importedCatalog, process.env);
  const editorBaseUrl = config.editorBaseUrl?.trim() || process.env.SLIDESTUDIO_EDITOR_URL || "http://127.0.0.1:55200";
  process.env.SLIDESTUDIO_EDITOR_URL = editorBaseUrl;
  process.env.OPEN_SLIDESTUDIO_ROOT = workspaceRoot;
  const provision = renderRuntime(workspaceRoot, dshHome);
  const store = new SliceSessionStore(dataRoot);
  const presentation = createPresentationRun({ repoRoot: workspaceRoot });
  for (const [sessionId, binding] of store.rebuild()) {
    try {
      presentation.hydrate(store.resolveRoot(binding));
    } catch (error) {
      console.warn(
        `[slides] skipping corrupt session ${sessionId} during hydrate:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
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

  const models = new HostModels(services.llm, { dshHome, personal });
  ctx.on("llm/adapters-updated" as never, (() => models.invalidate()) as never);
  const busy = new Set<string>();
  const faults = new AgentFaults();
  const rootOf = (sessionId: string) => {
    const binding = store.bindingFor(sessionId);
    return binding ? store.resolveRoot(binding) : undefined;
  };
  const live = new RuntimeStreamBridge(publishSessionLive, rootOf);
  const manager = new SessionRuntimeManager({
    store,
    presentation,
    editorBaseUrl,
    llm: services.llm,
    ...(services.attachments ? { attachments: services.attachments } : {}),
    ensureMediaEnv: bindGrokProduce,
    ...(config.writerLeaseHeartbeatMs || config.writerLeaseTtlMs
      ? { lease: { heartbeatMs: config.writerLeaseHeartbeatMs, ttlMs: config.writerLeaseTtlMs } }
      : {}),
    resolveLimits: (spec) => models.routeLimits(spec),
    onEvent: (sessionId, event) => live.observe(sessionId, event),
    onTurnEnd: (sessionId, result) => recovery.onTurnEnd(sessionId, result),
    onTurnError: (sessionId, error) => {
      console.warn(`[slides] session ${sessionId} turn failed:`, error instanceof Error ? error.message : error);
      recovery.onTurnError(sessionId, error);
    },
    onStatus: (sessionId, status) => {
      if (status === "running") busy.add(sessionId);
      else if (!recovery.recovering(sessionId)) busy.delete(sessionId);
    },
  });
  // Callbacks above run only after activation, once both collaborators exist.
  const recovery: SessionRecovery = new SessionRecovery({
    store,
    faults,
    reopen: async (sessionId) => {
      const bound = store.bindingFor(sessionId)?.provider;
      if (bound) commands.noteModel(sessionId, bound.modelId);
      await commands.resumeAgent(sessionId);
    },
    continueSession: (sessionId, text) => manager.enqueue(sessionId, { kind: "resume", fallbackText: text }),
    markBusy: (sessionId) => busy.add(sessionId),
    markIdle: (sessionId) => busy.delete(sessionId),
    beforeResume: () => assertHubProduceGatesReady(workspaceRoot),
    runTransition: withSessionTransition,
    isBusy: (sessionId) => busy.has(sessionId) || manager.running(sessionId),
    isRunning: (sessionId) => manager.running(sessionId),
    clearSteers: (sessionId) => manager.clearSteers(sessionId),
    grokFallbackTarget: () => {
      try {
        const next = assertSlidesGenerateReady(process.env, { xai: currentXai() });
        return { providerId: next.provider, modelId: next.model };
      } catch {
        return undefined;
      }
    },
    openrouterKeyPresent: () => openrouterKeyPresent(),
    minimaxCnKeyPresent: () => minimaxCnKeyPresent(),
    log: (message, detail) => console.warn(message, detail instanceof Error ? detail.message : detail),
  });
  const commands: SessionCommands = new SessionCommands({
    store,
    presentation,
    workspaceRoot,
    dataRoot,
    dshHome,
    editorBaseUrl,
    models,
    manager,
    recovery,
    busy,
    currentXai,
    bindGrokProduce,
    renderRuntime: provision,
    ...(config.operatorStopTimeoutMs !== undefined ? { operatorStopTimeoutMs: config.operatorStopTimeoutMs } : {}),
  });
  const questions = new AssistantQuestions(rootOf, (sessionId) => manager.questions(sessionId));

  const resolveAssistantIntent = async (input: AssistantIntentInput) => {
    const bound = input.sessionId ? store.bindingFor(input.sessionId)?.provider : undefined;
    const selected = input.modelSelection;
    const providerId = selected?.provider || bound?.providerId || "";
    try {
      const route = await models.readyRoute({
        xai: currentXai(),
        home: dshHome,
        provider: selected?.provider || bound?.providerId,
        model: selected?.model || bound?.modelId,
      });
      await models.assertRosterModel(route.provider, route.model);
      if (route.provider === "mimo-desktop") await assertMimoDesktopGateway(dshHome);
      // Effort support is advisory: a provider that cannot answer the info
      // query must not take down an intent call whose stream would work.
      const effort = await models.intentEffort(route.provider, route.model);
      const intent = await inferAssistantIntent(
        (options) => services.llm.stream(options) as never,
        { ...route, ...(effort ? { reasoningEffort: effort as never } : {}) },
        input,
      );
      models.providerSucceeded(route.provider);
      return intent;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (providerId) models.recordProviderFailure(providerId, detail);
      // The raw cause goes to the server log, never raw JS internals into the chat bubble.
      console.warn("[slides] assistant intent failed:", detail);
      throw new Error(`助手暂时未能处理这条请求，请重试或更换模型；输入内容已保留。${friendlyProviderCause(detail)}`, {
        cause: error,
      });
    }
  };

  const runtime: SlidesHostRuntime = {
    questions,
    store,
    workspaceRoot,
    dataRoot,
    dshHome,
    presentation,
    renderRuntime: () => provision.snapshot(),
    startRenderRuntime: () => provision.start(),
    agentBusy: (sessionId) => busy.has(sessionId),
    markBusy: (sessionId) => busy.add(sessionId),
    cancelRateLimitWait: (sessionId) => recovery.onUserTurn(sessionId),
    providerHealth: (provider) => models.providerHealth(provider),
    listModelCatalog: () => models.listModelCatalog(),
    managedModels: personal,
    operatorStop: (sessionId) => commands.operatorStop(sessionId),
    getAgent: (sessionId) => manager.handle(sessionId),
    resolveAssistantIntent,
    createAgent: (input) => commands.createAgent(input),
    resumeAgent: (sessionId) => commands.resumeAgent(sessionId),
    switchModel: (sessionId, model, provider, effort) => commands.switchModel(sessionId, model, provider, effort),
  };

  recovery.restoreWaits();
  // A Host restart kills every running turn before it can close; mark those
  // turns interrupted and drop the dead process's Hub writer leases.
  recoverSessionsOnActivation(store, [], busy, (sessionId) => {
    console.warn(`[slides] marked interrupted generation turn for session ${sessionId}`);
  });
  ctx.effect(() => () => {
    live.dispose();
    closeSessionLive();
    return manager.dispose();
  });
  registerRoutes(ctx, services, runtime, personal);
}
