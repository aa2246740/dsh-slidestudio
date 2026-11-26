// End-to-end loop against the REAL slides-mcp tools driven in-process: an MCP
// session writes, a human editor write preempts it, the MCP fails closed until
// the editor tab releases through the HTTP release route, then re-acquires.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createSlidesMcpServer } from "@open-slidestudio/slides-mcp";
import { readProjectLease } from "@open-slidestudio/slides-tools";
import { guardEditorWrite } from "./editor-lease.mjs";
import { editorLeaseBeaconAllowed, handleEditorLeaseRoutes } from "./editor-lease-routes.mjs";
import { removeLeaseFixtures, startLeaseServer, tempDirectory } from "./editor-lease-fixtures.mjs";

const RUNTIME_ENV = "SLIDESTUDIO_PLAYWRIGHT_RUNTIME";
const savedRuntime = process.env[RUNTIME_ENV];
/** @type {{ base: string, close: () => Promise<unknown> }} */
let http;

before(async () => {
  // Keep the MCP's page raster offline: no browser runtime is ever launched.
  process.env[RUNTIME_ENV] = "/nonexistent/editor-lease-test/runtime.mjs";
  http = await startLeaseServer({ handle: handleEditorLeaseRoutes, beaconAllowed: editorLeaseBeaconAllowed });
});
after(async () => {
  if (savedRuntime === undefined) delete process.env[RUNTIME_ENV];
  else process.env[RUNTIME_ENV] = savedRuntime;
  await http.close();
  removeLeaseFixtures();
});

/** @typedef {{ outcome?: string, projectId?: string, next?: unknown, holder?: { kind?: string } }} ToolData */

/** @param {import("@open-slidestudio/slides-mcp").McpSession} session */
function mcpClient(session) {
  let next = 1;
  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  async function request(method, params) {
    const outcome = await session.handle({ jsonrpc: "2.0", id: next++, method, params });
    await outcome.afterDelivery?.();
    return /** @type {{ result?: { content?: { text?: string }[], isError?: boolean }, error?: { message: string } }} */ (
      outcome.response ?? {}
    );
  }
  /**
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   * @returns {Promise<{ isError?: boolean, data: ToolData }>}
   */
  async function call(name, args = {}) {
    const response = await request("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`tools/call ${name}: ${response.error.message}`);
    const text = response.result?.content?.[0]?.text;
    assert.equal(typeof text, "string", `text content for ${name}`);
    return { isError: response.result?.isError, data: /** @type {ToolData} */ (JSON.parse(String(text))) };
  }
  return { request, call };
}

/** @param {unknown} body */
async function beaconRelease(body) {
  const res = await fetch(`${http.base}/api/lease/release`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("editor-human lease against the real MCP tools", () => {
  it("preempts, blocks, releases through the route and lets the MCP re-acquire", async () => {
    const dataRoot = tempDirectory("lease-mcp-data");
    const inputs = tempDirectory("lease-mcp-inputs");
    fs.writeFileSync(path.join(inputs, "a.md"), "# 第一版\n");
    fs.writeFileSync(path.join(inputs, "b.md"), "# 第二版\n");
    const server = createSlidesMcpServer({ dataRoot, allowedImportRoots: [inputs], log: () => undefined });
    const session = server.createSession();
    const mcp = mcpClient(session);
    try {
      await mcp.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "agent" } });
      const opened = await mcp.call("open_project", { title: "编辑器抢占" });
      assert.equal(opened.isError, undefined, JSON.stringify(opened.data));
      const root = path.join(dataRoot, "output", "dsh-slices", String(opened.data.projectId));
      assert.equal(readProjectLease(root).holder?.kind, "mcp");
      const first = await mcp.call("import_material", { path: path.join(inputs, "a.md") });
      assert.equal(first.data.outcome, "imported", JSON.stringify(first.data));

      const guard = guardEditorWrite(root, { tabId: "tab-human" });
      assert.equal(guard.ok && guard.outcome, "preempted");
      assert.equal(guard.ok && guard.preempted?.kind, "mcp");
      const manifest = path.join(root, "_agent", "materials", "manifest.json");
      const manifestBefore = fs.readFileSync(manifest, "utf8");

      const blocked = await mcp.call("import_material", { path: path.join(inputs, "b.md") });
      assert.equal(blocked.isError, true);
      assert.equal(blocked.data.outcome, "lease-preempted-by-editor");
      assert.equal(fs.readFileSync(manifest, "utf8"), manifestBefore, "the preempted MCP wrote nothing");

      const early = await mcp.call("reacquire_lease");
      assert.equal(early.isError, true);
      assert.equal(early.data.outcome, "lease-preempted-by-editor");
      assert.equal(early.data.holder?.kind, "editor-human");

      const released = await beaconRelease({ project: root, tabId: "tab-human" });
      assert.deepEqual(released, { status: 200, body: { ok: true, released: true } });

      const implicit = await mcp.call("import_material", { path: path.join(inputs, "b.md") });
      assert.equal(implicit.data.outcome, "lease-preempted-by-editor", "an implicit write never re-acquires");
      const back = await mcp.call("reacquire_lease");
      assert.equal(back.isError, undefined, JSON.stringify(back.data));
      assert.match(String(back.data.next), /read_page/);
      assert.equal(readProjectLease(root).holder?.ownerId, session.state.callerId);

      const written = await mcp.call("import_material", { path: path.join(inputs, "b.md") });
      assert.equal(written.data.outcome, "imported", JSON.stringify(written.data));
      assert.notEqual(fs.readFileSync(manifest, "utf8"), manifestBefore);
    } finally {
      server.closeAll();
    }
  });
});
