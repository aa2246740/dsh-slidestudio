import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ABANDONED_LEASE_MS } from "./comment-batch-settle.mjs";
import { createBatchSettler, renewOrSettledReply, settledRestore } from "./comment-batch-settler.mjs";

const ROOT = path.resolve("/tmp/settler-project");
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const SUBMISSION = "sub-1";
const ACCEPTED_AT = "2026-11-15T09:50:00.000Z";
const NATIVE = { kind: "fake-native" };

/** @param {Record<string, unknown>} [patch] */
const batchLock = (patch = {}) => ({
  token: "token-1",
  root: ROOT,
  pagePath: "pages/01_page.page",
  submissionId: SUBMISSION,
  snapshotVersionId: "v3",
  items: [{ pagePath: "pages/01_page.page", commentId: "c1" }],
  createdAt: "2026-11-15T09:49:00.000Z",
  renewedAt: NOW - ABANDONED_LEASE_MS - 1,
  ...patch,
});

/** @param {{ accepted?: boolean, turn?: string }} [options] */
const activityOf = ({ accepted = true, turn = "complete" } = {}) => ({
  conversation: { messages: accepted ? [{ id: "m1", at: ACCEPTED_AT, reviewSubmissionId: SUBMISSION }] : [] },
  events: turn ? [{ id: "turn:1", kind: "turn", name: "turn", status: turn, at: "2026-11-15T09:50:01.000Z" }] : [],
});

/**
 * @param {{ lock?: any, activity?: any, apply?: any, failOnRestore?: boolean, clock?: { now: number } }} [options]
 */
function harness({
  lock = batchLock(),
  activity = activityOf(),
  apply = { ok: true, applied: [{ commentId: "c1" }] },
  failOnRestore = false,
  clock = { now: NOW },
} = {}) {
  /** @type {any} */
  let current = lock;
  /** @type {Array<{ outcome: string, failure?: string, unaccepted?: boolean }>} */
  const finished = [];
  /** @type {string[]} */
  const restored = [];
  /** @type {unknown[]} */
  const reported = [];
  let reads = 0;
  const settler = createBatchSettler({
    activeLock: (root) => (current && current.root === root ? current : undefined),
    async finishBatch(native, root, token, outcome, failure, unaccepted) {
      assert.equal(native, NATIVE);
      assert.equal(root, ROOT);
      assert.equal(token, lock.token);
      finished.push({ outcome, failure, unaccepted });
      if (outcome === "applied" && !apply.ok) return apply;
      current = undefined;
      return { ok: true, applied: outcome === "applied" ? apply.applied : [] };
    },
    restoreSnapshot(_native, _root, held) {
      if (failOnRestore) throw new Error("restore failed");
      restored.push(String(held.snapshotVersionId));
    },
    async readActivity() {
      reads += 1;
      return activity;
    },
    lockedRoots: () => (current ? [current.root] : []),
    onSettled: (entry) => reported.push(entry),
    now: () => clock.now,
  });
  return {
    settler,
    finished,
    restored,
    reported,
    get reads() {
      return reads;
    },
    /** @param {any} next */
    setLock(next) {
      current = next;
    },
  };
}

describe("server settlement of an abandoned comment batch", () => {
  it("applies a finished, accepted batch through the normal verification and remembers it", async () => {
    const h = harness();
    assert.equal(await h.settler.settle(NATIVE, ROOT), true);
    assert.deepEqual(h.finished, [{ outcome: "applied", failure: undefined, unaccepted: undefined }]);
    assert.equal(h.reads, 1);
    assert.equal(h.settler.settled("token-1")?.outcome, "applied");
    assert.equal(h.reported.length, 1);
  });

  it("uses the activity the caller already read instead of reading the journal again", async () => {
    const h = harness();
    assert.equal(await h.settler.settle(NATIVE, ROOT, activityOf()), true);
    assert.equal(h.reads, 0);
  });

  it("restores the snapshot and records a failure when verification rejects the turn", async () => {
    const apply = {
      ok: false,
      code: "REVIEW_BATCH_SCOPE_VIOLATION",
      error: "AI 改动超出了批注范围，正在恢复修改前版本",
    };
    const h = harness({ apply });
    assert.equal(await h.settler.settle(NATIVE, ROOT), true);
    assert.deepEqual(h.restored, ["v3"]);
    assert.deepEqual(
      h.finished.map((entry) => [entry.outcome, entry.failure]),
      [
        ["applied", undefined],
        ["failed", "AI 改动超出了批注范围，已恢复修改前版本"],
      ],
    );
    const entry = h.settler.settled("token-1");
    assert.equal(entry?.outcome, "failed");
    assert.equal(entry?.code, "REVIEW_BATCH_SCOPE_VIOLATION");
  });

  it("keeps the lease when verification fails for another reason or nothing can be restored", async () => {
    const other = harness({ apply: { ok: false, code: "REVIEW_BATCH_LOCK_UNKNOWN", error: "x" } });
    assert.equal(await other.settler.settle(NATIVE, ROOT), false);
    const noSnapshot = harness({
      lock: batchLock({ snapshotVersionId: undefined }),
      apply: { ok: false, code: "REVIEW_BATCH_INCOMPLETE", error: "x" },
    });
    assert.equal(await noSnapshot.settler.settle(NATIVE, ROOT), false);
    const broken = harness({ apply: { ok: false, code: "REVIEW_BATCH_INCOMPLETE", error: "x" }, failOnRestore: true });
    assert.equal(await broken.settler.settle(NATIVE, ROOT), false);
    for (const h of [other, noSnapshot, broken]) assert.equal(h.settler.settled("token-1"), undefined);
  });

  it("cancels a batch the Host never accepted, handing comments back to their earlier message", async () => {
    const h = harness({ activity: activityOf({ accepted: false, turn: "" }) });
    assert.equal(await h.settler.settle(NATIVE, ROOT), true);
    assert.deepEqual(h.finished, [{ outcome: "cancelled", failure: undefined, unaccepted: true }]);
    assert.equal(h.settler.settled("token-1")?.outcome, "cancelled");
  });

  it("waits while the browser renewed within 90 s, the turn runs, or nothing is locked", async () => {
    const fresh = harness({ lock: batchLock({ renewedAt: NOW - ABANDONED_LEASE_MS }) });
    assert.equal(await fresh.settler.settle(NATIVE, ROOT), false);
    assert.equal(fresh.reads, 0, "a live lease never reads the journal");
    const running = harness({ activity: activityOf({ turn: "running" }) });
    assert.equal(await running.settler.settle(NATIVE, ROOT), false);
    const none = harness();
    none.setLock(undefined);
    assert.equal(await none.settler.settle(NATIVE, ROOT), false);
    for (const h of [fresh, running, none]) assert.deepEqual(h.finished, []);
  });

  it("does nothing when the tab renewed while the journal was being read", async () => {
    let calls = 0;
    const settler = createBatchSettler({
      activeLock: () => (calls++ === 0 ? batchLock() : batchLock({ token: "token-2" })),
      finishBatch: async () => assert.fail("must not finish"),
      restoreSnapshot: () => assert.fail("must not restore"),
      readActivity: async () => activityOf(),
      now: () => NOW,
    });
    assert.equal(await settler.settle(NATIVE, ROOT), false);
    assert.equal(calls, 2);
  });

  it("runs a concurrent pair of settlements as one and swallows a failing journal read", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.settler.settle(NATIVE, ROOT), h.settler.settle(NATIVE, ROOT)]);
    assert.deepEqual([first, second].sort(), [false, true]);
    assert.equal(h.finished.length, 1);
    const failing = createBatchSettler({
      activeLock: () => batchLock(),
      finishBatch: async () => ({ ok: true }),
      restoreSnapshot: () => undefined,
      readActivity: async () => {
        throw new Error("journal unreadable");
      },
      now: () => NOW,
    });
    assert.equal(await failing.settle(NATIVE, ROOT), false);
  });

  it("never lets a throwing report callback undo a settlement", async () => {
    const settler = createBatchSettler({
      activeLock: () => batchLock(),
      finishBatch: async () => ({ ok: true, applied: [] }),
      restoreSnapshot: () => undefined,
      readActivity: async () => activityOf(),
      onSettled: () => {
        throw new Error("reporter down");
      },
      now: () => NOW,
    });
    assert.equal(await settler.settle(NATIVE, ROOT), true);
    assert.equal(settler.settled("token-1")?.outcome, "applied");
  });
});

describe("the original tab reporting in after settlement", () => {
  it("hears the server's terminal state for late apply/cancel only in the same project", async () => {
    const h = harness();
    await h.settler.settle(NATIVE, ROOT);
    assert.deepEqual(h.settler.late("token-1", "applied", ROOT), {
      ok: true,
      outcome: "applied",
      applied: [{ commentId: "c1" }],
      released: true,
      settled: true,
    });
    assert.equal(h.settler.late("token-1", "cancelled", ROOT)?.outcome, "applied");
    assert.equal(h.settler.late("token-1", "applied", "/tmp/another-project"), undefined);
    assert.equal(h.settler.late("never-issued", "applied", ROOT), undefined);
  });

  it("answers a late renewal with 200 settled instead of 409, and an unknown token with 409", async () => {
    const h = harness();
    await h.settler.settle(NATIVE, ROOT);
    const none = () => undefined;
    const settled = renewOrSettledReply("token-1", { renew: none, settled: h.settler.settled });
    assert.equal(settled.status, 200);
    assert.equal(settled.body.settled, "applied");
    const unknown = renewOrSettledReply("token-x", { renew: none, settled: h.settler.settled });
    assert.deepEqual(unknown, {
      status: 409,
      body: { error: "AI review lock is no longer active", code: "AI_REVIEW_LOCK_MISMATCH" },
    });
    const live = renewOrSettledReply("token-1", {
      renew: () => ({ pagePath: "p", expiresAt: 5 }),
      settled: () => assert.fail("a live lease never consults the ledger"),
    });
    assert.deepEqual(live, { status: 200, body: { ok: true, lock: { pagePath: "p", expiresAt: 5 } } });
  });

  it("reports a late restore of the settled snapshot as done and refuses any other version", async () => {
    const h = harness({
      apply: { ok: false, code: "REVIEW_BATCH_INCOMPLETE", error: "还有 1 条批注，正在恢复修改前版本" },
    });
    await h.settler.settle(NATIVE, ROOT);
    assert.equal(settledRestore(h.settler, "token-1", "v3")?.outcome, "failed");
    assert.equal(settledRestore(h.settler, "token-1", "v2"), undefined);
    assert.equal(settledRestore(h.settler, "", "v3"), undefined);
  });

  it("forgets a settled token after the retention window", async () => {
    const clock = { now: NOW };
    const h = harness({ clock });
    await h.settler.settle(NATIVE, ROOT);
    clock.now += 31 * 60_000;
    assert.equal(h.settler.settled("token-1"), undefined);
  });
});

describe("periodic settlement", () => {
  it("sweeps every locked root and starts one unref'd timer that stops on demand", async () => {
    const h = harness();
    assert.deepEqual(await h.settler.sweep(NATIVE), [ROOT]);
    assert.deepEqual(await h.settler.sweep(NATIVE), []);

    /** @type {Array<{ callback: () => void, ms: number, unrefed: boolean }>} */
    const scheduled = [];
    /** @type {unknown[]} */
    const cleared = [];
    const timed = createBatchSettler({
      activeLock: () => undefined,
      finishBatch: async () => ({ ok: true }),
      restoreSnapshot: () => undefined,
      readActivity: async () => ({}),
      setInterval(callback, ms) {
        const handle = {
          callback,
          ms,
          unrefed: false,
          unref() {
            handle.unrefed = true;
          },
        };
        scheduled.push(handle);
        return handle;
      },
      clearInterval: (handle) => cleared.push(handle),
    });
    const stop = timed.start(NATIVE, { intervalMs: 1234 });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.ms, 1234);
    assert.equal(scheduled[0]?.unrefed, true);
    scheduled[0]?.callback();
    stop();
    assert.deepEqual(cleared, [scheduled[0]]);
  });
});
