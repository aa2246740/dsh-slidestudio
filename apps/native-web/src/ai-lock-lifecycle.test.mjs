import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  AI_LOCK_LOST_STATUS,
  AI_LOCK_RENEW_MS,
  aiLockHeldMessage,
  aiLockLostStatus,
  createAiLockLifecycle,
  releaseWhenSettled,
  settleOrRestoreBatch,
  settledBatchError,
  settledOutcome,
} from "../public/ai-lock-lifecycle.js";
import { REVIEW_LIFECYCLE_I18N } from "../public/review-lifecycle-i18n.js";
import { ABANDONED_LEASE_MS } from "./comment-batch-settle.mjs";

/** A manual interval clock: `fire()` runs one period and lets its promise chain settle. */
function fakeTimers() {
  /** @type {Map<number, () => void>} */
  const intervals = new Map();
  let next = 1;
  return {
    intervals,
    timers: {
      setInterval: (/** @type {() => void} */ callback) => {
        intervals.set(next, callback);
        return next++;
      },
      clearInterval: (/** @type {number} */ handle) => void intervals.delete(handle),
    },
    async fire() {
      for (const callback of [...intervals.values()]) callback();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

const mismatch = () => Object.assign(new Error("lock gone"), { code: "AI_REVIEW_LOCK_MISMATCH", status: 409 });
const networkDown = () => Object.assign(new TypeError("fetch failed"));

describe("one AI lock lease lifecycle", () => {
  it("renews every 25 s, well inside the server's 90 s abandoned window", () => {
    assert.equal(AI_LOCK_RENEW_MS, 25_000);
    assert.ok(AI_LOCK_RENEW_MS * 3 < ABANDONED_LEASE_MS);
  });

  it("keeps renewing after a failed first renewal and clears the uncertainty once the network returns", async () => {
    const clock = fakeTimers();
    const answers = [networkDown(), { ok: true }];
    const renew = mock.fn(async () => {
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const onLost = mock.fn();
    const lease = createAiLockLifecycle(renew, onLost, { timers: clock.timers });
    lease.start();
    lease.start();
    assert.equal(clock.intervals.size, 1, "start is idempotent");
    await clock.fire();
    assert.equal(lease.uncertain, true);
    assert.equal(lease.running, true, "a network miss never ends the timer");
    await clock.fire();
    assert.equal(lease.uncertain, false);
    assert.equal(renew.mock.callCount(), 2);
    assert.equal(onLost.mock.callCount(), 0);
  });

  it("reports a 409 once while the edit still runs and stops renewing", async () => {
    const clock = fakeTimers();
    const onLost = mock.fn();
    const lease = createAiLockLifecycle(async () => Promise.reject(mismatch()), onLost, { timers: clock.timers });
    lease.start();
    await clock.fire();
    await clock.fire();
    assert.equal(onLost.mock.callCount(), 1);
    assert.equal(lease.running, false);
    await assert.rejects(lease.renew(), /lock gone/);
    assert.equal(onLost.mock.callCount(), 1, "a stopped lease does not report again");
  });

  it("uses the default global timers when none are injected", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const renew = mock.fn(async () => ({ ok: true }));
      const lease = createAiLockLifecycle(renew, () => undefined);
      lease.start();
      mock.timers.tick(AI_LOCK_RENEW_MS);
      assert.equal(renew.mock.callCount(), 1);
      lease.stop();
      mock.timers.tick(AI_LOCK_RENEW_MS);
      assert.equal(renew.mock.callCount(), 1);
    } finally {
      mock.timers.reset();
    }
  });

  it("a held lease always has a timer and is let go on its next good renewal", async () => {
    const clock = fakeTimers();
    let online = false;
    const lease = createAiLockLifecycle(
      async () => {
        if (!online) throw networkDown();
        return { ok: true };
      },
      () => undefined,
      { timers: clock.timers },
    );
    const release = mock.fn(async () => lease.free());
    lease.hold(release);
    assert.equal(lease.held, true);
    assert.equal(lease.running, true);
    await clock.fire();
    assert.equal(release.mock.callCount(), 0);
    assert.equal(lease.held, true);
    online = true;
    await clock.fire();
    assert.equal(release.mock.callCount(), 1);
    assert.equal(lease.held, false);
    assert.equal(lease.running, false);
  });
});

describe("a held lease whose batch the server settled meanwhile", () => {
  /** @param {unknown} answer */
  function heldLease(answer) {
    const clock = fakeTimers();
    const lease = createAiLockLifecycle(
      async () => answer,
      () => undefined,
      { timers: clock.timers },
    );
    const onApplied = mock.fn();
    /** @type {Error[]} */
    const failures = [];
    const onDone = mock.fn();
    lease.hold(releaseWhenSettled(lease, { onApplied, onFailed: (error) => void failures.push(error), onDone }));
    return { clock, lease, onApplied, failures, onDone };
  }

  it("unlocks and shows an applied batch done on the next renewal", async () => {
    const h = heldLease({ ok: true, settled: "applied" });
    await h.clock.fire();
    assert.equal(h.lease.held, false);
    assert.equal(h.onApplied.mock.callCount(), 1);
    assert.deepEqual(h.failures, []);
    assert.equal(h.onDone.mock.callCount(), 1);
  });

  for (const settled of /** @type {const} */ (["cancelled", "failed"])) {
    it(`unlocks and offers a retry for a ${settled} batch`, async () => {
      const h = heldLease({ ok: true, settled });
      await h.clock.fire();
      assert.equal(h.lease.held, false);
      assert.equal(h.failures.length, 1);
      assert.equal(h.failures[0]?.message, settledBatchError(settled).message);
      assert.equal(/** @type {any} */ (h.failures[0]).code, "REVIEW_BATCH_CANCELLED");
      assert.match(String(h.failures[0]?.message), /批注可重试/);
    });
  }

  it("stays held while renewals report a live lease", async () => {
    const h = heldLease({ ok: true, lock: { pagePath: "p", expiresAt: 1 } });
    await h.clock.fire();
    assert.equal(h.lease.held, true);
    assert.equal(h.onDone.mock.callCount(), 0);
  });
});

describe("the original tab's failure path", () => {
  /** @param {unknown[]} answers */
  function steps(answers) {
    const lease = createAiLockLifecycle(
      async () => answers.shift(),
      () => undefined,
      { timers: fakeTimers().timers },
    );
    const stopTurn = mock.fn(async () => undefined);
    const restoreSnapshot = mock.fn(async () => undefined);
    return { lease, stopTurn, restoreSnapshot };
  }

  it("skips stop and restore when the server already applied or cancelled the batch", async () => {
    for (const settled of ["applied", "cancelled", "failed"]) {
      const s = steps([{ ok: true, settled }]);
      assert.equal(await settleOrRestoreBatch(s.lease, s), settled);
      assert.equal(s.stopTurn.mock.callCount(), 0);
      assert.equal(s.restoreSnapshot.mock.callCount(), 0);
    }
  });

  it("stops, renews again and restores when the lease is still this tab's", async () => {
    const s = steps([{ ok: true }, { ok: true }]);
    assert.equal(await settleOrRestoreBatch(s.lease, s), "");
    assert.equal(s.stopTurn.mock.callCount(), 1);
    assert.equal(s.restoreSnapshot.mock.callCount(), 1);
  });

  it("decodes only known outcomes", () => {
    assert.equal(settledOutcome({ settled: "applied" }), "applied");
    assert.equal(settledOutcome({ settled: "weird" }), "");
    assert.equal(settledOutcome(null), "");
  });
});

describe("lifecycle copy", () => {
  it("has an English translation for every new Chinese message", () => {
    const sources = [
      AI_LOCK_LOST_STATUS,
      "AI 修改没有完成，服务端已恢复修改前版本，批注可重试",
      "这批批注没有被 AI 接收，服务端已取消，批注可重试",
      "AI 版本保护状态不确定，请检查生成历程；本标签继续禁止写入。",
    ];
    for (const source of sources)
      assert.ok(/** @type {Record<string, string>} */ (REVIEW_LIFECYCLE_I18N)[source], source);
    assert.equal(aiLockLostStatus(), AI_LOCK_LOST_STATUS);
    assert.match(aiLockHeldMessage(true), /版本保护状态不确定/);
    assert.match(aiLockHeldMessage(false), /尚未完成安全收尾/);
  });
});
