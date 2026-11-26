import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { ParsePool } from "./parse-pool.mjs";
import { PdfFixtureStore } from "./pdf-fixture-store.mjs";
import { pdfSample } from "./pdf-fixture-samples.mjs";
import { readPdfPage } from "./pdf-page-store.mjs";
import { enqueuePdfRender, publicPdfRenderStatus } from "./pdf-render-store.mjs";
import { PDF_RENDER_CONFIG, PdfRenderQueue } from "./pdf-render.mjs";

const CAP = PDF_RENDER_CONFIG.sampledRssCapMb;
const KILL_GRACE_MS = 1_000;
/** Stand-in render child (no canvas needed); it answers after a short paint delay. */
const STUB = fileURLToPath(new URL("./test-fixtures/pdf-images-stub-child.mjs", import.meta.url));

/** @type {string} */
let scratch;
/** @type {string} */
let renderTmp;
/** @type {string|undefined} */
let originalTmpdir;
/** @type {PdfFixtureStore} */
let store;
/** @type {ParsePool} */
let pool;
/** @type {PdfRenderQueue} */
let queue;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-pdf-limits-"));
  // runPdfRenderChild builds its temp directory from os.tmpdir(); a private root
  // lets the tests prove a killed render leaves nothing behind.
  renderTmp = path.join(scratch, "tmp");
  fs.mkdirSync(renderTmp);
  originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = renderTmp;
  store = new PdfFixtureStore(path.join(scratch, "attachments"));
  pool = new ParsePool();
  queue = new PdfRenderQueue({ probe: async () => true });
});

after(async () => {
  reapStrayChildren();
  queue?.close();
  await pool?.close();
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** @param {string} name */
const upload = (name) => store.add(name, pdfSample(name));

/** @type {Set<number>} */
const seenPids = new Set();

/**
 * A failing test must not leave a stopped child behind. Only a pid that is still
 * a direct child of this process is signalled, so a reused pid is never touched.
 */
function reapStrayChildren() {
  for (const pid of seenPids) {
    try {
      const parent = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (Number(parent) === process.pid) process.kill(pid, "SIGKILL");
    } catch {
      // ps exits non-zero for a pid that no longer exists.
    }
  }
}

/**
 * Sampler injected in place of `ps`. It remembers every child pid it is asked
 * about and reports the resident size the scenario wants the queue to believe.
 * A frozen child models a hung render: it can neither finish nor exit on its own,
 * so it disappears only if the queue really kills it.
 * @param {() => number} [rssMb]
 * @param {{freeze?: boolean}} [options]
 */
function pidRecorder(rssMb = () => 0, { freeze = false } = {}) {
  /** @type {Set<number>} */
  const pids = new Set();
  return {
    pids,
    /** @param {number|undefined} pid */
    sampleRssMb(pid) {
      if (pid && !pids.has(pid)) {
        pids.add(pid);
        seenPids.add(pid);
        if (freeze) process.kill(pid, "SIGSTOP");
      }
      return rssMb();
    },
  };
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/** Pids still alive after a grace period for the OS to reap a SIGKILLed child. */
async function survivors(/** @type {Set<number>} */ pids, graceMs = 5_000) {
  const deadline = Date.now() + graceMs;
  while ([...pids].some(isAlive) && Date.now() < deadline) await sleep(25);
  return [...pids].filter(isAlive);
}

/** @param {() => boolean} predicate @param {string} label */
async function until(predicate, label, limitMs = 15_000) {
  const deadline = Date.now() + limitMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** The parts of a PDF record that a failed render must never touch. */
function parsedState(/** @type {Record<string, any>} */ derivative) {
  return structuredClone({
    status: derivative.status,
    parser: derivative.parser?.id,
    summary: derivative.summary,
    pageCount: derivative.document.pageCount,
    chars: derivative.document.chars,
    pages: derivative.document.pages,
    styleProfile: derivative.document.styleProfile,
  });
}

/** @param {string} id @returns {any} */
function readRecord(id) {
  const record = store.read(id);
  assert.ok(record, "record must still be readable with a valid hash receipt");
  return record;
}

/** @param {string} id */
const pageFiles = (id) => fs.readdirSync(store.root).filter((name) => name.includes(`${id}.page-`));

const renderTempEntries = () => fs.readdirSync(renderTmp).filter((name) => name.startsWith("oss-pdf-render-"));

/**
 * Assert the shared outcome of a killed render: the PDF keeps its text and
 * vector hints exactly as parsed, nothing rendered, and the only change is one
 * Chinese warning with the expected code.
 * @param {any} before @param {{code: string, message: string}} expected
 */
function assertFailedButParsed(before, expected) {
  const id = before.meta.id;
  const after = readRecord(id);
  assert.deepEqual(parsedState(after.derivative), parsedState(before.derivative));
  const document = after.derivative.document;
  assert.deepEqual(document.renderedPages, []);
  assert.equal(document.renderState, "failed");
  assert.equal(document.renderMessage, expected.message);
  assert.deepEqual(after.derivative.warnings, [
    ...before.derivative.warnings,
    { code: expected.code, message: document.renderMessage },
  ]);
  assert.deepEqual(pageFiles(id), [], "no page image may stay on disk");
  assert.equal(readPdfPage(store, id, 1), undefined);
  const status = publicPdfRenderStatus(after, queue.available);
  assert.equal(status?.state, "failed");
  assert.equal(status?.renderedPages, 0);
  assert.deepEqual(status?.pages, []);
  return after;
}

/** @type {{name: string, overrides: {limits: import("./pdf-render.mjs").PdfRenderLimits, rssMb: () => number}, expected: {code: string, message: string}}[]} */
const KILLS = [
  {
    name: "per-page timeout",
    overrides: { limits: { pageTimeoutMs: 150 }, rssMb: () => 0 },
    expected: {
      code: "render-timeout",
      message: "单页 PDF 图片生成超过 0.15 秒上限，文字内容仍可读取；请稍后重试",
    },
  },
  {
    name: "document budget",
    overrides: { limits: { documentTimeoutMs: 200 }, rssMb: () => 0 },
    expected: {
      code: "render-timeout",
      message: "PDF 文档图片生成超过 0.2 秒上限，文字内容仍可读取",
    },
  },
  {
    name: "sampled RSS cap",
    overrides: { limits: {}, rssMb: () => CAP + 1 },
    expected: {
      code: "render-limit",
      message: `PDF 页面渲染超过 ${CAP} MB 内存上限，已停止；文字内容仍可读取`,
    },
  },
];

for (const { name, overrides, expected } of KILLS) {
  test(
    `${name} kill leaves the PDF parsed, reaps the child and lets the next queued PDF render`,
    { timeout: 60_000 },
    async () => {
      const killed = /** @type {any} */ (await upload("text.pdf"));
      const next = await upload("styled-report.pdf");
      assert.equal(killed.derivative.document.renderState, "queued");
      const recorder = pidRecorder(overrides.rssMb, { freeze: true });

      assert.equal(
        enqueuePdfRender({
          store,
          queue,
          record: killed,
          overrides: {
            limits: overrides.limits,
            sampleRssMb: recorder.sampleRssMb,
            sampleIntervalMs: 10,
            childPath: STUB,
          },
        }),
        true,
      );
      // Default limits and the real sampler: the kill must not poison the queue.
      assert.equal(enqueuePdfRender({ store, queue, record: next, overrides: { childPath: STUB } }), true);
      await queue.drain();

      const after = assertFailedButParsed(killed, expected);
      if (expected.code === "render-limit") {
        assert.equal(after.derivative.document.renderMetrics?.peakRssMb, CAP + 1);
      }
      assert.equal(recorder.pids.size, 1, "the document stops at the first killed child");
      assert.deepEqual(await survivors(recorder.pids, KILL_GRACE_MS), [], "the killed child must be gone");
      assert.deepEqual(renderTempEntries(), [], "the render temp directory must be removed");
      assert.equal(queue.activeCount, 0);
      assert.equal(queue.pending.length, 0);

      const rendered = readRecord(next.meta.id).derivative.document;
      assert.equal(rendered.renderState, "ready");
      assert.equal(rendered.renderedPages.length, 1);
      const page = readPdfPage(store, next.meta.id, 1);
      assert.ok(page && page.bytes[0] === 0xff && page.bytes[1] === 0xd8, "next PDF page is a JPEG");
    },
  );
}

test(
  "a sampled RSS exactly at the cap does not kill the render and is recorded as the peak",
  { timeout: 60_000 },
  async () => {
    const record = await upload("styled-report.pdf");
    const recorder = pidRecorder(() => CAP);
    enqueuePdfRender({
      store,
      queue,
      record,
      overrides: { sampleRssMb: recorder.sampleRssMb, sampleIntervalMs: 10, childPath: STUB },
    });
    await queue.drain();
    const document = readRecord(record.meta.id).derivative.document;
    assert.equal(document.renderState, "ready");
    assert.equal(document.renderMetrics.peakRssMb, CAP);
    assert.deepEqual(await survivors(recorder.pids), []);
  },
);

test(
  "a CSV parses normally while a render child is alive and while it is being killed",
  { timeout: 60_000 },
  async () => {
    const csv = Buffer.from(["name,value", ...Array.from({ length: 120 }, (_, i) => `row${i},${i}`)].join("\n"));
    const parseCsv = async (/** @type {string} */ materialId) =>
      /** @type {any} */ (await pool.run({ materialId, name: `${materialId}.csv`, bytes: csv }));
    let release = false;
    const recorder = pidRecorder(() => (release ? CAP + 1 : 100), { freeze: true });
    const pdf = await upload("text.pdf");
    enqueuePdfRender({
      store,
      queue,
      record: pdf,
      overrides: { sampleRssMb: recorder.sampleRssMb, sampleIntervalMs: 10, childPath: STUB },
    });
    await until(() => recorder.pids.size > 0, "the render child to start");
    assert.ok([...recorder.pids].every(isAlive), "the hung render child is still alive");
    assert.equal(pool.activeCount, 0, "a live render child holds no parse-pool slot");

    const during = await parseCsv("csv-during-render");
    assert.equal(during.ok, true);
    assert.equal(during.derivative.status, "ok");
    assert.equal(
      readRecord(pdf.meta.id).derivative.document.renderState,
      "running",
      "the CSV finished while the render was still in progress",
    );

    release = true;
    const [whileKilled] = await Promise.all([parseCsv("csv-during-kill"), queue.drain()]);
    assert.equal(whileKilled.derivative.status, "ok");
    assertFailedButParsed(pdf, {
      code: "render-limit",
      message: `PDF 页面渲染超过 ${CAP} MB 内存上限，已停止；文字内容仍可读取`,
    });
    assert.deepEqual(await survivors(recorder.pids, KILL_GRACE_MS), []);
    const pair = await Promise.all([parseCsv("csv-after-a"), parseCsv("csv-after-b")]);
    assert.deepEqual(
      pair.map((result) => result.derivative.status),
      ["ok", "ok"],
      "the pool still runs its full concurrency after a render kill",
    );
  },
);

test("limit overrides are reachable only through injected call parameters", () => {
  const sources = ["pdf-render.mjs", "pdf-render-store.mjs", "intake.mjs", "attachment-routes.mjs"];
  const text = Object.fromEntries(
    sources.map((file) => [file, fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8")]),
  );
  for (const file of ["pdf-render.mjs", "pdf-render-store.mjs"]) {
    assert.doesNotMatch(text[file] ?? "", /process\.env\.(?!PATH\b)/, `${file} must not read limits from env`);
  }
  for (const file of ["intake.mjs", "attachment-routes.mjs"]) {
    assert.doesNotMatch(text[file] ?? "", /overrides|sampleRssMb|sampleIntervalMs|childPath/, `${file} passes none`);
  }
  assert.equal(PDF_RENDER_CONFIG.sampledRssCapMb, 1024);
  assert.equal(PDF_RENDER_CONFIG.pageTimeoutMs, 30_000);
  assert.equal(PDF_RENDER_CONFIG.documentTimeoutMs, 180_000);
  assert.ok(Object.isFrozen(PDF_RENDER_CONFIG));
});
