import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ABANDONED_LEASE_MS,
  abandonedBatchAction,
  lateBatchResult,
  recallSettled,
  rememberSettled,
  SETTLED_RETENTION_MS,
  SETTLED_MAX_ENTRIES,
} from "./comment-batch-settle.mjs";

const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const SUBMISSION = "11111111-1111-4111-8111-111111111111";
const ACCEPTED_AT = "2026-11-15T09:50:00.000Z";

const batchLock = (patch = {}) => ({
  token: "token-1",
  submissionId: SUBMISSION,
  items: [{ pagePath: "pages/01_page.page", commentId: "c1" }],
  createdAt: "2026-11-15T09:49:00.000Z",
  renewedAt: NOW - ABANDONED_LEASE_MS - 1,
  ...patch,
});
const message = (patch = {}) => ({
  id: "m1",
  at: ACCEPTED_AT,
  reviewSubmissionId: SUBMISSION,
  ...patch,
});
/** @param {string} status @param {string} [at] @param {Record<string, unknown>} [patch] */
const turn = (status, at = "2026-11-15T09:50:01.000Z", patch = {}) => ({
  id: "turn:1",
  at,
  kind: "turn",
  name: "turn",
  status,
  ...patch,
});
/** @param {{ lock?: any, messages?: unknown[], events?: unknown[], now?: number }} [input] */
const decide = ({ lock = batchLock(), messages = [message()], events = [], now = NOW } = {}) =>
  abandonedBatchAction({ lock, messages, events, now });

describe("abandoned comment batch decision table", () => {
  it("applies once the turn is over and the browser has been silent for more than 90 s", () => {
    assert.equal(ABANDONED_LEASE_MS, 90_000);
    assert.equal(decide({ events: [turn("complete")] }), "apply");
  });

  it("treats exactly 90000 ms of silence as a browser that is still here", () => {
    const lock = batchLock({ renewedAt: NOW - 90_000 });
    assert.equal(decide({ lock, events: [turn("complete")] }), "wait");
    assert.equal(decide({ lock: batchLock({ renewedAt: NOW - 90_001 }), events: [turn("complete")] }), "apply");
  });

  it("hands a failed turn to verification, which decides between apply and restore", () => {
    assert.equal(decide({ events: [turn("failed")] }), "apply");
  });

  it("waits while the accepted turn is still running", () => {
    assert.equal(decide({ events: [turn("running")] }), "wait");
    assert.equal(
      decide({
        events: [
          turn("complete", "2026-11-15T09:50:01.000Z"),
          turn("running", "2026-11-15T09:55:00.000Z", { id: "turn:2" }),
        ],
      }),
      "wait",
    );
  });

  it("waits when the Host accepted the batch but no turn has been recorded yet", () => {
    assert.equal(decide({ events: [] }), "wait");
  });

  it("ignores a turn that ended before the batch was accepted", () => {
    assert.equal(decide({ events: [turn("complete", "2026-11-15T09:40:00.000Z")] }), "wait");
  });

  it("ignores events that are not turn rows", () => {
    assert.equal(
      decide({
        events: [
          {
            id: "t",
            at: "2026-11-15T09:50:02.000Z",
            kind: "tool",
            name: "turn",
            status: "complete",
          },
        ],
      }),
      "wait",
    );
    assert.equal(
      decide({
        events: [
          {
            id: "t",
            at: "2026-11-15T09:50:02.000Z",
            kind: "turn",
            name: "write_page",
            status: "complete",
          },
        ],
      }),
      "wait",
    );
  });

  it("cancels a batch the Host never took: no message and no turn since the lock was taken", () => {
    assert.equal(decide({ messages: [], events: [] }), "cancel-unaccepted");
    assert.equal(
      decide({
        messages: [message({ reviewSubmissionId: "another-submission" })],
        events: [turn("complete", "2026-11-15T09:30:00.000Z")],
      }),
      "cancel-unaccepted",
    );
  });

  it("does not cancel when a turn started after the lock but no message carries this batch", () => {
    assert.equal(decide({ messages: [], events: [turn("running", "2026-11-15T09:51:00.000Z")] }), "wait");
  });

  it("never settles while the browser is still renewing", () => {
    const lock = batchLock({ renewedAt: NOW - 10_000 });
    assert.equal(decide({ lock, events: [turn("complete")] }), "wait");
    assert.equal(decide({ lock, messages: [], events: [] }), "wait");
  });

  it("only handles batch locks", () => {
    const events = [turn("complete")];
    assert.equal(decide({ lock: batchLock({ items: undefined }), events }), "wait");
    assert.equal(decide({ lock: batchLock({ items: [] }), events }), "wait");
    assert.equal(decide({ lock: batchLock({ submissionId: undefined }), events }), "wait");
    assert.equal(abandonedBatchAction({ messages: [message()], events, now: NOW }), "wait");
  });

  it("falls back to the creation time when a lock has never been renewed", () => {
    const old = batchLock({
      renewedAt: undefined,
      createdAt: new Date(NOW - 200_000).toISOString(),
    });
    assert.equal(
      decide({
        lock: old,
        events: [turn("complete", new Date(NOW - 100_000).toISOString())],
        messages: [message({ at: new Date(NOW - 150_000).toISOString() })],
      }),
      "apply",
    );
    const fresh = batchLock({
      renewedAt: undefined,
      createdAt: new Date(NOW - 5_000).toISOString(),
    });
    assert.equal(decide({ lock: fresh, events: [turn("complete")] }), "wait");
  });

  it("does not guess from malformed inputs", () => {
    // An unreadable conversation or journal is missing evidence, never evidence of "not accepted".
    const lock = batchLock();
    assert.equal(abandonedBatchAction({ lock, events: [], now: NOW }), "wait");
    assert.equal(abandonedBatchAction({ lock, messages: [], now: NOW }), "wait");
    assert.equal(decide({ messages: [message({ at: "not a date" })], events: [turn("complete")] }), "wait");
    assert.equal(decide({ events: [turn("complete", "not a date")] }), "wait");
  });
});

describe("settled batch memory for a late original tab", () => {
  /** @param {Record<string, unknown>} [patch] @returns {import("./comment-batch-settle.mjs").SettledBatch} */
  const entry = (patch = {}) => ({
    root: "/p",
    pagePath: "pages/01_page.page",
    applied: [{ pagePath: "pages/01_page.page", commentId: "c1" }],
    ...patch,
    outcome: /** @type {"applied" | "failed" | "cancelled"} */ (patch.outcome ?? "applied"),
  });

  it("remembers a settled token for a bounded time", () => {
    const ledger = new Map();
    rememberSettled(ledger, "t", entry(), NOW);
    assert.equal(recallSettled(ledger, "t", NOW + SETTLED_RETENTION_MS - 1)?.outcome, "applied");
    assert.equal(recallSettled(ledger, "t", NOW + SETTLED_RETENTION_MS + 1), undefined);
    assert.equal(ledger.size, 0, "an expired entry is dropped when it is read");
  });

  it("caps the number of remembered tokens, dropping the oldest", () => {
    const ledger = new Map();
    for (let index = 0; index < SETTLED_MAX_ENTRIES + 5; index += 1)
      rememberSettled(ledger, `t${index}`, entry(), NOW + index);
    assert.equal(ledger.size, SETTLED_MAX_ENTRIES);
    assert.equal(recallSettled(ledger, "t0", NOW + 100), undefined);
    assert.ok(recallSettled(ledger, `t${SETTLED_MAX_ENTRIES + 4}`, NOW + 100));
  });

  it("answers a late apply with the server's own terminal state", () => {
    const applied = lateBatchResult(entry(), "applied");
    assert.equal(applied.ok, true);
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.released, true);
    assert.equal(applied.error, undefined);
    assert.equal(applied.applied.length, 1);

    const failed = lateBatchResult(
      entry({
        outcome: "failed",
        code: "REVIEW_BATCH_SCOPE_VIOLATION",
        failure: "AI 改动超出了批注范围，已恢复修改前版本",
        applied: [],
      }),
      "applied",
    );
    assert.equal(failed.ok, undefined);
    assert.equal(failed.code, "REVIEW_BATCH_SCOPE_VIOLATION");
    assert.equal(failed.error, "AI 改动超出了批注范围，已恢复修改前版本");

    const cancelled = lateBatchResult(entry({ outcome: "cancelled", applied: [] }), "applied");
    assert.equal(cancelled.code, "REVIEW_BATCH_CANCELLED");
  });

  it("never reports a server-applied batch as failed when the tab later cancels", () => {
    for (const requested of /** @type {const} */ (["failed", "cancelled"])) {
      const result = lateBatchResult(entry(), requested);
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "applied");
    }
  });

  it("acknowledges a late cancel of a failed or cancelled batch without a second release", () => {
    const failed = lateBatchResult(entry({ outcome: "failed", failure: "x", applied: [] }), "failed");
    assert.equal(failed.ok, true);
    assert.equal(failed.outcome, "failed");
    const cancelled = lateBatchResult(entry({ outcome: "cancelled", applied: [] }), "cancelled");
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.outcome, "cancelled");
  });
});
