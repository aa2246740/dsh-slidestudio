import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { get, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { apply as apply$1 } from "@open-slidestudio/dsh-slides-host";
// ../scripts/lib/observability.mjs
const PRIVATE_KEYS = /(?:authorization|cookie|token|secret|password|api.?key|prompt|brief|text|content|attachment|email|phone|path|project|session)/i;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;
function scrub(value, depth = 0) {
	if (depth > 4) return "[truncated]";
	if (value instanceof Error) return {
		name: value.name,
		message: scrub(value.message, depth + 1)
	};
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrub(item, depth + 1));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, PRIVATE_KEYS.test(key) ? "[redacted]" : scrub(item, depth + 1)]));
	if (typeof value !== "string") return value;
	return value.slice(0, 500).replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/\b(?:sk-|xai-|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]").replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"',;]+/gi, "[personal-path]").replace(/\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, "[phone]");
}
function requestId(value) {
	return typeof value === "string" && REQUEST_ID.test(value) ? value : randomUUID();
}
function routeLabel(raw) {
	const pathname = String(raw ?? "/").split("?")[0].replace(/^\/slides\/sessions\/[^/]+/, "/slides/sessions/id");
	if (/^\/(?:api|slides)\/[a-z0-9/-]+$/i.test(pathname) && pathname.length < 100) return pathname;
	return "/static";
}
/** Local-only, bounded diagnostics. No user identity, body, query or outbound transport. */
function createObservability({ app, version = "development", sink = (line) => console.log(line), clock = () => performance.now() }) {
	const counters = /* @__PURE__ */ new Map();
	const errors = [];
	const recent = [];
	const startedAt = (/* @__PURE__ */ new Date()).toISOString();
	function log(level, event, fields = {}) {
		const record = {
			at: (/* @__PURE__ */ new Date()).toISOString(),
			app,
			version,
			level,
			event,
			...scrub(fields)
		};
		recent.push(record);
		if (recent.length > 100) recent.shift();
		sink(JSON.stringify(record));
	}
	function observe(req, res) {
		const id = requestId(req.headers["x-request-id"]);
		const route = routeLabel(req.url);
		const start = clock();
		req.headers["x-request-id"] = id;
		res.setHeader("X-Request-ID", id);
		res.once("finish", () => {
			const elapsedMs = Math.max(0, clock() - start);
			const status = Math.floor(res.statusCode / 100) * 100;
			const key = `${req.method ?? "GET"} ${route} ${status}`;
			if (!counters.has(key) && counters.size >= 100) return;
			const metric = counters.get(key) ?? {
				method: req.method ?? "GET",
				route,
				status,
				count: 0,
				totalMs: 0,
				maxMs: 0
			};
			metric.count += 1;
			metric.totalMs += elapsedMs;
			metric.maxMs = Math.max(metric.maxMs, elapsedMs);
			counters.set(key, metric);
			log(status >= 500 ? "error" : "info", "http_request", {
				requestId: id,
				method: metric.method,
				route,
				status: res.statusCode,
				elapsedMs
			});
		});
		return {
			requestId: id,
			route
		};
	}
	function error(cause, context = {}) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		const safe = {
			name: error.name,
			code: typeof error.code === "string" && /^[A-Z_0-9]{1,40}$/.test(error.code) ? error.code : "UNCLASSIFIED"
		};
		const fingerprint = createHash("sha256").update(`${error.name}:${error.message}`).digest("hex").slice(0, 16);
		const record = {
			at: (/* @__PURE__ */ new Date()).toISOString(),
			fingerprint,
			...scrub(context),
			error: safe
		};
		errors.push(record);
		if (errors.length > 30) errors.shift();
		log("error", "runtime_error", record);
		return fingerprint;
	}
	function snapshot() {
		return {
			app,
			version,
			startedAt,
			counters: [...counters.values()].map((value) => ({ ...value })),
			errors: structuredClone(errors),
			recent: structuredClone(recent)
		};
	}
	function wrap(handler, authorize = () => true) {
		return async (req, res) => {
			observe(req, res);
			if (req.method === "GET" && req.url?.split("?")[0] === "/api/diagnostics" && authorize(req)) {
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff"
				});
				return res.end(JSON.stringify(snapshot()));
			}
			return handler(req, res);
		};
	}
	return {
		log,
		observe,
		error,
		snapshot,
		wrap
	};
}
// lib/types/logger.js
const logger = createObservability({
	app: "slidestudio-plugin",
	version: "0.2.9"
});
// lib/types/editor-sidecar.js
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
/** Lazily spawns the editor sidecar on its own loopback port. */
function startEditorSidecar(repoRoot, dataRoot, port) {
	const server = join(repoRoot, "apps/native-web/src/server.mjs");
	if (!existsSync(server)) {
		logger.log("warn", "editor_sidecar_missing");
		return;
	}
	const child = spawn(process.execPath, [server], {
		cwd: repoRoot,
		env: {
			...process.env,
			PORT: String(port),
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
		logger.error(error, { operation: "editor_sidecar_start" });
	});
	child.on("exit", (code, signal) => {
		logger.log("warn", "editor_sidecar_exit", {
			code,
			signal
		});
	});
	return child;
}
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
// lib/types/data-directory.js
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
// lib/types/sidecar-ready.js
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
		if (Date.now() < deadline) await setTimeout$1(Math.min(100, deadline - Date.now()));
	} while (Date.now() < deadline);
	return false;
}
// lib/types/slides-preset.js
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
// lib/types/dsh-slidestudio.js
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
const SIDECAR_RESTART_COOLDOWN_MS = 2e3;
const SIDECAR_KILL_GRACE_MS = 200;
/** `killed` only means a signal was delivered. A child that ignores SIGTERM is still alive. */
function processAlive(proc) {
	return proc != null && proc.exitCode == null && proc.signalCode == null;
}
function defaultSleep(ms, signal) {
	if (signal?.aborted || ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** Restart the editor after an unexpected exit instead of latching the first failure. */
function createEditorSupervisor(options) {
	const cooldownMs = options.cooldownMs ?? SIDECAR_RESTART_COOLDOWN_MS;
	const killGraceMs = options.killGraceMs ?? SIDECAR_KILL_GRACE_MS;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? defaultSleep;
	const start = options.start ?? startEditorSidecar;
	const wait = options.wait ?? ((origin) => waitForEditor(origin));
	let child;
	let port = options.port;
	let origin = `http://127.0.0.1:${port}`;
	let pending;
	let cooldownUntil = 0;
	let ticket = 0;
	let launching;
	let disposed = false;
	let cooldownAbort;
	const owned = /* @__PURE__ */ new Set();
	const reaping = /* @__PURE__ */ new Map();
	const resetPort = () => {
		port = options.port;
		origin = `http://127.0.0.1:${port}`;
	};
	const armCooldown = () => {
		cooldownUntil = now() + cooldownMs;
	};
	const releaseCurrent = (proc) => {
		if (child === proc) child = void 0;
		pending = void 0;
		resetPort();
		armCooldown();
	};
	const exitedWithin = (proc, ms) => new Promise((resolve) => {
		if (!processAlive(proc)) {
			resolve(true);
			return;
		}
		const timer = setTimeout(() => {
			proc.off("exit", onExit);
			resolve(!processAlive(proc));
		}, ms);
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		proc.once("exit", onExit);
	});
	const reap = (proc) => {
		if (!proc) return Promise.resolve();
		const existing = reaping.get(proc);
		if (existing) return existing;
		const job = (async () => {
			if (!processAlive(proc)) return;
			try {
				proc.kill("SIGTERM");
			} catch {}
			if (processAlive(proc) && !await exitedWithin(proc, killGraceMs)) {
				if (processAlive(proc)) try {
					proc.kill("SIGKILL");
				} catch {}
				await exitedWithin(proc, killGraceMs);
			}
		})().finally(() => {
			reaping.delete(proc);
			owned.delete(proc);
			if (child === proc) child = void 0;
		});
		reaping.set(proc, job);
		return job;
	};
	const launch = () => {
		if (disposed) return Promise.resolve(false);
		resetPort();
		const spawned = start(options.repoRoot, options.dataRoot, port);
		if (disposed) {
			if (spawned) {
				owned.add(spawned);
				reap(spawned);
			}
			return Promise.resolve(false);
		}
		if (!spawned) {
			armCooldown();
			pending = void 0;
			return Promise.resolve(false);
		}
		child = spawned;
		owned.add(spawned);
		const mine = ++ticket;
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			resolveLaunch(ok);
		};
		let resolveLaunch = () => {};
		const result = new Promise((resolve) => {
			resolveLaunch = resolve;
		});
		spawned.on("exit", () => {
			owned.delete(spawned);
			if (!disposed && mine === ticket) releaseCurrent(spawned);
			finish(false);
		});
		wait(origin).then(async (ok) => {
			if (settled) return;
			if (disposed || mine !== ticket) {
				finish(false);
				if (processAlive(spawned)) await reap(spawned);
				return;
			}
			if (ok) {
				finish(true);
				return;
			}
			ticket += 1;
			releaseCurrent(spawned);
			await reap(spawned);
			finish(false);
		});
		pending = result;
		return result;
	};
	return {
		origin: () => origin,
		ensure() {
			if (disposed) return Promise.resolve(false);
			if (processAlive(child) && pending) return pending;
			if (launching) return launching;
			const epoch = ticket;
			const controller = new AbortController();
			cooldownAbort = controller;
			launching = (async () => {
				const delay = cooldownUntil - now();
				if (delay > 0) await sleep(delay, controller.signal);
				if (disposed || epoch !== ticket || controller.signal.aborted) return false;
				if (processAlive(child) && pending) return pending;
				return launch();
			})().finally(() => {
				if (cooldownAbort === controller) cooldownAbort = void 0;
				launching = void 0;
			});
			return launching;
		},
		stop() {
			disposed = true;
			ticket += 1;
			cooldownAbort?.abort();
			cooldownAbort = void 0;
			const procs = new Set(owned);
			if (child) procs.add(child);
			for (const proc of reaping.keys()) procs.add(proc);
			child = void 0;
			pending = void 0;
			resetPort();
			return Promise.all([...procs].map((proc) => reap(proc))).then(() => void 0);
		}
	};
}
function editorUnavailable(res) {
	res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
	res.end("SlideStudio editor is restarting. Retry this request.");
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
	const supervisor = createEditorSupervisor({
		repoRoot,
		dataRoot,
		port: EDITOR_PORT
	});
	ctx.effect(() => () => {
		supervisor.stop();
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
				logger.observe(req, res);
				const rejection = connection?.requestRejection?.(req);
				if (rejection !== void 0) {
					res.writeHead(rejection);
					res.end("Access denied");
					return;
				}
				if (!await supervisor.ensure()) {
					editorUnavailable(res);
					return;
				}
				if (req.destroyed || res.destroyed) return;
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				req.url = `${prefix === "/app" ? url.pathname.slice(prefix.length) || "/" : url.pathname}${url.search}`;
				proxyToSidecar(req, res, supervisor.origin());
			}
		}));
		stops.push(ctx.webServer.register({
			kind: "exact",
			path: "/personal/slides/editor",
			handler: async (req, res) => {
				logger.observe(req, res);
				const rejection = connection?.requestRejection?.(req);
				if (rejection !== void 0) {
					res.writeHead(rejection);
					res.end("Access denied");
					return;
				}
				if (!await supervisor.ensure()) {
					editorUnavailable(res);
					return;
				}
				const project = new URL(req.url ?? "/personal/slides/editor", "http://127.0.0.1").searchParams.get("project") ?? "";
				const target = new URL("/index.html", supervisor.origin());
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
	logger.log("info", "plugin_loaded");
}
export { apply, createEditorSupervisor, inject, name };
