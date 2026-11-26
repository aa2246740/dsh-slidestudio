import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_SLIDE_TOOL_NAMES,
  toolSchemasSnapshot,
  type SlideToolDefinition,
  type SlideToolResult,
} from "@open-slidestudio/slides-tools";
import { IMAGES_DISABLED_NOTE, toCallToolResult } from "./content.js";
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND } from "./jsonrpc.js";
import { MCP_ONLY_TOOL_NAMES } from "./mcp-tools.js";
import { createSlidesMcpServer, type SlidesMcpConfig } from "./server.js";
import { SessionClient, tempDir, toolData } from "./testkit.js";

process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = "/nonexistent/slides-mcp-test/runtime.mjs";

function client(extra: Partial<SlidesMcpConfig> = {}) {
  const server = createSlidesMcpServer({ dataRoot: tempDir("protocol"), ...extra });
  return new SessionClient(server.createSession());
}

test("initialize echoes a supported protocol version and falls back to 2025-03-26", async () => {
  for (const [requested, expected] of [
    ["2024-11-05", "2024-11-05"],
    ["2025-03-26", "2025-03-26"],
    ["1999-01-01", "2025-03-26"],
    [undefined, "2025-03-26"],
  ] as const) {
    const c = client();
    const reply = await c.request("initialize", {
      protocolVersion: requested,
      clientInfo: { name: "Probe", version: "2" },
    });
    const result = reply.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, expected);
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(result.serverInfo, { name: "open-slidestudio-slides-mcp", version: "0.1.0" });
    assert.match(String(result.instructions), /ask the user directly/);
    assert.equal(c.session.state.label, "Probe@2");
  }
});

test("notifications get no response, ping returns {}, bad messages map to JSON-RPC errors", async () => {
  const c = client();
  assert.deepEqual(await c.session.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), {});
  assert.equal(c.session.initialized, true);
  assert.deepEqual((await c.request("ping")).result, {});
  assert.equal((await c.request("resources/list")).error?.code, METHOD_NOT_FOUND);
  const invalid = await c.session.handle({ jsonrpc: "1.0", id: 9, method: "ping" });
  assert.equal((invalid.response as { error: { code: number } }).error.code, INVALID_REQUEST);
  assert.deepEqual(await c.session.handle({ jsonrpc: "2.0", id: 4, result: {} }), {}, "client responses are ignored");
  assert.equal((await c.request("tools/call", { name: "no_such_tool" })).error?.code, INVALID_PARAMS);
  assert.equal((await c.request("tools/call", { name: "open_project", arguments: [] })).error?.code, INVALID_PARAMS);
  assert.equal((await c.request("tools/list", [])).error?.code, INVALID_PARAMS);
});

test("tools/list exposes the 29 canonical tools unchanged plus the three MCP-only tools", async () => {
  const c = client();
  const tools = (await c.request("tools/list")).result?.tools as {
    name: string;
    inputSchema: unknown;
    description: string;
    annotations: { readOnlyHint: boolean };
  }[];
  assert.equal(CANONICAL_SLIDE_TOOL_NAMES.length, 29);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...CANONICAL_SLIDE_TOOL_NAMES, ...MCP_ONLY_TOOL_NAMES].sort(),
  );
  const snapshot = toolSchemasSnapshot();
  for (const tool of tools) {
    const canonical = snapshot[tool.name];
    if (!canonical) continue;
    assert.deepEqual(tool.inputSchema, canonical.inputSchema, `${tool.name} schema drifted`);
    assert.equal(tool.description, canonical.description);
    assert.equal(tool.annotations.readOnlyHint, canonical.readOnly);
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of MCP_ONLY_TOOL_NAMES) assert.equal(byName.get(name)?.annotations.readOnlyHint, false, name);
});

test("argument violations come back as a readable tool error before any binding is resolved", async () => {
  const c = client();
  const bad = await c.call("read_reference", { sourceId: 3, extra: true });
  assert.equal(bad.isError, true);
  const data = toolData(bad);
  assert.equal(data.error, "invalid_arguments");
  assert.ok((data.violations as string[]).some((v) => v.includes('"sourceId" must be a string')));
  assert.ok((data.violations as string[]).some((v) => v.includes('missing required property "chunkIndex"')));
  const unbound = await c.call("inspect_capabilities");
  assert.equal(unbound.isError, true);
  assert.equal(toolData(unbound).error, "project_not_bound");
});

function imageTool(render: SlideToolDefinition["render"] = "json"): SlideToolDefinition {
  return {
    name: "probe",
    description: "probe",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    render,
    execute: () => Promise.reject(new Error("unused")),
  };
}

function imageResult(onDelivered: () => void): SlideToolResult {
  return {
    data: { ok: true },
    content: [
      { type: "text", text: "caption" },
      { type: "image", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]), mediaType: "image/jpeg" },
    ],
    onContentDelivered: async () => onDelivered(),
  };
}

test("image blocks map to ImageContent; the delivery hook is deferred to the transport", async () => {
  let delivered = 0;
  const mapped = toCallToolResult(
    imageTool(),
    imageResult(() => (delivered += 1)),
    true,
  );
  const image = mapped.result.content.find((block) => block.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/png", "the sniffed bytes win over a wrong declared type");
  assert.deepEqual([...Buffer.from(image.data, "base64")], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  assert.equal(mapped.result.content[1]?.type === "text" && mapped.result.content[1].text, "caption");
  assert.equal(delivered, 0, "not delivered before the transport wrote the response");
  await mapped.afterDelivery?.();
  assert.equal(delivered, 1);
});

test("with images disabled the image is dropped with a note and the hook is never offered", () => {
  let delivered = 0;
  const mapped = toCallToolResult(
    imageTool(),
    imageResult(() => (delivered += 1)),
    false,
  );
  assert.equal(
    mapped.result.content.some((block) => block.type === "image"),
    false,
  );
  assert.ok(mapped.result.content.some((block) => block.type === "text" && block.text === IMAGES_DISABLED_NOTE));
  assert.equal(mapped.afterDelivery, undefined);
  assert.equal(delivered, 0);
});

test("text renderers and isError survive the mapping", () => {
  const mapped = toCallToolResult(
    imageTool((data) => `rendered:${String(data.ok)}`),
    { data: { ok: false }, isError: true },
    true,
  );
  assert.deepEqual(mapped.result, { content: [{ type: "text", text: "rendered:false" }], isError: true });
});

test("open_project creates an mcp-<id> project with an MCP provider binding and reopens it", async () => {
  const c = client({ clientLabel: "fixed-label", acceptsImages: false });
  await c.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "ignored" } });
  const opened = toolData(await c.call("open_project", { title: "季度复盘" }));
  assert.equal(opened.outcome, "created");
  assert.match(String(opened.projectId), /^mcp-[0-9a-f]{10}$/);
  assert.equal(opened.projectRoot, `output/dsh-slices/${String(opened.projectId)}`);
  const caps = toolData(await c.call("inspect_capabilities")).payload as {
    provider?: unknown;
    vision: { modelAcceptsImages: boolean };
  };
  assert.equal(caps.vision.modelAcceptsImages, false, "--no-images declares a text-only route");
  const again = toolData(await c.call("open_project", { title: "季度复盘" }));
  assert.equal(again.outcome, "reopened");
  assert.equal(again.projectId, opened.projectId);
});
