import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GROK_PROVIDER_ID, hostedProduceToolNames, inspectCapabilities, } from "@open-slidestudio/presentation-run";
import { GROK_PROVIDER } from "./oauth-login.js";
import { hubCapabilityCard, assertGenerationRenderingReady } from "./hub-capability.js";
function stubPlaywrightRuntime() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-pw-"));
    const file = path.join(dir, "runtime.mjs");
    fs.writeFileSync(file, `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub"); }
`);
    return file;
}
describe("hub capability card", () => {
    it("blocks generation before model work when rendering is unavailable while allowing discussion", () => {
        assert.throws(() => assertGenerationRenderingReady({ render: false }), /渲染环境未就绪，暂未开始生成/);
        assert.doesNotThrow(() => assertGenerationRenderingReady({ render: false }, "discuss"));
        assert.doesNotThrow(() => assertGenerationRenderingReady({ render: true }));
    });
    it("opens search, image-search, image-generate, and main-model vision for signed-in grok when raster is ready", () => {
        const env = {
            SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
            SLIDESTUDIO_PLAYWRIGHT_RUNTIME: stubPlaywrightRuntime(),
        };
        const modelInputModalities = ["text", "image"];
        const card = hubCapabilityCard({
            providerId: GROK_PROVIDER,
            ready: true,
            modelInputModalities,
            env,
        });
        const produce = inspectCapabilities({
            env,
            providerId: GROK_PROVIDER_ID,
            ready: true,
            modelInputModalities,
        });
        assert.equal(GROK_PROVIDER, "pi-xai");
        assert.equal(card.research.configured, true);
        assert.equal(card.imageSearch.configured, true);
        assert.equal(card.imageGenerate.configured, true);
        assert.equal(card.research.via, "pi-xai-hosted");
        assert.equal(card.imageSearch.via, "pi-xai-hosted");
        assert.equal(card.imageGenerate.via, "pi-xai-hosted");
        assert.equal(card.vision.mode, "main-model");
        assert.equal(card.runtime.kind, "dsh");
        assert.deepEqual(card.research, produce.research);
        assert.deepEqual(card.imageSearch, produce.imageSearch);
        assert.deepEqual(card.imageGenerate, produce.imageGenerate);
        assert.equal(card.vision.mode, produce.vision.mode);
        assert.deepEqual(hostedProduceToolNames(card), ["search_image", "generate_image"]);
    });
    it("keeps unknown and explicit text-only models out of main-model vision", () => {
        const base = { providerId: "amd", ready: true, rasterReady: true };
        assert.equal(hubCapabilityCard({ ...base, modelId: "Vision-In-Name" }).vision.mode, "none");
        assert.equal(hubCapabilityCard({
            ...base,
            modelId: "actual-text-model",
            modelInputModalities: ["text"],
        }).vision.mode, "none");
        assert.equal(hubCapabilityCard({
            ...base,
            modelId: "plain-name",
            modelInputModalities: ["text", "image"],
        }).vision.mode, "main-model");
    });
    it("does not claim 看页 when Playwright cannot raster", () => {
        const card = hubCapabilityCard({
            providerId: GROK_PROVIDER,
            ready: true,
            env: {
                SLIDESTUDIO_EDITOR_URL: "http://127.0.0.1:55200",
                SLIDESTUDIO_PLAYWRIGHT_RUNTIME: path.join(os.tmpdir(), "missing-hub-runtime.mjs"),
            },
        });
        assert.equal(card.research.configured, true);
        assert.equal(card.vision.mode, "none");
        assert.equal(card.render, false);
    });
    it("keeps MiniMax sessions on env ports when research and image URLs are absent", () => {
        const card = hubCapabilityCard({
            providerId: "minimax-cn",
            ready: true,
            env: { MINIMAX_CN_API_KEY: "sk-test-cn" },
        });
        assert.equal(card.research.configured, false);
        assert.equal(card.imageSearch.configured, false);
        assert.equal(card.imageGenerate.configured, false);
        assert.equal(card.research.via, "env");
        assert.equal(card.vision.mode, "none");
        assert.equal(hostedProduceToolNames(card).includes("web_search"), false);
    });
    it("marks Codex research native when signed in, env-only otherwise", () => {
        const signed = hubCapabilityCard({
            providerId: "pi-openai-codex",
            ready: true,
            nativeSearch: true,
            env: {},
        });
        assert.equal(signed.research.configured, true);
        assert.equal(signed.research.via, "native");
        assert.equal(signed.imageSearch.configured, false);
        assert.equal(signed.imageGenerate.configured, false);
        assert.equal(signed.vision.mode, "none");
        const out = hubCapabilityCard({
            providerId: "pi-openai-codex",
            ready: false,
            nativeSearch: false,
            env: {},
        });
        assert.equal(out.research.configured, false);
        assert.equal(out.research.via, "env");
    });
    it("does not advertise hosted tools when grok is not ready", () => {
        const card = hubCapabilityCard({ providerId: GROK_PROVIDER, ready: false, env: {} });
        assert.equal(card.research.configured, false);
        assert.equal(card.research.via, "env");
        assert.equal(card.imageSearch.configured, false);
        assert.equal(card.imageGenerate.configured, false);
        assert.equal(card.vision.mode, "none");
    });
    it("does not open MiniMax env-port research from SLIDESTUDIO_RESEARCH_URL", () => {
        const card = hubCapabilityCard({
            providerId: "openrouter",
            ready: true,
            env: {
                OPENROUTER_ONLYUSE_FREEMODEL_API_KEY: "sk-or-test-not-a-live-key",
                SLIDESTUDIO_RESEARCH_URL: "http://127.0.0.1:9/research",
            },
        });
        assert.equal(card.research.configured, false);
        assert.equal(card.research.via, "env");
        assert.equal(card.imageSearch.configured, false);
        assert.equal(card.imageGenerate.configured, false);
        assert.equal(hostedProduceToolNames(card).includes("web_search"), false);
    });
});
//# sourceMappingURL=hub-capability.test.js.map