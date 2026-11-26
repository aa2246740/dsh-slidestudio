/**
 * The model roster as seen through the kept `llm` thin service:
 * `ctx.llm.listProviders/listModels/resolveModelInfo` build the live catalog,
 * failure-derived provider health hides broken routes, and the route limits
 * (`contextWindow`, `maxTokens`) feed the session runtime's context budget.
 */
import type { ModelInputModality } from "@open-slidestudio/presentation-run";
import { friendlyProviderCause } from "./agent-fault.js";
import { assertSlidesGenerateReady } from "./args.js";
import {
  isAntigravityId,
  modelInputModalities,
  type RuntimeModelCatalog,
  type RuntimeModelInfo,
} from "./local-models.js";
import { slidesProviderHasModel } from "./providers.js";
import { DEFAULT_ROUTE_LIMITS, type RouteLimits, type SessionRouteSpec } from "./session-runtime-config.js";

/** The structural slice of DSH `ctx.llm` the host uses (rc.2 and rc.5 `LlmRuntime`). */
export type HostLlmCatalog = {
  listProviders(): readonly { readonly id: string }[];
  listModels(
    provider: string,
  ): Promise<readonly { readonly id: string; readonly name?: string; readonly inputModalities?: readonly string[] }[]>;
  resolveModelInfo(
    provider: string,
    model: string,
  ): Promise<{
    readonly inputModalities?: readonly string[];
    readonly context?: { readonly contextWindow: number };
    readonly defaultMaxTokens?: number;
    readonly reasoning?: { readonly efforts: readonly { readonly id: string }[] };
  }>;
};

export type CapabilityProvider = {
  providerId: string;
  modelId: string;
  ready: boolean;
  modelInputModalities: readonly ModelInputModality[];
};

export type ProviderHealth = { kind: "broken" | "degraded"; reason: string };

const BROKEN_DETAIL =
  /no adapter|NO_ADAPTER|adapter-error|UNSUPPORTED|not in the current provider roster|Cannot read propert|TypeError|undefined is not|no credential/i;

export class HostModels {
  private cache: RuntimeModelCatalog | undefined;
  private revision = 0;
  private readonly health = new Map<string, ProviderHealth>();

  constructor(
    private readonly llm: HostLlmCatalog,
    private readonly options: { readonly dshHome: string; readonly personal: boolean },
  ) {}

  /** `llm/adapters-updated`: credentials or settings changed; drop stale roster facts. */
  invalidate(): void {
    this.cache = undefined;
    this.revision += 1;
    this.health.clear();
  }

  providerHealth(provider: string): ProviderHealth | undefined {
    return this.health.get(provider);
  }

  providerSucceeded(provider: string): void {
    this.health.delete(provider);
  }

  /** A real call failure is the only trustworthy resolvability signal. */
  recordProviderFailure(provider: string, detail: string): void {
    const d = detail.slice(0, 200);
    const broken = BROKEN_DETAIL.test(d);
    this.health.set(provider, {
      kind: broken ? "broken" : "degraded",
      reason: friendlyProviderCause(d).replace(/[（）]/g, "") || (broken ? "该模型在当前环境不可用" : "上次调用失败"),
    });
  }

  async listModelCatalog(): Promise<RuntimeModelCatalog> {
    const revision = this.revision;
    const catalog = new Map<string, ReadonlyMap<string, RuntimeModelInfo>>();
    for (const provider of this.llm.listProviders()) {
      if (!this.options.personal && isAntigravityId(provider.id)) continue;
      catalog.set(provider.id, await this.providerModels(provider.id));
    }
    if (revision !== this.revision) return this.listModelCatalog();
    this.cache = catalog;
    return catalog;
  }

  private async providerModels(providerId: string): Promise<Map<string, RuntimeModelInfo>> {
    const models = await this.llm.listModels(providerId).catch(() => []);
    const byId = new Map<string, RuntimeModelInfo>();
    for (const model of models) {
      if (!model.id) continue;
      const info = await this.llm.resolveModelInfo(providerId, model.id).catch(() => undefined);
      byId.set(model.id, {
        name: model.name || model.id,
        inputModalities: [...((info?.inputModalities ?? model.inputModalities ?? []) as ModelInputModality[])],
        efforts: info?.reasoning?.efforts.map((effort) => String(effort.id)) ?? [],
      });
    }
    return byId;
  }

  async readyRoute(options: Parameters<typeof assertSlidesGenerateReady>[1]) {
    return assertSlidesGenerateReady(process.env, {
      ...options,
      ...(this.options.personal ? { managedCatalog: await this.listModelCatalog() } : {}),
    });
  }

  capabilityProvider(
    providerId: string,
    modelId: string,
    ready: boolean,
    catalog?: RuntimeModelCatalog,
  ): CapabilityProvider {
    const modalities = modelInputModalities(this.options.dshHome, providerId, modelId, catalog ?? this.cache);
    return { providerId, modelId, ready, modelInputModalities: modalities ?? [] };
  }

  async assertRosterModel(providerId: string, modelId: string): Promise<RuntimeModelCatalog> {
    const catalog = await this.listModelCatalog();
    const known = this.options.personal
      ? catalog.get(providerId)?.has(modelId)
      : slidesProviderHasModel(this.options.dshHome, providerId, modelId, catalog);
    if (!known) throw new Error(`generate model ${providerId}/${modelId} is not in the current provider roster`);
    return catalog;
  }

  /** Context window and output cap for the session runtime's budget; unknown routes use safe defaults. */
  async routeLimits(spec: SessionRouteSpec): Promise<RouteLimits> {
    const info = await this.llm.resolveModelInfo(spec.providerId, spec.modelId).catch(() => undefined);
    const contextWindow = info?.context?.contextWindow;
    const maxTokens = info?.defaultMaxTokens;
    return {
      contextWindow: contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_ROUTE_LIMITS.contextWindow,
      maxTokens: maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_ROUTE_LIMITS.maxTokens,
    };
  }

  /** Lowest reasoning effort for the intent classifier, when the route exposes one. */
  async intentEffort(providerId: string, modelId: string): Promise<string | undefined> {
    return this.llm
      .resolveModelInfo(providerId, modelId)
      .then((info) => info.reasoning?.efforts.find((effort) => effort.id === "low")?.id)
      .catch(() => undefined);
  }
}
