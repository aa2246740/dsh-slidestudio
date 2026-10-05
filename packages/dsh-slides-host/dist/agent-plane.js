import { scopeOf } from "@deepseek-ai/dsh-scope";
import { PRODUCE_WEB_SEARCH_NAME, patchProduceAssembly } from "./produce-request-header.js";
import { registerSliceTools, sessionProduceToolAllowlist } from "./tools.js";
export const SLIDES_PRESET_ID = "slides";
// Function web_search stays out of the agent layer: hosted web tools own that
// route and the produce patch strips leaked schemas anyway.
const PLANE_EXCLUDED_TOOLS = new Set([PRODUCE_WEB_SEARCH_NAME]);
/**
 * Everything the slides preset exposes to an owning agent: the product tool
 * set plus its guard, the ask_user_question waterfall interceptor, and the
 * produce assemble patch.
 *
 * The registrations are scope-tagged to whatever context installs them:
 * installing on the agent's own scoped context makes them visible only to
 * that agent; a generation scope would work the same way, but only the agent
 * ctx is reachable without the registry's module state. Nothing here is
 * `global: true` — an unrelated agent's tools, question routing and
 * assembled request must stay untouched, including one carrying a stale
 * store binding.
 */
export function attachSlidesAgentPlane(ctx, deps) {
    // Ordinary Work chat sends user input with an RPC receipt. SlideStudio's
    // own validated routes send directly, after acquiring the project lease.
    // Refuse accidental Work prompts before any model step or tool mutation.
    const disposeInputGuard = ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
        // Pre-step contains the whole conversation. An old rejected Work prompt
        // must not prevent a later, valid instruction sent from the slide editor.
        let latestInputFromWork = false;
        for (let i = messages.length - 1; i >= 0; i--) {
            const source = messages[i].source;
            if (source.kind !== "user")
                continue;
            latestInputFromWork = "rpcId" in source && source.rpcId !== undefined;
            break;
        }
        if (deps.store.bindingFor(agent.id) && latestInputFromWork) {
            throw new Error("请在演示文稿中继续此 PPT；工作区对话为生成记录，不接受编辑指令。Open this deck in SlideStudio to continue.");
        }
        return next();
    }, { prepend: true });
    // `ctx.get` resolves services without an inject declaration: a scope
    // context (preset generation or agent) has no `inject` list of its own,
    // while the resolved runtime still registers into the caller's own scope
    // layer.
    const tools = ctx.get("tools");
    const disposeTools = tools ? registerSliceTools(tools, deps, { exclude: PLANE_EXCLUDED_TOOLS }) : () => undefined;
    const disposeQuestions = ctx.on("user-questions/request", (request, next) => {
        const sessionId = request.agent?.id;
        if (!sessionId || !deps.questions || !deps.store.bindingFor(sessionId))
            return next();
        return deps.questions.ask(sessionId, request);
    }, { prepend: true });
    const disposeAssemble = ctx.on("system-prompt/assemble", async (_assembly, context, next) => patchProduceAssembly(await next(), sessionProduceToolAllowlist(deps, context?.agent?.id)), { prepend: true });
    return () => {
        disposeInputGuard();
        disposeTools();
        disposeQuestions();
        disposeAssemble();
    };
}
/**
 * One live attachment per scope key, shared across module reloads through a
 * `Symbol.for` slot. Re-attaching on the same scope (a second wire attempt,
 * a hot reload with fresh deps) disposes the previous registration first, so
 * an agent never ends up with duplicate routes, guards or listeners.
 */
const planeSlots = (() => {
    const slot = Symbol.for("open-slidestudio.dsh-slides-host.agent-plane");
    const host = globalThis;
    return (host[slot] ??= new WeakMap());
})();
export function wireSlidesAgentPlane(ctx, deps) {
    const key = scopeOf(ctx) ?? ctx;
    const existing = planeSlots.get(key);
    if (existing?.deps === deps)
        return;
    try {
        existing?.dispose();
    }
    catch (error) {
        console.warn("[slides-host] previous agent-plane wiring failed to dispose", error);
    }
    planeSlots.set(key, { deps, dispose: attachSlidesAgentPlane(ctx, deps) });
}
export function unwireSlidesAgentPlane(ctx) {
    const key = scopeOf(ctx) ?? ctx;
    const existing = planeSlots.get(key);
    if (!existing)
        return;
    try {
        existing.dispose();
    }
    catch (error) {
        console.warn("[slides-host] agent-plane wiring failed to dispose", error);
    }
    planeSlots.delete(key);
}
/**
 * Resolve the preset an agent currently stands on. `agentPresets` answers
 * through the registry service's own module, so its view of mounted
 * generations is always current. When the registry service is absent (very
 * old Hosts) fall back to the session projection, then the session/agent
 * header — the creation-time declaration. A persisted store binding is
 * deliberately not consulted: it is not ownership evidence.
 */
export function agentPresetId(agent, presets, projections) {
    const live = presets?.composedPreset?.(agent.ctx);
    if (typeof live === "string" && live !== "")
        return live;
    const session = agent.session;
    const projected = session !== undefined ? projections?.stateOf?.(session, "agentPreset") : undefined;
    if (typeof projected === "string" && projected !== "")
        return projected;
    const declared = agent.meta?.agentPreset ?? session?.header?.agentPreset;
    return typeof declared === "string" && declared !== "" ? declared : undefined;
}
/**
 * Wire an agent's own scope when that agent stands on the `slides` preset.
 * Returns false for every other agent — an ordinary, Creator or
 * differently-preset agent never reaches the slides plane, so a persisted
 * store binding by itself can no longer mark ownership.
 */
export function wireSlidesAgentPlaneForAgent(agent, deps, presets, projections) {
    if (agentPresetId(agent, presets, projections) !== SLIDES_PRESET_ID)
        return false;
    wireSlidesAgentPlane(agent.ctx, deps);
    return true;
}
/**
 * Re-evaluate an agent after an `agent-preset/selected` event: wire the
 * plane when the agent moved onto `slides`, dispose it when it moved away.
 * Returns true when the agent now stands on the slides plane.
 */
export function reconcileSlidesAgentPlane(agent, deps, presets, projections) {
    if (agentPresetId(agent, presets, projections) !== SLIDES_PRESET_ID) {
        unwireSlidesAgentPlane(agent.ctx);
        return false;
    }
    wireSlidesAgentPlane(agent.ctx, deps);
    return true;
}
//# sourceMappingURL=agent-plane.js.map