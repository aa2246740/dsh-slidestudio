import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveDataDirectory } from "./data-directory.js";
import { waitForEditor } from "./sidecar-ready.js";
import { apply as applySlidesHost } from "@open-slidestudio/dsh-slides-host";
import { request as httpRequest } from "node:http";
import { logger } from "./logger.js";
/** Cross-package Context shape; cordis is shared at runtime, types differ. */
const applySlidesHostAny = applySlidesHost;
export const name = "dsh-slidestudio";
// slides-host services are injected through this wrapper so activation ordering
// keeps `webServer`/`agents`/`llm` ready before the slice API mounts.
export const inject = [
    "webServer",
    "connection",
    "tools",
    "agents",
    "attachments",
    "llm",
];
const EDITOR_PORT = Number(process.env.SLIDES_EDITOR_PORT ?? "56200");
/** The slide preset's director persona, kept verbatim with the standalone bundle. */
const SLIDES_PERSONA_PREFIX = [
    "You are the DSH SlideStudio slides director. Working directory is {{cwd}}.",
    "Write user-facing progress and explanations in the language of the user brief.",
    "Treat clear user instructions as authorization; do not ask for a second confirmation for a whole-deck edit or a reversible styling change.",
    "When a missing preference materially affects the result, use ask_user_question with concise options or free text. Wait for its native answer and continue the same task. Never invent an answer or repeat a cancelled question.",
    "Use only the product PPT tools and ask_user_question. Never write YAML except through write_page.",
    "Pass every tool's declared fields directly at the top level; never wrap them in an arguments object.",
    "write_page elements use elementId, elementType, bounds [x,y,w,h], and content.text.",
    "Put fontSize, fontFamily, color, and align directly on content; content.style is",
    "only a string theme reference such as $title, never an object. Put layoutRole on the element.",
    "Charts are data.cols + data.rows and series[].type/encode.",
    "After adopt, every write_page color MUST be official #RRGGBB or a",
    "Theme.colors $token that already resolves to that pack PART B",
    "【Color Palette】 hex. Prefer pack hexes. Host does not fill",
    "Theme.colors; empty-create $primary is #2563EB and is not a pack",
    "color. Never host navy #06223F. Never 澄光 memory chrome (#FDC356) on",
    "another pack. Never omit shape fill expecting a default; omitted",
    "fill is no paint and must not become white. Set an explicit pack fill.",
    "Copy the adopted pack's official PART A/B craft: body titles are",
    "assertion-sentence conclusions with a one-line scope subtitle; body",
    "pages carry a chapter breadcrumb; source/footnote bottom-left and",
    "page number bottom-right. Host will not paint YAML or Theme.colors.",
    "Use inspect_capabilities and the tools actually supplied for this session.",
    "Provider-hosted search or image tools are available only when explicitly supplied; do not infer them from a model name.",
    "search_image and generate_image remain product tools that write media/ for PPTD.",
    "If imageSearch or imageGenerate is on, BATCH search_image and generate_image for every photo-led page into media/ with unique ids BEFORE write_page. Do not stop after the cover image. Mark photo-led pages with the photo exhibit in write_todo; a photo page whose media image is missing or reused is refused. Do not reuse one src as another page's full-bleed.",
    "Splitting a section into more pages is fine: update write_todo with the new pageIds before writing them; a page not in the todo is refused.",
].join("\n");
/**
 * Registers the `slides` agent preset programmatically through the public
 * `agentPresets` service — the same definition the standalone bundle declares
 * in cordis.patch.yml, but scoped to this plugin so it never alters the
 * profile's default preset or other features.
 */
function registerSlidesPreset(ctx) {
    const presets = ctx.get("agentPresets");
    if (!presets?.register) {
        logger.log("warn", "agent_preset_unavailable");
        return;
    }
    ctx.effect(() => presets.register({
        id: "slides",
        name: "DSH SlideStudio slides",
        description: "Product PPT tools only. No bash, filesystem, or editor tools.",
        order: 10,
        plugins: [
            {
                id: "persona",
                name: "@deepseek-ai/dsh-persona",
                config: {
                    prefix: SLIDES_PERSONA_PREFIX,
                    complete: true,
                    includeRuntimeContext: false,
                },
            },
            {
                id: "slides-ask-user",
                name: "@deepseek-ai/dsh-tool-ask-user",
            },
        ],
    }));
}
/** Lazily spawns the editor sidecar on its own loopback port. */
function startEditorSidecar(repoRoot, dataRoot) {
    const server = join(repoRoot, "apps/native-web/src/server.mjs");
    if (!existsSync(server)) {
        logger.log("warn", "editor_sidecar_missing");
        return undefined;
    }
    const child = spawn(process.execPath, [server], {
        cwd: repoRoot,
        env: { ...process.env, PORT: String(EDITOR_PORT), OPEN_SLIDESTUDIO_ROOT: repoRoot, SLIDESTUDIO_DATA_DIR: dataRoot },
        stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", (error) => {
        logger.error(error, { operation: "editor_sidecar_start" });
    });
    child.on("exit", (code, signal) => {
        logger.log("warn", "editor_sidecar_exit", { code, signal });
    });
    return child;
}
const HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
]);
/** Pipes one request to the editor sidecar; mirrors the standalone shell's product proxy. */
function proxyToSidecar(req, res, editorOrigin) {
    const upstream = new URL(req.url ?? "/", editorOrigin);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        const lowered = key.toLowerCase();
        if (HOP_HEADERS.has(lowered) || value === undefined)
            continue;
        headers[lowered] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    headers.host = upstream.host;
    // The sidecar rejects cross-site mutations when Origin disagrees with Host;
    // the host's own guard already covers the browser-to-host hop, so present the
    // request to the sidecar as same-origin.
    headers.origin = upstream.origin;
    const proxy = httpRequest({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: `${upstream.pathname}${upstream.search}`,
        headers,
    }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
    });
    proxy.setTimeout(30_000, () => proxy.destroy(new Error("editor sidecar timeout")));
    req.on("aborted", () => proxy.destroy());
    proxy.on("error", () => {
        if (!res.headersSent)
            res.writeHead(502);
        res.end("editor sidecar unreachable");
    });
    req.pipe(proxy);
}
export function apply(ctx) {
    // Packaged install: <pkg>/lib/dsh-slidestudio.js ships apps/, packages/,
    // vendor/ inside the package root. Dev checkout: <plugin>/lib/… is one level
    // below the repo root, so fall back to the parent directory.
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const checkoutRoot = fileURLToPath(new URL("../..", import.meta.url));
    const repoRoot = resolve(existsSync(join(packageRoot, "apps/native-web/src/server.mjs"))
        ? packageRoot
        : checkoutRoot);
    const editorOrigin = `http://127.0.0.1:${EDITOR_PORT}`;
    const home = ctx.get("profileContext")?.home
        || process.env.DSH_HOME || join(homedir(), ".dsh");
    const dataRoot = resolveDataDirectory(repoRoot, home, process.env.SLIDESTUDIO_DATA_DIR);
    registerSlidesPreset(ctx);
    applySlidesHostAny(ctx, {
        workspaceRoot: repoRoot,
        dataRoot,
        editorBaseUrl: editorOrigin,
        personal: true,
    });
    const sidecar = startEditorSidecar(repoRoot, dataRoot);
    const editorReady = sidecar ? waitForEditor(editorOrigin) : Promise.resolve(false);
    ctx.effect(() => () => {
        if (sidecar && !sidecar.killed)
            sidecar.kill("SIGTERM");
    });
    ctx.effect(() => {
        const connection = ctx.get("connection");
        const stops = [];
        // The real create hub and editor live on the sidecar; expose them under the
        // same-origin /app, /media, /runtime prefixes the product shell uses, so the
        // Personal feature can frame hub.html without cross-origin CSP issues.
        for (const prefix of ["/app", "/media", "/runtime"]) {
            stops.push(ctx.webServer.register({
                kind: "prefix",
                path: prefix,
                handler: async (req, res) => {
                    logger.observe(req, res);
                    const rejection = connection?.requestRejection?.(req);
                    if (rejection !== undefined) {
                        res.writeHead(rejection);
                        res.end("Access denied");
                        return;
                    }
                    if (!await editorReady) {
                        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
                        res.end("SlideStudio editor could not start. Disable and enable the plugin to retry.");
                        return;
                    }
                    if (req.destroyed || res.destroyed)
                        return;
                    const url = new URL(req.url ?? "/", "http://127.0.0.1");
                    // /app is the product-shell prefix the sidecar does not know; strip
                    // it. /media and /runtime are real sidecar routes — forward intact.
                    const rest = prefix === "/app" ? url.pathname.slice(prefix.length) || "/" : url.pathname;
                    req.url = `${rest}${url.search}`;
                    proxyToSidecar(req, res, editorOrigin);
                },
            }));
        }
        stops.push(ctx.webServer.register({
            kind: "exact",
            path: "/personal/slides/editor",
            handler: (req, res) => {
                logger.observe(req, res);
                const rejection = connection?.requestRejection?.(req);
                if (rejection !== undefined) {
                    res.writeHead(rejection);
                    res.end("Access denied");
                    return;
                }
                const url = new URL(req.url ?? "/personal/slides/editor", "http://127.0.0.1");
                const project = url.searchParams.get("project") ?? "";
                const target = new URL("/index.html", editorOrigin);
                target.searchParams.set("workspace", "1");
                if (project)
                    target.searchParams.set("project", project);
                res.writeHead(302, { location: target.href });
                res.end();
            },
        }));
        return () => {
            for (const stop of stops)
                stop();
        };
    });
    logger.log("info", "plugin_loaded");
}
//# sourceMappingURL=dsh-slidestudio.js.map