import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { AgentFaults } from "./agent-fault.js";
import { SliceSessionStore } from "./slice-session.js";
import { attachProduceAssemblePatch, bindToolProviderToModelSelection, createSlidesProduceSetup, hostedProduceToolDefinitions, registerHostedProduceTools, } from "./produce-agent-setup.js";
import { sessionProduceCapabilities } from "./tools.js";
import { NATIVE_WEB_FORBID_SENTENCE, serializeProduceRequestHeader } from "./produce-request-header.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addPlaywrightRuntimeLayout } from "./runtime-test-fixture.js";
function stubPresentation() {
    return {
        execute: async () => {
            throw new Error("unused");
        },
        open: async () => {
            throw new Error("unused");
        },
        inspect: async () => {
            throw new Error("unused");
        },
        hydrate: () => undefined,
        epochFor: () => "epoch",
    };
}
function stubDeps() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "produce-setup-"));
    return {
        store: new SliceSessionStore(workspace),
        presentation: stubPresentation(),
        workspaceRoot: workspace,
        editorBaseUrl: "http://127.0.0.1:55200",
        faults: new AgentFaults(),
        provider: { providerId: "pi-xai", modelId: "grok-4.6" },
    };
}
describe("produce agent setup", () => {
    it("mounts slides and own-layer-registers search_image without function web_search", async () => {
        const registered = [];
        const mounted = [];
        const assembleAttached = [];
        const hostCtx = {
            get(name) {
                if (name !== "agentPresets")
                    return undefined;
                return {
                    mount: async (_agentCtx, id) => {
                        mounted.push(id);
                    },
                };
            },
        };
        const assembleOptions = [];
        const fakeTools = {
            register(def) {
                registered.push(def.name);
                return () => undefined;
            },
            guard() {
                return () => undefined;
            },
        };
        const agentCtx = {
            tools: fakeTools,
            on(name, _listener, options) {
                assembleAttached.push(name);
                if (name === "system-prompt/assemble" && options)
                    assembleOptions.push(options);
                return () => undefined;
            },
            get(name) {
                return name === "tools" ? fakeTools : undefined;
            },
        };
        const setup = createSlidesProduceSetup(hostCtx, stubDeps());
        await setup(agentCtx, { id: "slides-agent" });
        assert.deepEqual(mounted, ["slides"]);
        // The fake registry cannot expose a standing mount, so the agent falls
        // back to scope-local wiring: the whole product plane lands on the agent's
        // own layer — still isolated, never global.
        assert.equal(registered.includes("web_search"), false);
        assert.equal(registered.includes("open_project"), true);
        assert.equal(registered.includes("search_image"), true);
        assert.equal(registered.includes("generate_image"), true);
        assert.equal(assembleAttached.includes("user-questions/request"), true);
        assert.equal(assembleAttached.includes("system-prompt/assemble"), true);
        assert.equal(assembleOptions.some((options) => options.global === true), false);
        assert.deepEqual(assembleOptions, [{ prepend: true }]);
    });
    it("registers hosted product tools with the same strict argument contract", async () => {
        const base = stubDeps();
        const sessionId = "hosted-envelope-session";
        base.store.openProject({
            dshSessionId: sessionId,
            title: "Hosted envelope",
            design: { kind: "self-directed" },
            provider: base.provider,
        });
        const called = [];
        const deps = {
            ...base,
            presentation: {
                ...stubPresentation(),
                execute: async (command) => {
                    called.push(command.name);
                    return {
                        ok: true,
                        name: command.name,
                        summary: "ok",
                        detail: "ok",
                        payload: { id: "hero", src: "media/hero.png" },
                    };
                },
            },
        };
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt, {});
        const toolsFiber = await ctx.plugin(ToolRuntime, {});
        try {
            registerHostedProduceTools(ctx.tools, deps);
            const wrapped = await ctx.tools.execute({
                callId: ToolCallId("hosted-envelope-1"),
                name: "search_image",
                arguments: { id: "sibling", arguments: { id: "hero", query: "night skyline" } },
                agent: { id: sessionId },
                signal: new AbortController().signal,
            });
            assert.equal(wrapped.isError, true);
            if (wrapped.isError)
                assert.equal(wrapped.error?.info?.code, "INVALID_ARGS");
            assert.deepEqual(called, []);
            const flat = await ctx.tools.execute({
                callId: ToolCallId("hosted-flat-1"),
                name: "search_image",
                arguments: { id: "hero", query: "night skyline" },
                agent: { id: sessionId },
                signal: new AbortController().signal,
            });
            assert.equal(flat.isError, false);
            assert.deepEqual(called, ["search_image"]);
        }
        finally {
            await toolsFiber.dispose();
            await promptFiber.dispose();
        }
    });
    it("applies a model switch to the next step of the same live Agent", async () => {
        const listeners = new Map();
        const fakeTools = {
            register() {
                return () => undefined;
            },
            guard() {
                return () => undefined;
            },
        };
        const agentCtx = {
            tools: fakeTools,
            on(name, listener) {
                const rows = listeners.get(name) ?? [];
                rows.push(listener);
                listeners.set(name, rows);
                return () => undefined;
            },
            get(name) {
                return name === "tools" ? fakeTools : undefined;
            },
        };
        const hostCtx = { get: () => undefined };
        const selection = {
            current: { provider: "amd", model: "DeepSeek-V4-Flash" },
            assembled: undefined,
        };
        await createSlidesProduceSetup(hostCtx, stubDeps(), selection)(agentCtx, { id: "slides-agent" });
        selection.current = { provider: "amd", model: "DeepSeek-Vision-Exp" };
        const assemble = listeners.get("system-prompt/assemble")?.[0];
        const request = listeners.get("agent/request")?.[0];
        assert.ok(assemble);
        assert.ok(request);
        const assembled = await assemble({}, {}, async () => ({ variables: {} }));
        const routed = await request({}, async () => ({ provider: "old", model: "old" }));
        assert.equal(assembled.variables.provider, "amd");
        assert.equal(assembled.variables.model, "DeepSeek-Vision-Exp");
        assert.equal(routed.provider, "amd");
        assert.equal(routed.model, "DeepSeek-Vision-Exp");
    });
    it("filters the next assembly from the same agent after a live vision-to-text switch", async () => {
        const listeners = [];
        const selection = {
            current: { provider: "amd", model: "DeepSeek-Vision-Exp" },
            assembled: undefined,
        };
        const deps = bindToolProviderToModelSelection(stubDeps(), selection, (selected) => ({
            providerId: selected.provider,
            modelId: selected.model,
            ready: true,
            modelInputModalities: selected.model.includes("Vision") ? ["text", "image"] : ["text"],
        }));
        const fakeTools = {
            register() {
                return () => undefined;
            },
            guard() {
                return () => undefined;
            },
        };
        const agentCtx = {
            agent: { id: "live-capability-session" },
            tools: fakeTools,
            on(name, listener) {
                if (name === "system-prompt/assemble")
                    listeners.push(listener);
                return () => undefined;
            },
            get(name) {
                return name === "tools" ? fakeTools : undefined;
            },
        };
        const hostCtx = { get: () => undefined };
        const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "produce-assembly-pw-")), "runtime.mjs");
        fs.writeFileSync(runtime, "export function verifyPinnedRuntime() { return true; }\nexport async function launchPinnedChromium() {}\n");
        addPlaywrightRuntimeLayout(runtime);
        const previousEditor = process.env.SLIDESTUDIO_EDITOR_URL;
        const previousRuntime = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
        process.env.SLIDESTUDIO_EDITOR_URL = "http://127.0.0.1:55200";
        process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtime;
        try {
            await createSlidesProduceSetup(hostCtx, deps, selection)(agentCtx, { id: "slides-agent" });
            const filter = listeners.at(-1);
            assert.ok(filter);
            const base = {
                sections: [],
                tools: [
                    { name: "render_page", description: "render", parameters: { type: "object" } },
                    { name: "review_page", description: "review", parameters: { type: "object" } },
                    { name: "search_image", description: "search", parameters: { type: "object" } },
                    { name: "generate_image", description: "generate", parameters: { type: "object" } },
                    { name: "review_pages", description: "structural", parameters: { type: "object" } },
                    { name: "compose_deck", description: "compose", parameters: { type: "object" } },
                ],
                variables: {},
            };
            const assemble = () => filter(base, {}, async () => base);
            const vision = await assemble();
            assert.equal(vision.tools.some((tool) => tool.name === "review_page"), true);
            selection.current = { provider: "amd", model: "Qwen3.8" };
            const text = await assemble();
            const names = text.tools.map((tool) => tool.name);
            assert.equal(names.includes("review_page"), false);
            assert.equal(names.includes("search_image"), false);
            assert.equal(names.includes("generate_image"), false);
            assert.equal(names.includes("render_page"), true);
            assert.equal(names.includes("review_pages"), true);
            assert.equal(names.includes("compose_deck"), true);
        }
        finally {
            if (previousEditor === undefined)
                delete process.env.SLIDESTUDIO_EDITOR_URL;
            else
                process.env.SLIDESTUDIO_EDITOR_URL = previousEditor;
            if (previousRuntime === undefined)
                delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
            else
                process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = previousRuntime;
        }
    });
    it("keeps tool capabilities on consecutive Vision to Qwen live selections", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "produce-live-caps-"));
        fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
        fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), `${JSON.stringify({
            provider: {
                providerId: "amd",
                modelId: "DeepSeek-Vision-Exp",
                ready: true,
                modelInputModalities: ["text", "image"],
            },
        })}\n`);
        let boundProvider = { providerId: "amd", modelId: "DeepSeek-Vision-Exp" };
        const store = {
            bindingFor: () => ({ projectRoot: root, provider: boundProvider }),
            resolveRoot: () => root,
        };
        const selection = {
            current: { provider: "amd", model: "DeepSeek-Vision-Exp" },
            assembled: undefined,
        };
        const deps = bindToolProviderToModelSelection({ ...stubDeps(), store }, selection, (selected) => ({
            providerId: selected.provider,
            modelId: selected.model,
            ready: true,
            modelInputModalities: ["text", "image"],
        }));
        const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "produce-live-pw-")), "runtime.mjs");
        fs.writeFileSync(runtime, "export function verifyPinnedRuntime() { return true; }\nexport async function launchPinnedChromium() {}\n");
        addPlaywrightRuntimeLayout(runtime);
        const previousEditor = process.env.SLIDESTUDIO_EDITOR_URL;
        const previousRuntime = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
        process.env.SLIDESTUDIO_EDITOR_URL = "http://127.0.0.1:55200";
        process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtime;
        try {
            assert.equal(sessionProduceCapabilities(deps, "session").vision.mode, "main-model");
            selection.current = { provider: "amd", model: "Qwen3.8" };
            boundProvider = { providerId: "amd", modelId: "Qwen3.8" };
            assert.equal(sessionProduceCapabilities(deps, "session").vision.mode, "main-model");
            const bootDeps = {
                store,
                provider: {
                    providerId: "amd",
                    modelId: "DeepSeek-V4-Flash",
                    ready: true,
                    modelInputModalities: ["text"],
                },
            };
            assert.equal(sessionProduceCapabilities(bootDeps, "session").vision.mode, "main-model");
            const persisted = JSON.parse(fs.readFileSync(path.join(root, "_agent", "presentation-run.v1.json"), "utf8"));
            assert.equal(persisted.provider.modelId, "Qwen3.8");
            assert.equal(persisted.provider.ready, true);
            assert.deepEqual(persisted.provider.modelInputModalities, ["text", "image"]);
        }
        finally {
            if (previousEditor === undefined)
                delete process.env.SLIDESTUDIO_EDITOR_URL;
            else
                process.env.SLIDESTUDIO_EDITOR_URL = previousEditor;
            if (previousRuntime === undefined)
                delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
            else
                process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = previousRuntime;
        }
    });
    it("still registers search_image when the preset roster is absent", async () => {
        const registered = [];
        const hostCtx = {
            get() {
                return undefined;
            },
        };
        const fakeTools = {
            register(def) {
                registered.push(def.name);
                return () => undefined;
            },
            guard() {
                return () => undefined;
            },
        };
        const agentCtx = {
            tools: fakeTools,
            on() {
                return () => undefined;
            },
            get(name) {
                return name === "tools" ? fakeTools : undefined;
            },
        };
        await createSlidesProduceSetup(hostCtx, stubDeps())(agentCtx, { id: "slides-agent" });
        assert.equal(registered.includes("web_search"), false);
        assert.equal(registered.includes("search_image"), true);
    });
    it("lists search_image and generate_image without function web_search", () => {
        const names = hostedProduceToolDefinitions(stubDeps()).map((def) => def.name);
        assert.deepEqual(names, ["search_image", "generate_image"]);
    });
    it("patches assemble to drop leaked function web_search and keep native-tools guidance", async () => {
        const searchImage = {
            name: "search_image",
            description: "Search images.",
            parameters: { type: "object", properties: { query: { type: "string" } } },
        };
        const generateImage = {
            name: "generate_image",
            description: "Generate an image.",
            parameters: { type: "object", properties: { prompt: { type: "string" } } },
        };
        let listener;
        let options;
        const ctx = {
            on(_name, fn, opts) {
                listener = fn;
                options = opts;
                return () => undefined;
            },
        };
        attachProduceAssemblePatch(ctx);
        assert.equal(options?.prepend, true);
        assert.deepEqual(options, { prepend: true });
        assert.ok(listener);
        const leaked = {
            sections: [
                {
                    name: "deployment:persona",
                    text: "search_image and generate_image remain product tools that write media/ for PPTD.",
                },
                { name: "oauth:native-tools", text: NATIVE_WEB_FORBID_SENTENCE },
            ],
            tools: [
                {
                    name: "web_search",
                    description: "leaked function tool",
                    parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" } } } },
                },
                searchImage,
                generateImage,
            ],
        };
        const patched = await listener(leaked, { scope: undefined }, async () => leaked);
        const names = patched.tools.map((tool) => tool.name);
        assert.equal(names.includes("web_search"), false);
        assert.equal(names.includes("search_image"), true);
        assert.equal(names.includes("generate_image"), true);
        const system = patched.sections.map((section) => section.text).join("\n\n");
        assert.match(system, /Do not call web_search or web_fetch/);
        assert.match(system, /those DSH tools are not available on this route/);
        const header = serializeProduceRequestHeader(leaked, {
            provider: "pi-xai",
            model: "grok-4.6",
        });
        assert.equal(header.tools?.some((tool) => tool.name === "web_search"), false);
        assert.equal(system.includes(NATIVE_WEB_FORBID_SENTENCE), true);
    });
});
//# sourceMappingURL=produce-agent-setup.test.js.map