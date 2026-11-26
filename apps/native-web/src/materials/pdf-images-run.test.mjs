import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { optionalNativeAvailable } from "../optional-native.mjs";
import { createPdfImageRunner, runPdfImagesChild } from "./pdf-images-run.mjs";
import { pdfSample } from "./pdf-fixture-samples.mjs";

const STUB = fileURLToPath(new URL("./test-fixtures/pdf-images-stub-child.mjs", import.meta.url));
const plan = (/** @type {any} */ value) => Buffer.from(JSON.stringify(value));
const run = (/** @type {any} */ value, overrides = {}) =>
  runPdfImagesChild({ bytes: plan(value), overrides: { childPath: STUB, ...overrides } });

/**
 * Runs `fn` with the temp root pointed at an empty directory and returns the
 * entries it left there.
 * @param {() => unknown} fn
 */
async function tempLeftovers(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-images-temp-"));
  const savedTempDir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    await fn();
    return fs.readdirSync(root);
  } finally {
    if (savedTempDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTempDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("VAL-PDF-007: PDF image extraction child process", () => {
  test("a finished extraction returns every streamed picture and the summary", async () => {
    const result = await run({ mode: "ok", pages: 3 });
    assert.deepEqual(
      result.images.map((image) => image.page),
      [1, 2, 3],
    );
    assert.ok(Buffer.isBuffer(result.images[0].bytes));
    assert.equal(result.countComplete, true);
    assert.equal(result.stopped, undefined);
    assert.equal(result.pageCount, 3);
  });

  test("each page's pictures reach onImages as soon as the page is done, in page order", async () => {
    /** @type {any[]} */ const arrivals = [];
    const result = await runPdfImagesChild({
      bytes: plan({ mode: "ok", pages: 3, gapMs: 30 }),
      overrides: { childPath: STUB },
      onImages: (images) => arrivals.push({ at: Date.now(), pages: images.map((image) => image.page) }),
    });
    assert.deepEqual(
      arrivals.map(({ pages }) => pages),
      [[1], [2], [3]],
    );
    assert.ok(arrivals[2].at - arrivals[0].at >= 40, "they did not all arrive at the end");
    assert.deepEqual(
      result.images.map((image) => image.page),
      [1, 2, 3],
      "the result still lists every picture",
    );
    assert.ok(Buffer.isBuffer(arrivals.length && result.images[0].bytes));
  });

  test("an aborted run kills the child, keeps nothing and rejects with the aborted code", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runPdfImagesChild({
      bytes: plan({ mode: "hang", pages: 2, gapMs: 10 }),
      signal: controller.signal,
      overrides: { childPath: STUB },
    });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending, (/** @type {any} */ error) => {
      assert.equal(error.code, "aborted");
      return true;
    });
    assert.ok(Date.now() - started < 5_000, "the hung child did not have to time out");
  });

  test("a run aborted before it starts never forks a child, and a queued one never starts", async () => {
    const early = new AbortController();
    early.abort();
    await assert.rejects(
      runPdfImagesChild({
        bytes: plan({ mode: "ok", pages: 1 }),
        signal: early.signal,
        overrides: { childPath: "/nonexistent/child.mjs" },
      }),
      { code: "aborted" },
    );

    let starts = 0;
    const runner = createPdfImageRunner({
      run: (input) => {
        starts += 1;
        return runPdfImagesChild({ ...input, overrides: { childPath: STUB } });
      },
    });
    const queued = new AbortController();
    const first = runner({ bytes: plan({ mode: "ok", pages: 2, gapMs: 60 }) });
    const second = runner({ bytes: plan({ mode: "ok", pages: 1 }), signal: queued.signal });
    queued.abort();
    await first;
    await assert.rejects(second, { code: "aborted" });
    assert.equal(starts, 2, "run() is entered for the queued job but rejects before forking");
  });

  test("a listener that throws does not stop the extraction", async () => {
    const result = await runPdfImagesChild({
      bytes: plan({ mode: "ok", pages: 2 }),
      overrides: { childPath: STUB },
      onImages: () => {
        throw new Error("listener failed");
      },
    });
    assert.equal(result.images.length, 2);
    assert.equal(result.countComplete, true);
  });

  test("the memory cap stops the child and keeps the pictures already sent", async () => {
    let sampled = 0;
    const result = await run(
      { mode: "hang", pages: 3, gapMs: 50 },
      {
        // Quiet for the first samples, then over the cap while the child still hangs.
        sampleRssMb: () => (++sampled > 8 ? 4096 : 10),
        sampleIntervalMs: 40,
        limits: { sampledRssCapMb: 1024, timeoutMs: 20_000 },
      },
    );
    assert.equal(result.stopped, "memory");
    assert.equal(result.timedOut, false);
    assert.equal(result.countComplete, false);
    assert.deepEqual(
      result.images.map((image) => image.page),
      [1, 2, 3],
    );
    assert.equal(result.qualifying, 3);
  });

  test("the wall-clock limit stops a hung child and says it timed out", async () => {
    const result = await run(
      { mode: "hang", pages: 2, gapMs: 10 },
      { limits: { timeoutMs: 400 }, sampleRssMb: () => 10 },
    );
    assert.equal(result.stopped, "time");
    assert.equal(result.timedOut, true);
    assert.equal(result.images.length, 2);
  });

  test("a crashing child rejects so the document gets a warning, not a half-result", async () => {
    await assert.rejects(run({ mode: "crash", pages: 1 }), /异常退出/);
  });

  test("a child that reports an encrypted file rejects with its code and Chinese message", async () => {
    await assert.rejects(run({ mode: "error", pages: 1 }), (/** @type {any} */ error) => {
      assert.equal(error.code, "encrypted");
      assert.match(error.message, /已加密/);
      return true;
    });
  });

  test("the extraction child gets PATH and the temp variables, never other parent variables", async () => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-images-env-"));
    const reportEnvTo = path.join(probeDir, "env.json");
    const names = ["TMPDIR", "TMP", "TEMP", "OSS_CHILD_PROBE_SECRET"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.TMPDIR = probeDir;
    process.env.TMP = probeDir;
    process.env.TEMP = probeDir;
    process.env.OSS_CHILD_PROBE_SECRET = "credential-that-must-not-leak";
    try {
      await run({ mode: "ok", pages: 1, reportEnvTo });
      const received = JSON.parse(fs.readFileSync(reportEnvTo, "utf8"))
        // fork adds Node's IPC bootstrap variables and macOS adds __CF_USER_TEXT_ENCODING;
        // the caller passes everything else.
        .filter((/** @type {any} */ name) => !name.startsWith("NODE_CHANNEL_") && !name.startsWith("__CF_"))
        .sort();
      assert.deepEqual(received, ["PATH", "TEMP", "TMP", "TMPDIR"]);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });

  test("the real child extracts from a real PDF end to end", { timeout: 60_000 }, async () => {
    const bytes = pdfSample("photo-in.pdf");
    if (!(await optionalNativeAvailable("sharp"))) {
      // Without the optional encoder the child degrades to a typed rejection.
      await assert.rejects(runPdfImagesChild({ bytes }), { code: "images-unavailable" });
      return;
    }
    const result = await runPdfImagesChild({ bytes });
    assert.deepEqual(
      result.images.map(({ page, width, height }) => ({ page, width, height })),
      [
        { page: 1, width: 240, height: 160 },
        { page: 2, width: 160, height: 200 },
      ],
    );
    assert.equal(result.qualifying, 2);
    assert.equal(result.skipped.small, 3);
    assert.equal(result.countComplete, true);
    assert.equal(result.stopped, undefined);
  });

  test("extraction jobs run one at a time and the queue refuses work beyond its cap", async () => {
    let active = 0;
    let peak = 0;
    const slow = createPdfImageRunner({
      queueCap: 3,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return /** @type {any} */ ({ images: [], qualifying: 0, countComplete: true, pagesScanned: 0, pageCount: 0 });
      },
    });
    const jobs = [1, 2, 3].map(() => slow({ bytes: new Uint8Array() }));
    await assert.rejects(slow({ bytes: new Uint8Array() }), (/** @type {any} */ error) => error.code === "queue-full");
    await Promise.all(jobs);
    assert.equal(peak, 1);
    await slow({ bytes: new Uint8Array() });
  });

  test("a failed job does not block the next one", async () => {
    let calls = 0;
    const runner = createPdfImageRunner({
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return /** @type {any} */ ({ images: [], qualifying: 0, countComplete: true, pagesScanned: 0, pageCount: 0 });
      },
    });
    await assert.rejects(runner({ bytes: new Uint8Array() }), /boom/);
    await runner({ bytes: new Uint8Array() });
    assert.equal(calls, 2);
  });

  test("an input that cannot be written throws and leaves no temp directory behind", async () => {
    const leftovers = await tempLeftovers(() => {
      assert.throws(() => runPdfImagesChild({ bytes: /** @type {any} */ ({}), overrides: { childPath: STUB } }));
    });
    assert.deepEqual(leftovers, []);
  });

  test("a child that cannot be forked rejects and leaves no temp directory behind", async () => {
    const leftovers = await tempLeftovers(async () => {
      await assert.rejects(run({ mode: "ok", pages: 1 }, { childPath: 42 }));
    });
    assert.deepEqual(leftovers, []);
  });
});
