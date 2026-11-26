import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReviewProgress, withReviewProgress } from "./review-progress.js";

test("review progress follows plan order and includes unwritten or revised pages", () => {
  assert.deepEqual(
    buildReviewProgress(
      ["p02", "p01", "p03"],
      [
        { pageId: "p02", visualReview: "pass" },
        { pageId: "p01", visualReview: "revise" },
      ],
      true,
    ),
    { pendingReview: ["p01", "p03"], next: "review_page p01" },
  );
});

test("a page whose layout changed is rendered before anything else is reviewed", () => {
  // Typed as a plain value so the stale flag is not an object-literal excess property.
  const stale = { pageId: "p02", visualReview: "missing" as const, chromeStale: true };
  assert.deepEqual(
    buildReviewProgress(
      ["p01", "p02", "p03"],
      [{ pageId: "p01", visualReview: "pass" }, stale, { pageId: "p03", visualReview: "missing" }],
      true,
    ),
    { pendingReview: ["p02", "p03"], next: "render_page p02" },
  );
});

test("no pending visual reviews points directly to compose_deck", () => {
  assert.deepEqual(
    buildReviewProgress(
      ["p01", "p02"],
      [
        { pageId: "p01", visualReview: "pass" },
        { pageId: "p02", visualReview: "pass" },
      ],
      true,
    ),
    { pendingReview: [], next: "compose_deck" },
  );
});

test("text-only runs skip visual review and point to compose_deck", () => {
  assert.deepEqual(buildReviewProgress(["p01"], [{ pageId: "p01", visualReview: "missing" }], false), {
    pendingReview: [],
    next: "compose_deck",
  });
});

test("render_page, review_page, and review_pages all carry progress fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-progress-result-"));
  for (const name of ["render_page", "review_page", "review_pages"]) {
    const result = withReviewProgress(root, name, {
      name,
      ok: true,
      summary: "synthetic result",
      detail: "synthetic result",
      payload: { marker: "kept" },
    });
    assert.deepEqual(result.payload, {
      marker: "kept",
      pendingReview: [],
      next: "compose_deck",
    });
  }
});

test("a generic failed review retry cannot replace the ledger-derived next step", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-progress-failure-"));
  const result = withReviewProgress(root, "review_page", {
    name: "review_page",
    ok: false,
    summary: "synthetic rejection",
    detail: "synthetic rejection",
    payload: { next: "review_page", error: "review_page_issues_conflict" },
  });
  assert.equal((result.payload as Record<string, unknown>).next, "compose_deck");
});
