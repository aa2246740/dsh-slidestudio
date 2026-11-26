import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { WRITER_LEASE_LOCK_DIR } from "@open-slidestudio/slides-tools";
import { sessionProduceCapabilities } from "./produce-tool-policy.js";
import { SliceSessionStore } from "./slice-session.js";

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
