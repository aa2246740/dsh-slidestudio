import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createObservability, requestId, routeLabel, scrub } from "../../../scripts/lib/observability.mjs";
import { createBrowserLogger, installBrowserDiagnostics } from "../public/logger.js";

describe("local diagnostics privacy and correlation", () => {
  it("redacts secrets, identity, private paths and nested content", () => {
    expect(
      scrub({
        prompt: "private",
        nested: { apiKey: "secret", result: "Bearer abcdef user@example.test /Users/person/private.pptd 13812345678" },
      }),
    ).toEqual({
      prompt: "[redacted]",
      nested: { apiKey: "[redacted]", result: "Bearer [redacted] [email] [personal-path] [phone]" },
    });
    expect(scrub(new Error("sk-abcdefghijk"))).toEqual({ name: "Error", message: "[redacted]" });
    expect(scrub({ a: { b: { c: { d: { e: "private" } } } } })).toEqual({
      a: { b: { c: { d: { e: "[truncated]" } } } },
    });
    expect(scrub([1, "safe"])).toEqual([1, "safe"]);
  });
  it("keeps errors categorical and bounded even when provider text contains a prompt", () => {
    const lines = [];
    const logger = createObservability({ app: "test", sink: (line) => lines.push(line) });
    for (let i = 0; i < 120; i++)
      logger.error(new Error("private document body"), { requestId: "r1", email: "user@example.test" });
    const snapshot = logger.snapshot();
    expect(snapshot.errors).toHaveLength(30);
    expect(snapshot.recent).toHaveLength(100);
    expect(JSON.stringify(snapshot)).not.toContain("private document body");
    expect(lines.join("")).not.toContain("user@example.test");
    snapshot.errors.length = 0;
    expect(logger.snapshot().errors).toHaveLength(30);
    expect(logger.error("unknown")).toHaveLength(16);
  });
  it("validates request IDs and excludes query and session identity from labels", () => {
    expect(requestId("r_1")).toBe("r_1");
    expect(requestId("bad\r\nvalue")).toMatch(/^[a-f0-9-]{36}$/);
    expect(routeLabel("/slides/sessions/private-session/turn?prompt=private")).toBe("/slides/sessions/id/turn");
    expect(routeLabel("/media/private.png")).toBe("/static");
    expect(routeLabel()).toBe("/static");
  });
  it("collects request counters without response bodies and bounds label cardinality", () => {
    let time = 5;
    const logger = createObservability({ app: "test", sink: () => {}, clock: () => time });
    const req = { headers: {}, method: "GET", url: "/api/health?email=private" };
    const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), statusCode: 200 });
    const context = logger.observe(req, response);
    time = 15;
    response.emit("finish");
    expect(req.headers["x-request-id"]).toBe(context.requestId);
    expect(logger.snapshot().counters[0]).toMatchObject({ count: 1, totalMs: 10, maxMs: 10 });
    for (let i = 0; i < 110; i++) {
      const res = Object.assign(new EventEmitter(), { setHeader() {}, statusCode: 500 });
      logger.observe({ headers: {}, url: `/api/route-${i}` }, res);
      res.emit("finish");
    }
    expect(logger.snapshot().counters).toHaveLength(100);
  });
});

describe("browser diagnostics", () => {
  it("records categorical HTTP success and failure without bodies or URLs", async () => {
    const logger = createBrowserLogger({ app: "test", sink: () => {}, now: () => 10 });
    const fetcher = vi.fn(async () => new Response("private body", { headers: { "X-Request-ID": "server-id" } }));
    await logger.request(fetcher, "/api/health?prompt=private");
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Request-ID")).toBeTruthy();
    expect(logger.snapshot().events[0]).toMatchObject({ requestId: "server-id", outcome: "success" });
    await logger.request(async () => new Response("", { status: 500 }), "/api/fail");
    await expect(
      logger.request(async () => {
        throw new Error("private");
      }, "/api/fail"),
    ).rejects.toThrow("private");
    for (let i = 0; i < 110; i++) logger.record("http_request", { status: 200 });
    logger.record("bad event", {
      requestId: "bad id",
      status: NaN,
      elapsedMs: -5,
      outcome: "unknown",
      prompt: "private",
    });
    expect(logger.snapshot().events).toHaveLength(100);
    expect(logger.snapshot().events.at(-1)).toEqual({ app: "test", event: "unknown", elapsedMs: 0 });
    expect(JSON.stringify(logger.snapshot())).not.toContain("private");
  });
  it("instruments only same-origin API fetches and installs once", async () => {
    const listeners = {};
    const target = {
      location: { href: "http://127.0.0.1:1234/hub.html", origin: "http://127.0.0.1:1234" },
      fetch: vi.fn(async () => new Response("{}")),
      addEventListener: (name, handler) => {
        listeners[name] = handler;
      },
    };
    const logger = installBrowserDiagnostics(target);
    expect(installBrowserDiagnostics(target)).toBe(logger);
    await target.fetch("/api/health");
    await target.fetch(new URL("http://127.0.0.1:1234/slides/health"));
    await target.fetch("https://example.test/image");
    await target.fetch(new Request("http://127.0.0.1:1234/api/health"));
    listeners.error();
    listeners.unhandledrejection();
    expect(logger.snapshot().events).toHaveLength(4);
  });
});

describe("diagnostics HTTP adapter", () => {
  let server;
  let origin;
  beforeAll(async () => {
    const logger = createObservability({ app: "test", sink: () => {} });
    server = createServer(
      logger.wrap(
        (_req, res) => {
          res.writeHead(404);
          res.end();
        },
        (req) => req.headers["x-deny"] !== "1",
      ),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  it("serves local counters only when the application's guard allows it", async () => {
    expect((await fetch(`${origin}/api/diagnostics`)).status).toBe(200);
    expect((await fetch(`${origin}/api/diagnostics`, { headers: { "x-deny": "1" } })).status).toBe(404);
    expect((await fetch(`${origin}/missing`)).status).toBe(404);
    const body = await (await fetch(`${origin}/api/diagnostics`)).json();
    expect(body.app).toBe("test");
  });
});
