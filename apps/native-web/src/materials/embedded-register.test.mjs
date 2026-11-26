import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { openRegistration, registerCandidates } from "./embedded-register.mjs";
import { solidPng } from "../testlib/pptx-fixture.mjs";

/** @type {Buffer[]} */
let pictures;

before(() => {
  pictures = Array.from({ length: 8 }, (_, index) => solidPng({ width: 80, height: 80, rgb: [index * 30, 90, 160] }));
});

const candidateAt = (/** @type {number} */ index, name = `p${index}.png`, bytes = pictures[index]) => ({
  name,
  bytes,
  position: { page: index + 1 },
});

/**
 * A pool whose jobs take as long as `delays[name]` says, then succeed (or fail when the
 * name starts with "bad"). It records how many ran at once.
 * @param {{maxConcurrent: number, delays?: Record<string, number>}} options
 */
function steppedPool({ maxConcurrent, delays = {} }) {
  /** @type {{inFlight: number, maxInFlight: number, started: string[], finished: string[]}} */
  const state = { inFlight: 0, maxInFlight: 0, started: [], finished: [] };
  return {
    maxConcurrent,
    state,
    /**
     * @param {{ name: string; materialId: any; }} job
     */
    async run(job) {
      state.started.push(job.name);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, delays[job.name] ?? 0));
      state.inFlight -= 1;
      state.finished.push(job.name);
      if (job.name.startsWith("bad")) return { ok: false, code: "corrupt", message: "bad" };
      return {
        ok: true,
        derivative: {
          materialId: job.materialId,
          kind: "image",
          status: "ok",
          warnings: [],
          summary: { zh: "PNG 图片 · 80×80" },
          image: { width: 80, height: 80 },
        },
      };
    },
  };
}

function memoryStore() {
  let sequence = 0;
  return /** @type {import("../attachments.mjs").AttachmentStore} */ ({
    nextId: (/** @type {any} */ name) => `id-${++sequence}-${name}`,
    record: async ({ derivative }) => ({ meta: { id: derivative.materialId }, derivative }),
  });
}

const OPTIONS = {
  store: undefined,
  parent: { materialId: "parent", name: "doc.pdf" },
  origin: /** @type {const} */ ("pdf"),
  limit: 40,
  budgetMs: 25_000,
  now: Date.now,
};

const sleep = (/** @type {number | undefined} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {Record<string, unknown>} overrides */
async function register(overrides) {
  /** @type {Record<string, number>} */
  const skipped = {};
  // `overrides` supplies the pool and candidates each test drives.
  const result = await registerCandidates(
    /** @type {Parameters<typeof registerCandidates>[0]} */ ({
      store: memoryStore(),
      parent: { materialId: "parent", name: "doc.pdf" },
      origin: "pdf",
      limit: 40,
      budgetMs: 25_000,
      now: Date.now,
      bump: (key, count = 1) => {
        skipped[key] = (skipped[key] ?? 0) + count;
      },
      ...overrides,
    }),
  );
  return { ...result, skipped };
}

describe("VAL-PDF-007: embedded picture registration runs side by side and stays in document order", () => {
  test("registers as many at once as the pool runs and returns document order whatever finishes first", async () => {
    const pool = steppedPool({
      maxConcurrent: 2,
      delays: { "p0.png": 60, "p1.png": 5, "p2.png": 5 },
    });
    const { images, createdIds } = await register({
      pool,
      candidates: [0, 1, 2, 3].map((index) => candidateAt(index)),
    });
    assert.equal(pool.state.maxInFlight, 2, "bounded by the pool limit, and actually parallel");
    assert.deepEqual(
      images.map(({ name }) => name),
      ["p0.png", "p1.png", "p2.png", "p3.png"],
    );
    assert.deepEqual(
      images.map(({ position }) => position.page),
      [1, 2, 3, 4],
    );
    assert.equal(pool.state.finished[0], "p1.png", "the slow first picture finished after a later one");
    assert.deepEqual(
      createdIds,
      images.map(({ id }) => id),
    );
    assert.deepEqual(
      images.map(({ note }) => note),
      ["来自 PDF 第 1 页", "来自 PDF 第 2 页", "来自 PDF 第 3 页", "来自 PDF 第 4 页"],
    );
  });

  test("a one-wide pool registers one at a time", async () => {
    const pool = steppedPool({ maxConcurrent: 1 });
    await register({ pool, candidates: [0, 1, 2].map((index) => candidateAt(index)) });
    assert.equal(pool.state.maxInFlight, 1);
  });

  test("the limit keeps the first pictures of the document, and failures give way to later ones", async () => {
    const pool = steppedPool({ maxConcurrent: 2, delays: { "p1.png": 20 } });
    const { images, skipped } = await register({
      pool,
      limit: 3,
      candidates: [
        candidateAt(0, "bad0.png", pictures[0]),
        candidateAt(1),
        candidateAt(2),
        candidateAt(3),
        candidateAt(4),
        candidateAt(5),
      ],
    });
    assert.deepEqual(
      images.map(({ name }) => name),
      ["p1.png", "p2.png", "p3.png"],
    );
    assert.equal(skipped.undecodable, 1);
    assert.equal(pool.state.started.includes("p4.png"), false, "no parse past the limit");
    assert.equal(pool.state.started.includes("p5.png"), false);
  });

  test("duplicates and unsupported bytes never reach the pool and are counted", async () => {
    const pool = steppedPool({ maxConcurrent: 2 });
    const { images, skipped } = await register({
      pool,
      candidates: [
        candidateAt(0),
        candidateAt(0, "again.png", pictures[0]),
        { name: "vector.emf", bytes: Buffer.from("not an image"), position: { page: 3 } },
        candidateAt(1),
      ],
    });
    assert.deepEqual(
      images.map(({ name }) => name),
      ["p0.png", "p1.png"],
    );
    assert.deepEqual(skipped, { duplicate: 1, unsupported: 1 });
    assert.deepEqual([...pool.state.started].sort(), ["p0.png", "p1.png"]);
  });

  test("candidates that were not started when the time ran out are counted as budget", async () => {
    const pool = steppedPool({ maxConcurrent: 2, delays: { "p0.png": 30, "p1.png": 30 } });
    let ticks = 0;
    // The start reading and the first two pulls are inside the budget, later pulls are not.
    const now = () => (ticks++ < 3 ? 0 : 10_000);
    const { images, skipped } = await register({
      pool,
      now,
      budgetMs: 1_000,
      candidates: [0, 1, 2, 3, 4].map((index) => candidateAt(index)),
    });
    assert.deepEqual(
      images.map(({ name }) => name),
      ["p0.png", "p1.png"],
    );
    assert.equal(skipped.budget, 3);
  });

  test("a DOCX picture that does not decode is refused before any parse", async () => {
    const pool = steppedPool({ maxConcurrent: 2 });
    const { images, skipped } = await register({
      pool,
      origin: "docx",
      verify: async (/** @type {Buffer<ArrayBufferLike>} */ bytes) => bytes === pictures[1],
      candidates: [0, 1].map((index) => candidateAt(index)),
    });
    assert.deepEqual(
      images.map(({ name }) => name),
      ["p1.png"],
    );
    assert.equal(skipped.undecodable, 1);
    assert.deepEqual(pool.state.started, ["p1.png"]);
  });
});

describe("VAL-PDF-007: pictures can arrive while earlier ones are being registered", () => {
  /** @param {ReturnType<typeof steppedPool>} pool */
  const session = (pool, extra = {}) => {
    /** @type {Record<string, number>} */
    const skipped = {};
    const opened = openRegistration({
      ...OPTIONS,
      store: memoryStore(),
      // The stepped pool is a test double that implements only `maxConcurrent` and `run`.
      pool: /** @type {import("./parse-pool.mjs").ParsePool} */ (/** @type {unknown} */ (pool)),
      bump: (key, count = 1) => {
        skipped[key] = (skipped[key] ?? 0) + count;
      },
      ...extra,
    });
    return { ...opened, skipped };
  };

  test("a picture is parsed before the last ones have arrived, and the result is in arrival order", async () => {
    const pool = steppedPool({ maxConcurrent: 2, delays: { "p0.png": 40 } });
    const opened = session(pool);
    opened.push([candidateAt(0)]);
    await sleep(15);
    assert.deepEqual(pool.state.started, ["p0.png"], "p0 is already being parsed");
    assert.equal(pool.state.finished.length, 0);
    opened.push([candidateAt(1), candidateAt(2)]);
    await sleep(5);
    opened.push([candidateAt(3)]);
    opened.close();
    const { images } = await opened.done;
    assert.deepEqual(
      images.map(({ name }) => name),
      ["p0.png", "p1.png", "p2.png", "p3.png"],
    );
  });

  test("closing without any picture ends the session with nothing", async () => {
    const opened = session(steppedPool({ maxConcurrent: 2 }));
    opened.close();
    assert.deepEqual(await opened.done, { images: [], createdIds: [] });
  });

  test("pictures pushed after the session is closed are ignored", async () => {
    const pool = steppedPool({ maxConcurrent: 2 });
    const opened = session(pool);
    opened.push([candidateAt(0)]);
    opened.close();
    opened.push([candidateAt(1)]);
    const { images } = await opened.done;
    assert.deepEqual(
      images.map(({ name }) => name),
      ["p0.png"],
    );
  });

  test("the limit counts the first pictures across batches and later failures give way", async () => {
    const pool = steppedPool({ maxConcurrent: 2 });
    const opened = session(pool, { limit: 2 });
    opened.push([candidateAt(0, "bad0.png", pictures[0])]);
    await sleep(10);
    opened.push([candidateAt(1), candidateAt(2), candidateAt(3)]);
    opened.close();
    const { images } = await opened.done;
    assert.deepEqual(
      images.map(({ name }) => name),
      ["p1.png", "p2.png"],
    );
    assert.equal(opened.skipped.undecodable, 1);
    assert.equal(pool.state.started.includes("p3.png"), false);
  });

  test("the time allowed starts with the first picture, not with the session", async () => {
    const pool = steppedPool({ maxConcurrent: 2 });
    let clock = 0;
    const opened = session(pool, { budgetMs: 100, now: () => clock });
    clock = 50_000;
    opened.push([candidateAt(0)]);
    opened.close();
    const { images } = await opened.done;
    assert.equal(images.length, 1, "waiting for the first picture used none of the budget");
  });
});
