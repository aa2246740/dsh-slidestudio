import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROK_PROVIDER_ID, hostedProduceToolNames, inspectCapabilities, inspectProjectCapabilities, persistPresentationRunProvider, visualReviewIsClaimable, } from "./capabilities.js";
import { createPresentationRun } from "./run.js";
import { rasterRuntimeReady } from "./domain/page-raster.js";
function stubPlaywrightRuntime() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-runtime-"));
    const file = path.join(dir, "runtime.mjs");
    fs.writeFileSync(file, `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub runtime"); }
`);
    return file;
}
const missingRuntime = path.join(os.tmpdir(), "no-such-playwright-runtime-oss.mjs");
describe("inspectCapabilities SSOT", () => {
    it("distinguishes missing rasters, disabled vision, and a text-only route", () => {
        const base = { env: {}, providerId: "deepseek-account", modelId: "deepseek-flash", ready: true, modelInputModalities: ["text", "image"] };
        const noRaster = inspectCapabilities({ ...base, rasterReady: false });
        assert.equal(noRaster.vision.modelAcceptsImages, true);
        assert.equal(noRaster.vision.unavailableReason, "raster-unavailable");
        assert.match(noRaster.note, /configure the pinned Playwright runtime/);
        const ready = inspectCapabilities({ ...base, rasterReady: true });
        assert.equal(ready.vision.mode, "main-model");
        assert.equal(ready.vision.unavailableReason, undefined);
        assert.equal(inspectCapabilities({ ...base, rasterReady: true, modelInputModalities: ["text"] }).vision.unavailableReason, "model-input-unsupported");
        assert.equal(inspectCapabilities({ ...base, rasterReady: true, env: { SLIDESTUDIO_LLM_IMAGE: "0" } }).vision.unavailableReason, "disabled");
    });
    it("opens hosted Grok research, image search, image generate, and main-model vision when raster is ready", () => {
        const env = {
            SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
            SLIDESTUDIO_PLAYWRIGHT_RUNTIME: stubPlaywrightRuntime(),
        };
        const snap = inspectCapabilities({
            env,
            providerId: GROK_PROVIDER_ID,
            ready: true,
            modelInputModalities: ["text", "image"],
        });
        assert.equal(snap.research.configured, true);
        assert.equal(snap.imageSearch.configured, true);
        assert.equal(snap.imageGenerate.configured, true);
        assert.equal(snap.research.via, "pi-xai-hosted");
        assert.equal(snap.imageSearch.via, "pi-xai-hosted");
        assert.equal(snap.imageGenerate.via, "pi-xai-hosted");
        assert.equal(snap.vision.mode, "main-model");
        assert.equal(snap.vision.via, "pi-xai-hosted");
        assert.equal(snap.web, true);
        assert.equal(snap.render, true);
        assert.deepEqual(hostedProduceToolNames(snap), ["search_image", "generate_image"]);
    });
    it("does not claim vision or render when Playwright runtime is missing", () => {
        const snap = inspectCapabilities({
            env: {
                SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
                SLIDESTUDIO_PLAYWRIGHT_RUNTIME: missingRuntime,
            },
            providerId: GROK_PROVIDER_ID,
            ready: true,
        });
        assert.equal(rasterRuntimeReady({ SLIDESTUDIO_PLAYWRIGHT_RUNTIME: missingRuntime }), false);
        assert.equal(snap.render, false);
        assert.equal(snap.vision.mode, "none");
        assert.equal(snap.research.configured, true);
        assert.equal(snap.imageSearch.configured, true);
        assert.equal(snap.imageGenerate.configured, true);
    });
    it("marks provider-native search for a signed-in Codex route without env URLs", () => {
        const snap = inspectCapabilities({
            env: {},
            providerId: "pi-openai-codex",
            ready: true,
            nativeSearch: true,
        });
        assert.equal(snap.research.configured, true);
        assert.equal(snap.research.via, "native");
        assert.equal(snap.web, true);
        assert.equal(snap.imageSearch.configured, false);
        assert.equal(snap.imageGenerate.configured, false);
        assert.deepEqual(hostedProduceToolNames(snap), []);
    });
    it("falls back to env ports when the route has no native search plan", () => {
        const snap = inspectCapabilities({
            env: {},
            providerId: "pi-openai-codex",
            ready: true,
            nativeSearch: false,
        });
        assert.equal(snap.research.configured, false);
        assert.equal(snap.research.via, "env");
        assert.equal(snap.web, false);
    });
    it("keeps MiniMax without env URLs off, including no hosted Grok tools", () => {
        const snap = inspectCapabilities({
            env: { MINIMAX_CN_API_KEY: "sk-test-cn" },
            providerId: "minimax-cn",
            ready: true,
        });
        assert.equal(snap.research.configured, false);
        assert.equal(snap.imageSearch.configured, false);
        assert.equal(snap.imageGenerate.configured, false);
        assert.equal(snap.research.via, "env");
        assert.equal(snap.vision.mode, "none");
        assert.equal(snap.web, false);
        assert.deepEqual(hostedProduceToolNames(snap), []);
    });
    it("does not treat a boot-time Grok imagine env bind as MiniMax image generate", () => {
        const snap = inspectCapabilities({
            env: {
                MINIMAX_CN_API_KEY: "sk-test-cn",
                SLIDESTUDIO_IMAGE: "1",
                SLIDESTUDIO_IMAGE_BASE_URL: "https://api.x.ai/v1",
                SLIDESTUDIO_IMAGE_MODEL: "grok-imagine-image-2.0",
                SLIDESTUDIO_IMAGE_API_KEY: "xai-token-not-minimax",
            },
            providerId: "minimax-cn",
            ready: true,
        });
        assert.equal(snap.imageGenerate.configured, false);
        assert.equal(snap.imageGenerate.via, "env");
        assert.deepEqual(hostedProduceToolNames(snap), []);
        const grok = inspectCapabilities({
            env: {
                SLIDESTUDIO_IMAGE: "1",
                SLIDESTUDIO_IMAGE_BASE_URL: "https://api.x.ai/v1",
                SLIDESTUDIO_IMAGE_MODEL: "grok-imagine-image-2.0",
                SLIDESTUDIO_IMAGE_API_KEY: "xai-token",
            },
            providerId: GROK_PROVIDER_ID,
            ready: true,
        });
        assert.equal(grok.imageGenerate.configured, true);
        assert.equal(grok.imageGenerate.via, "pi-xai-hosted");
    });
    it("requires explicit model image input and ignores misleading model names", () => {
        const base = {
            env: {},
            providerId: "amd",
            ready: true,
            rasterReady: true,
        };
        assert.equal(inspectCapabilities({ ...base, modelId: "DeepSeek-Vision-Exp" }).vision.mode, "none");
        assert.equal(inspectCapabilities({
            ...base,
            modelId: "plain-name",
            modelInputModalities: ["text", "image"],
        }).vision.mode, "main-model");
        assert.equal(inspectCapabilities({
            ...base,
            modelId: "DeepSeek-Vision-Exp",
            modelInputModalities: ["text"],
        }).vision.mode, "none");
    });
    it("uses the real image port configuration, including key and explicit disable", () => {
        const base = {
            SLIDESTUDIO_IMAGE_BASE_URL: "http://127.0.0.1:9/images",
        };
        assert.equal(inspectCapabilities(base).imageGenerate.configured, false);
        assert.equal(inspectCapabilities({ ...base, SLIDESTUDIO_IMAGE_API_KEY: "test-key" })
            .imageGenerate.configured, true);
        assert.equal(inspectCapabilities({
            ...base,
            SLIDESTUDIO_IMAGE_API_KEY: "test-key",
            SLIDESTUDIO_IMAGE: "0",
        }).imageGenerate.configured, false);
    });
    it("clears prior image input metadata when the same route becomes unknown", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "caps-clear-model-input-"));
        fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
        fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), `${JSON.stringify({ provider: { providerId: "amd", modelId: "same-model" } })}\n`);
        persistPresentationRunProvider(root, {
            providerId: "amd",
            modelId: "same-model",
            ready: true,
            modelInputModalities: ["text", "image"],
        });
        const env = {
            SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
            SLIDESTUDIO_PLAYWRIGHT_RUNTIME: stubPlaywrightRuntime(),
        };
        assert.equal(inspectProjectCapabilities(root, env).vision.mode, "main-model");
        persistPresentationRunProvider(root, {
            providerId: "amd",
            modelId: "same-model",
            ready: true,
            modelInputModalities: [],
        });
        const rec = JSON.parse(fs.readFileSync(path.join(root, "_agent", "presentation-run.v1.json"), "utf8"));
        assert.deepEqual(rec.provider.modelInputModalities, []);
        assert.equal(inspectProjectCapabilities(root, env).vision.mode, "none");
    });
    it("ignores MiniMax env research URL and does not invent Grok web_search", () => {
        const snap = inspectCapabilities({
            env: {
                SLIDESTUDIO_RESEARCH_URL: "http://127.0.0.1:9/research",
            },
            providerId: "openrouter",
            ready: true,
        });
        assert.equal(snap.research.configured, false);
        assert.equal(snap.research.via, "env");
        assert.equal(hostedProduceToolNames(snap).includes("web_search"), false);
    });
    it("turns MiniMax vision on only with SLIDESTUDIO_VISION_REVIEWER, not Grok main-model", () => {
        const snap = inspectCapabilities({
            env: { SLIDESTUDIO_VISION_REVIEWER: "http://127.0.0.1:9/review" },
            providerId: "minimax-cn",
            ready: true,
        });
        assert.equal(snap.vision.mode, "reviewer");
        assert.equal(visualReviewIsClaimable({ SLIDESTUDIO_VISION_REVIEWER: "http://127.0.0.1:9/review" }), true);
        assert.equal(visualReviewIsClaimable({ SLIDESTUDIO_VISION_REVIEWER: "", SLIDESTUDIO_LLM_IMAGE: "0" }), false);
    });
    it("matches Hub/produce for a Grok project binding", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-caps-"));
        const runtime = stubPlaywrightRuntime();
        fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
        fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), `${JSON.stringify({
            provider: {
                providerId: GROK_PROVIDER_ID,
                modelId: "grok-4.6",
                ready: true,
                modelInputModalities: ["text", "image"],
            },
        })}\n`);
        const env = {
            SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
            SLIDESTUDIO_PLAYWRIGHT_RUNTIME: runtime,
        };
        const produce = inspectProjectCapabilities(root, env);
        const card = inspectCapabilities({
            env,
            providerId: GROK_PROVIDER_ID,
            modelId: "grok-4.6",
            ready: true,
            modelInputModalities: ["text", "image"],
        });
        assert.deepEqual(produce.research, card.research);
        assert.deepEqual(produce.imageSearch, card.imageSearch);
        assert.deepEqual(produce.imageGenerate, card.imageGenerate);
        assert.equal(produce.vision.mode, card.vision.mode);
        assert.equal(produce.vision.mode, "main-model");
    });
    it("returns the same capability object from produce inspect_capabilities for a Grok run", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-inspect-"));
        const runtime = stubPlaywrightRuntime();
        const env = {
            SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
            SLIDESTUDIO_PLAYWRIGHT_RUNTIME: runtime,
        };
        const prevEditor = process.env.SLIDESTUDIO_EDITOR_URL;
        const prevPw = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
        process.env.SLIDESTUDIO_EDITOR_URL = env.SLIDESTUDIO_EDITOR_URL;
        process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
        try {
            const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
            const run = createPresentationRun({ repoRoot: path.resolve(pkg, "../..") });
            const handle = await run.open({
                projectRoot: root,
                sessionId: "grok-sess",
                brief: "封面需要今年航天新闻和一张封面底图",
                editorBaseUrl: env.SLIDESTUDIO_EDITOR_URL,
                design: { kind: "self-directed" },
                provider: { providerId: GROK_PROVIDER_ID, modelId: "grok-4.6" },
            });
            persistPresentationRunProvider(root, {
                providerId: GROK_PROVIDER_ID,
                modelId: "grok-4.6",
                ready: true,
                modelInputModalities: ["text", "image"],
            });
            const receipt = await run.execute({ name: "inspect_capabilities", args: {} }, {
                runId: handle.runId,
                sessionId: handle.sessionId,
                toolCallId: "caps-1",
                projectRoot: root,
                abortSignal: new AbortController().signal,
            });
            assert.equal(receipt.ok, true);
            const payload = receipt.payload;
            assert.equal(payload.research.configured, true);
            assert.equal(payload.imageSearch.configured, true);
            assert.equal(payload.imageGenerate.configured, true);
            assert.equal(payload.vision.mode, "main-model");
            assert.deepEqual(hostedProduceToolNames(inspectProjectCapabilities(root, env)), ["search_image", "generate_image"]);
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
    it("writes a missing Grok provider onto presentation-run.v1.json", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-persist-"));
        fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
        fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), `${JSON.stringify({
            sessionId: "cc4bece0-c193-4d0e-af81-da00459921e5",
            brief: "封面需要今年航天新闻和一张封面底图",
            design: { kind: "self-directed" },
        })}\n`);
        const env = { MINIMAX_CN_API_KEY: "sk-test-cn" };
        assert.equal(inspectProjectCapabilities(root, env).research.configured, false);
        assert.equal(persistPresentationRunProvider(root, {
            providerId: GROK_PROVIDER_ID,
            modelId: "grok-4.6",
            ready: true,
            modelInputModalities: ["text", "image"],
        }), true);
        const produce = inspectProjectCapabilities(root, env);
        assert.equal(produce.research.configured, true);
        assert.equal(produce.imageSearch.configured, true);
        assert.equal(produce.imageGenerate.configured, true);
        assert.equal(produce.research.via, "pi-xai-hosted");
        assert.deepEqual(hostedProduceToolNames(produce), ["search_image", "generate_image"]);
    });
});
//# sourceMappingURL=capabilities.test.js.map