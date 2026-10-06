import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { get, request } from "node:http";
import { setTimeout } from "node:timers/promises";
import { apply as apply$1 } from "@open-slidestudio/dsh-slides-host";
//#region lib/types/data-directory.js
/** Persist the workspace outside the versioned package. A linked checkout keeps
* its existing projects in place; later registry installs reuse that location.
*/
function resolveDataDirectory(productRoot, home, override) {
	const stateRoot = join(home, "data", "dsh-slidestudio");
	const pointer = join(stateRoot, "workspace.json");
	let root = override?.trim() || void 0;
	if (root && !isAbsolute(root)) throw new Error("SLIDESTUDIO_DATA_DIR must be an absolute path");
	if (!root && existsSync(pointer)) {
		const saved = JSON.parse(readFileSync(pointer, "utf8"));
		if (typeof saved.root !== "string" || !isAbsolute(saved.root)) throw new Error(`Invalid SlideStudio workspace: ${pointer}`);
		root = saved.root;
		if (!existsSync(root)) throw new Error(`SlideStudio workspace is missing: ${root}. Restore it or set SLIDESTUDIO_DATA_DIR.`);
	}
	root ??= existsSync(join(productRoot, "output", "dsh-slices")) ? productRoot : join(stateRoot, "workspace");
	root = resolve(root);
	mkdirSync(root, { recursive: true });
	mkdirSync(stateRoot, { recursive: true });
	writeFileSync(pointer, `${JSON.stringify({
		version: 1,
		root
	}, null, 2)}\n`, { mode: 384 });
	return root;
}
//#endregion
//#region lib/types/sidecar-ready.js
/** Hold the first iframe request until the freshly spawned editor is listening. */
async function waitForEditor(origin, timeoutMs = 15e3) {
	const deadline = Date.now() + timeoutMs;
	do {
		if (await new Promise((resolve) => {
			const request = get(`${origin}/api/health`, (response) => {
				response.resume();
				resolve(response.statusCode === 200);
			});
			request.setTimeout(Math.max(1, Math.min(500, deadline - Date.now())), () => request.destroy());
			request.on("error", () => resolve(false));
		})) return true;
		if (Date.now() < deadline) await setTimeout(Math.min(100, deadline - Date.now()));
	} while (Date.now() < deadline);
	return false;
}
//#endregion
//#region lib/types/dsh-slidestudio.js
/** Cross-package Context shape; cordis is shared at runtime, types differ. */
const applySlidesHostAny = apply$1;
const name = "dsh-slidestudio";
const inject = [
	"webServer",
	"connection",
	"tools",
	"agents",
	"attachments",
	"llm"
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
	"Splitting a section into more pages is fine: update write_todo with the new pageIds before writing them; a page not in the todo is refused."
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
		console.warn("[dsh-slidestudio] agentPresets service missing; slides agents will run without the preset");
		return;
	}
	ctx.effect(() => presets.register({
		id: "slides",
		name: "DSH SlideStudio slides",
		description: "Product PPT tools only. No bash, filesystem, or editor tools.",
		order: 10,
		plugins: [{
			id: "persona",
			name: "@deepseek-ai/dsh-persona",
			config: {
				prefix: SLIDES_PERSONA_PREFIX,
				complete: true,
				includeRuntimeContext: false
			}
		}, {
			id: "slides-ask-user",
			name: "@deepseek-ai/dsh-tool-ask-user"
		}]
	}));
}
/** Lazily spawns the editor sidecar on its own loopback port. */
function startEditorSidecar(repoRoot, dataRoot) {
	const server = join(repoRoot, "apps/native-web/src/server.mjs");
	if (!existsSync(server)) {
		console.warn(`[dsh-slidestudio] editor sidecar not found at ${server}`);
		return;
	}
	const child = spawn(process.execPath, [server], {
		cwd: repoRoot,
		env: {
			...process.env,
			PORT: String(EDITOR_PORT),
			OPEN_SLIDESTUDIO_ROOT: repoRoot,
			SLIDESTUDIO_DATA_DIR: dataRoot
		},
		stdio: [
			"ignore",
			"ignore",
			"inherit"
		]
	});
	child.on("error", (error) => {
		console.warn("[dsh-slidestudio] editor sidecar failed to start", error);
	});
	child.on("exit", (code, signal) => {
		console.warn(`[dsh-slidestudio] editor sidecar exited code=${String(code)} signal=${String(signal)}`);
	});
	return child;
}
const HOP_HEADERS = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade"
]);
/** Pipes one request to the editor sidecar; mirrors the standalone shell's product proxy. */
function proxyToSidecar(req, res, editorOrigin) {
	const upstream = new URL(req.url ?? "/", editorOrigin);
	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) {
		const lowered = key.toLowerCase();
		if (HOP_HEADERS.has(lowered) || value === void 0) continue;
		headers[lowered] = Array.isArray(value) ? value.join(", ") : String(value);
	}
	headers.host = upstream.host;
	headers.origin = upstream.origin;
	const proxy = request({
		protocol: upstream.protocol,
		hostname: upstream.hostname,
		port: upstream.port,
		method: req.method,
		path: `${upstream.pathname}${upstream.search}`,
		headers
	}, (up) => {
		res.writeHead(up.statusCode ?? 502, up.headers);
		up.pipe(res);
	});
	proxy.setTimeout(3e4, () => proxy.destroy(/* @__PURE__ */ new Error("editor sidecar timeout")));
	req.on("aborted", () => proxy.destroy());
	proxy.on("error", () => {
		if (!res.headersSent) res.writeHead(502);
		res.end("editor sidecar unreachable");
	});
	req.pipe(proxy);
}
function apply(ctx) {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const checkoutRoot = fileURLToPath(new URL("../..", import.meta.url));
	const repoRoot = resolve(existsSync(join(packageRoot, "apps/native-web/src/server.mjs")) ? packageRoot : checkoutRoot);
	const editorOrigin = `http://127.0.0.1:${EDITOR_PORT}`;
	const dataRoot = resolveDataDirectory(repoRoot, ctx.get("profileContext")?.home || process.env.DSH_HOME || join(homedir(), ".dsh"), process.env.SLIDESTUDIO_DATA_DIR);
	registerSlidesPreset(ctx);
	applySlidesHostAny(ctx, {
		workspaceRoot: repoRoot,
		dataRoot,
		editorBaseUrl: editorOrigin,
		personal: true
	});
	const sidecar = startEditorSidecar(repoRoot, dataRoot);
	const editorReady = sidecar ? waitForEditor(editorOrigin) : Promise.resolve(false);
	ctx.effect(() => () => {
		if (sidecar && !sidecar.killed) sidecar.kill("SIGTERM");
	});
	ctx.effect(() => {
		const connection = ctx.get("connection");
		const stops = [];
		for (const prefix of [
			"/app",
			"/media",
			"/runtime"
		]) stops.push(ctx.webServer.register({
			kind: "prefix",
			path: prefix,
			handler: async (req, res) => {
				const rejection = connection?.requestRejection?.(req);
				if (rejection !== void 0) {
					res.writeHead(rejection);
					res.end("Access denied");
					return;
				}
				if (!await editorReady) {
					res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
					res.end("SlideStudio editor could not start. Disable and enable the plugin to retry.");
					return;
				}
				if (req.destroyed || res.destroyed) return;
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				req.url = `${prefix === "/app" ? url.pathname.slice(prefix.length) || "/" : url.pathname}${url.search}`;
				proxyToSidecar(req, res, editorOrigin);
			}
		}));
		stops.push(ctx.webServer.register({
			kind: "exact",
			path: "/personal/slides/editor",
			handler: (req, res) => {
				const rejection = connection?.requestRejection?.(req);
				if (rejection !== void 0) {
					res.writeHead(rejection);
					res.end("Access denied");
					return;
				}
				const project = new URL(req.url ?? "/personal/slides/editor", "http://127.0.0.1").searchParams.get("project") ?? "";
				const target = new URL("/index.html", editorOrigin);
				target.searchParams.set("workspace", "1");
				if (project) target.searchParams.set("project", project);
				res.writeHead(302, { location: target.href });
				res.end();
			}
		}));
		return () => {
			for (const stop of stops) stop();
		};
	});
	console.log("[my-plugins/dsh-slidestudio] loaded");
}
//#endregion
export { apply, inject, name };
