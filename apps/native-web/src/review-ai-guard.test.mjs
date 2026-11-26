import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import {
  REVIEW_AI_LOCK_REL,
  readReviewAiGuardFile,
  removeReviewAiGuard,
  reviewAiGuardRecord,
  withReviewAiGuardLifted,
  writeReviewAiGuard,
} from "./review-ai-guard.mjs";
import * as lockModule from "./review-ai-lock.mjs";

const { acquireReviewAiLock, releaseReviewAiLock, renewReviewAiLock, snapshotAssistantRequestId } = lockModule;

/** @type {string[]} */
const roots = [];
const scratch = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-ai-guard-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  mock.timers.reset();
  for (const root of roots.splice(0)) {
    releaseAll(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
/** @param {string} root */
function releaseAll(root) {
  const lock = lockModule.activeReviewAiLock(root);
  if (lock) releaseReviewAiLock(root, lock.token);
}

const baseLock = {
  token: "t-1",
  pagePath: "pages/01.page",
  createdAt: "2026-11-15T10:00:00.000Z",
  expiresAt: 1_000,
};

describe("durable review guard file", () => {
  it("writes the legacy single-comment shape and adds batch arrays only when present", () => {
    const root = scratch();
    writeReviewAiGuard(root, baseLock);
    const single = readReviewAiGuardFile(root);
    assert.deepEqual(Object.keys(single ?? {}), ["version", "token", "pagePath", "createdAt", "expiresAt"]);
    const record = reviewAiGuardRecord({ ...baseLock, items: [{ commentId: "c" }], projectPages: [] });
    assert.deepEqual(record.items, [{ commentId: "c" }]);
    assert.equal("projectPages" in record, false);
    assert.equal("renewedAt" in reviewAiGuardRecord(/** @type {any} */ ({ ...baseLock, renewedAt: 5 })), false);
    removeReviewAiGuard(root);
    assert.equal(readReviewAiGuardFile(root), undefined);
  });

  it("reads a corrupt or non-object guard as absent", () => {
    const root = scratch();
    const file = path.join(root, REVIEW_AI_LOCK_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const raw of ["{", "42", "null"]) {
      fs.writeFileSync(file, raw);
      assert.equal(readReviewAiGuardFile(root), undefined);
    }
  });

  it("lifts the guard only for the task and always puts it back", () => {
    const root = scratch();
    writeReviewAiGuard(root, baseLock);
    const seen = withReviewAiGuardLifted(root, baseLock, () => readReviewAiGuardFile(root));
    assert.equal(seen, undefined);
    assert.equal(readReviewAiGuardFile(root)?.token, "t-1");
    assert.throws(() =>
      withReviewAiGuardLifted(root, baseLock, () => {
        throw new Error("snapshot failed");
      }),
    );
    assert.equal(readReviewAiGuardFile(root)?.token, "t-1");
    removeReviewAiGuard(root);
    assert.equal(
      withReviewAiGuardLifted(root, undefined, () => "ran"),
      "ran",
    );
    assert.equal(readReviewAiGuardFile(root), undefined, "no lock means no guard is written");
  });
});

describe("lease liveness for the abandoned-batch settler", () => {
  it("records renewedAt on acquire and on every renewal, in memory only", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const root = scratch();
    const acquired = acquireReviewAiLock(root, { pagePath: "pages/01.page" }, String);
    assert.equal(acquired.conflict, false);
    const lock = acquired.lock;
    assert.ok(lock);
    assert.equal(lock.renewedAt, 1_000_000);
    mock.timers.tick(60_000);
    assert.equal(renewReviewAiLock(lock.token)?.renewedAt, 1_060_000);
    assert.equal("renewedAt" in (readReviewAiGuardFile(root) ?? {}), false);
  });

  it("re-exports the guard IO under its historical names", () => {
    assert.equal(lockModule.writeReviewAiGuard, writeReviewAiGuard);
    assert.equal(lockModule.readReviewAiGuardFile, readReviewAiGuardFile);
    assert.equal(lockModule.removeReviewAiGuard, removeReviewAiGuard);
  });
});

describe("pre-edit snapshot request identity", () => {
  it("uses the server-issued submission id for a comment batch and ignores the client's", () => {
    const batch = { ...baseLock, root: "/r", submissionId: "sub-1", items: [] };
    assert.equal(snapshotAssistantRequestId(batch, "client-id"), "sub-1");
    assert.equal(snapshotAssistantRequestId({ ...baseLock, root: "/r" }, "client-id"), "client-id");
    assert.equal(snapshotAssistantRequestId({ ...baseLock, root: "/r", commentId: "c" }, "client-id"), undefined);
    assert.equal(snapshotAssistantRequestId({ ...baseLock, root: "/r" }, 7), undefined);
    assert.equal(snapshotAssistantRequestId(undefined, "client-id"), undefined);
  });
});
