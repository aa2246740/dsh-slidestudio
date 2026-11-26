import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readProjectLease, type SlideToolDefinition } from "@open-slidestudio/slides-tools";
import { createSlidesMcpServer, type SlidesMcpConfig } from "./server.js";
import { createHttpTransport, MAX_HTTP_BODY_BYTES, type HttpTransportOptions } from "./transport-http.js";
import { INIT_PARAMS, pngBytes, rawRequest, rpcBody, tempDir, toolData, waitFor, type ToolResult } from "./testkit.js";

process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = "/nonexistent/slides-mcp-test/runtime.mjs";

type Harness = Awaited<ReturnType<typeof start>>;

/** A probe tool returning one PNG block whose delivery hook counts calls. */
function probeTool(counter: { delivered: number }): SlideToolDefinition {
  return {
    name: "probe_image",
    description: "test probe",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    requiresProject: false,
    render: "json",
    async execute() {
      return {
        data: { ok: true },
        content: [{ type: "image", data: new Uint8Array(pngBytes(2, 2)), mediaType: "image/png" }],
        onContentDelivered: async () => {
          counter.delivered += 1;
        },
      };
    },
  };
}

async function start(config: Partial<SlidesMcpConfig> = {}, options: HttpTransportOptions = {}) {
  const counter = { delivered: 0 };
  const dataRoot = tempDir("http-data");
  const server = createSlidesMcpServer({
    dataRoot,
    editorBaseUrl: "http://127.0.0.1:9",
    extraTools: () => [probeTool(counter)],
    log: () => undefined,
    ...config,
  });
  const transport = createHttpTransport(server, options);
  await transport.listen();
  const url = transport.url();
  const headers = (session?: string, extra: Record<string, string> = {}) => ({
    ...(session ? { "mcp-session-id": session } : {}),
    ...(options.authToken ? { authorization: `Bearer ${options.authToken}` } : {}),
    ...extra,
  });
  const initialize = async () => {
    const res = await rawRequest(url, { headers: headers(), body: rpcBody(1, "initialize", INIT_PARAMS) });
    assert.equal(res.status, 200, res.body);
    return String(res.headers["mcp-session-id"]);
  };
  let id = 10;
  const call = async (session: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const res = await rawRequest(url, {
      headers: headers(session),
      body: rpcBody(id++, "tools/call", { name, arguments: args }),
    });
    assert.equal(res.status, 200, res.body);
    return (JSON.parse(res.body) as { result: ToolResult }).result;
  };
  return { server, transport, url, counter, dataRoot, headers, initialize, call };
}

async function stop(harness: Harness) {
  await harness.transport.close();
}

test("http: initialize issues Mcp-Session-Id; later requests need a live id; notifications get 202", async () => {
  const h = await start();
  try {
    const session = await h.initialize();
    assert.match(session, /^[0-9a-f-]{36}$/);
    const note = await rawRequest(h.url, {
      headers: h.headers(session),
      body: rpcBody(undefined, "notifications/initialized"),
    });
    assert.equal(note.status, 202);
    assert.equal(note.body, "");
    const missing = await rawRequest(h.url, { headers: h.headers(), body: rpcBody(2, "ping") });
    assert.equal(missing.status, 400);
    const unknown = await rawRequest(h.url, { headers: h.headers("nope"), body: rpcBody(2, "ping") });
    assert.equal(unknown.status, 404);
    const ping = await rawRequest(h.url, { headers: h.headers(session), body: rpcBody(2, "ping") });
    assert.deepEqual(JSON.parse(ping.body), { jsonrpc: "2.0", id: 2, result: {} });
    const batch = await rawRequest(h.url, {
      headers: h.headers(session),
      body: `[${rpcBody(3, "ping")},${rpcBody(undefined, "notifications/initialized")},${rpcBody(4, "ping")}]`,
    });
    assert.deepEqual(
      (JSON.parse(batch.body) as { id: number }[]).map((row) => row.id),
      [3, 4],
    );
    assert.equal((await rawRequest(h.url, { headers: h.headers(session), body: "{" })).status, 400);
    assert.equal((await rawRequest(h.url, { method: "GET", headers: h.headers(session) })).status, 405);
    assert.equal((await rawRequest(`${h.url}/other`, { headers: h.headers(session), body: "{}" })).status, 404);
  } finally {
    await stop(h);
  }
});

test("http: ImageContent is base64 and the delivery hook runs only after the response was sent", async () => {
  const h = await start();
  try {
    const session = await h.initialize();
    const result = await h.call(session, "probe_image");
    const image = result.content.find((block) => block.type === "image");
    assert.equal(image?.mimeType, "image/png");
    assert.deepEqual(Buffer.from(String(image?.data), "base64"), pngBytes(2, 2));
    await waitFor(() => h.counter.delivered === 1);
    await h.call(session, "open_project", { title: "图片" });
    const inputs = tempDir("http-inputs");
    fs.writeFileSync(path.join(inputs, "pic.png"), pngBytes(3, 3));
    const binding = h.server.session(session)?.state.binding;
    assert.ok(binding);
    assert.equal((await h.call(session, "import_material", { path: path.join(inputs, "pic.png") })).isError, true);
  } finally {
    await stop(h);
  }
});

test("http --no-images: images are omitted with a note, the hook never runs, the route is text-only", async () => {
  const h = await start({ acceptsImages: false });
  try {
    const session = await h.initialize();
    const result = await h.call(session, "probe_image");
    assert.equal(
      result.content.some((block) => block.type === "image"),
      false,
    );
    assert.ok(result.content.some((block) => block.type === "text" && /images disabled/.test(String(block.text))));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.counter.delivered, 0);
    await h.call(session, "open_project", { title: "text only" });
    const caps = toolData(await h.call(session, "inspect_capabilities"));
    assert.equal((caps.payload as { vision: { modelAcceptsImages: boolean } }).vision.modelAcceptsImages, false);
  } finally {
    await stop(h);
  }
});

test("http: non-loopback Host or Origin is refused with 403 (DNS rebinding guard)", async () => {
  const h = await start();
  try {
    const body = rpcBody(1, "initialize", INIT_PARAMS);
    const port = new URL(h.url).port;
    const refused: Record<string, string>[] = [
      { host: `evil.example:${port}` },
      { host: `10.0.0.5:${port}` },
      { host: `evil.example@127.0.0.1:${port}` },
      { host: `127.0.0.1:${port}/injected` },
      { origin: "http://evil.example" },
      { origin: "http://user@127.0.0.1:3000" },
      { origin: "http://127.0.0.1:3000/extra" },
      { origin: "http://127.0.0.1:3000/." },
      { origin: "http://127.0.0.1:3000/" },
      { origin: "http://127.0.0.1:3000/.." },
      { origin: "http://127.0.0.1:0" },
      { origin: "http://127.0.0.1:70000" },
      { origin: "null" },
    ];
    for (const headers of refused) {
      const res = await rawRequest(h.url, { headers, body });
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    const allowed: Record<string, string>[] = [
      { host: `localhost:${port}` },
      { origin: "http://127.0.0.1:3000" },
      { origin: "http://[::1]" },
    ];
    for (const headers of allowed) {
      assert.equal((await rawRequest(h.url, { headers, body })).status, 200, JSON.stringify(headers));
    }
  } finally {
    await stop(h);
  }
});

test("http: bearer token is required when configured (401 without or wrong, 200 with)", async () => {
  const h = await start({}, { authToken: "s3cret-token" });
  try {
    const body = rpcBody(1, "initialize", INIT_PARAMS);
    assert.equal((await rawRequest(h.url, { body })).status, 401);
    const wrong = await rawRequest(h.url, { headers: { authorization: "Bearer nope" }, body });
    assert.equal(wrong.status, 401);
    assert.match(String(wrong.headers["www-authenticate"]), /Bearer/);
    assert.equal((await rawRequest(h.url, { headers: { authorization: "Bearer s3cret-token" }, body })).status, 200);
  } finally {
    await stop(h);
  }
});

test("http: non-loopback bind hosts are refused and oversized bodies get 413", async () => {
  const server = createSlidesMcpServer({ dataRoot: tempDir("http-bind"), log: () => undefined });
  for (const host of ["0.0.0.0", "192.168.1.20", "::", "example.com"]) {
    assert.throws(() => createHttpTransport(server, { host }), /loopback/, host);
  }
  const h = await start();
  try {
    const session = await h.initialize();
    const huge = Buffer.alloc(MAX_HTTP_BODY_BYTES + 16, 0x20);
    const res = await rawRequest(h.url, { headers: h.headers(session), body: huge });
    assert.equal(res.status, 413);
  } finally {
    await stop(h);
  }
});

test("http: DELETE /mcp ends the session and releases its lease; close() releases the rest", async () => {
  const h = await start();
  try {
    const first = await h.initialize();
    const opened = toolData(await h.call(first, "open_project", { title: "删除" }));
    const root = path.join(h.dataRoot, "output", "dsh-slices", String(opened.projectId));
    assert.equal(readProjectLease(root).holder?.ownerId, `mcp:${first}`);
    const deleted = await rawRequest(h.url, { method: "DELETE", headers: h.headers(first) });
    assert.equal(deleted.status, 204);
    assert.equal(readProjectLease(root).holder, undefined);
    assert.equal((await rawRequest(h.url, { headers: h.headers(first), body: rpcBody(5, "ping") })).status, 404);
    assert.equal((await rawRequest(h.url, { method: "DELETE", headers: h.headers(first) })).status, 404);

    const second = await h.initialize();
    const reopened = toolData(await h.call(second, "bind_project", { projectId: opened.projectId }));
    assert.equal(reopened.outcome, "bound");
    assert.equal(readProjectLease(root).holder?.ownerId, `mcp:${second}`);
    await h.transport.close();
    assert.equal(readProjectLease(root).holder, undefined, "server close released every session lease");
    assert.equal(h.server.sessionCount, 0);
  } finally {
    await stop(h).catch(() => undefined);
  }
});
