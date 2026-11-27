/**
 * Session lifecycle commands behind `/slides/sessions*`: create, resume,
 * model switch and operator stop. Each session runs on a
 * `SlidesAgentRuntime` owned by `SessionRuntimeManager`; the provider route is
 * the store binding, validated against the live roster.
 */
import crypto from "node:crypto";
import { relative as pathRelative } from "node:path";
import {
  buildCatalogDto,
  persistPresentationRunProvider,
  type PresentationRun,
} from "@open-slidestudio/presentation-run";
import { verifySessionMaterials, writeSessionMaterials } from "@open-slidestudio/slides-tools";
import { clearRateLimitWait, recordAgentError } from "./agent-fault.js";
import { discussionInstruction, recordConversationMessage } from "./assistant-conversation.js";
import { modelForRoute } from "./args.js";
import { directorBrief } from "./director-brief.js";
import {
  assertAttachmentBudget,
  attachmentDeliveryBlock,
  generationFormat,
  inputSha256,
  persistGenerationInput,
  type GenerationInputSnapshot,
} from "./generation-input.js";
import type { HostModels } from "./host-models.js";
import { assertGenerationRenderingReady } from "./hub-capability.js";
import { releaseBoundHubWriterLease } from "./interruption.js";
import { assertMimoDesktopGateway, reasoningEffortForModel } from "./local-models.js";
import { runModelSwitchTransaction } from "./model-switch.js";
import type { XaiLoginSnapshot } from "./oauth-login.js";
import { assertHubProduceGatesReady } from "./produce-gates.js";
import type { DesignDirective } from "./protocol.js";
import type { SlidesHostRuntime } from "./routes.js";
import type { RenderRuntimeSnapshot } from "./runtime-provision.js";
import { writeSliceRuntime } from "./runtime.js";
import type { SessionRecovery } from "./session-recovery.js";
import { materialAttachments, turnTextWithAttachments, withMaterialDetails } from "./session-materials.js";
import type { SessionRouteSpec } from "./session-runtime-config.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";
import { beginAttempt } from "./session-transition.js";
import { deckTitleFromBrief, type SliceSessionStore } from "./slice-session.js";

/**
 * Max time /slides/sessions/:id/stop waits for the runtime to honour the abort
 * before reporting the stop anyway — a hung turn must never keep the operator
 * control (and the busy flag behind the editor's "正在中止" state) pending.
 */
export const OPERATOR_STOP_IDLE_TIMEOUT_MS = 15_000;

export type SessionCommandDeps = {
  readonly store: SliceSessionStore;
  readonly presentation: PresentationRun;
  readonly workspaceRoot: string;
  readonly dataRoot: string;
  readonly dshHome: string;
  readonly editorBaseUrl: string;
  readonly models: HostModels;
  readonly manager: SessionRuntimeManager;
  readonly recovery: SessionRecovery;
  readonly busy: Set<string>;
  readonly currentXai: () => XaiLoginSnapshot;
  readonly bindGrokProduce: () => void;
  readonly renderRuntime: { current(): Promise<void> | undefined; snapshot(): RenderRuntimeSnapshot };
  readonly operatorStopTimeoutMs?: number;
};

type CreateInput = Parameters<SlidesHostRuntime["createAgent"]>[0];

export class SessionCommands {
  /** Per-session model/effort overrides accepted through switchModel or failover. */
  private readonly models = new Map<string, string>();
  private readonly efforts = new Map<string, string>();

  constructor(private readonly deps: SessionCommandDeps) {}

  private async routeFor(provider: string | undefined, model: string | undefined) {
    const { models } = this.deps;
    if (provider === "mimo-desktop") await assertMimoDesktopGateway(this.deps.dshHome);
    const route = await models.readyRoute({ xai: this.deps.currentXai(), home: this.deps.dshHome, provider, model });
    const selected = modelForRoute(route, model);
    const catalog = await models.assertRosterModel(route.provider, selected);
    return { route, model: selected, catalog };
  }

  private async assertCreateReady(conversationMode: CreateInput["conversationMode"]): Promise<void> {
    const pending = this.deps.renderRuntime.current();
    if (pending) await pending;
    const render = this.deps.renderRuntime.snapshot();
    assertGenerationRenderingReady({ render: render.phase === "ready" }, conversationMode, render.error);
    assertHubProduceGatesReady(this.deps.workspaceRoot);
    this.deps.bindGrokProduce();
  }

  private designFor(designSystemId: string | undefined) {
    const catalog = buildCatalogDto(this.deps.workspaceRoot);
    const style = designSystemId ? catalog.styles.find((entry) => entry.id === designSystemId) : undefined;
    if (designSystemId && !style) throw new Error("selected design is not in the verified catalog");
    const design: DesignDirective = style
      ? { kind: "explicit-style", designSystemId: style.id }
      : { kind: "self-directed" };
    const snapshotDesign: GenerationInputSnapshot["design"] = style
      ? {
          kind: "explicit-style",
          designSystemId: style.id,
          designSourceId: style.designSourceId,
          designHash: style.designHash,
        }
      : { kind: "self-directed" };
    return { design, snapshotDesign };
  }

  async createAgent(input: CreateInput): Promise<{ sessionId: string; projectPath?: string }> {
    const { store, dataRoot, dshHome, models } = this.deps;
    await this.assertCreateReady(input.conversationMode);
    const { route, model, catalog } = await this.routeFor(input.provider, input.model);
    const format = generationFormat(input.kind, input.layout);
    const { design, snapshotDesign } = this.designFor(input.designSystemId);
    const attachments = input.attachments ?? [];
    assertAttachmentBudget(attachments);
    const preparedMaterials = verifySessionMaterials(dataRoot, materialAttachments(attachments));
    const sessionId = crypto.randomUUID();
    const provider = models.capabilityProvider(route.provider, model, true, catalog);
    const reasoningEffort = reasoningEffortForModel(dshHome, route.provider, model, input.reasoningEffort, catalog);
    const discuss = input.conversationMode === "discuss";
    const brief = discuss
      ? discussionInstruction(input.brief)
      : directorBrief(input.brief, input.designSystemId, {
          hasAttachments: attachments.length > 0,
          patchPageElements: true,
        });
    const opened = store.openProject({
      dshSessionId: sessionId,
      title: deckTitleFromBrief(input.brief),
      design,
      provider,
      size: format.size,
    });
    const projectRoot = store.resolveRoot(opened.binding);
    const delivered = withMaterialDetails(attachments, writeSessionMaterials(projectRoot, preparedMaterials));
    const initialMessage = turnTextWithAttachments(
      `${brief}\n\nDocument format: Slides ${format.layout}, ${format.size[0]} x ${format.size[1]} pixels. Preserve this canvas size.`,
      delivered,
      { modelAcceptsImages: provider.modelInputModalities.includes("image") },
    );
    persistGenerationInput(projectRoot, {
      version: 1,
      sessionId,
      acceptedAt: new Date().toISOString(),
      brief: input.brief,
      format,
      design: snapshotDesign,
      model: { provider: route.provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
      attachments: delivered.map((attachment) => ({
        ...attachment,
        contentBlockSha256: inputSha256(attachmentDeliveryBlock(attachment)),
      })),
      initialMessage,
      initialMessageSha256: inputSha256(initialMessage),
    });
    recordConversationMessage(projectRoot, input.brief, discuss ? "discuss" : "generate");
    beginAttempt(projectRoot);
    const editorBaseUrl = this.deps.editorBaseUrl;
    writeSliceRuntime(projectRoot, { brief: input.brief, design, editorBaseUrl, strictExecution: true });
    await this.deps.presentation.open({ projectRoot, sessionId, brief: input.brief, editorBaseUrl, design, provider });
    if (reasoningEffort) this.efforts.set(sessionId, reasoningEffort);
    await this.deps.manager.open(sessionId, this.specFor(provider, reasoningEffort));
    this.deps.busy.add(sessionId);
    this.deps.manager.enqueue(sessionId, { kind: "prompt", text: initialMessage });
    return { sessionId, projectPath: pathRelative(dataRoot, projectRoot) };
  }

  private specFor(
    provider: { providerId: string; modelId: string; modelInputModalities: SessionRouteSpec["inputModalities"] },
    reasoningEffort: string | undefined,
  ): SessionRouteSpec {
    return {
      providerId: provider.providerId,
      modelId: provider.modelId,
      inputModalities: provider.modelInputModalities,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }

  /** (Re-)open the session runtime on its store binding, validated against the live roster. */
  async resumeAgent(sessionId: string): Promise<void> {
    const { store, dshHome, models } = this.deps;
    assertHubProduceGatesReady(this.deps.workspaceRoot);
    this.deps.bindGrokProduce();
    const bound = store.bindingFor(sessionId)?.provider;
    if (!bound) throw new Error(`unknown session ${sessionId}`);
    const { route, model, catalog } = await this.routeFor(
      bound.providerId,
      this.models.get(sessionId) ?? bound.modelId,
    );
    const provider = models.capabilityProvider(route.provider, model, true, catalog);
    store.updateProvider(sessionId, { providerId: route.provider, modelId: model });
    const resumed = store.bindingFor(sessionId);
    if (resumed) {
      const root = store.resolveRoot(resumed);
      persistPresentationRunProvider(root, provider);
      this.deps.presentation.hydrate(root);
    }
    const effort = reasoningEffortForModel(dshHome, route.provider, model, this.efforts.get(sessionId), catalog);
    await this.deps.manager.open(sessionId, this.specFor(provider, effort));
  }

  async switchModel(sessionId: string, model: string, provider?: string, reasoningEffort?: string): Promise<void> {
    const { store, dshHome, models, manager } = this.deps;
    const prior = store.bindingFor(sessionId);
    if (!prior) throw new Error(`unknown slides session ${sessionId}`);
    const requestedProvider =
      provider?.trim() || prior.provider.providerId || process.env.SLIDESTUDIO_LLM_PROVIDER?.trim() || "";
    const catalog = await models.assertRosterModel(requestedProvider, model);
    const route = await models.readyRoute({
      xai: this.deps.currentXai(),
      home: dshHome,
      provider: requestedProvider,
      model,
    });
    const selected = modelForRoute(route, model);
    if (manager.running(sessionId)) throw new Error(`cannot switch model for busy session ${sessionId}`);
    const projectRoot = store.resolveRoot(prior);
    const priorSpec = manager.spec(sessionId);
    const hadModel = this.models.has(sessionId);
    const priorModel = this.models.get(sessionId);
    const priorEffort = this.efforts.get(sessionId);
    const effort = reasoningEffortForModel(
      dshHome,
      route.provider,
      selected,
      reasoningEffort?.trim() || priorSpec?.reasoningEffort || priorEffort,
      catalog,
    );
    await runModelSwitchTransaction({
      apply: () => {
        this.models.set(sessionId, selected);
        if (effort) this.efforts.set(sessionId, effort);
        else this.efforts.delete(sessionId);
        store.updateProvider(sessionId, { providerId: route.provider, modelId: selected });
        if (
          !persistPresentationRunProvider(
            projectRoot,
            models.capabilityProvider(route.provider, selected, true, catalog),
          )
        ) {
          throw new Error(`presentation binding is missing for session ${sessionId}`);
        }
      },
      // An idle live runtime is rebuilt on the new DshLlmPort route right away.
      activate: () => (manager.has(sessionId) ? this.resumeAgent(sessionId) : undefined),
      rollback: async () => {
        store.updateProvider(sessionId, prior.provider);
        persistPresentationRunProvider(
          projectRoot,
          models.capabilityProvider(prior.provider.providerId, prior.provider.modelId, true),
        );
        if (hadModel) this.models.set(sessionId, priorModel!);
        else this.models.delete(sessionId);
        if (priorEffort) this.efforts.set(sessionId, priorEffort);
        else this.efforts.delete(sessionId);
        if (priorSpec) await manager.open(sessionId, priorSpec).catch(() => undefined);
      },
    });
    if (prior.provider.providerId !== route.provider || prior.provider.modelId !== selected) {
      manager.markSeedOnNextTurn(sessionId, "model-switch");
    }
    clearRateLimitWait(projectRoot);
  }

  /** Record a failover target so the next resume keeps the switched model. */
  noteModel(sessionId: string, modelId: string): void {
    this.models.set(sessionId, modelId);
  }

  async operatorStop(sessionId: string): Promise<void> {
    const { store, manager, busy, recovery } = this.deps;
    recovery.rateLimits.operatorStop(sessionId);
    const timeoutMs = this.deps.operatorStopTimeoutMs ?? OPERATOR_STOP_IDLE_TIMEOUT_MS;
    try {
      await manager.stop(sessionId, timeoutMs);
      // A session with no running turn may still hold a lease left by a crash.
      if (!manager.running(sessionId)) releaseBoundHubWriterLease(store, sessionId, true);
    } finally {
      busy.delete(sessionId);
      const binding = store.bindingFor(sessionId);
      if (binding) {
        const root = store.resolveRoot(binding);
        clearRateLimitWait(root);
        recordAgentError(root, { code: "operator-stop", detail: "operator stopped the turn" });
      }
    }
  }
}
