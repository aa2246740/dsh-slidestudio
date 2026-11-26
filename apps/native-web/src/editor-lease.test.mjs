import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { acquireProjectLease, readProjectLease, releaseProjectLease } from "@open-slidestudio/slides-tools";
import {
  EDITOR_LEASE_FALLBACK_OWNER,
  EDITOR_LEASE_TTL_MS,
  editorLeaseOwnerId,
  editorLeaseView,
  guardEditorWrite,
  refuseEditorWrite,
  releaseEditorLease,
} from "./editor-lease.mjs";
import {
  holdLeaseLock,
  leaseFileText,
  removeLeaseFixtures,
  tempDirectory,
  tempLeaseProject,
  writeAgentPage,
} from "./editor-lease-fixtures.mjs";

const MCP = { kind: /** @type {const} */ ("mcp"), ownerId: "mcp:session-1", label: "external agent" };
const HUB = { kind: /** @type {const} */ ("hub-run"), ownerId: "hub-run:session-7", label: "Hub run" };

after(removeLeaseFixtures);

describe("editor lease owner ids", () => {
  it("scopes the owner to the browser tab and falls back for unusable ids", () => {
    assert.equal(editorLeaseOwnerId("tab-a_1"), "editor-human:tab-a_1");
    for (const bad of [undefined, null, "", "default", "a b", "x".repeat(65), "../../etc"]) {
      assert.equal(editorLeaseOwnerId(bad), EDITOR_LEASE_FALLBACK_OWNER, String(bad));
    }
  });
});

describe("guardEditorWrite closed loop", () => {
  it("preempts an MCP writer, which then stays blocked until the editor releases and it re-acquires", () => {
    const root = tempLeaseProject("lease-mcp-loop");
    const mcp = acquireProjectLease(root, MCP);
    assert.equal(mcp.ok && mcp.outcome, "acquired");
    writeAgentPage(root, "written by the agent");

    const guard = guardEditorWrite(root, { tabId: "tab-1" });
    assert.equal(guard.ok, true);
    assert.equal(guard.ok && guard.outcome, "preempted");
    assert.deepEqual(guard.ok && guard.preempted, {
      kind: "mcp",
      label: "external agent",
      expiresAt: mcp.ok ? mcp.lease.expiresAt : "",
    });
    assert.equal(readProjectLease(root).holder?.ownerId, "editor-human:tab-1");
    const expires = Date.parse(readProjectLease(root).holder?.expiresAt ?? "");
    assert.ok(Math.abs(expires - Date.now() - EDITOR_LEASE_TTL_MS) < 5_000, "editor TTL applied");

    const implicit = acquireProjectLease(root, MCP);
    assert.equal(implicit.outcome, "lease-preempted-by-editor");
    const early = acquireProjectLease(root, { ...MCP, reacquire: true });
    assert.equal(early.outcome, "lease-preempted-by-editor", "editor still holds the project");
    assert.equal(!early.ok && early.outcome === "lease-preempted-by-editor" && early.holder?.kind, "editor-human");

    const renewed = guardEditorWrite(root, { tabId: "tab-1" });
    assert.equal(renewed.ok && renewed.outcome, "renewed", "every editor write renews its lease");
    assert.equal(editorLeaseView(root, { tabId: "tab-1" }).waiting.length, 1, "the agent waits");

    assert.deepEqual(releaseEditorLease(root, { tabId: "tab-1" }), { ok: true, released: true });
    assert.equal(acquireProjectLease(root, MCP).outcome, "lease-preempted-by-editor", "implicit acquire fails closed");
    const back = acquireProjectLease(root, { ...MCP, reacquire: true });
    assert.equal(back.ok && back.outcome, "acquired");
    assert.equal(readProjectLease(root).holder?.ownerId, MCP.ownerId);
    assert.deepEqual(editorLeaseView(root, { tabId: "tab-1" }).waiting, []);
  });

  it("refuses with 409 while a Hub run holds the lease and leaves the holder untouched on disk", () => {
    const root = tempLeaseProject("lease-hub");
    assert.equal(acquireProjectLease(root, HUB).ok, true);
    const before = leaseFileText(root);

    const guard = guardEditorWrite(root, { tabId: "tab-1" });
    assert.equal(guard.ok, false);
    if (guard.ok) return;
    assert.equal(guard.status, 409);
    assert.equal(guard.body.code, "WRITER_LEASE_CONFLICT");
    assert.equal(guard.body.outcome, "lease-conflict");
    assert.deepEqual(Object.keys(guard.body.holder ?? {}).sort(), ["expiresAt", "kind", "label"]);
    assert.equal(guard.body.holder?.kind, "hub-run");
    assert.match(guard.body.error, /AI 正在生成/);
    assert.equal(leaseFileText(root), before, "hub-run lease is byte-for-byte unchanged");
    assert.deepEqual(releaseEditorLease(root, { tabId: "tab-1" }), { ok: true, released: false });
    assert.equal(leaseFileText(root), before);
    assert.equal(readProjectLease(root).holder?.ownerId, HUB.ownerId);
  });

  it("refuseEditorWrite sends the refusal through the injected json helper", () => {
    const root = tempLeaseProject("lease-refuse");
    acquireProjectLease(root, HUB);
    /** @type {{ status: number, body: unknown }[]} */
    const sent = [];
    const res = /** @type {import("node:http").ServerResponse} */ (/** @type {unknown} */ ({}));
    const json = (/** @type {unknown} */ _res, /** @type {number} */ status, /** @type {unknown} */ body) =>
      sent.push({ status, body });
    assert.equal(refuseEditorWrite({ res, json, projectRoot: root, tabId: "tab-1" }), true);
    assert.equal(sent[0]?.status, 409);
    releaseProjectLease(root, HUB.ownerId);
    assert.equal(refuseEditorWrite({ res, json, projectRoot: root, tabId: "tab-1" }), false);
    assert.equal(sent.length, 1);
  });

  it("hands the lease between tabs of this editor process but not across a foreign editor process", () => {
    const root = tempLeaseProject("lease-tabs");
    assert.equal(guardEditorWrite(root, { tabId: "tab-a" }).ok, true);
    const handed = guardEditorWrite(root, { tabId: "tab-b" });
    assert.equal(handed.ok && handed.outcome, "handed-over");
    assert.equal(readProjectLease(root).holder?.ownerId, "editor-human:tab-b");
    assert.deepEqual(releaseEditorLease(root, { tabId: "tab-a" }), { ok: true, released: false });

    releaseEditorLease(root, { tabId: "tab-b" });
    acquireProjectLease(root, { kind: "editor-human", ownerId: "editor-human:remote", pid: 1 });
    const foreign = guardEditorWrite(root, { tabId: "tab-a" });
    assert.equal(foreign.ok, false);
    assert.equal(!foreign.ok && foreign.body.holder?.kind, "editor-human");
  });

  it("answers a structured 503 when the lease lock is stuck instead of hanging", () => {
    const root = tempLeaseProject("lease-busy");
    acquireProjectLease(root, HUB);
    const unlock = holdLeaseLock(root);
    try {
      const started = Date.now();
      const guard = guardEditorWrite(root, { tabId: "tab-1", lockTimeoutMs: 60 });
      assert.ok(Date.now() - started < 2_000, "bounded wait");
      assert.equal(guard.ok, false);
      if (guard.ok) return;
      assert.equal(guard.status, 503);
      assert.equal(guard.body.code, "WRITER_LEASE_BUSY");
      assert.equal(guard.body.outcome, "lock-timeout");
      assert.equal(guard.body.holder?.kind, "hub-run");
      const release = releaseEditorLease(root, { tabId: "tab-1", lockTimeoutMs: 60 });
      assert.equal(release.ok === false && release.status, 503);
    } finally {
      unlock();
    }
    assert.equal(guardEditorWrite(root, { tabId: "tab-1" }).ok, false, "hub still holds after the lock clears");
  });

  it("never creates a missing project and degrades on a read-only project", () => {
    const parent = tempDirectory("lease-missing");
    const missing = path.join(parent, "nope");
    assert.deepEqual(guardEditorWrite(missing, { tabId: "t" }), { ok: true, outcome: "skipped", lease: null });
    assert.deepEqual(releaseEditorLease(missing, { tabId: "t" }), { ok: true, released: false });
    assert.equal(editorLeaseView(missing).active, false);
    assert.equal(fs.existsSync(missing), false);

    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = tempLeaseProject("lease-readonly");
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.chmodSync(path.join(root, "_agent"), 0o555);
    try {
      assert.deepEqual(guardEditorWrite(root, { tabId: "t" }), { ok: true, outcome: "unavailable", lease: null });
    } finally {
      fs.chmodSync(path.join(root, "_agent"), 0o755);
    }
  });

  it("exposes a read-only view without pids, hosts, tokens or foreign owner ids", () => {
    const root = tempLeaseProject("lease-view");
    acquireProjectLease(root, MCP);
    guardEditorWrite(root, { tabId: "tab-1", label: "my tab" });
    const mine = editorLeaseView(root, { tabId: "tab-1" });
    assert.equal(mine.active, true);
    assert.equal(mine.mine, true);
    assert.deepEqual(Object.keys(mine.holder ?? {}).sort(), ["expiresAt", "kind", "label"]);
    assert.deepEqual(Object.keys(mine.waiting[0] ?? {}).sort(), ["at", "kind"]);
    assert.equal(editorLeaseView(root, { tabId: "tab-2" }).mine, false);
    const serialized = JSON.stringify(mine);
    assert.doesNotMatch(serialized, /pid|hostname|token|mcp:session-1/);
    const expired = editorLeaseView(root, { tabId: "tab-1", now: Date.now() + EDITOR_LEASE_TTL_MS + 1_000 });
    assert.equal(expired.active, false);
    assert.equal(expired.holder, null);
  });
});
