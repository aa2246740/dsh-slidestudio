const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** Only categorical operational events are retained, in memory, on this browser. */
export function createBrowserLogger({ app, sink = () => {}, now = () => performance.now() }) {
  const events = [];
  const counters = new Map();
  function record(event, { requestId, status, elapsedMs, outcome } = {}) {
    const item = {
      app,
      event: SAFE_ID.test(event) ? event : "unknown",
      ...(typeof requestId === "string" && SAFE_ID.test(requestId) ? { requestId } : {}),
      ...(Number.isFinite(status) ? { status } : {}),
      ...(Number.isFinite(elapsedMs) ? { elapsedMs: Math.max(0, elapsedMs) } : {}),
      ...(["success", "failure", "cancelled"].includes(outcome) ? { outcome } : {}),
    };
    events.push(item);
    if (events.length > 100) events.shift();
    counters.set(item.event, (counters.get(item.event) ?? 0) + 1);
    sink(JSON.stringify(item));
  }
  async function request(fetcher, input, init = {}) {
    const started = now();
    const id = globalThis.crypto.randomUUID();
    const headers = new Headers(init.headers);
    headers.set("X-Request-ID", id);
    try {
      const response = await fetcher(input, { ...init, headers });
      record("http_request", {
        requestId: response.headers.get("X-Request-ID") ?? id,
        status: response.status,
        elapsedMs: now() - started,
        outcome: response.ok ? "success" : "failure",
      });
      return response;
    } catch (error) {
      record("http_request", { requestId: id, elapsedMs: now() - started, outcome: "failure" });
      throw error;
    }
  }
  return {
    record,
    request,
    snapshot: () => ({ app, events: structuredClone(events), counters: Object.fromEntries(counters) }),
  };
}

export function installBrowserDiagnostics(target = window) {
  if (target.slideStudioDiagnostics) return target.slideStudioDiagnostics;
  const logger = createBrowserLogger({ app: "native-editor" });
  const original = target.fetch.bind(target);
  target.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof Request ? input.url : input.href,
      target.location.href,
    );
    // Preserve arbitrary Request objects and external image/provider requests.
    if (
      input instanceof Request ||
      url.origin !== target.location.origin ||
      !/^\/(?:api|slides)\//.test(url.pathname)
    ) {
      return original(input, init);
    }
    return logger.request(original, input, init);
  };
  target.addEventListener("error", () => logger.record("browser_error", { outcome: "failure" }));
  target.addEventListener("unhandledrejection", () => logger.record("unhandled_rejection", { outcome: "failure" }));
  target.slideStudioDiagnostics = logger;
  return logger;
}
