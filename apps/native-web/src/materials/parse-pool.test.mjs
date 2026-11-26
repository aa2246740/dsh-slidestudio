import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ParsePool, PARSE_MAX_CONCURRENT, PARSE_RESOURCE_LIMITS } from "./parse-pool.mjs";
import { classifyWorkerError } from "./parse-worker.mjs";

/** @param {import("node:test").TestContext} t */
function scratch(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oss-parse-pool-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return temporary;
}

test("a parser that runs past the deadline yields a timeout record, and the pool survives", async (t) => {
  const dir = scratch(t);
  const workerPath = path.join(dir, "hang-worker.mjs");
  fs.writeFileSync(
    workerPath,
    `import { parentPort } from "node:worker_threads";
parentPort.on("message", () => { /* hang on purpose */ });`,
  );
  const pool = new ParsePool({ timeoutMs: 1500, workerPath });
  const outcome = await pool.run({
    materialId: "m1",
    name: "slow.csv",
    bytes: Buffer.from("a,b\n1,2"),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "timeout");
  assert.match(outcome.message, /超时|过长/);
  assert.equal(pool.activeCount, 0);
  // The terminated worker did not poison the pool: a fresh pool with the real
  // worker still parses.
  const realPool = new ParsePool({ timeoutMs: 1500 });
  const next = await realPool.run({
    materialId: "m2",
    name: "a.txt",
    bytes: Buffer.from("正常文本"),
  });
  assert.equal(next.ok, true);
  assert.equal(next.derivative.parser.id, "text-utf8-v1");
  await realPool.close();
  await pool.close();
});

test("a heap overrun is reported as out-of-memory without crashing the parent", async (t) => {
  const dir = scratch(t);
  const workerPath = path.join(dir, "oom-worker.mjs");
  fs.writeFileSync(
    workerPath,
    `import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  const keep = [];
  const block = "y".repeat(1000000);
  for (;;) keep.push(block);
});`,
  );
  const pool = new ParsePool({ workerPath });
  const outcome = await pool.run({
    materialId: "m1",
    name: "bomb.csv",
    bytes: Buffer.from("a,b\n1,2"),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "out-of-memory");
  assert.match(outcome.message, /内存/);
  assert.equal(pool.activeCount, 0);
  // Parent still healthy and able to parse with a fresh worker.
  const realPool = new ParsePool({
    workerPath: new URL("./parse-worker.mjs", import.meta.url).pathname,
  });
  const next = await realPool.run({
    materialId: "m2",
    name: "a.txt",
    bytes: Buffer.from("依然存活"),
  });
  assert.equal(next.ok, true);
  await realPool.close();
  await pool.close();
});

test("with 3 jobs submitted, at most 2 run concurrently and the third is queued", async (t) => {
  const dir = scratch(t);
  const workerPath = path.join(dir, "slow-ok-worker.mjs");
  fs.writeFileSync(
    workerPath,
    `import { parentPort } from "node:worker_threads";
parentPort.on("message", (job) => {
  setTimeout(() => {
    parentPort.postMessage({ jobId: job.jobId, ok: true, derivative: { parser: { id: "test" } } });
  }, 400);
});`,
  );
  const pool = new ParsePool({ workerPath, timeoutMs: 5000 });
  const jobs = ["1", "2", "3"].map((n) => pool.run({ materialId: n, name: `${n}.txt`, bytes: Buffer.from("x") }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pool.activeCount, 2);
  assert.equal(pool.pending, 1);
  assert.equal(PARSE_MAX_CONCURRENT, 2);
  const outcomes = await Promise.all(jobs);
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every((o) => o.ok));
  assert.equal(pool.activeCount, 0);
  await pool.close();
});

test("resource limits pin the worker heap budget (256/32/4)", () => {
  assert.deepEqual(PARSE_RESOURCE_LIMITS, {
    maxOldGenerationSizeMb: 256,
    maxYoungGenerationSizeMb: 32,
    stackSizeMb: 4,
  });
});

test("worker-side error classification maps allocation failures to out-of-memory", () => {
  assert.equal(classifyWorkerError(new RangeError("Array buffer allocation failed")).code, "out-of-memory");
  assert.equal(classifyWorkerError(new Error("heap out of memory")).code, "out-of-memory");
  const classified = classifyWorkerError(new Error("unexpected"));
  assert.equal(classified.code, "corrupt");
  assert.match(classified.message, /损坏/);
});
