import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  batchThreadUpdate,
  commentAssociation,
  createCommentSubmission,
  finishCommentSubmission,
  readCommentSubmissions,
  readDecodedCommentSubmissions,
  submissionStatusForOutcome,
  unacceptedBatchRollback,
} from "./comment-submissions.mjs";

const prepared = () => [
  {
    pagePath: "pages/a.page",
    comment: { id: "comment", revision: 1, text: "修改标题", scope: { elementIds: ["title"] } },
  },
];
/** @param {(root: string) => void} run */
function scratch(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "comment-receipt-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the native receipt writer retains exact scope and identity across restart reads", () => {
  scratch((root) => {
    const first = createCommentSubmission(root, prepared(), "修改");
    assert.equal(first.status, "preparing");
    finishCommentSubmission(root, first.id, "failed", "范围校验失败");
    const saved = readCommentSubmissions(root);
    assert.equal(saved[0]?.id, first.id);
    assert.equal(saved[0]?.status, "failed");
    assert.equal(saved[0]?.error, "范围校验失败");
    assert.ok(saved[0]?.finishedAt);
    assert.deepEqual(saved[0]?.items[0].scope, { elementIds: ["title"] });
    assert.deepEqual(readDecodedCommentSubmissions(root)[0]?.items[0]?.commentRevision, 1);
  });
});

test("a store with the wrong envelope fails closed without rewriting its evidence", () => {
  scratch((root) => {
    createCommentSubmission(root, prepared(), "修改");
    const file = path.join(root, "_agent/comment-submissions.v1.json");
    for (const raw of [JSON.stringify({ version: 2, submissions: [] }), JSON.stringify({ version: 1 })]) {
      fs.writeFileSync(file, raw);
      assert.throws(() => readCommentSubmissions(root), /Invalid comment submission/);
      assert.throws(() => finishCommentSubmission(root, "any", "failed"), /Invalid comment submission/);
      assert.equal(fs.readFileSync(file, "utf8"), raw);
    }
  });
});

test("legacy and partial receipts stay readable, but only complete ones are decoded for the browser", () => {
  scratch((root) => {
    const first = createCommentSubmission(root, prepared(), "修改");
    const file = path.join(root, "_agent/comment-submissions.v1.json");
    const legacy = { id: "legacy-preparing", status: "preparing" };
    const badRevision = { ...first, id: "bad", items: [{ ...first.items[0], commentRevision: "1" }] };
    fs.writeFileSync(file, JSON.stringify({ version: 1, submissions: [first, legacy, badRevision] }));
    assert.equal(readCommentSubmissions(root).length, 3);
    assert.deepEqual(
      readDecodedCommentSubmissions(root).map((entry) => entry.id),
      [first.id],
    );
    // The reconciler can still fail a legacy preparing row closed.
    finishCommentSubmission(root, "legacy-preparing", "failed", "interrupted");
    assert.equal(readCommentSubmissions(root)[1]?.status, "failed");
  });
});

test("invalid finish arguments cannot mutate a valid store", () => {
  scratch((root) => {
    const first = createCommentSubmission(root, prepared(), "修改");
    const file = path.join(root, "_agent/comment-submissions.v1.json");
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => createCommentSubmission(root, "not-a-list", "修改"), /Invalid comment submission/);
    assert.throws(() => finishCommentSubmission(root, first.id, "unknown"), /Invalid comment submission/);
    assert.throws(() => finishCommentSubmission(root, 42, "failed"), /Invalid comment submission/);
    assert.throws(() => finishCommentSubmission(root, first.id, "failed", { reason: 1 }), /Invalid comment submission/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    // Older single-comment locks carry no receipt id: finishing them is a no-op.
    assert.equal(finishCommentSubmission(root, undefined, "applied"), undefined);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("an unaccepted retry batch hands the comment back to the message that carried it", () => {
  const earlier = { aiSubmissionId: "first", aiStatus: "failed", aiError: "范围校验失败" };
  const item = { previous: commentAssociation(earlier) };
  const retried = { aiSubmissionId: "second", aiStatus: "running" };
  assert.deepEqual(unacceptedBatchRollback(retried, item, "second"), earlier);
  // Something else already owns the comment, or it never belonged to an earlier message.
  assert.deepEqual(unacceptedBatchRollback({ aiSubmissionId: "third" }, item, "second"), {});
  assert.deepEqual(unacceptedBatchRollback(retried, { previous: commentAssociation({}) }, "second"), {});
});

test("each batch outcome writes the thread fields the review inbox shows", () => {
  const at = Date.parse("2026-11-15T10:00:00.000Z");
  const now = () => at;
  assert.deepEqual(batchThreadUpdate({}, {}, { outcome: "applied", now }), {
    aiStatus: "applied",
    aiAppliedAt: "2026-11-15T10:00:00.000Z",
    aiError: undefined,
  });
  assert.equal(batchThreadUpdate({}, {}, { outcome: "failed" }).aiError, "AI 修改失败，可重试");
  assert.equal(batchThreadUpdate({}, {}, { outcome: "failed", failure: "范围" }).aiError, "范围");
  const earlier = { aiSubmissionId: "first", aiStatus: "failed", aiError: "旧" };
  const handedBack = batchThreadUpdate(
    { aiSubmissionId: "second" },
    { previous: commentAssociation(earlier) },
    { outcome: "cancelled", unaccepted: true, submissionId: "second" },
  );
  assert.deepEqual(handedBack, { aiStatus: "failed", aiAppliedAt: undefined, aiError: "旧", aiSubmissionId: "first" });
  assert.equal(batchThreadUpdate({}, {}, { outcome: "cancelled" }).aiStatus, "idle");
  assert.deepEqual(
    ["applied", "failed", "cancelled"].map((outcome) =>
      submissionStatusForOutcome(/** @type {"applied" | "failed" | "cancelled"} */ (outcome)),
    ),
    ["applied", "failed", "cancelled"],
  );
});
