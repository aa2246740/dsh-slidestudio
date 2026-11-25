import type { Context } from "@deepseek-ai/cordis";
import { type AgentSetup, type ModelSelection, type ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { installModelSelectionCompat, type ModelSelectionCompatRef } from "./model-selection-compat.js";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { generateImageTool, searchImageTool, withProductToolArgumentContract, type SliceToolDeps } from "./tools.js";
import { wireSlidesAgentPlane, type SlidesAgentPlaneDeps } from "./agent-plane.js";
import { patchProduceAssembly } from "./produce-request-header.js";

type AgentPresetsMount = {
  mount(agentCtx: Context, id: string): Promise<unknown>;
};

function agentPresetsOf(ctx: Context): AgentPresetsMount | undefined {
  const value = ctx.get("agentPresets");
  if (!value || typeof value !== "object") return undefined;
  if (!("mount" in value)) return undefined;
  const mount = value.mount;
  if (typeof mount !== "function") return undefined;
  return { mount: mount.bind(value) };
}

/** Keep Agent-owned tools on the same provider/model as its mutable live selection. */
export function bindToolProviderToModelSelection(
  deps: SliceToolDeps,
  selection: ModelSelectionRef | ModelSelectionCompatRef,
  resolveProvider: (selected: ModelSelection) => SliceToolDeps["provider"],
): SliceToolDeps {
  const fallback = deps.provider;
  return {
    ...deps,
    get provider() {
      const selected = selection.current;
      return selected ? resolveProvider(selected) : fallback;
    },
  };
}

/**
 * Product tools that write `media/` for PPTD.
 * Grok search and conversational image generation are dsh-oauth native hosted
 * tools (`{ type: "web_search" }`, `{ type: "x_search" }`, `{ type: "image_generation" }`).
 * Do not own-layer-register function `web_search` — that fights the plugin and
 * previously required a host-forced sidecar that aborted the generate.
 */
export function hostedProduceToolDefinitions(deps: SliceToolDeps): ToolDefinition[] {
  return [searchImageTool(deps), generateImageTool(deps)];
}

export function registerHostedProduceTools(tools: ToolRuntime, deps: SliceToolDeps): () => void {
  const disposers: Array<() => void> = [];
  for (const def of hostedProduceToolDefinitions(deps)) {
    try {
      disposers.push(tools.register(withProductToolArgumentContract(def)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already registered/.test(message)) throw error;
    }
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * Wrap the assemble waterfall as the outermost listener (`prepend`).
 * Strip leaked function-calling `web_search` so dsh-oauth can attach hosted
 * `{ type: "web_search" }` / `{ type: "x_search" }` / `{ type: "image_generation" }`.
 * Do not delete the native-tools guidance sentence.
 *
 * The listener stays tagged to the caller's scope — never `global: true` — so
 * a produce agent's assembly patch can no longer leak into every other agent's
 * assembled model request. Install on the `slides` preset generation scope
 * (see `attachSlidesAgentPlane`) to cover every bound agent.
 */
export function attachProduceAssemblePatch(ctx: Context, allowed?: () => ReadonlySet<string>): () => void {
  return ctx.on(
    "system-prompt/assemble",
    async (_assembly, _context, next) => patchProduceAssembly(await next(), allowed?.()),
    { prepend: true },
  );
}

/**
 * Produce create/resume setup. Apiproxy mounts presets; Hub `/api/generate`
 * did not, so the complete slides persona never applied and global `web_search`
 * was name-denied as a DSH native tool.
 */
export function createSlidesProduceSetup(
  hostCtx: Context,
  deps: SlidesAgentPlaneDeps,
  modelSelection?: ModelSelectionRef,
  planeDeps: SlidesAgentPlaneDeps = deps,
): AgentSetup {
  return async (agentCtx) => {
    const selection = modelSelection ?? {
      current: {
        provider: deps.provider.providerId,
        model: deps.provider.modelId,
        ...(deps.reasoningEffort ? { reasoningEffort: ReasoningEffortId(deps.reasoningEffort) } : {}),
      },
      assembled: undefined,
    };
    installModelSelectionCompat(agentCtx, selection);
    const presets = agentPresetsOf(hostCtx);
    if (presets) {
      // Personal mode registers the `slides` preset definition itself; hosts
      // without it keep the agent but lose the director persona, so a missing
      // preset degrades instead of failing the session.
      try {
        await presets.mount(agentCtx, "slides");
      } catch (error) {
        console.warn(
          "[slides-host] agent preset 'slides' is unavailable; continuing without the slides persona",
          error,
        );
      }
    }
    // The agent plane (tools, guard, question routing, assemble patch) wires
    // the agent's own scope so the same surfaces stay isolated instead of
    // global. The `agent/created` listener reaches the same scope key with the
    // same deps object — dedupe keeps that wiring single, not duplicated.
    wireSlidesAgentPlane(agentCtx, planeDeps);
  };
}
