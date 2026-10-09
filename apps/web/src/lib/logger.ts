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

export async function monitoredFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const id = crypto.randomUUID();
  const headers = new Headers(init.headers);
  headers.set("X-Request-ID", id);
  const start = performance.now();
  try {
    const response = await fetch(input, { ...init, headers });
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
