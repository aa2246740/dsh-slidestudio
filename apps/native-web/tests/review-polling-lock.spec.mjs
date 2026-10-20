import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

test("warmed model and review GET polling does not acquire the project write lock", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openslides-review-polling-"));
  const project = path.join(scratch, "project");
  fs.mkdirSync(path.join(project, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "deck.pptd"),
    JSON.stringify({
      version: "v2",
      title: "Review polling",
      size: [960, 540],
      theme: {},
      pages: ["pages/01.page"],
    }),
  );
  fs.writeFileSync(
    path.join(project, "pages/01.page"),
    JSON.stringify({
      pageType: "content",
      background: { type: "solid", color: "#FFF" },
      elements: [],
    }),
  );
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not select an unused port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  /** @type {string[]} */
  const serverLogs = [];
  const server = spawn(process.execPath, ["apps/native-web/src/server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      OPEN_SLIDESTUDIO_PROJECT: project,
      SLIDESTUDIO_RETENTION_DAYS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  /** @param {Buffer | string} chunk */
  const collectLog = (chunk) => {
    serverLogs.push(String(chunk));
  };
  server.stdout.on("data", collectLog);
  server.stderr.on("data", collectLog);
  let watcher;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (server.exitCode !== null) {
        throw new Error(`server exited ${server.exitCode} before listen\n${serverLogs.join("")}`);
      }
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          ready = true;
          break;
        }
      } catch {
        if (attempt === 79) throw new Error(`server did not start\n${serverLogs.join("")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "server did not become ready");

    /** @type {string[]} */
    const lockEvents = [];
    watcher = fs.watch(project, (_event, filename) => {
      if (String(filename) === ".pptd-write.lock") lockEvents.push(String(filename));
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const model = await fetch(`${base}/api/model?project=${encodeURIComponent(project)}`);
      assert.equal(model.status, 200);
      const reviews = await fetch(
        `${base}/api/reviews?project=${encodeURIComponent(project)}&pagePath=pages%2F01.page`,
      );
      assert.equal(reviews.status, 200);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(lockEvents, []);
  } finally {
    watcher?.close();
    if (server.exitCode === null) {
      const stopped = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await stopped;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
