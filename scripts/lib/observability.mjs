import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const PRIVATE_KEYS =
  /(?:authorization|cookie|token|secret|password|api.?key|prompt|brief|text|content|attachment|email|phone|path|project|session)/i;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;

export function scrub(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (value instanceof Error) return { name: value.name, message: scrub(value.message, depth + 1) };
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrub(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [key, PRIVATE_KEYS.test(key) ? "[redacted]" : scrub(item, depth + 1)]),
    );
  }
  if (typeof value !== "string") return value;
  return value
    .slice(0, 500)
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-|xai-|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"',;]+/gi, "[personal-path]")
    .replace(/\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, "[phone]");
}

export function requestId(value) {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : randomUUID();
}

export function routeLabel(raw) {
  const pathname = String(raw ?? "/")
    .split("?")[0]
    .replace(/^\/slides\/sessions\/[^/]+/, "/slides/sessions/id");
  if (/^\/(?:api|slides)\/[a-z0-9/-]+$/i.test(pathname) && pathname.length < 100) return pathname;
  return "/static";
}

/** Local-only, bounded diagnostics. No user identity, body, query or outbound transport. */
export function createObservability({
  app,
  version = "development",
  sink = (line) => console.log(line),
  clock = () => performance.now(),
}) {
  const counters = new Map();
  const errors = [];
  const recent = [];
  const startedAt = new Date().toISOString();
  function log(level, event, fields = {}) {
    const record = { at: new Date().toISOString(), app, version, level, event, ...scrub(fields) };
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
        maxMs: 0,
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
        elapsedMs,
      });
    });
    return { requestId: id, route };
  }
  function error(cause, context = {}) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // Provider error messages can contain arbitrary user text. Fingerprint them,
    // but retain only categorical metadata rather than the message or stack.
    const safe = {
      name: error.name,
      code: typeof error.code === "string" && /^[A-Z_0-9]{1,40}$/.test(error.code) ? error.code : "UNCLASSIFIED",
    };
    const fingerprint = createHash("sha256").update(`${error.name}:${error.message}`).digest("hex").slice(0, 16);
    const record = { at: new Date().toISOString(), fingerprint, ...scrub(context), error: safe };
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
      recent: structuredClone(recent),
    };
  }
  function wrap(handler, authorize = () => true) {
    return async (req, res) => {
      observe(req, res);
      if (req.method === "GET" && req.url?.split("?")[0] === "/api/diagnostics" && authorize(req)) {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(JSON.stringify(snapshot()));
      }
      return handler(req, res);
    };
  }
  return { log, observe, error, snapshot, wrap };
}
