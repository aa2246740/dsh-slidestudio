import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMENT_SUBMISSION_MAX_ITEMS,
  commentSubmissionRetryable,
  commentSubmissionStatus,
  decodeCommentSubmission,
  isCommentRevision,
  record,
} from "../public/comment-submission-data.js";

const item = (patch = {}) => ({ pagePath: "pages/a.page", commentId: "c1", commentRevision: 2, text: "改", ...patch });
const receipt = (patch = {}) => ({
  id: "sub-1",
  status: "running",
  at: "2026-11-15T10:00:00.000Z",
  brief: "",
  items: [item()],
  ...patch,
});

describe("comment submission receipt DTO", () => {
  it("decodes a complete receipt and keeps unknown descriptive fields", () => {
    const decoded = decodeCommentSubmission(receipt({ retryable: true, items: [item({ scope: { kind: "page" } })] }));
    assert.equal(decoded?.id, "sub-1");
    assert.equal(decoded?.status, "running");
    assert.deepEqual(decoded?.items[0]?.scope, { kind: "page" });
    assert.equal(decoded?.retryable, true);
  });

  it("refuses the whole receipt when any authorized target is malformed", () => {
    const bad = [
      null,
      "text",
      receipt({ id: " " }),
      receipt({ status: "unknown" }),
      receipt({ at: "not a date" }),
      receipt({ finishedAt: 5 }),
      receipt({ error: 5 }),
      receipt({ brief: [] }),
      receipt({ items: [] }),
      receipt({ items: "x" }),
      receipt({ items: [item({ commentRevision: "2" })] }),
      receipt({ items: [item({ commentRevision: -1 })] }),
      receipt({ items: [item({ pagePath: "" })] }),
      receipt({ items: [item({ text: 3 })] }),
      receipt({ items: [item(), item()] }),
      receipt({
        items: Array.from({ length: COMMENT_SUBMISSION_MAX_ITEMS + 1 }, (_, i) => item({ commentId: `c${i}` })),
      }),
    ];
    for (const value of bad) assert.equal(decodeCommentSubmission(value), null, JSON.stringify(value)?.slice(0, 80));
  });

  it("accepts the same comment on two pages and an exact maximum batch", () => {
    assert.ok(decodeCommentSubmission(receipt({ items: [item(), item({ pagePath: "pages/b.page" })] })));
    const full = Array.from({ length: COMMENT_SUBMISSION_MAX_ITEMS }, (_, i) => item({ commentId: `c${i}` }));
    assert.equal(decodeCommentSubmission(receipt({ items: full }))?.items.length, COMMENT_SUBMISSION_MAX_ITEMS);
  });

  it("names the statuses, revisions and retryable outcomes", () => {
    assert.deepEqual(["preparing", "running", "applied", "failed", "cancelled", "x"].map(commentSubmissionStatus), [
      "preparing",
      "running",
      "applied",
      "failed",
      "cancelled",
      undefined,
    ]);
    assert.deepEqual([0, 3, 1.5, -1, "1"].map(isCommentRevision), [true, true, false, false, false]);
    const statuses = /** @type {const} */ (["failed", "cancelled", "applied", "running"]);
    assert.deepEqual(
      statuses.map((status) => commentSubmissionRetryable(decodeCommentSubmission(receipt({ status })))),
      [true, true, false, false],
    );
    assert.equal(commentSubmissionRetryable(null), false);
    assert.deepEqual(record(null), {});
    assert.deepEqual(record({ a: 1 }), { a: 1 });
  });
});
