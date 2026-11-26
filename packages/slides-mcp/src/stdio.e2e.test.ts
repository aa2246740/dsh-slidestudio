import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CANONICAL_SLIDE_TOOL_NAMES, readProjectLease } from "@open-slidestudio/slides-tools";
import { createSlidesMcpServer } from "./server.js";
import { MAX_STDIO_LINE_BYTES, serveStdio } from "./transport-stdio.js";
import { INIT_PARAMS, StdioClient, pngBytes, tempDir, toolData, type RpcMessage } from "./testkit.js";

const clients: StdioClient[] = [];
test.after(() => {
  for (const client of clients) if (client.child.exitCode === null) client.child.kill("SIGKILL");
});

function spawnClient(args: readonly string[], opts: { readonly cwd?: string } = {}): StdioClient {
  const client = new StdioClient(args, OFFLINE_ENV, opts);
  clients.push(client);
  return client;
}

const OFFLINE_ENV = { SLIDESTUDIO_PLAYWRIGHT_RUNTIME: "/nonexistent/slides-mcp-test/runtime.mjs" };

function projectRootOf(dataRoot: string, opened: Record<string, unknown>): string {
  return path.join(dataRoot, "output", "dsh-slices", String(opened.projectId));
}

function assertCleanStdout(client: StdioClient): void {
  for (const line of client.stdoutLines) {
    const message = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(message.jsonrpc, "2.0", `stdout carried a non JSON-RPC line: ${line}`);
  }
}

test("stdio: handshake, tool list, project, imports, editor link and lease release on EOF", async () => {
  const dataRoot = tempDir("stdio-data");
  const inputs = tempDir("stdio-inputs");
  const outside = tempDir("stdio-outside");
  fs.writeFileSync(path.join(inputs, "brief.md"), "# 季度复盘\n\n收入同比增长 12%。\n");
  fs.writeFileSync(path.join(inputs, "sales.csv"), "季度,收入\nQ1,100\nQ2,120\n");
  fs.writeFileSync(path.join(inputs, "chart.png"), pngBytes(6, 4));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(inputs, "escape.txt"));
  fs.mkdirSync(path.join(inputs, "folder.md"));
  const client = spawnClient([
    "--data-root",
    dataRoot,
    "--allow-import-root",
    inputs,
    "--editor-url",
    "http://127.0.0.1:9",
  ]);

  const init = await client.request("initialize", INIT_PARAMS);
  assert.equal(init.result?.protocolVersion, "2025-03-26");
  client.notify("notifications/initialized");
  const names = ((await client.request("tools/list")).result?.tools as { name: string }[]).map((tool) => tool.name);
  for (const name of [...CANONICAL_SLIDE_TOOL_NAMES, "import_material", "reacquire_lease", "bind_project"]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(names.length, 32);

  const opened = toolData(await client.call("open_project", { title: "季度复盘" }));
  assert.equal(opened.outcome, "created");
  const root = projectRootOf(dataRoot, opened);
  assert.equal(readProjectLease(root).holder?.kind, "mcp");
  const binding = JSON.parse(fs.readFileSync(path.join(root, "_agent", "presentation-run.v1.json"), "utf8"));
  assert.deepEqual(binding.provider, {
    providerId: "mcp",
    modelId: "slides-mcp-test@1.0.0",
    ready: true,
    modelInputModalities: ["text", "image"],
  });
  const caps = toolData(await client.call("inspect_capabilities"));
  assert.equal((caps.payload as { vision: { modelAcceptsImages: boolean } }).vision.modelAcceptsImages, true);

  const ids: Record<string, string> = {};
  for (const file of ["brief.md", "sales.csv", "chart.png"]) {
    const imported = await client.call("import_material", { path: path.join(inputs, file) });
    assert.equal(imported.isError, undefined, JSON.stringify(imported));
    ids[file] = String(toolData(imported).materialId);
  }
  const listed = toolData(await client.call("list_materials"));
  assert.match(String(listed.detail), /brief\.md \| text/);
  assert.match(String(listed.detail), /sales\.csv \| table/);
  assert.match(String(listed.detail), /chart\.png \| image/);
  const text = toolData(await client.call("read_material", { materialId: ids["brief.md"] }));
  assert.match(String((text.payload as { text: string }).text), /收入同比增长 12%/);
  const table = toolData(await client.call("read_material", { materialId: ids["sales.csv"] }));
  assert.match(String((table.payload as { text: string }).text), /Q2/);
  const viewed = await client.call("view_material", { materialId: ids["chart.png"] });
  const image = viewed.content.find((block) => block.type === "image");
  assert.equal(image?.mimeType, "image/png");
  assert.deepEqual(Buffer.from(String(image?.data), "base64"), pngBytes(6, 4));

  for (const [args, expected] of [
    [{ path: `${inputs}/../${path.basename(outside)}/secret.txt` }, "import_path_outside_roots"],
    [{ path: path.join(inputs, "escape.txt") }, "import_path_outside_roots"],
    [{ path: path.join(inputs, "folder.md") }, "import_path_not_file"],
    [{ path: "relative.md" }, "import_path_not_absolute"],
  ] as const) {
    const refused = await client.call("import_material", args);
    assert.equal(refused.isError, true);
    assert.equal(toolData(refused).error, expected);
  }

  const editor = toolData(await client.call("open_in_editor"));
  assert.equal(editor.url, `http://127.0.0.1:9/?project=${encodeURIComponent(String(opened.projectRoot))}`);

  assert.equal(await client.end(), 0);
  assert.equal(readProjectLease(root).holder, undefined, "EOF released the writer lease");
  assertCleanStdout(client);
  assert.equal(client.stderr.includes('{"jsonrpc"'), false);
});

test("stdio: import_material is refused without configured import roots", async () => {
  const dataRoot = tempDir("stdio-noroots");
  const inputs = tempDir("stdio-noroots-in");
  fs.writeFileSync(path.join(inputs, "a.md"), "a\n");
  const client = spawnClient(["--data-root", dataRoot]);
  await client.request("initialize", INIT_PARAMS);
  await client.call("open_project", { title: "x" });
  const refused = await client.call("import_material", { path: path.join(inputs, "a.md") });
  assert.equal(refused.isError, true);
  assert.equal(toolData(refused).error, "import_roots_not_configured");
  assert.equal(await client.end(), 0);
});

test("stdio: half packets and several messages in one chunk are framed correctly", async () => {
  const client = spawnClient(["--data-root", tempDir("stdio-framing")]);
  const first = client.expect(1);
  const second = client.expect(2);
  const third = client.expect(3);
  const ping = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS });
  client.writeRaw(init.slice(0, 17));
  await new Promise((resolve) => setTimeout(resolve, 30));
  client.writeRaw(`${init.slice(17)}\n${ping(2)}\n${ping(3).slice(0, 5)}`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  client.writeRaw(`${ping(3).slice(5)}\r\nnot json\n`);
  assert.equal(((await first) as RpcMessage).result?.protocolVersion, "2025-03-26");
  assert.deepEqual((await second).result, {});
  assert.deepEqual((await third).result, {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(client.stdoutLines.some((line) => JSON.parse(line).error?.code === -32700));
  assert.equal(await client.end(), 0);
  assertCleanStdout(client);
});

test("stdio: SIGTERM releases the session's writer lease", async () => {
  const dataRoot = tempDir("stdio-signal");
  const client = spawnClient(["--data-root", dataRoot]);
  await client.request("initialize", INIT_PARAMS);
  const opened = toolData(await client.call("open_project", { title: "signal" }));
  const root = projectRootOf(dataRoot, opened);
  assert.equal(readProjectLease(root).holder?.kind, "mcp");
  client.child.kill("SIGTERM");
  await client.exited;
  assert.equal(readProjectLease(root).holder, undefined);
});

test("stdio: launching from an arbitrary cwd without OPEN_SLIDESTUDIO_ROOT still opens projects and reads references", async () => {
  const dataRoot = tempDir("stdio-cwd-data");
  const outsideCwd = tempDir("stdio-unrelated-cwd");
  const client = spawnClient(["--data-root", dataRoot], { cwd: outsideCwd });
  await client.request("initialize", INIT_PARAMS);
  const opened = toolData(await client.call("open_project", { title: "任意工作目录" }));
  assert.equal(opened.outcome, "created");
  const refs = toolData(await client.call("list_references"));
  assert.equal(refs.ok, true);
  assert.equal(await client.end(), 0);
  assertCleanStdout(client);
});

test("stdio: a failed or broken output write never invokes onContentDelivered", async () => {
  let delivered = 0;
  const server = createSlidesMcpServer({
    dataRoot: tempDir("stdio-broken-pipe"),
    extraTools: () => [
      {
        name: "probe_image",
        description: "probe",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        requiresProject: false,
        render: "vision",
        async execute() {
          return {
            data: { ok: true },
            content: [{ type: "image", data: new Uint8Array(pngBytes(2, 2)), mediaType: "image/png" }],
            onContentDelivered: async () => {
              delivered += 1;
            },
          };
        },
      },
    ],
  });
  const input = new PassThrough();
  const brokenOutput = new Writable({
    write(_chunk, _enc, cb) {
      const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      cb(err);
      process.nextTick(() => brokenOutput.emit("error", err));
    },
  });
  const transport = serveStdio(server, input, brokenOutput);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe_image" } })}\n`);
  await transport.closed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, 0, "failed stdio write must not mark image delivered");
});

test("stdio: real child-process broken stdout pipe (EPIPE) exits 0 and releases writer lease", async () => {
  const dataRoot = tempDir("stdio-real-epipe");
  const client = spawnClient(["--data-root", dataRoot]);
  await client.request("initialize", INIT_PARAMS);
  const opened = toolData(await client.call("open_project", { title: "真实断管" }));
  const root = projectRootOf(dataRoot, opened);
  assert.equal(readProjectLease(root).holder?.kind, "mcp");

  // Close the reader side of the child's stdout pipe, then provoke a response write.
  client.child.stdout!.destroy();
  await new Promise((resolve) => setTimeout(resolve, 40));
  client.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n`);
  const code = await client.exited;
  assert.equal(code, 0, `expected clean exit 0 on EPIPE, got ${code}; stderr=${client.stderr}`);
  assert.equal(readProjectLease(root).holder, undefined, "broken pipe released the writer lease");
});

test("stdio: an exact 4 MiB CRLF frame split between \\r and \\n is accepted, while 4 MiB + 1 is rejected", async () => {
  const server = createSlidesMcpServer({ dataRoot: tempDir("stdio-crlf-4mib"), log: () => undefined });
  const input = new PassThrough();
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString("utf8"));
      cb();
    },
  });
  const transport = serveStdio(server, input, output);
  const prefix = '{"jsonrpc":"2.0","id":7,"method":"ping"';
  const exact = `${prefix}${" ".repeat(MAX_STDIO_LINE_BYTES - prefix.length - 1)}}`;
  assert.equal(Buffer.byteLength(exact, "utf8"), MAX_STDIO_LINE_BYTES);
  input.write(`${exact}\r`);
  await new Promise((resolve) => setImmediate(resolve));
  input.write("\n");
  const over = `${prefix}${" ".repeat(MAX_STDIO_LINE_BYTES - prefix.length)}}`;
  assert.equal(Buffer.byteLength(over, "utf8"), MAX_STDIO_LINE_BYTES + 1);
  input.write(`${over}\r`);
  await new Promise((resolve) => setImmediate(resolve));
  input.write("\n");
  input.end();
  await transport.closed;
  const parsed = lines
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: unknown; result?: unknown; error?: { code: number } });
  assert.equal(parsed.length, 2, JSON.stringify(parsed));
  assert.deepEqual(parsed[0], { jsonrpc: "2.0", id: 7, result: {} });
  assert.equal(parsed[1]?.error?.code, -32600);
});

test("stdio: --config-b64 passes literal dataRoot containing ${credential:...} safely", async () => {
  const base = tempDir("stdio-b64");
  const trickyDataRoot = path.join(base, "${credential:NO_EXPAND}");
  fs.mkdirSync(trickyDataRoot, { recursive: true });
  const encoded = Buffer.from(JSON.stringify({ dataRoot: trickyDataRoot }), "utf8").toString("base64url");
  const client = spawnClient(["--config-b64", encoded], { cwd: tempDir("stdio-b64-cwd") });
  await client.request("initialize", INIT_PARAMS);
  const opened = toolData(await client.call("open_project", { title: "模板字面量路径" }));
  assert.equal(opened.outcome, "created");
  assert.equal(fs.existsSync(path.join(trickyDataRoot, "output", "dsh-slices", String(opened.projectId))), true);
  assert.equal(await client.end(), 0);
});
