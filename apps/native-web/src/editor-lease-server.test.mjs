// The real editor server guards human deck writes with the editor-human
// lease: a write preempts an MCP holder, a Hub run's lease refuses it with
// 409, an AI review lock keeps its own 423, and the text/plain beacon release
// frees the deck for the next agent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { acquireProjectLease, readProjectLease, releaseProjectLease } from "@open-slidestudio/slides-tools";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "editor-lease-server-")));
/** @type {import("node:child_process").ChildProcess | undefined} */
let server;
let base = "";

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** @param {string} name */
function project(name) {
  const root = path.join(dataRoot, "output", name);
  createEmptyProject(root, { title: name });
  return root;
}

/** @param {string} root @param {string} tab @param {Record<string, unknown>} body */
async function command(root, tab, body) {
  const response = await fetch(`${base}/api/command?project=${encodeURIComponent(root)}&tab=${tab}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: /** @type {Record<string, any>} */ (await response.json()) };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SLIDESTUDIO_DATA_DIR: dataRoot,
      OPEN_SLIDESTUDIO_PROJECT: project("default"),
      SLIDESTUDIO_RETENTION_DAYS: "0",
      SLIDESTUDIO_LEGACY_CONVERT: "off",
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("editor server did not start");
});

after(() => {
  server?.kill();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("a human deck write preempts an MCP holder and the MCP must re-acquire explicitly", async () => {
  const root = project("mcp-preempt");
  const mcp = { kind: /** @type {const} */ ("mcp"), ownerId: "mcp:agent-1", label: "agent" };
  assert.equal(acquireProjectLease(root, mcp).ok, true);

  const edit = await command(root, "tab-human", { cmd: "addPage" });
  assert.equal(edit.status, 200);
  const lease = readProjectLease(root);
  assert.equal(lease.holder?.kind, "editor-human");
  assert.equal(lease.holder?.ownerId, "editor-human:tab-human");
  assert.deepEqual(
    lease.preempted.map((row) => row.kind),
    ["mcp"],
  );

  const blocked = acquireProjectLease(root, mcp);
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.outcome, "lease-preempted-by-editor");

  const release = await fetch(`${base}/api/lease/release`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: base },
    body: JSON.stringify({ project: root, tabId: "tab-human" }),
  });
  assert.equal(release.status, 200);
  assert.deepEqual(await release.json(), { ok: true, released: true });
  assert.equal(readProjectLease(root).active, false);
  assert.equal(acquireProjectLease(root, { ...mcp, reacquire: true }).ok, true);
});

test("a Hub run's lease refuses the human write with 409 and leaves the deck untouched", async () => {
  const root = project("hub-run");
  const deck = fs.readFileSync(path.join(root, "deck.pptd"), "utf8");
  assert.equal(acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:session-1" }).ok, true);
  const edit = await command(root, "tab-human", { cmd: "addPage" });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, "WRITER_LEASE_CONFLICT");
  assert.equal(edit.body.holder?.kind, "hub-run");
  assert.equal(fs.readFileSync(path.join(root, "deck.pptd"), "utf8"), deck);
  assert.equal(releaseProjectLease(root, "hub-run:session-1"), true);
});

test("read-only commands never take the lease", async () => {
  const root = project("read-only");
  const view = await command(root, "tab-human", { cmd: "zoom", direction: "in" });
  assert.equal(view.status, 200);
  assert.equal(readProjectLease(root).active, false);
  const state = await fetch(`${base}/api/lease?project=${encodeURIComponent(root)}&tab=tab-human`);
  assert.deepEqual(await state.json(), { active: false, holder: null, mine: false, waiting: [] });
});
