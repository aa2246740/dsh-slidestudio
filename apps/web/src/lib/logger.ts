type Event = { event: string; requestId?: string; status?: number; elapsedMs?: number };
const events: Event[] = [];

export const logger = {
  record(event: Event): void {
    // Only allowlisted operational fields; never accept prompt/body/URL or identity.
    events.push({
      event: /^[a-z_]+$/.test(event.event) ? event.event : "unknown",
      ...(event.requestId && /^[A-Za-z0-9._-]{1,80}$/.test(event.requestId) ? { requestId: event.requestId } : {}),
      ...(Number.isFinite(event.status) ? { status: event.status } : {}),
      ...(Number.isFinite(event.elapsedMs) ? { elapsedMs: Math.max(0, event.elapsedMs!) } : {}),
    });
    if (events.length > 100) events.shift();
  },
  snapshot(): Event[] {
    return events.map((event) => ({ ...event }));
  },
};

const REQUEST_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOnce(input: string, init: RequestInit, id: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Request-ID", id);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const start = performance.now();
  try {
    const response = await fetch(input, { ...init, headers, signal });
    logger.record({
      event: "http_request",
      requestId: response.headers.get("X-Request-ID") ?? id,
      status: response.status,
      elapsedMs: performance.now() - start,
    });
    return response;
  } catch (error) {
    logger.record({ event: "request_failure", requestId: id, elapsedMs: performance.now() - start });
    throw error;
  }
}

/**
 * Fetch with request correlation, a per-attempt timeout, and bounded exponential
 * backoff for idempotent reads (GET/HEAD) on network failures or 502/503/504.
 */
export async function monitoredFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const id = crypto.randomUUID();
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const maxAttempts = idempotent ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchOnce(input, init, id);
      if (!idempotent || !RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts - 1) {
        return response;
      }
    } catch (error) {
      if (!idempotent || attempt === maxAttempts - 1 || init.signal?.aborted) throw error;
    }
    await sleep(250 * 2 ** attempt);
  }
  throw new Error("unreachable");
}
