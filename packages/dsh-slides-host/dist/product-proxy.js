import http from "node:http";
import https from "node:https";
const DEFAULT_EDITOR_ORIGIN = "http://127.0.0.1:55200";
const UPSTREAM_TIMEOUT_MS = 30_000;
// Resolved lazily: plugin.ts assigns SLIDESTUDIO_EDITOR_URL from config at
// init time, which runs after this module is imported. A module-level const
// would pin whatever the env held at import time.
export function editorOrigin() {
    const configured = process.env.SLIDESTUDIO_EDITOR_URL?.trim() || DEFAULT_EDITOR_ORIGIN;
    const url = new URL(configured);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${url.hostname}:${port}`;
}
export function editorPort() {
    return Number(new URL(editorOrigin()).port || (new URL(editorOrigin()).protocol === "https:" ? 443 : 80));
}
const HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/**
 * The editor proxy runs before the host request guard, so it owns the
 * browser-to-host CSRF check: a mutation must come from this host's own origin
 * (same rule as the sidecar), and only then is it presented to the sidecar as
 * same-origin.
 */
function crossSiteMutation(req) {
    if (!MUTATING.has(req.method ?? "GET"))
        return false;
    const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none")
        return true;
    const origin = String(req.headers.origin ?? "").trim();
    if (!origin)
        return false;
    try {
        return new URL(origin).host !== String(req.headers.host ?? "");
    }
    catch {
        return true;
    }
}
export function shouldProxyToEditor(pathname) {
    if (pathname === "/api/generate" || pathname === "/api/generate-status")
        return false;
    if (pathname.startsWith("/api/pi/"))
        return false;
    if (pathname.startsWith("/slides"))
        return false;
    if (pathname.startsWith("/app/") || pathname === "/app")
        return true;
    if (pathname.startsWith("/api/"))
        return true;
    if (pathname.startsWith("/media/"))
        return true;
    if (pathname.startsWith("/runtime/"))
        return true;
    return false;
}
/** Product home. The Harness shell at `/` is not a page we keep. */
export const PRODUCT_HOME = "/app/hub.html";
function writeHomeRedirect(req, res) {
    res.writeHead(302, {
        location: PRODUCT_HOME,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
    });
    res.end();
}
/**
 * `/` is the Harness shell. Send people to the create hub instead.
 * A launch `?token=` is still exchanged by DSH (it answers 303 back to `/`);
 * the next request, with the cookie and no token, is the one we redirect.
 */
export function redirectRootToProductHome(req, res, authorizeIndex) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
        res.end();
        return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.has("token")) {
        authorizeIndex?.(req, res);
        if (!res.headersSent)
            writeHomeRedirect(req, res);
        return;
    }
    writeHomeRedirect(req, res);
}
export function editorPath(pathname) {
    if (pathname === "/app" || pathname === "/app/")
        return "/";
    if (pathname.startsWith("/app/"))
        return pathname.slice("/app".length);
    return pathname;
}
export function proxyToEditor(req, res, origin = editorOrigin()) {
    if (crossSiteMutation(req)) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "cross-site mutation rejected" }));
        return;
    }
    const target = new URL(origin);
    const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
    const targetPath = `${editorPath(incoming.pathname)}${incoming.search}`;
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (HOP.has(key.toLowerCase()))
            continue;
        headers[key] = value;
    }
    // The product host and sidecar must travel as a pair. The upstream stays
    // pinned to loopback even when the configured origin names another host so
    // this never becomes an open proxy; the port follows the config.
    headers.host = target.host || `127.0.0.1:${target.port}`;
    // The sidecar compares Origin with its own Host; the browser hop was checked above.
    if (headers.origin)
        headers.origin = target.origin;
    const transport = target.protocol === "https:" ? https : http;
    const proxy = transport.request({
        protocol: target.protocol,
        hostname: "127.0.0.1",
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: targetPath,
        method: req.method,
        headers,
    }, (upstream) => {
        const out = {};
        for (const [key, value] of Object.entries(upstream.headers)) {
            if (HOP.has(key.toLowerCase()))
                continue;
            out[key] = value;
        }
        res.writeHead(upstream.statusCode ?? 502, out);
        upstream.pipe(res);
    });
    // A hung upstream must not pin the client socket forever, and a client
    // disconnect must tear the upstream request down instead of leaking it.
    proxy.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        proxy.destroy(new Error("editor sidecar timeout"));
    });
    req.on("aborted", () => proxy.destroy());
    res.on("close", () => {
        if (!res.writableFinished)
            proxy.destroy();
    });
    proxy.on("error", () => {
        if (res.headersSent) {
            res.end();
            return;
        }
        const body = JSON.stringify({
            error: "editor sidecar unavailable",
            origin,
        });
        res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        res.end(body);
    });
    req.pipe(proxy);
}
//# sourceMappingURL=product-proxy.js.map