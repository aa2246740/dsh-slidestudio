import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import {
  acquireProjectLease,
  readProjectLease,
  releaseProjectLease,
  WRITER_LEASE_FILE,
  WRITER_LEASE_LOCK_DIR,
} from "@open-slidestudio/slides-tools";
import { createPresentationRun } from "@open-slidestudio/presentation-run";
import { AgentFaults } from "./agent-fault.js";
import { apply as applySlidesHostPlugin } from "./plugin.js";
import { SliceSessionStore } from "./slice-session.js";
import { registerSliceTools, sessionProduceCapabilities } from "./tools.js";

const PPTD_SAVE_LOCK = ".pptd-write.lock";

function createLockDir(lockDir: string): string {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() }),
  );
  return lockDir;
}

function mountStopHarness(
  dataRoot: string,
  opts: {
    liveAgents?: Array<{ id: string; status: string; cancel?: () => void; whenIdle?: () => Promise<void> }>;
    operatorStopTimeoutMs?: number;
    writerLeaseHeartbeatMs?: number;
  } = {},
) {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const agentsById = new Map((opts.liveAgents ?? []).map((agent) => [agent.id, agent]));
  let slidesHandler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const ctx = {
    on(event: string, fn: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    effect(fn: () => (() => void) | void) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return () => undefined;
    },
    inject: () => undefined,
    get: () => undefined,
    webServer: {
      register(entry: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) {
        if (entry.path === "/slides") slidesHandler = entry.handler;
        return () => undefined;
      },
    },
    agents: { get: (id: string) => agentsById.get(id), list: () => [...agentsById.values()] },
    tools: { register: () => () => undefined, guard: () => () => undefined },
  } as unknown as Context;
  const dshHome = path.join(dataRoot, ".dsh", "home");
  fs.mkdirSync(dshHome, { recursive: true });
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    applySlidesHostPlugin(ctx, {
      workspaceRoot: dataRoot,
      dataRoot,
      personal: true,
      ...(opts.operatorStopTimeoutMs !== undefined ? { operatorStopTimeoutMs: opts.operatorStopTimeoutMs } : {}),
      ...(opts.writerLeaseHeartbeatMs !== undefined ? { writerLeaseHeartbeatMs: opts.writerLeaseHeartbeatMs } : {}),
    });
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
  return {
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    async postStop(sessionId: string) {
      assert.ok(slidesHandler);
      return new Promise<number>((resolve) => {
        const req = Readable.from([Buffer.alloc(0)]) as IncomingMessage;
        req.method = "POST";
        req.url = `/slides/sessions/${encodeURIComponent(sessionId)}/stop`;
        req.headers = { host: "127.0.0.1:55200" };
        let status = 0;
        const res = {
          headersSent: false,
          writeHead(code: number) {
            status = code;
            res.headersSent = true;
          },
          end() {
            resolve(status);
          },
        };
        slidesHandler!(req, res as unknown as ServerResponse);
      });
    },
    dispose() {
      for (const fn of disposers) fn();
    },
  };
}

test("store.openProject rolls back the created directory when writing kernel.lock fails", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "open-rollback-"));
  const store = new SliceSessionStore(workspace);
  const origWrite = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: unknown) => {
    if (!injected && typeof file === "string" && file.endsWith(path.join("_agent", "kernel.lock"))) {
      injected = true;
      const err = new Error("injected EIO on kernel.lock") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    }
    return origWrite(file, data, opts as never);
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(
      () =>
        store.openProject({
          dshSessionId: "eio-session",
          title: "Atomic Kernel Lock",
          design: { kind: "self-directed" },
          provider: { providerId: "test", modelId: "test" },
        }),
      /EIO/,
    );
  } finally {
    fs.writeFileSync = origWrite;
  }
  assert.equal(injected, true);
  assert.equal(store.bindingFor("eio-session"), undefined);
  assert.deepEqual(fs.readdirSync(store.slicesRoot()), []);

  const retried = store.openProject({
    dshSessionId: "eio-session",
    title: "Atomic Kernel Lock",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  assert.equal(retried.created, true);
});

test("sessionProduceCapabilities serializes lease check and provider write under the lease lock", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cap-lease-race-"));
  const store = new SliceSessionStore(workspace);
  const { binding } = store.openProject({
    dshSessionId: "guard-sess",
    title: "Guard",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const root = store.resolveRoot(binding);
  const metaPath = path.join(root, "_agent", "presentation-run.v1.json");
  const initial = JSON.stringify({
    version: 1,
    provider: { providerId: "test", modelId: "test", ready: false },
  });
  fs.writeFileSync(metaPath, initial);

  const worker = new Worker(
    `
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const { parentPort, workerData } = require("node:worker_threads");
      const lockDir = path.join(workerData.root, workerData.lockRel);
      fs.mkdirSync(path.dirname(lockDir), { recursive: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() }),
      );
      parentPort.postMessage("locked");
      setTimeout(() => {
        const leaseFile = path.join(workerData.root, "_agent", "writer-lease.v1.json");
        const now = Date.now();
        fs.writeFileSync(
          leaseFile,
          JSON.stringify({
            version: 1,
            holder: {
              kind: "mcp",
              ownerId: "mcp:racer",
              pid: process.pid,
              hostname: os.hostname(),
              acquiredAt: new Date(now).toISOString(),
              renewedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + 60_000).toISOString(),
              token: "worker-mcp-token",
            },
            preempted: [],
          }),
        );
        fs.rmSync(lockDir, { recursive: true, force: true });
        parentPort.postMessage("done");
      }, 60);
    `,
    { eval: true, workerData: { root, lockRel: WRITER_LEASE_LOCK_DIR } },
  );
  await new Promise<void>((resolve, reject) => {
    worker.once("message", (msg) => {
      if (msg === "locked") resolve();
    });
    worker.once("error", reject);
  });
  try {
    sessionProduceCapabilities(
      { store, provider: { providerId: "test", modelId: "test", ready: true, modelInputModalities: ["text"] } },
      "guard-sess",
    );
    assert.equal(fs.readFileSync(metaPath, "utf8"), initial, "provider.ready must not mutate after racing MCP lease");
  } finally {
    await worker.terminate();
  }
});

test("operatorStop renews a short-remaining lease immediately even while a slow PPTD save holds .pptd-write.lock", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stop-short-ttl-"));
  const store = new SliceSessionStore(dataRoot);
  const { binding } = store.openProject({
    dshSessionId: "hb-short",
    title: "Short TTL",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const root = store.resolveRoot(binding);
  assert.equal(acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:hb-short", ttlMs: 160 }).ok, true);
  const initialExpiry = Date.parse(readProjectLease(root).holder!.expiresAt);

  // Hold the PPTD YAML save lock longer than the initial 160ms lease TTL (320ms).
  const pptdLock = createLockDir(path.join(root, PPTD_SAVE_LOCK));
  let resolveIdle!: () => void;
  const idlePromise = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  const h = mountStopHarness(dataRoot, {
    liveAgents: [{ id: "hb-short", status: "running", cancel: () => undefined, whenIdle: () => idlePromise }],
    operatorStopTimeoutMs: 420,
  });
  try {
    const stopPromise = h.postStop("hb-short");
    // Wait past the original 160ms TTL while the PPTD save lock is still held and POST /stop has not returned.
    await new Promise((resolve) => setTimeout(resolve, 260));
    fs.rmSync(pptdLock, { recursive: true, force: true });
    const mid = readProjectLease(root);
    assert.equal(mid.active, true, "lease renewal must not stall behind a slow PPTD save lock");
    assert.ok(Date.parse(mid.holder!.expiresAt) > initialExpiry + 10_000);
    assert.equal(acquireProjectLease(root, { kind: "mcp", ownerId: "mcp:racer" }).outcome, "lease-conflict");

    assert.equal(await stopPromise, 200);
    assert.equal(acquireProjectLease(root, { kind: "mcp", ownerId: "mcp:racer" }).outcome, "lease-conflict");

    resolveIdle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readProjectLease(root).active, false);
    assert.equal(acquireProjectLease(root, { kind: "mcp", ownerId: "mcp:racer" }).ok, true);
  } finally {
    fs.rmSync(pptdLock, { recursive: true, force: true });
    h.dispose();
  }
});

test("lease-lock contention during agent/status:idle + operatorStop does not stall HTTP 200", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stop-lease-lock-"));
  const store = new SliceSessionStore(dataRoot);
  const { binding } = store.openProject({
    dshSessionId: "lock-sess",
    title: "Lease Lock Contention",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const root = store.resolveRoot(binding);
  assert.equal(acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:lock-sess" }).ok, true);

  const worker = new Worker(
    `
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const { parentPort, workerData } = require("node:worker_threads");
      const lockDir = path.join(workerData.root, workerData.lockRel);
      fs.mkdirSync(path.dirname(lockDir), { recursive: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() }),
      );
      parentPort.postMessage("locked");
      setTimeout(() => {
        fs.rmSync(lockDir, { recursive: true, force: true });
        parentPort.postMessage("unlocked");
      }, 260);
    `,
    { eval: true, workerData: { root, lockRel: WRITER_LEASE_LOCK_DIR } },
  );
  await new Promise<void>((resolve, reject) => {
    worker.once("message", (msg) => {
      if (msg === "locked") resolve();
    });
    worker.once("error", reject);
  });

  const ref: { harness?: ReturnType<typeof mountStopHarness> } = {};
  const agent = {
    id: "lock-sess",
    status: "running",
    cancel() {
      agent.status = "idle";
      ref.harness?.emit("agent/status", { agent, status: "idle" });
    },
    whenIdle: () => Promise.resolve(),
  };
  const harness = mountStopHarness(dataRoot, { liveAgents: [agent], operatorStopTimeoutMs: 25 });
  ref.harness = harness;
  try {
    const start = Date.now();
    assert.equal(await harness.postStop("lock-sess"), 200);
    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 120, `stop + agent/status:idle must not stall on lease lock (took ${elapsedMs}ms)`);
    assert.ok(fs.existsSync(path.join(root, WRITER_LEASE_FILE)));

    for (let i = 0; i < 30 && readProjectLease(root).active; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(readProjectLease(root).active, false);
    assert.equal(releaseProjectLease(root, "hub-run:lock-sess"), false);
  } finally {
    await worker.terminate();
    fs.rmSync(path.join(root, WRITER_LEASE_LOCK_DIR), { recursive: true, force: true });
    harness.dispose();
  }
});

test("stale deferred release retry from an earlier stop never deletes a newer lease of the same session", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stop-stale-retry-"));
  const store = new SliceSessionStore(dataRoot);
  const { binding } = store.openProject({
    dshSessionId: "reuse-sess",
    title: "Stale Retry Guard",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const root = store.resolveRoot(binding);
  const firstLease = acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:reuse-sess" });
  assert.ok(firstLease.ok && firstLease.lease.token);

  const registered = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>();
  const disposeTools = registerSliceTools(
    {
      register(def: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) {
        registered.set(def.name, def);
        return () => undefined;
      },
      guard: () => () => undefined,
    } as never,
    {
      workspaceRoot: dataRoot,
      store,
      presentation: createPresentationRun(),
      editorBaseUrl: "http://127.0.0.1:55200",
      provider: { providerId: "test", modelId: "test", ready: true },
      faults: new AgentFaults(),
    },
  );

  const lockDir = createLockDir(path.join(root, WRITER_LEASE_LOCK_DIR));
  const ref: { harness?: ReturnType<typeof mountStopHarness> } = {};
  const agent = {
    id: "reuse-sess",
    status: "running",
    cancel() {
      agent.status = "idle";
      ref.harness?.emit("agent/status", { agent, status: "idle" });
    },
    whenIdle: () => Promise.resolve(),
  };
  const harness = mountStopHarness(dataRoot, { liveAgents: [agent], operatorStopTimeoutMs: 25 });
  ref.harness = harness;
  try {
    assert.equal(await harness.postStop("reuse-sess"), 200);
    fs.rmSync(lockDir, { recursive: true, force: true });
    const openTool = registered.get("open_project");
    assert.ok(openTool);
    await openTool.execute({ title: "Stale Retry Guard" }, { agent: { id: "reuse-sess" }, callId: "reopen-1" });
    const renewedToken = readProjectLease(root).holder?.token;
    assert.ok(renewedToken && renewedToken !== firstLease.lease.token);

    await new Promise((resolve) => setTimeout(resolve, 110));
    const current = readProjectLease(root);
    assert.equal(current.active, true, "stale retry must not delete lease #2");
    assert.equal(current.holder?.token, renewedToken);
    assert.equal(acquireProjectLease(root, { kind: "mcp", ownerId: "mcp:racer" }).outcome, "lease-conflict");
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
    disposeTools();
    harness.dispose();
  }
});

test("late whenIdle after plugin unload never deletes a lease owned by a hot-reloaded instance", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stop-unload-"));
  const store = new SliceSessionStore(dataRoot);
  const { binding } = store.openProject({
    dshSessionId: "reload-sess",
    title: "Unload Isolation",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const root = store.resolveRoot(binding);
  const firstLease = acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:reload-sess" });
  assert.ok(firstLease.ok && firstLease.lease.token);

  let resolveOldIdle!: () => void;
  const oldIdle = new Promise<void>((resolve) => {
    resolveOldIdle = resolve;
  });
  const plugin1 = mountStopHarness(dataRoot, {
    liveAgents: [{ id: "reload-sess", status: "running", cancel: () => undefined, whenIdle: () => oldIdle }],
    operatorStopTimeoutMs: 25,
  });
  assert.equal(await plugin1.postStop("reload-sess"), 200);

  // Unload plugin #1, then hot-reload plugin #2 with a live running agent holding a fresh lease token.
  plugin1.dispose();
  const nextLease = acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:reload-sess" });
  assert.ok(nextLease.ok && nextLease.lease.token && nextLease.lease.token !== firstLease.lease.token);
  const plugin2 = mountStopHarness(dataRoot, {
    liveAgents: [
      { id: "reload-sess", status: "running", cancel: () => undefined, whenIdle: () => new Promise(() => {}) },
    ],
  });
  try {
    // Late settlement of plugin #1's stopped agent must not touch plugin #2's lease.
    resolveOldIdle();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const current = readProjectLease(root);
    assert.equal(current.active, true, "disposed plugin's late whenIdle must not delete active lease");
    assert.equal(current.holder?.token, nextLease.lease.token);
    assert.equal(acquireProjectLease(root, { kind: "mcp", ownerId: "mcp:racer" }).outcome, "lease-conflict");
  } finally {
    plugin2.dispose();
  }
});
