import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { XAI_API_BASE } from "./domain/grok-hosted.js";
import { writeFileAtomic } from "./domain/atomic-file.js";
import { imageConfigFromEnv, imageConfigured } from "./domain/image-port.js";
import { rasterRuntimeReady } from "./domain/page-raster.js";
/** Same id as dsh-oauth-login / Hub connection.providerId. */
export const GROK_PROVIDER_ID = "pi-xai";
const BINDING_REL = path.join("_agent", "presentation-run.v1.json");
function isInspectInput(value) {
    if (!value || typeof value !== "object")
        return false;
    return ("providerId" in value ||
        "ready" in value ||
        "modelInputModalities" in value ||
        "rasterReady" in value ||
        "nativeSearch" in value ||
        "env" in value);
}
function resolveArgs(envOrInput) {
    if (isInspectInput(envOrInput)) {
        return { ...envOrInput, env: envOrInput.env ?? process.env };
    }
    return { env: envOrInput ?? process.env };
}
function editorConfigured(env) {
    return Boolean(env.SLIDESTUDIO_EDITOR_URL?.trim() || env.SLIDESTUDIO_PRODUCT_URL?.trim());
}
/** Grok imagine credentials bound into process.env must not look like a MiniMax image port. */
export function envLooksLikeGrokImagine(env) {
    const base = (env.SLIDESTUDIO_IMAGE_BASE_URL || "").replace(/\/+$/, "");
    const model = env.SLIDESTUDIO_IMAGE_MODEL || "";
    return base === XAI_API_BASE || /api\.x\.ai/i.test(base) || /grok-imagine/i.test(model);
}
function flag(configured, via) {
    return { configured, via };
}
function visionNote(mode, reason) {
    if (mode === "none") {
        if (reason === "disabled")
            return "Visual review is disabled by SLIDESTUDIO_LLM_IMAGE=0. Run deterministic render_page and review_pages checks; do not claim a visual-review pass.";
        if (reason === "raster-unavailable")
            return "Page rendering is unavailable: configure the pinned Playwright runtime and editor connection. The selected model may accept images, but no page PNG can be delivered. Do not blame the model or retry visual review until rendering is ready.";
        if (reason === "provider-unavailable")
            return "The selected model route is not ready. Connect this provider in DSH settings before visual review.";
        if (reason === "model-input-unsupported")
            return "DSH does not declare image input for this exact provider/model. Use deterministic render_page and review_pages checks, then compose and export. Do not call review_page or claim visual inspection.";
        return "No vision reviewer is configured, or page rasters cannot be produced. Do not claim a visual-review pass.";
    }
    if (mode === "main-model") {
        return "Main model accepts page rasters as image parts. render_page must emit a PNG. review_page is aesthetics-only.";
    }
    return "Vision reviewer is available as a tool.";
}
export function inspectCapabilities(envOrInput = process.env) {
    const input = resolveArgs(envOrInput);
    const env = input.env ?? process.env;
    const grokHosted = input.ready === true && input.providerId === GROK_PROVIDER_ID;
    const visionOff = env.SLIDESTUDIO_LLM_IMAGE === "0";
    const rasterReady = input.rasterReady ?? (editorConfigured(env) && rasterRuntimeReady(env));
    const via = grokHosted ? "pi-xai-hosted" : "env";
    const modelAcceptsImages = input.modelInputModalities?.includes("image") === true;
    const native = grokHosted ? false : input.nativeSearch === true;
    const research = grokHosted
        ? flag(true, "pi-xai-hosted")
        : native
            ? flag(true, "native")
            : flag(false, "env");
    const imageSearch = grokHosted
        ? flag(true, "pi-xai-hosted")
        : flag(Boolean(env.SLIDESTUDIO_IMAGE_SEARCH_URL?.trim()), "env");
    const imageGenerate = grokHosted
        ? flag(true, "pi-xai-hosted")
        : flag(!envLooksLikeGrokImagine(env) && imageConfigured(imageConfigFromEnv(env)), "env");
    let visionMode = "none";
    if (!visionOff) {
        if (input.ready && modelAcceptsImages && rasterReady)
            visionMode = "main-model";
        else if (!grokHosted && env.SLIDESTUDIO_VISION_REVIEWER?.trim())
            visionMode = "reviewer";
    }
    const unavailableReason = visionMode !== "none"
        ? undefined
        : visionOff ? "disabled"
            : !rasterReady ? "raster-unavailable"
                : !input.ready ? "provider-unavailable"
                    : "model-input-unsupported";
    return {
        research,
        imageSearch,
        imageGenerate,
        vision: { mode: visionMode, via, modelAcceptsImages, ...(unavailableReason ? { unavailableReason } : {}) },
        runtime: { kind: "dsh" },
        web: research.configured,
        render: rasterReady,
        exportPptx: true,
        note: visionNote(visionMode, unavailableReason),
    };
}
function normalizeModelInputModalities(value) {
    if (!Array.isArray(value))
        return undefined;
    const result = [];
    for (const item of value) {
        if ((item === "text" || item === "image") && !result.includes(item))
            result.push(item);
    }
    return result;
}
function readBindingProvider(projectRoot) {
    const file = path.join(projectRoot, BINDING_REL);
    try {
        if (!fs.existsSync(file))
            return undefined;
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed.provider || typeof parsed.provider !== "object")
            return undefined;
        return {
            providerId: parsed.provider.providerId,
            modelId: parsed.provider.modelId,
            ready: parsed.provider.ready === true,
            modelInputModalities: normalizeModelInputModalities(parsed.provider.modelInputModalities),
        };
    }
    catch {
        return undefined;
    }
}
export function inspectProjectCapabilities(projectRoot, env = process.env) {
    const provider = readBindingProvider(projectRoot);
    return inspectCapabilities({
        env,
        providerId: provider?.providerId,
        modelId: provider?.modelId,
        ready: provider?.ready === true,
        modelInputModalities: provider?.modelInputModalities,
    });
}
/**
 * Write the Hub session provider onto disk SSOT so inspect_capabilities,
 * domain-hands ports, and Hub chips stay one object. Missing binding files
 * are left alone; createAgent / presentation.open still mint them.
 */
export function persistPresentationRunProvider(projectRoot, provider) {
    const file = path.join(projectRoot, BINDING_REL);
    if (!fs.existsSync(file))
        return false;
    let rec;
    try {
        rec = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return false;
    }
    const current = rec.provider && typeof rec.provider === "object"
        ? rec.provider
        : undefined;
    const sameRoute = current?.providerId === provider.providerId && current?.modelId === provider.modelId;
    const next = {
        ...(sameRoute ? current : {}),
        providerId: provider.providerId,
        modelId: provider.modelId,
        ...(provider.ready === undefined ? {} : { ready: provider.ready }),
        ...(provider.modelInputModalities === undefined
            ? {}
            : { modelInputModalities: normalizeModelInputModalities(provider.modelInputModalities) }),
    };
    if (JSON.stringify(current) === JSON.stringify(next)) {
        return true;
    }
    rec.provider = next;
    // A provider/model change is a different brain: receipts earned by the old
    // route (chunk reads, rendered rasters, reviews) must stop counting. Mint a
    // fresh context epoch; same-route rewrites (restart, ready refresh) keep it.
    if (!sameRoute)
        rec.contextEpochId = `dsh-${crypto.randomUUID()}`;
    writeFileAtomic(file, `${JSON.stringify(rec, null, 2)}\n`);
    return true;
}
/** MiniMax text is not a visual review. Pass only if a vision path is actually on. */
export function visualReviewIsClaimable(envOrInput = process.env) {
    return inspectCapabilities(envOrInput).vision.mode !== "none";
}
export function hostedProduceToolNames(snapshot) {
    const names = [];
    if (snapshot.imageSearch.configured)
        names.push("search_image");
    if (snapshot.imageGenerate.configured)
        names.push("generate_image");
    return names;
}
//# sourceMappingURL=capabilities.js.map