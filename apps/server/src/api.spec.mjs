import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { get } from "node:http";
import { createApiServer } from "./index.mjs";
import { createLogger } from "./logger.mjs";

describe("legacy HTTP integration and dynamic security checks", () => {
  let server;
  let origin;
  const loader = vi.fn(async () => ({
    hasLlmCredentials: () => false,
    resolveLlmCredentials: () => null,
  }));
  beforeAll(async () => {
    server = createApiServer({ agentLoader: loader, diagnostics: createLogger({ sink: () => {} }) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  it("returns health, request correlation and defensive headers", async () => {
    const response = await fetch(`${origin}/api/health`, {
      headers: { "X-Request-ID": "test-r1", Origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toBe("test-r1");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(await response.json()).toMatchObject({ ok: true, llm: false });
  });
  it("rejects hostile origins, simple-content-type mutations and invalid JSON", async () => {
    const count = loader.mock.calls.length;
    const cases = [
      [{ Origin: "https://attacker.test", "Content-Type": "application/json" }, "{}", 403],
      [{ "Content-Type": "text/plain" }, "{}", 415],
      [{ "Content-Type": "application/json" }, "{invalid", 400],
      [{ "Content-Type": "application/json" }, "[]", 400],
      [{ "Content-Type": "application/json" }, "{}", 400],
      [{ "Content-Type": "application/json" }, '{"pins":"not an array"}', 400],
    ];
    for (const [headers, body, status] of cases) {
      expect((await fetch(`${origin}/api/generate`, { method: "POST", headers, body })).status).toBe(status);
    }
    expect(loader.mock.calls.length).toBe(count);
  });
  it("supports bounded CORS preflight without wildcard credentials", async () => {
    const response = await fetch(`${origin}/api/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Request-ID");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(
      (await fetch(`${origin}/api/health`, { method: "OPTIONS", headers: { Origin: "https://attacker.test" } })).status,
    ).toBe(403);
    const hostStatus = await new Promise((resolve, reject) => {
      get(`${origin}/api/health`, { headers: { Host: "attacker.test" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(hostStatus).toBe(421);
  });
  it("exposes only bounded sanitized diagnostics and documents the API", async () => {
    const data = await (await fetch(`${origin}/api/diagnostics?prompt=private`)).json();
    expect(data.counters.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain("private");
    const schema = await (await fetch(`${origin}/api/openapi`)).json();
    expect(schema.openapi).toBe("3.1.0");
    expect(schema.paths["/api/generate"].post.requestBody).toBeTruthy();
    expect((await fetch(`${origin}/missing`)).status).toBe(404);
    expect(
      (
        await fetch(`${origin}/api/export-pptx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });
});

describe("API provider/export adapter seam", () => {
  let server;
  let origin;
  const input = [];
  let fail = false;
  const agent = {
    hasLlmCredentials: () => true,
    resolveLlmCredentials: () => ({ source: "test", model: "test-model" }),
    MockProvider: class {
      id = "mock";
      displayName = "Test provider";
    },
    resolveProvider: vi.fn(() => ({ id: "test", displayName: "Test provider" })),
    createAgentRun: (request) => {
      input.push(request);
      if (fail) throw new Error("private prompt user@example.test sk-secret-example");
      return {
        subscribe: (callback) => {
          callback({ type: "tool_started", stepId: "1", tool: "test", label: "Test" });
          callback({ type: "tool_completed", stepId: "1", summary: "done" });
          callback({ type: "tool_started", stepId: "2", tool: "test", label: "Test" });
          callback({ type: "tool_failed", stepId: "2", error: "synthetic failure" });
          callback({ type: "ignored", stepId: "missing" });
        },
        wait: async () => ({
          deck: { slides: [] },
          versionId: "v1",
          versionNumber: 1,
          versionLabel: "V1",
          summary: "done",
        }),
      };
    },
  };
  beforeAll(async () => {
    server = createApiServer({
      agentLoader: async () => agent,
      diagnostics: createLogger({ sink: () => {} }),
      exporterLoader: async () => ({
        exportDeckToArrayBuffer: async () => ({
          data: new Uint8Array([80, 75]),
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          filename: 'unsafe"\r\n.pptx',
          report: { nativeCoverage: 1, fullyNative: true },
        }),
      }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  function post(route, body) {
    return fetch(`${origin}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  it("preserves multi-model selection, scoped pin input and tool settlement", async () => {
    const result = await (
      await post("/api/generate", { prompt: "public fixture", modelId: "mock", pins: [{ id: "pin" }] })
    ).json();
    expect(result.provider).toBe("mock");
    expect(result.steps.map((step) => step.status)).toEqual(["completed", "failed"]);
    expect(input.at(-1).pins).toEqual([{ id: "pin" }]);
    await post("/api/generate", { prompt: "", pins: [{ id: "pin" }], modelId: "test-model" });
    expect(agent.resolveProvider).toHaveBeenCalledWith({ modelId: "test-model" });
    expect(input.at(-1).prompt).toContain("annotation");
    await post("/api/generate", { references: [{}] });
    expect(input.at(-1).prompt).toBe("Create slides from references");
    expect(agent.resolveProvider).toHaveBeenLastCalledWith({ modelId: undefined });
    expect(await (await fetch(`${origin}/api/health`)).json()).toMatchObject({ llm: true, model: "test-model" });
  });
  it("exports bytes with safe filenames and an editability report", async () => {
    const response = await post("/api/export-pptx", { deck: { slides: [] } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="unsafe___.pptx"');
    expect(response.headers.get("X-Export-Report")).toBeTruthy();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([80, 75]));
  });
  it("never returns provider error messages or private data in diagnostics", async () => {
    fail = true;
    try {
      const response = await post("/api/generate", { prompt: "public fixture" });
      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toBe("internal server error");
      expect(error.requestId).toBeTruthy();
      const snapshot = await (await fetch(`${origin}/api/diagnostics`)).text();
      expect(snapshot).not.toContain("private prompt");
      expect(snapshot).not.toContain("user@example.test");
    } finally {
      fail = false;
    }
  });
});

describe("real offline legacy adapters", () => {
  let server;
  let origin;
  beforeAll(async () => {
    server = createApiServer({ diagnostics: createLogger({ sink: () => {} }) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  it("loads compiled legacy packages, generates an explicit mock and exports real editable bytes", async () => {
    const response = await fetch(`${origin}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "A public synthetic project status report", modelId: "mock-offline" }),
    });
    expect(response.status).toBe(200);
    const generated = await response.json();
    expect(generated.deck.slides.length).toBeGreaterThan(0);
    const exported = await fetch(`${origin}/api/export-pptx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck: generated.deck }),
    });
    expect(exported.status).toBe(200);
    const bytes = new Uint8Array(await exported.arrayBuffer());
    expect([...bytes.slice(0, 2)]).toEqual([80, 75]);
    expect(bytes.byteLength).toBeGreaterThan(500);
  });
});
