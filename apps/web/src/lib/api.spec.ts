import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHealth, generateDeckRemote } from "./api";
import { logger, monitoredFetch } from "./logger";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("legacy web API interface", () => {
  it("reads health and correlates requests without retaining response bodies", async () => {
    const fetcher = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, llm: false }), { headers: { "X-Request-ID": "web-r1" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchHealth()).toMatchObject({ ok: true, llm: false });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Request-ID")).toBeTruthy();
    expect(logger.snapshot().at(-1)).toMatchObject({ requestId: "web-r1", status: 200 });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    await expect(fetchHealth()).rejects.toThrow("health 503");
  });
  it("keeps generation input intact and reports provider failure without fallback", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Response(init.body as string));
    vi.stubGlobal("fetch", fetcher);
    const input = {
      prompt: "public fixture",
      modelId: "chosen-model",
      pins: [{ id: "p1", slideId: "s1", x: 1, y: 2, text: "public pin" }],
    };
    expect(await generateDeckRemote(input)).toMatchObject(input);
    vi.stubGlobal("fetch", async () => new Response('{"error":"synthetic unavailable"}', { status: 503 }));
    await expect(generateDeckRemote(input)).rejects.toThrow("synthetic unavailable");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 502 }));
    await expect(generateDeckRemote(input)).rejects.toThrow("generate failed (502)");
    expect(JSON.stringify(logger.snapshot())).not.toContain("public fixture");
  });
  it("tracks network errors and bounds local operational events", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("private network message");
    });
    await expect(monitoredFetch("/api/health")).rejects.toThrow("private network message");
    for (let i = 0; i < 120; i++) logger.record({ event: "http_request" });
    logger.record({ event: "bad event", requestId: "bad id", status: NaN, elapsedMs: -1 });
    expect(logger.snapshot()).toHaveLength(100);
    expect(logger.snapshot().at(-1)).toEqual({ event: "unknown", elapsedMs: 0 });
    const snapshot = logger.snapshot();
    snapshot.length = 0;
    expect(logger.snapshot()).toHaveLength(100);
  });
});
