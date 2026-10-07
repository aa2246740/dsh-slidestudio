/**
 * Pluggable image search. No vendor hardcode.
 * `generic` preset: POST { query } → { images: [{ url | b64_json, width,
 * height, attribution }] }. Named presets cover mainstream stock/photo
 * APIs (Pixabay, Pexels, Unsplash, Bing); `template` maps any sync JSON
 * API via {{query}} interpolation + a dotted response path.
 */
import { buildTemplateRequest, jsonPath, templateVars, } from "./endpoint-template.js";
export const IMAGE_SEARCH_PRESETS = [
    "generic",
    "pixabay",
    "pexels",
    "unsplash",
    "bing",
    "template",
];
function templateFromEnv(raw) {
    const text = raw?.trim();
    if (!text)
        return undefined;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
export function imageSearchConfigFromEnv(env = process.env) {
    return {
        url: env.SLIDESTUDIO_IMAGE_SEARCH_URL?.trim() || undefined,
        apiKey: env.SLIDESTUDIO_IMAGE_SEARCH_KEY?.trim() || undefined,
        preset: env.SLIDESTUDIO_IMAGE_SEARCH_PRESET?.trim() || undefined,
        template: templateFromEnv(env.SLIDESTUDIO_IMAGE_SEARCH_TEMPLATE),
        timeoutMs: Number(env.SLIDESTUDIO_IMAGE_SEARCH_TIMEOUT_MS) || 20_000,
    };
}
export function imageSearchConfigured(cfg = imageSearchConfigFromEnv()) {
    if (!cfg.url)
        return false;
    // Named stock-photo presets authenticate with an API key; generic and
    // template endpoints may be keyless (intranet or key-in-URL).
    const needsKey = ["pixabay", "pexels", "unsplash", "bing"].includes(cfg.preset ?? "");
    return !needsKey || Boolean(cfg.apiKey?.trim());
}
function mimeFromBytes(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
    if (bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP") {
        return "image/webp";
    }
    return "image/png";
}
function firstImage(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const o = raw;
    const list = Array.isArray(o.images)
        ? o.images
        : Array.isArray(o.data)
            ? o.data
            : [];
    const first = list[0];
    if (!first || typeof first !== "object")
        return undefined;
    const img = first;
    const b64 = typeof img.b64_json === "string"
        ? img.b64_json
        : typeof img.b64 === "string"
            ? img.b64
            : undefined;
    const url = typeof img.url === "string" ? img.url : undefined;
    const width = typeof img.width === "number" ? img.width : undefined;
    const height = typeof img.height === "number" ? img.height : undefined;
    const attribution = typeof img.attribution === "string"
        ? img.attribution
        : typeof img.source === "string"
            ? img.source
            : undefined;
    if (!b64 && !url)
        return undefined;
    return { b64, url, width, height, attribution };
}
function rec(parsed, path) {
    const v = jsonPath(parsed, path);
    return v && typeof v === "object" && !Array.isArray(v)
        ? v
        : undefined;
}
function str(v) {
    return typeof v === "string" && v ? v : undefined;
}
function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
/** Append a path+query onto a user-entered base, skipping a path the base already ends with. */
function urlWithQuery(base, path, params) {
    const trimmed = base.replace(/\/+$/, "");
    const root = trimmed.endsWith(path) || /\/api\/?$/i.test(trimmed) && path.startsWith("/api/")
        ? trimmed
        : `${trimmed}${path}`;
    const qs = new URLSearchParams(params).toString();
    return `${root}${root.includes("?") ? "&" : "?"}${qs}`;
}
function searchRequest(cfg, preset, q) {
    const key = cfg.apiKey?.trim() ?? "";
    const base = cfg.url.replace(/\/+$/, "");
    switch (preset) {
        case "pixabay":
            return {
                url: urlWithQuery(base, "/api", {
                    key,
                    q: q.slice(0, 100),
                    image_type: "photo",
                    lang: "zh",
                    per_page: "8",
                    safesearch: "true",
                }),
                headers: {},
            };
        case "pexels":
            return {
                url: urlWithQuery(base, "/v1/search", { query: q.slice(0, 200), per_page: "8" }),
                headers: { Authorization: key },
            };
        case "unsplash":
            return {
                url: urlWithQuery(base, "/search/photos", {
                    query: q.slice(0, 200),
                    per_page: "8",
                    client_id: key,
                }),
                headers: {},
            };
        case "bing":
            return {
                url: urlWithQuery(base, "/v7.0/images/search", {
                    q: q.slice(0, 200),
                    count: "8",
                    safeSearch: "Strict",
                }),
                headers: { "Ocp-Apim-Subscription-Key": key },
            };
        case "template": {
            const tmpl = cfg.template ?? {};
            const vars = templateVars({ query: q.slice(0, 400), q: q.slice(0, 400), key, apikey: key, lang: "zh" });
            const req = buildTemplateRequest({ ...tmpl, url: tmpl.url || cfg.url }, vars);
            return {
                url: req.url,
                headers: req.init.headers ?? {},
                body: typeof req.init.body === "string" ? req.init.body : undefined,
            };
        }
        default:
            return {
                url: base,
                headers: {
                    "Content-Type": "application/json",
                    ...(key ? { Authorization: `Bearer ${key}` } : {}),
                },
                body: JSON.stringify({ query: q.slice(0, 400) }),
            };
    }
}
function searchCandidate(parsed, preset, tmpl) {
    switch (preset) {
        case "pixabay": {
            const hit = rec(parsed, "hits.0");
            if (!hit)
                return undefined;
            const url = str(hit.largeImageURL) ?? str(hit.webformatURL);
            if (!url)
                return undefined;
            const user = str(hit.user);
            return {
                url,
                width: num(hit.imageWidth) ?? num(hit.webformatWidth),
                height: num(hit.imageHeight) ?? num(hit.webformatHeight),
                attribution: `Pixabay${user ? ` · ${user}` : ""}`,
            };
        }
        case "pexels": {
            const hit = rec(parsed, "photos.0");
            if (!hit)
                return undefined;
            const url = str(rec(hit, "src")?.large2x) ?? str(rec(hit, "src")?.large) ?? str(rec(hit, "src")?.original);
            if (!url)
                return undefined;
            const photographer = str(hit.photographer);
            return {
                url,
                width: num(hit.width),
                height: num(hit.height),
                attribution: `Pexels${photographer ? ` · ${photographer}` : ""}`,
            };
        }
        case "unsplash": {
            const hit = rec(parsed, "results.0");
            if (!hit)
                return undefined;
            const url = str(rec(hit, "urls")?.regular) ?? str(rec(hit, "urls")?.full);
            if (!url)
                return undefined;
            const user = str(rec(hit, "user")?.name);
            return {
                url,
                width: num(hit.width),
                height: num(hit.height),
                attribution: `Unsplash${user ? ` · ${user}` : ""}`,
            };
        }
        case "bing": {
            const hit = rec(parsed, "value.0");
            const url = str(hit?.contentUrl);
            if (!url)
                return undefined;
            let host = "";
            try {
                host = new URL(str(hit?.hostPageUrl) ?? "").hostname;
            }
            catch {
                host = "";
            }
            return {
                url,
                width: num(hit?.width),
                height: num(hit?.height),
                attribution: `Bing Images${host ? ` · ${host}` : ""}`,
            };
        }
        case "template": {
            const path = tmpl?.imagePath;
            if (!path)
                return undefined;
            const raw = str(jsonPath(parsed, path));
            if (!raw)
                return undefined;
            return /^https?:\/\//i.test(raw)
                ? { url: raw, attribution: tmpl?.attribution }
                : { b64: raw, attribution: tmpl?.attribution };
        }
        default:
            return firstImage(parsed);
    }
}
export function createImageSearchPort(cfg = imageSearchConfigFromEnv(), deps = {}) {
    return {
        async search(query) {
            const q = query.trim();
            if (!q) {
                return { kind: "none", note: "search query empty" };
            }
            if (!cfg.url) {
                return {
                    kind: "none",
                    note: "no image search URL — design without a bitmap, or use generate if that port is on",
                };
            }
            const preset = IMAGE_SEARCH_PRESETS.includes(cfg.preset ?? "")
                ? cfg.preset
                : "generic";
            const fetchFn = deps.fetch ?? fetch;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 20_000);
            try {
                const req = searchRequest(cfg, preset, q);
                const res = await fetchFn(req.url, {
                    method: req.body ? "POST" : "GET",
                    signal: ctrl.signal,
                    headers: req.headers,
                    ...(req.body ? { body: req.body } : {}),
                });
                const body = await res.text();
                if (!res.ok) {
                    return { kind: "none", note: `image search HTTP ${res.status}` };
                }
                let parsed;
                try {
                    parsed = JSON.parse(body);
                }
                catch {
                    return { kind: "none", note: "image search returned non-JSON" };
                }
                const hit = searchCandidate(parsed, preset, cfg.template);
                if (!hit) {
                    return { kind: "none", note: "image search returned no images" };
                }
                let bytes;
                if (hit.b64) {
                    bytes = Buffer.from(hit.b64, "base64");
                }
                else if (hit.url) {
                    const imgRes = await fetchFn(hit.url, { signal: ctrl.signal });
                    if (!imgRes.ok) {
                        return { kind: "none", note: `image download HTTP ${imgRes.status}` };
                    }
                    bytes = Buffer.from(await imgRes.arrayBuffer());
                }
                else {
                    return { kind: "none", note: "image search hit had no bytes" };
                }
                if (bytes.length < 64) {
                    return { kind: "none", note: "image search returned empty bytes" };
                }
                return {
                    bytes,
                    mime: mimeFromBytes(bytes),
                    width: hit.width,
                    height: hit.height,
                    attribution: hit.attribution,
                    note: hit.attribution
                        ? `search hit — ${hit.attribution}`
                        : "search hit from configured image search port",
                };
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return { kind: "none", note: `image search failed: ${msg.slice(0, 180)}` };
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
//# sourceMappingURL=image-search-port.js.map