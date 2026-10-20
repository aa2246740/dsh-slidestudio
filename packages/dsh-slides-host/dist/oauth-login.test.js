import { stubPlaywrightRuntime, invokeSlides, emptyRuntime } from "./oauth-test-fixtures.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentOptionsForRoute, assertSlidesGenerateReady, markGrokFailed, resetGenerateRouteState, resolveSlidesLlmRoute, } from "./args.js";
import { classifyAgentError, isWaitAndResumeFault } from "./agent-fault.js";
import { bindGrokImageEnv, grokModelFromCatalog, GROK_DEFAULT_MODEL, GROK_PROVIDER, OAUTH_AUTH_FILENAME, readXaiImageSecret, readXaiLoginSnapshot, shouldFailoverGrok, XAI_API_BASE, XAI_IMAGE_MODEL, } from "./oauth-login.js";
import { connectionState, slidesProviderHasModel } from "./providers.js";
import { inspectCapabilities } from "@open-slidestudio/presentation-run";
const FIXTURE_ACCESS = "test-access-not-a-live-token";
const FIXTURE_REFRESH = "test-refresh-not-a-live-token";
const OR_KEY = "sk-or-test-not-a-live-key";
const CN_KEY = "sk-test-cn";
function signedInEnv() {
    return {
        MINIMAX_CN_API_KEY: CN_KEY,
        OPENROUTER_ONLYUSE_FREEMODEL_API_KEY: OR_KEY,
    };
}
function writeOauthDoc(home, xai) {
    const file = path.join(home, OAUTH_AUTH_FILENAME);
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, credentials: { xai } }, null, 2)}\n`, { mode: 0o600 });
    return file;
}
describe("xai grok generate route", () => {
    it("selects pi-xai only when that provider is explicit, and does not steal DSH App OAuth by default", () => {
        resetGenerateRouteState();
        const implicit = resolveSlidesLlmRoute(signedInEnv(), {
            xai: { status: "signed-in", models: ["grok-4.6"] },
        });
        assert.equal(implicit.provider, "minimax-cn");
        const route = resolveSlidesLlmRoute({ ...signedInEnv(), SLIDESTUDIO_LLM_PROVIDER: GROK_PROVIDER, SLIDESTUDIO_LLM_MODEL: GROK_DEFAULT_MODEL }, { xai: { status: "signed-in", models: ["grok-4.6"] } });
        assert.deepEqual(route, {
            provider: GROK_PROVIDER,
            model: GROK_DEFAULT_MODEL,
            nativeTools: true,
        });
        const options = agentOptionsForRoute(route);
        assert.equal(options.provider, GROK_PROVIDER);
        assert.equal(options.model, GROK_DEFAULT_MODEL);
        assert.equal("nativeTools" in options, false);
        assert.deepEqual(assertSlidesGenerateReady({ SLIDESTUDIO_LLM_PROVIDER: GROK_PROVIDER, SLIDESTUDIO_LLM_MODEL: GROK_DEFAULT_MODEL }, { xai: { status: "signed-in", models: ["grok-4.6"] } }), route);
    });
    it("uses the signed-in catalog when grok is explicit and grok-4.6 is absent", () => {
        resetGenerateRouteState();
        assert.equal(grokModelFromCatalog(["grok-4.5"]), "grok-4.5");
        const route = resolveSlidesLlmRoute({ ...signedInEnv(), SLIDESTUDIO_LLM_PROVIDER: GROK_PROVIDER, SLIDESTUDIO_LLM_MODEL: "grok-4.5" }, { xai: { status: "signed-in", models: ["grok-4.5"] } });
        assert.equal(route.provider, GROK_PROVIDER);
        assert.equal(route.model, "grok-4.5");
        assert.equal(route.nativeTools, true);
    });
    it("uses MiniMax China when xai is signed out and no explicit provider is set", () => {
        resetGenerateRouteState();
        const env = signedInEnv();
        assert.deepEqual(resolveSlidesLlmRoute(env, { xai: { status: "signed-out" } }), {
            provider: "minimax-cn",
            model: "MiniMax-M3",
        });
        assert.deepEqual(resolveSlidesLlmRoute(env), {
            provider: "minimax-cn",
            model: "MiniMax-M3",
        });
    });
    it("stays on the explicit grok route until the caller picks another provider", () => {
        resetGenerateRouteState();
        const env = {
            ...signedInEnv(),
            SLIDESTUDIO_LLM_PROVIDER: GROK_PROVIDER,
            SLIDESTUDIO_LLM_MODEL: GROK_DEFAULT_MODEL,
        };
        const xai = { status: "signed-in", models: ["grok-4.6"] };
        assert.equal(resolveSlidesLlmRoute(env, { xai }).provider, GROK_PROVIDER);
        markGrokFailed();
        assert.equal(resolveSlidesLlmRoute(env, { xai }).provider, GROK_PROVIDER);
        resetGenerateRouteState();
    });
    it("still rejects Antigravity when grok is signed in", () => {
        resetGenerateRouteState();
        assert.throws(() => resolveSlidesLlmRoute({
            ...signedInEnv(),
            SLIDESTUDIO_LLM_PROVIDER: "agy-google-antigravity",
            SLIDESTUDIO_LLM_MODEL: "gemini-3.8-flash",
        }, { xai: { status: "signed-in", models: ["grok-4.6"] } }), /Antigravity generate is rejected/);
    });
    it("reads a signed-in snapshot from the oauth file and never returns tokens", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "xai-oauth-"));
        writeOauthDoc(home, {
            type: "oauth",
            access: FIXTURE_ACCESS,
            refresh: FIXTURE_REFRESH,
            expires: Date.now() + 60_000,
            availableModelIds: ["grok-4.6", "grok-4.5"],
        });
        const snap = readXaiLoginSnapshot(home);
        assert.deepEqual(snap, { status: "signed-in", models: ["grok-4.6", "grok-4.5"] });
        const encoded = JSON.stringify(snap);
        assert.doesNotMatch(encoded, new RegExp(FIXTURE_ACCESS));
        assert.doesNotMatch(encoded, new RegExp(FIXTURE_REFRESH));
        assert.equal("access" in snap, false);
        assert.equal("refresh" in snap, false);
        assert.equal("key" in snap, false);
        const secret = readXaiImageSecret(home);
        assert.equal(secret, FIXTURE_ACCESS);
        const state = connectionState(home, {
            ...signedInEnv(),
            SLIDESTUDIO_LLM_PROVIDER: GROK_PROVIDER,
            SLIDESTUDIO_LLM_MODEL: GROK_DEFAULT_MODEL,
        });
        assert.equal(state.providerId, GROK_PROVIDER);
        assert.equal(state.ready, true);
        assert.equal(state.method, "oauth");
        assert.equal(state.model, GROK_DEFAULT_MODEL);
        const leaked = JSON.stringify(state);
        assert.doesNotMatch(leaked, new RegExp(FIXTURE_ACCESS));
        assert.doesNotMatch(leaked, new RegExp(CN_KEY));
        assert.doesNotMatch(leaked, new RegExp(OR_KEY));
    });
    it("treats a missing oauth file as signed-out MiniMax fallback", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "xai-oauth-empty-"));
        assert.deepEqual(readXaiLoginSnapshot(home), { status: "signed-out" });
        const state = connectionState(home, signedInEnv());
        assert.equal(state.providerId, "minimax-cn");
        assert.equal(state.model, "MiniMax-M3");
    });
    it("binds grok image generate to the xAI images API, not chat completions", () => {
        const env = {};
        bindGrokImageEnv(env, FIXTURE_ACCESS);
        assert.equal(env.SLIDESTUDIO_IMAGE_BASE_URL, XAI_API_BASE);
        assert.equal(env.SLIDESTUDIO_IMAGE_MODEL, XAI_IMAGE_MODEL);
        assert.equal(env.SLIDESTUDIO_IMAGE, "1");
        assert.equal(env.SLIDESTUDIO_IMAGE_API_KEY, FIXTURE_ACCESS);
        assert.doesNotMatch(String(env.SLIDESTUDIO_IMAGE_BASE_URL), /chat\/completions/);
        assert.match(`${env.SLIDESTUDIO_IMAGE_BASE_URL}/images/generations`, /\/v1\/images\/generations$/);
    });
    it("failovers grok AUTH and QUOTA, and waits on grok 429 in the same session", () => {
        const auth = classifyAgentError({ code: "AUTH", message: "unauthorized" });
        const quota = classifyAgentError({ code: "QUOTA", message: "quota" });
        const limited = classifyAgentError({ code: "RATE_LIMIT", message: "429 rate limit" });
        assert.equal(shouldFailoverGrok(GROK_PROVIDER, auth), true);
        assert.equal(shouldFailoverGrok(GROK_PROVIDER, quota), true);
        assert.equal(shouldFailoverGrok(GROK_PROVIDER, limited), false);
        assert.equal(shouldFailoverGrok("minimax-cn", auth), false);
        assert.equal(shouldFailoverGrok("minimax-cn", quota), false);
        assert.equal(isWaitAndResumeFault(limited), true);
        assert.equal(isWaitAndResumeFault(auth), false);
        assert.equal(isWaitAndResumeFault(quota), false);
    });
    it("reports grok oauth on /slides/providers without leaking fixture tokens", async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "xai-oauth-http-"));
        writeOauthDoc(home, {
            type: "oauth",
            access: FIXTURE_ACCESS,
            refresh: FIXTURE_REFRESH,
            expires: Date.now() + 60_000,
            availableModelIds: ["grok-4.6"],
        });
        const prevP = process.env.SLIDESTUDIO_LLM_PROVIDER;
        const prevM = process.env.SLIDESTUDIO_LLM_MODEL;
        process.env.SLIDESTUDIO_LLM_PROVIDER = GROK_PROVIDER;
        process.env.SLIDESTUDIO_LLM_MODEL = GROK_DEFAULT_MODEL;
        try {
            const res = await invokeSlides(emptyRuntime(home), "GET", "/slides/providers");
            assert.equal(res.status, 200);
            const body = JSON.stringify(res.json);
            assert.match(body, /pi-xai/);
            assert.doesNotMatch(body, new RegExp(FIXTURE_ACCESS));
            assert.doesNotMatch(body, new RegExp(FIXTURE_REFRESH));
            const parsed = res.json;
            assert.equal(parsed.connection.providerId, GROK_PROVIDER);
            assert.equal(parsed.connection.method, "oauth");
            assert.equal(parsed.connection.ready, true);
            assert.equal(parsed.connection.model, GROK_DEFAULT_MODEL);
            assert.equal(parsed.oauth.available, true);
        }
        finally {
            if (prevP === undefined)
                delete process.env.SLIDESTUDIO_LLM_PROVIDER;
            else
                process.env.SLIDESTUDIO_LLM_PROVIDER = prevP;
            if (prevM === undefined)
                delete process.env.SLIDESTUDIO_LLM_MODEL;
            else
                process.env.SLIDESTUDIO_LLM_MODEL = prevM;
        }
    });
    it("advertises grok hosted search and image generate on /slides/health for Hub chips", async () => {
        resetGenerateRouteState();
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "xai-oauth-health-"));
        writeOauthDoc(home, {
            type: "oauth",
            access: FIXTURE_ACCESS,
            refresh: FIXTURE_REFRESH,
            expires: Date.now() + 60_000,
            availableModelIds: ["grok-4.6"],
        });
        const runtimeFile = stubPlaywrightRuntime();
        const prevEditor = process.env.SLIDESTUDIO_EDITOR_URL;
        const prevPw = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
        const prevP = process.env.SLIDESTUDIO_LLM_PROVIDER;
        const prevM = process.env.SLIDESTUDIO_LLM_MODEL;
        process.env.SLIDESTUDIO_EDITOR_URL = "http://127.0.0.1:55200";
        process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtimeFile;
        process.env.SLIDESTUDIO_LLM_PROVIDER = GROK_PROVIDER;
        process.env.SLIDESTUDIO_LLM_MODEL = GROK_DEFAULT_MODEL;
        try {
            const runtime = emptyRuntime(home);
            runtime.listModelCatalog = async () => new Map([
                [GROK_PROVIDER, new Map([[GROK_DEFAULT_MODEL, { name: "Grok", inputModalities: ["text", "image"] }]])],
            ]);
            const res = await invokeSlides(runtime, "GET", "/slides/health");
            assert.equal(res.status, 200);
            const parsed = res.json;
            assert.equal(parsed.connection.providerId, GROK_PROVIDER);
            assert.equal(parsed.connection.model, GROK_DEFAULT_MODEL);
            assert.equal(parsed.capability.research.configured, true);
            assert.equal(parsed.capability.imageSearch.configured, true);
            assert.equal(parsed.capability.imageGenerate.configured, true);
            assert.equal(parsed.capability.research.via, "pi-xai-hosted");
            assert.equal(parsed.capability.imageSearch.via, "pi-xai-hosted");
            assert.equal(parsed.capability.imageGenerate.via, "pi-xai-hosted");
            assert.equal(parsed.capability.vision.mode, "main-model");
            assert.equal(parsed.capability.render, true);
            const produce = inspectCapabilities({
                env: process.env,
                providerId: GROK_PROVIDER,
                ready: true,
                modelInputModalities: ["text", "image"],
            });
            assert.equal(parsed.capability.vision.mode, produce.vision.mode);
            assert.deepEqual(parsed.capability.research, produce.research);
            assert.deepEqual(parsed.capability.imageSearch, produce.imageSearch);
            assert.deepEqual(parsed.capability.imageGenerate, produce.imageGenerate);
            assert.doesNotMatch(JSON.stringify(res.json), new RegExp(FIXTURE_ACCESS));
        }
        finally {
            if (prevEditor === undefined)
                delete process.env.SLIDESTUDIO_EDITOR_URL;
            else
                process.env.SLIDESTUDIO_EDITOR_URL = prevEditor;
            if (prevPw === undefined)
                delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
            else
                process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = prevPw;
            if (prevP === undefined)
                delete process.env.SLIDESTUDIO_LLM_PROVIDER;
            else
                process.env.SLIDESTUDIO_LLM_PROVIDER = prevP;
            if (prevM === undefined)
                delete process.env.SLIDESTUDIO_LLM_MODEL;
            else
                process.env.SLIDESTUDIO_LLM_MODEL = prevM;
        }
    });
    it("health ?provider=pi-xai uses Grok caps even when the default connection is MiniMax", async () => {
        resetGenerateRouteState();
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "xai-oauth-query-"));
        writeOauthDoc(home, {
            type: "oauth",
            access: FIXTURE_ACCESS,
            refresh: FIXTURE_REFRESH,
            expires: Date.now() + 60_000,
            availableModelIds: ["grok-4.6"],
        });
        const runtimeFile = stubPlaywrightRuntime();
        const prevEditor = process.env.SLIDESTUDIO_EDITOR_URL;
        const prevPw = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
        process.env.SLIDESTUDIO_EDITOR_URL = "http://127.0.0.1:55200";
        process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtimeFile;
        try {
            const runtime = emptyRuntime(home);
            runtime.listModelCatalog = async () => new Map([[GROK_PROVIDER, new Map([["grok-4.6", { name: "Grok", inputModalities: ["text", "image"] }]])]]);
            const res = await invokeSlides(runtime, "GET", "/slides/health?provider=pi-xai&model=grok-4.6");
            assert.equal(res.status, 200);
            const parsed = res.json;
            assert.equal(parsed.selection.providerId, GROK_PROVIDER);
            assert.equal(parsed.selection.model, "grok-4.6");
            assert.equal(parsed.selection.ready, true);
            assert.equal(parsed.capability.research.configured, true);
            assert.equal(parsed.capability.research.via, "pi-xai-hosted");
            assert.equal(parsed.capability.vision.mode, "main-model");
            const unknown = await invokeSlides(emptyRuntime(home), "GET", "/slides/health?provider=pi-xai&model=unknown-grok-model");
            const unknownParsed = unknown.json;
            assert.equal(unknownParsed.selection.ready, false);
            assert.equal(unknownParsed.capability.research.configured, false);
            assert.equal(unknownParsed.capability.vision.mode, "none");
        }
        finally {
            if (prevEditor === undefined)
                delete process.env.SLIDESTUDIO_EDITOR_URL;
            else
                process.env.SLIDESTUDIO_EDITOR_URL = prevEditor;
            if (prevPw === undefined)
                delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
            else
                process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = prevPw;
        }
    });
    it("uses one live catalog for grouped models, health and execution validation", async (t) => {
        resetGenerateRouteState();
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "xai-oauth-catalog-"));
        const runtimeFile = stubPlaywrightRuntime();
        const prevEditor = process.env.SLIDESTUDIO_EDITOR_URL;
        const prevPw = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
        process.env.SLIDESTUDIO_EDITOR_URL = "http://127.0.0.1:55200";
        process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtimeFile;
        t.after(() => {
            if (prevEditor === undefined)
                delete process.env.SLIDESTUDIO_EDITOR_URL;
            else
                process.env.SLIDESTUDIO_EDITOR_URL = prevEditor;
            if (prevPw === undefined)
                delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
            else
                process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = prevPw;
        });
        writeOauthDoc(home, {
            type: "oauth",
            access: FIXTURE_ACCESS,
            refresh: FIXTURE_REFRESH,
            expires: Date.now() + 60_000,
            availableModelIds: ["grok-4.6"],
        });
        const catalog = new Map([
            [
                "pi-xai",
                new Map([
                    ["grok-4.7", { name: "Grok 4.7", inputModalities: ["text", "image"], efforts: ["low", "high"] }],
                    ["grok-4.6", { name: "Grok 4.6", inputModalities: ["text"], efforts: [] }],
                ]),
            ],
        ]);
        const runtime = emptyRuntime(home);
        runtime.listModelCatalog = async () => catalog;
        const listed = await invokeSlides(runtime, "GET", "/slides/providers");
        const providers = listed.json.providers;
        const grok = providers.find((row) => row.id === GROK_PROVIDER);
        assert.deepEqual(grok?.models, ["grok-4.7", "grok-4.6"]);
        assert.equal(slidesProviderHasModel(home, GROK_PROVIDER, "grok-4.7", catalog), true);
        assert.equal(slidesProviderHasModel(home, GROK_PROVIDER, "grok-4.3", catalog), false);
        const grouped = await invokeSlides(runtime, "GET", "/slides/models");
        const groups = grouped.json;
        assert.deepEqual(groups.map((row) => row.providerId), [GROK_PROVIDER]);
        assert.deepEqual(groups[0]?.models[0], { id: "grok-4.7", name: "Grok 4.7", inputModalities: ["text", "image"] });
        assert.deepEqual(groups[0]?.modelEfforts["grok-4.7"], ["low", "high"]);
        const health = await invokeSlides(runtime, "GET", "/slides/health?provider=pi-xai&model=grok-4.7");
        const parsed = health.json;
        // grok-4.7 is not in the host's preferred list, but DSH advertises it, so
        // both the selection and the image capability come from the catalog.
        assert.equal(parsed.selection.model, "grok-4.7");
        assert.equal(parsed.selection.ready, true);
        assert.equal(parsed.capability.vision.mode, "main-model");
        const textOnly = await invokeSlides(runtime, "GET", "/slides/health?provider=pi-xai&model=grok-4.6");
        const textParsed = textOnly.json;
        assert.equal(textParsed.capability.vision.mode, "none");
        runtime.providerHealth = () => ({ kind: "broken", reason: "adapter unavailable" });
        assert.deepEqual((await invokeSlides(runtime, "GET", "/slides/models")).json, []);
        const brokenHealth = (await invokeSlides(runtime, "GET", "/slides/health?provider=pi-xai&model=grok-4.7")).json;
        assert.equal(brokenHealth.selection.ready, false);
        runtime.providerHealth = () => ({ kind: "degraded", reason: "try later" });
        const degraded = (await invokeSlides(runtime, "GET", "/slides/models")).json;
        assert.equal(degraded[0]?.degraded, true);
        runtime.listModelCatalog = async () => new Map();
        assert.deepEqual((await invokeSlides(runtime, "GET", "/slides/models")).json, []);
        assert.equal(slidesProviderHasModel(home, GROK_PROVIDER, "grok-4.6", new Map()), false);
        delete runtime.listModelCatalog;
        const fallback = (await invokeSlides(runtime, "GET", "/slides/models")).json;
        assert.ok(fallback[0]?.models.some((model) => model.id === "grok-4.6"));
    });
    it("uses subscription grants rather than a duplicate imported API-key slot", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-imported-route-"));
        fs.writeFileSync(path.join(home, OAUTH_AUTH_FILENAME), JSON.stringify({
            version: 1,
            credentials: {
                anthropic: { type: "oauth", access: FIXTURE_ACCESS, refresh: FIXTURE_REFRESH, expires: Date.now() + 60_000 },
            },
        }));
        const opts = {
            home,
            provider: "pi-anthropic",
            model: "claude-sonnet-4-6",
            catalog: {
                sourceHome: "/unused",
                destHome: home,
                excluded: [],
                oauthSkipped: [],
                defaultProvider: "pi-anthropic",
                defaultModel: "claude-sonnet-4-6",
                providers: [
                    {
                        id: "pi-anthropic",
                        name: "Claude",
                        apiKeyEnv: "MISSING_TEST_KEY",
                        ready: false,
                        models: ["claude-sonnet-4-6"],
                    },
                ],
            },
        };
        assert.equal(assertSlidesGenerateReady({}, opts).provider, "pi-anthropic");
        fs.unlinkSync(path.join(home, OAUTH_AUTH_FILENAME));
        assert.throws(() => assertSlidesGenerateReady({}, opts), /no credential/);
    });
    it("keeps MiniMax /slides/health chips on env ports when grok is signed out", async () => {
        resetGenerateRouteState();
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "xai-oauth-health-mm-"));
        const res = await invokeSlides(emptyRuntime(home), "GET", "/slides/health");
        assert.equal(res.status, 200);
        const parsed = res.json;
        assert.notEqual(parsed.connection.providerId, GROK_PROVIDER);
        assert.equal(parsed.capability.research.via, "env");
        assert.equal(parsed.capability.imageSearch.via, "env");
        assert.equal(parsed.capability.imageGenerate.via, "env");
    });
});
//# sourceMappingURL=oauth-login.test.js.map