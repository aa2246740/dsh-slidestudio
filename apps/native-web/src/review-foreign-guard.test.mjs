import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import {
  writeProject,
  acquireReviewAiLock,
  releaseReviewAiLock,
  renewReviewAiLock,
  fixture,
  httpEndpoint,
  createHttpReview,
} from "./review-test-fixtures.mjs";

it("rejects foreign-origin review status requests before reconciling a guard", async () => {
  const root = fixture();
  writeProject(root);
  const guardFile = path.join(root, "_agent", "ai-review-lock.v1.json");
  fs.mkdirSync(path.dirname(guardFile), { recursive: true });
  const guard = JSON.stringify({ version: 1, token: "foreign-origin-fixture", expiresAt: Date.now() - 1 });
  fs.writeFileSync(guardFile, guard);
  const base = await httpEndpoint();
  const response = await fetch(
    `${base}/api/reviews/ai-lock/status?project=${encodeURIComponent(root)}&token=foreign-origin-fixture`,
    {
      headers: { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site" },
    },
  );
  assert.equal(response.status, 403);
  assert.equal(fs.readFileSync(guardFile, "utf8"), guard);
});

it("does not replace or expose a foreign durable review guard", async () => {
  const root = fixture();
  writeProject(root);
  const base = await httpEndpoint();
  const comment = await createHttpReview(base, { id: "foreign-guard", project: root });
  const guardFile = path.join(root, "_agent", "ai-review-lock.v1.json");
  const foreignGuard = {
    version: 1,
    token: "foreign-process-token",
    pagePath: "private/page.page",
    pageBody: { text: "secret page content" },
    expiresAt: Date.now() + 60_000,
  };
  fs.writeFileSync(guardFile, `${JSON.stringify(foreignGuard)}\n`, "utf8");

  const response = await fetch(`${base}/api/reviews/ai-lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: root,
      pagePath: "pages/01_page.page",
      commentId: "foreign-guard",
      commentRevision: comment.revision,
    }),
  });
  const conflict = await response.json();
  assert.equal(response.status, 409);
  assert.equal(conflict.code, "AI_REVIEW_LOCKED");
  assert.equal(conflict.lock, undefined);
  assert.equal(JSON.stringify(conflict).includes(foreignGuard.token), false);
  assert.equal(JSON.stringify(conflict).includes("secret page content"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(guardFile, "utf8")), foreignGuard);

  const ownRoot = fixture();
  const own = acquireReviewAiLock(ownRoot, { pagePath: "page-01" });
  assert.ok(own.lock);
  const ownGuardFile = path.join(ownRoot, "_agent", "ai-review-lock.v1.json");
  fs.writeFileSync(ownGuardFile, `${JSON.stringify(foreignGuard)}\n`, "utf8");
  assert.equal(renewReviewAiLock(own.lock.token), undefined);
  assert.equal(releaseReviewAiLock(ownRoot, own.lock.token).released, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(ownGuardFile, "utf8")), foreignGuard);
});
