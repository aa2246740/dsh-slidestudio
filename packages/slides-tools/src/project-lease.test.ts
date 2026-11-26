import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  acquireProjectLease,
  readProjectLease,
  releaseProjectLease,
  renewProjectLease,
  WRITER_LEASE_FILE,
} from "./project-lease.js";
import { tempDir } from "./testkit.js";

const T0 = Date.parse("2026-11-26T00:00:00.000Z");
const hub = { kind: "hub-run" as const, ownerId: "hub-run:session-1", label: "Hub run" };
const mcp = { kind: "mcp" as const, ownerId: "mcp:client-a", label: "Claude Desktop" };
const editor = { kind: "editor-human" as const, ownerId: "editor-human:tab-1", label: "Editor tab" };

test("acquire persists the holder atomically under _agent/writer-lease.v1.json", () => {
  const root = tempDir("lease");
  const acquired = acquireProjectLease(root, { ...hub, now: T0, ttlMs: 60_000 });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.outcome, "acquired");
  const file = path.join(root, WRITER_LEASE_FILE);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.holder.ownerId, hub.ownerId);
  assert.equal(stored.holder.expiresAt, new Date(T0 + 60_000).toISOString());
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
    [],
    "no temp file is left behind",
  );
});

test("renew extends the owner's TTL and keeps acquiredAt", () => {
  const root = tempDir("lease");
  acquireProjectLease(root, { ...hub, now: T0, ttlMs: 60_000 });
  const renewed = renewProjectLease(root, { ...hub, now: T0 + 30_000, ttlMs: 60_000 });
  assert.equal(renewed.ok && renewed.outcome, "renewed");
  assert.ok(renewed.ok);
  assert.equal(renewed.lease.acquiredAt, new Date(T0).toISOString());
  assert.equal(renewed.lease.expiresAt, new Date(T0 + 90_000).toISOString());
});

test("another owner fails closed while the lease is active and names the holder", () => {
  const root = tempDir("lease");
  acquireProjectLease(root, { ...hub, now: T0, ttlMs: 60_000 });
  const before = fs.readFileSync(path.join(root, WRITER_LEASE_FILE), "utf8");
  const denied = acquireProjectLease(root, { ...mcp, now: T0 + 1_000 });
  assert.equal(denied.ok, false);
  assert.equal(denied.outcome, "lease-conflict");
  assert.ok(!denied.ok && denied.outcome === "lease-conflict");
  assert.deepEqual(denied.holder, {
    kind: "hub-run",
    ownerId: hub.ownerId,
    label: "Hub run",
    expiresAt: new Date(T0 + 60_000).toISOString(),
  });
  assert.match(denied.detail, /hub-run \(Hub run\)/);
  assert.equal(fs.readFileSync(path.join(root, WRITER_LEASE_FILE), "utf8"), before, "a refusal writes nothing");
});

test("an expired lease is taken over so a crashed owner cannot wedge the project", () => {
  const root = tempDir("lease");
  acquireProjectLease(root, { ...hub, now: T0, ttlMs: 1_000 });
  const taken = acquireProjectLease(root, { ...mcp, now: T0 + 5_000 });
  assert.equal(taken.ok && taken.outcome, "taken-over-expired");
  assert.equal(readProjectLease(root, T0 + 5_000).holder?.ownerId, mcp.ownerId);
});

test("a same-host holder whose process exited is no longer active", () => {
  const root = tempDir("lease");
  acquireProjectLease(root, { ...hub, now: T0, ttlMs: 3_600_000, pid: 2_147_483_646 });
  assert.equal(readProjectLease(root, T0 + 1).active, false);
  const taken = acquireProjectLease(root, { ...mcp, now: T0 + 1 });
  assert.equal(taken.ok && taken.outcome, "taken-over-expired");
});

test("editor-human preempts an active MCP lease and the MCP writer fails closed until it re-acquires", () => {
  const root = tempDir("lease");
  acquireProjectLease(root, { ...mcp, now: T0, ttlMs: 60_000 });
  const preempted = acquireProjectLease(root, { ...editor, now: T0 + 1_000 });
  assert.equal(preempted.ok && preempted.outcome, "preempted");
  assert.ok(preempted.ok);
  assert.equal(preempted.preempted?.ownerId, mcp.ownerId);

  const blocked = acquireProjectLease(root, { ...mcp, now: T0 + 2_000 });
  assert.equal(blocked.outcome, "lease-preempted-by-editor");
  assert.ok(!blocked.ok && blocked.outcome === "lease-preempted-by-editor");
  assert.equal(blocked.holder?.kind, "editor-human");
  assert.equal(
    acquireProjectLease(root, { ...mcp, now: T0 + 2_500, reacquire: true }).outcome,
    "lease-preempted-by-editor",
    "re-acquire waits for the editor to release",
  );

  assert.equal(releaseProjectLease(root, editor.ownerId), true);
  assert.equal(
    acquireProjectLease(root, { ...mcp, now: T0 + 3_000 }).outcome,
    "lease-preempted-by-editor",
    "an implicit per-write acquire stays closed after the editor changed the project",
  );
  const back = acquireProjectLease(root, { ...mcp, now: T0 + 4_000, reacquire: true });
  assert.equal(back.ok && back.outcome, "acquired");
  assert.deepEqual(readProjectLease(root, T0 + 4_000).preempted, []);
});

test("editor-human does not preempt a Hub run, and a Hub run does not preempt the editor", () => {
  const root = tempDir("lease");
  acquireProjectLease(root, { ...hub, now: T0, ttlMs: 60_000 });
  assert.equal(acquireProjectLease(root, { ...editor, now: T0 + 1 }).outcome, "lease-conflict");
  releaseProjectLease(root, hub.ownerId);
  acquireProjectLease(root, { ...editor, now: T0 + 2, ttlMs: 60_000 });
  assert.equal(acquireProjectLease(root, { ...hub, now: T0 + 3 }).outcome, "lease-conflict");
});

test("release is owner-scoped and idempotent", () => {
  const root = tempDir("lease");
  assert.equal(releaseProjectLease(root, hub.ownerId), false, "nothing to release");
  acquireProjectLease(root, { ...hub, now: T0 });
  assert.equal(releaseProjectLease(root, mcp.ownerId), false, "a non-holder cannot release");
  assert.equal(releaseProjectLease(root, hub.ownerId), true);
  assert.equal(readProjectLease(root).holder, undefined);
  assert.equal(releaseProjectLease(root, hub.ownerId), false);
});

test("a corrupt lease file is treated as empty, never as held", () => {
  const root = tempDir("lease");
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(path.join(root, WRITER_LEASE_FILE), "{not json");
  assert.equal(acquireProjectLease(root, { ...mcp, now: T0 }).outcome, "acquired");
});

test("a holder with a malformed expiresAt timestamp is treated as inactive, never immortal", () => {
  const root = tempDir("lease");
  acquireProjectLease(root, { ...hub, now: T0, ttlMs: 60_000 });
  const file = path.join(root, WRITER_LEASE_FILE);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.holder.expiresAt = "not-a-timestamp";
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));
  assert.equal(readProjectLease(root, T0 + 1).active, false);
  const taken = acquireProjectLease(root, { ...mcp, now: T0 + 1 });
  assert.equal(taken.ok && taken.outcome, "taken-over-expired");
});

test("releaseProjectLease enforces expectedToken compare-and-delete across renewals and tokenless legacy leases", () => {
  const root = tempDir("lease");
  const first = acquireProjectLease(root, { ...hub, now: T0, ttlMs: 60_000 });
  assert.ok(first.ok && typeof first.lease.token === "string");
  const renewed = renewProjectLease(root, { ...hub, now: T0, ttlMs: 60_000 });
  assert.ok(renewed.ok && typeof renewed.lease.token === "string");
  assert.notEqual(renewed.lease.token, first.lease.token, "same-ms renew rotates token");
  assert.equal(
    releaseProjectLease(root, hub.ownerId, { expectedToken: first.lease.token }),
    false,
    "stale token must not release renewed lease",
  );
  assert.equal(releaseProjectLease(root, hub.ownerId, { expectedToken: null }), false);
  assert.equal(releaseProjectLease(root, hub.ownerId, { expectedToken: renewed.lease.token }), true);
  assert.equal(readProjectLease(root).holder, undefined);
});

test("renewProjectLease with renewOnly refuses to re-acquire an already released lease", () => {
  const root = tempDir("lease");
  acquireProjectLease(root, { ...hub, now: T0, ttlMs: 60_000 });
  assert.equal(releaseProjectLease(root, hub.ownerId), true);
  const denied = renewProjectLease(root, { ...hub, now: T0 + 1_000, ttlMs: 60_000, renewOnly: true });
  assert.equal(denied.ok, false);
  assert.equal(readProjectLease(root).holder, undefined);
});

test("cross-process same ownerId takeover after TTL expiry is isolated by expectedPid on release and renewOnly", () => {
  const root = tempDir("lease-pid");
  const otherPid = process.pid === 1 ? 2 : 1;
  const first = acquireProjectLease(root, { ...hub, now: T0, ttlMs: 1_000, pid: otherPid });
  assert.equal(first.ok && first.outcome, "acquired");
  const taken = acquireProjectLease(root, { ...hub, now: T0 + 5_000, ttlMs: 60_000, pid: process.pid });
  assert.equal(taken.ok && taken.outcome, "taken-over-expired");
  assert.equal(
    renewProjectLease(root, { ...hub, now: T0 + 6_000, ttlMs: 60_000, pid: otherPid, renewOnly: true }).ok,
    false,
    "stale PID cannot renew same ownerId held by another live PID",
  );
  assert.equal(
    releaseProjectLease(root, hub.ownerId, { expectedPid: otherPid }),
    false,
    "stale PID must not release another PID's active lease with the same ownerId",
  );
  assert.equal(readProjectLease(root, T0 + 6_000).holder?.pid, process.pid);
  assert.equal(releaseProjectLease(root, hub.ownerId, { expectedPid: process.pid }), true);
  assert.equal(readProjectLease(root, T0 + 6_000).holder, undefined);
});
