/**
 * Pluggable image generate. No public-web scrape.
 * Intranet/local OpenAI-compatible /v1/images/generations, or xAI grok-imagine.
 * When generate is on, fail closed — never write a fake placeholder PNG.
 */
import { placeholderSize } from "./placeholder-png.js";
import { XAI_API_BASE } from "./grok-hosted.js";
export const GROK_IMAGINE_MODEL = "grok-imagine-image-2.0";
export function imageConfigFromEnv(env = process.env) {
    const disabled = env.SLIDESTUDIO_IMAGE === "0";
    const explicit = env.SLIDESTUDIO_IMAGE_BASE_URL?.trim();
    const llmBase = env.SLIDESTUDIO_LLM_BASE_URL?.trim();
    const optIn = env.SLIDESTUDIO_IMAGE === "1";
    const raw = explicit || (optIn ? llmBase : "");
    const baseUrl = raw ? raw.replace(/\/+$/, "") : "";
    return {
        baseUrl: baseUrl || undefined,
        apiKey: env.SLIDESTUDIO_IMAGE_API_KEY || env.SLIDESTUDIO_LLM_API_KEY,
        model: env.SLIDESTUDIO_IMAGE_MODEL?.trim() || undefined,
        timeoutMs: Number(env.SLIDESTUDIO_IMAGE_TIMEOUT_MS) || 180_000,
        enabled: !disabled && Boolean(baseUrl),
    };
}
/** Signed-in Grok: always the xAI imagine endpoint. Missing token fails at generate. */
export function grokImageConfigFromEnv(env = process.env) {
    return {
        enabled: true,
        baseUrl: env.SLIDESTUDIO_IMAGE_BASE_URL?.trim() || XAI_API_BASE,
        apiKey: env.SLIDESTUDIO_IMAGE_API_KEY?.trim() || undefined,
        model: env.SLIDESTUDIO_IMAGE_MODEL?.trim() || GROK_IMAGINE_MODEL,
        timeoutMs: Number(env.SLIDESTUDIO_IMAGE_TIMEOUT_MS) || 180_000,
    };
}
export function imageConfigured(cfg = imageConfigFromEnv()) {
    return Boolean(cfg.enabled && cfg.baseUrl && cfg.apiKey);
}
function imagesUrl(baseUrl) {
    if (/\/images\/generations\/?$/.test(baseUrl))
        return baseUrl;
    if (/\/openai\/v1\/?$/.test(baseUrl))
        return `${baseUrl}/images/generations`;
    if (/\/v1\/?$/.test(baseUrl))
        return `${baseUrl}/images/generations`;
    if (/generativelanguage\.googleapis\.com/i.test(baseUrl)) {
        return `${baseUrl.replace(/\/+$/, "")}/openai/images/generations`;
    }
    return `${baseUrl}/v1/images/generations`;
}
function isXaiImagine(cfg) {
    const model = cfg.model ?? "";
    const base = cfg.baseUrl ?? "";
    return model.includes("grok-imagine") || /api\.x\.ai/i.test(base);
}
const SLOT_ASPECTS = [
    { id: "1:1", ratio: 1 },
    { id: "4:3", ratio: 4 / 3 },
    { id: "3:4", ratio: 3 / 4 },
    { id: "16:9", ratio: 16 / 9 },
    { id: "9:16", ratio: 9 / 16 },
];
/** Map a planned photo frame to the nearest API aspect. 258×344 → 3:4, not 16:9. */
export function aspectFromSlot(width, height) {
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
        throw new Error("photo slot width and height must be positive");
    }
    const r = width / height;
    let bestId = "16:9";
    let best = Infinity;
    for (const slot of SLOT_ASPECTS) {
        const dist = Math.abs(Math.log(r / slot.ratio));
        if (dist < best) {
            best = dist;
            bestId = slot.id;
        }
    }
    return bestId;
}
function aspectRatio(aspect) {
    const raw = (aspect || "16:9").trim();
    if (raw === "square")
        return "1:1";
    if (raw === "portrait")
        return "3:4";
    if (raw === "widescreen")
        return "16:9";
    return raw;
}
function sizeForAspect(aspect) {
    const ratio = aspectRatio(aspect);
    if (ratio === "1:1")
        return "1024x1024";
    if (ratio === "3:4" || ratio === "9:16")
        return "1024x1536";
    if (ratio === "4:3")
        return "1024x768";
    return "1536x1024";
}
export function pngSizeFromBytes(bytes) {
    if (bytes.length < 24)
        return undefined;
    if (bytes.toString("ascii", 1, 4) !== "PNG")
        return undefined;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!(width > 0) || !(height > 0))
        return undefined;
    return { width, height };
}
function requestBody(cfg, prompt, aspect) {
    const model = cfg.model || (isXaiImagine(cfg) ? GROK_IMAGINE_MODEL : "image");
    if (isXaiImagine(cfg)) {
        return {
            model,
            prompt: prompt.slice(0, 800),
            n: 1,
            aspect_ratio: aspectRatio(aspect),
            response_format: "b64_json",
        };
    }
    return {
        model,
        prompt: prompt.slice(0, 800),
        size: sizeForAspect(aspect),
        n: 1,
        response_format: "b64_json",
    };
}
async function bytesFromApiPayload(parsed, fetchFn, signal) {
    const rec = parsed && typeof parsed === "object" ? parsed : {};
    const data = Array.isArray(rec.data) ? rec.data : [];
    const first = data[0] && typeof data[0] === "object" ? data[0] : undefined;
    const b64 = typeof first?.b64_json === "string" ? first.b64_json : undefined;
    if (b64) {
        const bytes = Buffer.from(b64, "base64");
        if (bytes.length < 64)
            throw new Error("image API returned empty bytes");
        return { bytes, mime: "image/png" };
    }
    const url = typeof first?.url === "string" ? first.url.trim() : "";
    if (!url)
        throw new Error("image API returned no b64_json or url");
    const res = await fetchFn(url, { signal });
    if (!res.ok)
        throw new Error(`image URL HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 64)
        throw new Error("image URL returned empty bytes");
    const mime = /jpe?g/i.test(res.headers.get("content-type") ?? "") || /\.jpe?g(\?|$)/i.test(url)
        ? "image/jpeg"
        : "image/png";
    return { bytes, mime };
}
async function generateViaApi(cfg, prompt, aspect, deps) {
    if (!cfg.apiKey?.trim()) {
        throw new Error("image generate has no API key — refusing to write a placeholder PNG");
    }
    const fetchFn = deps.fetch ?? fetch;
    const url = imagesUrl(cfg.baseUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 180_000);
    try {
        const res = await fetchFn(url, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.apiKey.trim()}`,
            },
            body: JSON.stringify(requestBody(cfg, prompt, aspect)),
        });
        const body = await res.text();
        if (!res.ok) {
            throw new Error(`image HTTP ${res.status}: ${body.slice(0, 180)}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            throw new Error("image API returned non-JSON");
        }
        const { bytes, mime } = await bytesFromApiPayload(parsed, fetchFn, ctrl.signal);
        const measured = pngSizeFromBytes(bytes);
        const ph = placeholderSize(aspect);
        return {
            bytes,
            mime,
            width: measured?.width ?? ph.width,
            height: measured?.height ?? ph.height,
            kind: "generated",
            note: "generated — write_page bounds must use this aspect; do not stretch or cover-crop a mismatched frame",
        };
    }
    finally {
        clearTimeout(timer);
    }
}
export function createImagePort(cfg = imageConfigFromEnv(), deps = {}) {
    return {
        async generate(prompt, aspect) {
            if (!(cfg.enabled && cfg.baseUrl)) {
                throw new Error("image generate is not configured — refusing to write a placeholder PNG");
            }
            return generateViaApi(cfg, prompt, aspect, deps);
        },
    };
}
//# sourceMappingURL=image-port.js.map