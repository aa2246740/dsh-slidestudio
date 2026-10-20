import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  httpRoot,
  writeProject,
  writeTwoPageProject,
  writeThreePageProject,
  acquireReviewAiLock,
  captureWorkspaceEditScope,
  readReviewThreads,
  releaseReviewAiLock,
  reviewAiLockByToken,
  renewReviewAiLock,
  reviewDeckDelta,
  reviewPageDelta,
  sanitizeReviewThread,
  upsertReviewThread,
  createEmptyProject,
  loadProject,
  currentPageRevision,
  inspectRunLedger,
  stableSha256,
  editorReviewScopeFromEdit,
  createCommentSubmission,
  readCommentSubmissions,
  native,
  fixture,
  httpEndpoint,
  openHttpRoot,
  createHttpReview,
  textElement,
  writeReviewLedger,
  writeWorkspaceReviewLedger,
  findReviewStatus,
} from "./review-test-fixtures.mjs";

describe("project-owned review thread revisions", () => {
  it("creates at revision 1, accepts the expected revision, and rejects stale edits", () => {
    const root = fixture();
    const pagePath = "page-01";
    const initial = upsertReviewThread(native, root, pagePath, {
      id: "review-1",
      text: "first",
    });
    assert.equal(initial.conflict, false);
    assert.equal(initial.comment.revision, 1);

    const accepted = upsertReviewThread(native, root, pagePath, {
      ...initial.comment,
      text: "newer",
      revision: 1,
    });
    assert.equal(accepted.conflict, false);
    assert.equal(accepted.comment.revision, 2);

    const stale = upsertReviewThread(native, root, pagePath, {
      ...initial.comment,
      text: "stale overwrite",
      revision: 1,
    });
    assert.equal(stale.conflict, true);
    assert.equal(stale.comment.text, "newer");
    assert.equal(stale.comment.revision, 2);
    assert.equal(readReviewThreads(root).revision, accepted.revision);
  });

  it("treats stored legacy comments without revisions as revision 1", () => {
    const root = fixture();
    const pagePath = "page-01";
    const file = path.join(root, "_agent", "review-threads.v1.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        revision: 4,
        pages: { [pagePath]: [{ id: "legacy", text: "old" }] },
      }),
    );

    const stored = readReviewThreads(root).pages[pagePath][0];
    assert.equal(sanitizeReviewThread(stored, pagePath).revision, 1);
    const accepted = upsertReviewThread(native, root, pagePath, {
      ...stored,
      text: "migrated safely",
      revision: 1,
    });
    assert.equal(accepted.conflict, false);
    assert.equal(accepted.comment.revision, 2);
  });

  it("does not let an existing comment bypass CAS by omitting its revision", () => {
    const root = fixture();
    const pagePath = "page-01";
    const created = upsertReviewThread(native, root, pagePath, { id: "review-1", text: "first" });
    const conflict = upsertReviewThread(native, root, pagePath, { id: created.comment.id, text: "overwrite" });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.comment.revision, 1);
  });

  it("serializes AI review turns across browser tabs", async () => {
    const root = fixture();
    writeProject(root);
    const base = await httpEndpoint();
    const first = acquireReviewAiLock(root, {
      pagePath: "page-01",
      commentId: "review-1",
      scope: { kind: "elements", pageId: "page-01", elementIds: ["title"] },
    });
    assert.equal(first.conflict, false);
    assert.ok(first.lock);
    assert.equal(first.lock.root, path.resolve(root));
    assert.equal(reviewAiLockByToken(first.lock.token)?.root, path.resolve(root));
    const guardFile = path.join(root, "_agent", "ai-review-lock.v1.json");
    assert.equal(fs.existsSync(guardFile), true);
    const guard = JSON.parse(fs.readFileSync(guardFile, "utf8"));
    assert.equal(guard.token, first.lock.token);
    assert.equal(guard.pagePath, "page-01");
    assert.equal(guard.commentId, "review-1");
    assert.deepEqual(guard.scope.elementIds, ["title"]);
    assert.equal(guard.expiresAt, first.lock.expiresAt);
    const second = acquireReviewAiLock(root, { pagePath: "page-01", commentId: "review-2" });
    assert.equal(second.conflict, true);
    assert.equal(releaseReviewAiLock(root, "wrong-token").released, false);
    assert.equal(releaseReviewAiLock(root, first.lock.token).released, true);
    assert.equal(fs.existsSync(path.join(root, "_agent", "ai-review-lock.v1.json")), false);
    const third = acquireReviewAiLock(root, { pagePath: "page-01", commentId: "review-2" });
    assert.equal(third.conflict, false);
    assert.ok(third.lock);
    third.lock.expiresAt = Date.now() - 1;
    assert.equal(releaseReviewAiLock(root, "wrong-token").released, true);
    const staleGuard = JSON.parse(fs.readFileSync(guardFile, "utf8"));
    assert.equal(staleGuard.token, third.lock.token);
    staleGuard.expiresAt = Date.now() - 1;
    fs.writeFileSync(guardFile, `${JSON.stringify(staleGuard)}\n`, "utf8");
    const reconciled = await fetch(`${base}/api/reviews?project=${encodeURIComponent(root)}&all=1`);
    assert.equal(reconciled.status, 200);
    assert.equal(fs.existsSync(guardFile), false);
  });

  it("renews an active AI review lease atomically and rejects an unknown token", async () => {
    const base = await httpEndpoint();
    await openHttpRoot(base);
    const comment = await createHttpReview(base, { id: "renewal" });
    const acquiredResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        commentId: "renewal",
        commentRevision: comment.revision,
      }),
    });
    assert.equal(acquiredResponse.status, 200);
    const acquired = await acquiredResponse.json();
    assert.ok(acquired.lock);
    const token = acquired.lock.token;
    const expiresBefore = acquired.lock.expiresAt;
    const guardFile = path.join(httpRoot, "_agent", "ai-review-lock.v1.json");

    const invalid = await fetch(`${base}/api/reviews/ai-lock/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-the-lock-token" }),
    });
    assert.equal(invalid.status, 409);
    assert.equal((await invalid.json()).code, "AI_REVIEW_LOCK_MISMATCH");

    const renewedResponse = await fetch(`${base}/api/reviews/ai-lock/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(renewedResponse.status, 200);
    const renewed = await renewedResponse.json();
    assert.ok(renewed.lock.expiresAt > expiresBefore);
    const guard = JSON.parse(fs.readFileSync(guardFile, "utf8"));
    assert.equal(guard.token, token);
    assert.equal(guard.expiresAt, renewed.lock.expiresAt);

    // Exercise the server's expiry cleanup path as well as a random mismatch:
    // an expired token must never be resurrected by a later renew request.
    reviewAiLockByToken(token).expiresAt = Date.now() - 1;
    const expired = await fetch(`${base}/api/reviews/ai-lock/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).code, "AI_REVIEW_LOCK_MISMATCH");
    assert.equal(fs.existsSync(guardFile), true);
    const staleGuard = JSON.parse(fs.readFileSync(guardFile, "utf8"));
    staleGuard.expiresAt = Date.now() - 1;
    fs.writeFileSync(guardFile, `${JSON.stringify(staleGuard)}\n`, "utf8");
    const reconciled = await fetch(`${base}/api/reviews?project=${encodeURIComponent(httpRoot)}&all=1`);
    assert.equal(reconciled.status, 200);
    assert.equal(fs.existsSync(guardFile), false);
  });

  it("does not extend the in-memory lease when writing its durable guard fails", () => {
    const root = fixture();
    const acquired = acquireReviewAiLock(root, { pagePath: "page-01", commentId: "write-failure" });
    assert.equal(acquired.conflict, false);
    assert.ok(acquired.lock);
    const expiresBefore = acquired.lock.expiresAt;
    const guardFile = path.join(root, "_agent", "ai-review-lock.v1.json");
    const guardBefore = JSON.parse(fs.readFileSync(guardFile, "utf8"));

    assert.throws(
      () =>
        renewReviewAiLock(acquired.lock.token, {
          writeGuard() {
            throw new Error("simulated guard write failure");
          },
        }),
      /simulated guard write failure/,
    );
    assert.equal(reviewAiLockByToken(acquired.lock.token)?.expiresAt, expiresBefore);
    assert.equal(JSON.parse(fs.readFileSync(guardFile, "utf8")).expiresAt, guardBefore.expiresAt);
    assert.equal(releaseReviewAiLock(root, acquired.lock.token).released, true);
  });

  it("rejects element-targeted AI edits that touch unrelated page content", () => {
    const stable = (value) => JSON.stringify(value ?? null);
    const before = {
      pageType: "content",
      elements: [
        { elementId: "title", content: { text: "before" } },
        { elementId: "chart", chartData: { rows: [["Q1", 1]] } },
      ],
    };
    const safe = {
      ...before,
      elements: [{ elementId: "title", content: { text: "after" } }, before.elements[1]],
    };
    assert.equal(reviewPageDelta(stable, before, safe, "title").scopeViolation, false);
    const unsafe = {
      ...safe,
      elements: [safe.elements[0], { elementId: "chart", chartData: { rows: [["Q1", 9]] } }],
    };
    const delta = reviewPageDelta(stable, before, unsafe, "title");
    assert.equal(delta.scopeViolation, true);
    assert.deepEqual(delta.changedElementIds.sort(), ["chart", "title"]);
    const reordered = { ...safe, elements: [...safe.elements].reverse() };
    assert.equal(reviewPageDelta(stable, before, reordered, "title").scopeViolation, true);

    const deckBefore = { title: "Before", theme: { colors: { primary: "#123456" } }, pageOrder: ["a", "b"] };
    assert.equal(reviewDeckDelta(stable, deckBefore, structuredClone(deckBefore)).scopeViolation, false);
    const deckChanged = reviewDeckDelta(stable, deckBefore, {
      title: "After",
      theme: { colors: { primary: "#654321" } },
      pageOrder: ["b", "a"],
    });
    assert.equal(deckChanged.scopeViolation, true);
    assert.equal(deckChanged.deckTitleChanged, true);
    assert.equal(deckChanged.deckThemeChanged, true);
    assert.equal(deckChanged.deckPageOrderChanged, true);
  });

  it("returns HTTP 409 with the current comment for a stale PATCH", async () => {
    const base = await httpEndpoint();
    const endpoint = `${base}/api/reviews`;
    const patch = async (comment) =>
      fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: httpRoot,
          pagePath: "pages/01_page.page",
          comment: comment.scope ? comment : { ...comment, scope: { kind: "page", elementIds: [] } },
        }),
      });

    const created = await patch({ id: "http-review", text: "first" });
    const first = await created.json();
    assert.equal(created.status, 200);
    const accepted = await patch({ ...first.comment, text: "newer", revision: 1 });
    assert.equal(accepted.status, 200);

    const stale = await patch({ ...first.comment, text: "stale", revision: 1 });
    const body = await stale.json();
    assert.equal(stale.status, 409);
    assert.equal(body.code, "REVIEW_COMMENT_CONFLICT");
    assert.equal(body.comment.text, "newer");
    assert.equal(body.comment.revision, 2);

    const removedPut = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pagePath: "page-01", comments: [] }),
    });
    assert.equal(removedPut.status, 410);
    assert.equal((await removedPut.json()).code, "REVIEW_PUT_REMOVED");
  });

  it("persists an authoritative multi-element page scope and refuses rebinding", async () => {
    const base = await httpEndpoint();
    writeProject(httpRoot, { elements: [textElement("title", "Before"), textElement("subtitle", "Detail")] });
    await openHttpRoot(base);
    const created = await createHttpReview(base, {
      id: "multi-scope",
      elementIds: ["title", "subtitle", "title"],
    });
    assert.deepEqual(created.scope.elementIds, ["title", "subtitle"]);
    assert.equal(created.scope.kind, "elements");
    assert.equal(created.scope.pageId, "01_page");
    assert.equal(created.scope.pageRevision, null);
    assert.match(created.scope.pageSha256, /^[a-f0-9]{64}$/);
    assert.equal(created.elementId, "title");

    const reboundResponse = await fetch(`${base}/api/reviews`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        comment: {
          ...created,
          revision: created.revision,
          scope: { ...created.scope, elementIds: ["title"] },
        },
      }),
    });
    assert.equal(reboundResponse.status, 409);
    assert.equal((await reboundResponse.json()).code, "REVIEW_SCOPE_IMMUTABLE");

    const forgedApplied = await fetch(`${base}/api/reviews`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        comment: { ...created, revision: created.revision, aiStatus: "applied" },
      }),
    });
    assert.equal(forgedApplied.status, 409);
    assert.equal((await forgedApplied.json()).code, "REVIEW_AI_STATUS_SERVER_OWNED");
  });

  it("uses the explicit review project after another tab changes the global open project", async () => {
    const base = await httpEndpoint();
    writeProject(httpRoot, { pageText: "Review owner" });
    const otherRoot = fixture();
    writeProject(otherRoot, { pageText: "Other tab" });
    const openedOther = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: otherRoot, page: 0 }),
    });
    assert.equal(openedOther.status, 200);

    const comment = await createHttpReview(base, { id: "project-bound" });
    assert.equal(comment.scope.pageId, "01_page");
    assert.equal(fs.existsSync(path.join(httpRoot, "_agent", "review-threads.v1.json")), true);
    assert.equal(fs.existsSync(path.join(otherRoot, "_agent", "review-threads.v1.json")), false);
    const lockResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        commentId: comment.id,
        commentRevision: comment.revision,
      }),
    });
    const lockBody = await lockResponse.json();
    assert.equal(lockResponse.status, 200, JSON.stringify(lockBody));
    assert.equal(findReviewStatus(httpRoot, comment.id), "running");
    assert.equal(fs.existsSync(path.join(otherRoot, "_agent", "review-threads.v1.json")), false);
    const snapshotResponse = await fetch(`${base}/api/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockToken: lockBody.lock.token, label: "Project-bound review baseline" }),
    });
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200, JSON.stringify(snapshot));
    assert.equal(snapshot.lockRoot, path.resolve(httpRoot));
    assert.equal(fs.existsSync(path.join(httpRoot, ".versions", snapshot.version.id, "deck.pptd")), true);
    assert.equal(fs.existsSync(path.join(otherRoot, ".versions", snapshot.version.id, "deck.pptd")), false);
    writeProject(httpRoot, { pageText: "Temporary Agent change" });
    const restoreResponse = await fetch(`${base}/api/versions/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: snapshot.version.id, lockToken: lockBody.lock.token }),
    });
    const restored = await restoreResponse.json();
    assert.equal(restoreResponse.status, 200, JSON.stringify(restored));
    assert.equal(loadProject(httpRoot).pages[0].page.elements[0].content.text, "Review owner");
    assert.equal(loadProject(otherRoot).pages[0].page.elements[0].content.text, "Other tab");
    assert.equal(releaseReviewAiLock(httpRoot, lockBody.lock.token).released, true);
  });

  it("records a human-edited page revision for a new comment without refreshing a stale comment", async () => {
    const base = await httpEndpoint();
    fs.rmSync(path.join(httpRoot, "_agent", "ai-review-lock.v1.json"), { force: true });
    fs.rmSync(path.join(httpRoot, "_agent", "run-ledger.v1.json"), { force: true });
    writeProject(httpRoot, { pageText: "Generated baseline" });
    const originalPage = loadProject(httpRoot).pages[0].page;
    const originalSha = stableSha256({ id: "01_page", ...originalPage });
    writeReviewLedger(httpRoot, originalSha, 6);

    // This represents a real native-editor save after generation. It changes
    // PPTD on disk but has not yet created a presentation-run revision fact.
    writeProject(httpRoot, { pageText: "Human correction" });
    await openHttpRoot(base);
    const currentComment = await createHttpReview(base, { id: "human-edit-current" });
    assert.equal(currentComment.scope.pageRevision, null);

    const lockResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        commentId: currentComment.id,
        commentRevision: currentComment.revision,
      }),
    });
    const lockBody = await lockResponse.json();
    assert.equal(lockResponse.status, 200, JSON.stringify(lockBody));
    const currentPage = loadProject(httpRoot).pages[0].page;
    const currentSha = stableSha256({ id: "01_page", ...currentPage });
    assert.equal(lockBody.lock.scope.pageRevision, 7);
    assert.equal(lockBody.lock.scope.pageSha256, currentSha);
    assert.equal(lockBody.comment.scope.pageRevision, 7);
    const hostScope = editorReviewScopeFromEdit({
      pageId: lockBody.lock.scope.pageId,
      revision: lockBody.lock.scope.pageRevision,
      pageSha256: lockBody.lock.scope.pageSha256,
      reviewScope: {
        ...lockBody.lock.scope,
        commentId: currentComment.id,
        commentRevision: lockBody.comment.revision,
      },
    });
    assert.equal(
      hostScope?.pageRevision,
      7,
      "the synchronized lock payload must pass the unchanged Host review-scope guard",
    );
    assert.equal(currentPageRevision(httpRoot, "01_page")?.pageSha256, currentSha);
    const inspection = inspectRunLedger(httpRoot);
    assert.equal(
      inspection.pages.find((page) => page.pageId === "01_page")?.raster,
      false,
      "the prior revision's raster must not be reused for the human-edited revision",
    );
    assert.equal(releaseReviewAiLock(httpRoot, lockBody.lock.token).released, true);

    // A comment captured before another page write remains stale. The lock
    // route must reject it before recording or authorizing revision 8.
    const staleComment = await createHttpReview(base, { id: "human-edit-stale" });
    writeProject(httpRoot, { pageText: "Changed after stale comment" });
    const staleResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        commentId: staleComment.id,
        commentRevision: staleComment.revision,
      }),
    });
    const staleBody = await staleResponse.json();
    assert.equal(staleResponse.status, 409, JSON.stringify(staleBody));
    assert.equal(staleBody.code, "REVIEW_SCOPE_STALE");
    assert.equal(
      currentPageRevision(httpRoot, "01_page")?.revision,
      7,
      "rejecting a stale comment must not record the changed page as authorized",
    );
    fs.rmSync(path.join(httpRoot, "_agent", "run-ledger.v1.json"), { force: true });
  });

  it("keeps direct workspace edits on a separate explicit scope contract", () => {
    const pageSha256 = "c".repeat(64);
    const snapshot = {
      pageId: "01_page",
      pageRevision: 4,
      pageSha256,
      pageBody: { elements: [textElement("title", "Before"), textElement("outside", "Keep")] },
    };
    const scope = captureWorkspaceEditScope(snapshot, {
      authorizationId: "agent-chat-1",
      kind: "elements",
      pageId: "01_page",
      elementIds: ["title"],
      targetPages: [{ pageId: "01_page", revision: 4, pageSha256 }],
    });
    assert.deepEqual(scope.elementIds, ["title"]);
    assert.deepEqual(scope.targetPageIds, ["01_page"]);
    assert.throws(
      () =>
        captureWorkspaceEditScope(snapshot, {
          authorizationId: "agent-chat-2",
          kind: "elements",
          pageId: "01_page",
          elementIds: ["deleted"],
          targetPages: [{ pageId: "01_page", revision: 4, pageSha256 }],
        }),
      /no longer exist/,
    );
  });

  it("returns authoritative human-edited revisions for a new direct workspace lock", async () => {
    const base = await httpEndpoint();
    fs.rmSync(path.join(httpRoot, "_agent", "ai-review-lock.v1.json"), { force: true });
    fs.rmSync(path.join(httpRoot, "_agent", "run-ledger.v1.json"), { force: true });
    writeProject(httpRoot, { pageText: "Workspace baseline" });
    const originalPage = loadProject(httpRoot).pages[0].page;
    const originalSha = stableSha256({ id: "01_page", ...originalPage });
    writeReviewLedger(httpRoot, originalSha, 6);
    writeProject(httpRoot, { pageText: "Human workspace edit" });
    await openHttpRoot(base);

    const request = {
      authorizationId: "workspace-after-human-edit",
      kind: "elements",
      pageId: "01_page",
      elementIds: ["title"],
      targetPages: [{ pageId: "01_page", revision: 6, pageSha256: originalSha }],
    };
    const lockResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        workspaceEdit: request,
      }),
    });
    const lockBody = await lockResponse.json();
    assert.equal(lockResponse.status, 200, JSON.stringify(lockBody));
    const currentPage = loadProject(httpRoot).pages[0].page;
    const currentSha = stableSha256({ id: "01_page", ...currentPage });
    assert.deepEqual(lockBody.lock.scope.targetPages, [
      {
        pageId: "01_page",
        revision: 7,
        pageSha256: currentSha,
      },
    ]);
    assert.equal(currentPageRevision(httpRoot, "01_page")?.revision, 7);
    assert.equal(inspectRunLedger(httpRoot).pages[0]?.raster, false);
    assert.equal(releaseReviewAiLock(httpRoot, lockBody.lock.token).released, true);

    const staleResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        workspaceEdit: { ...request, authorizationId: "workspace-stale-retry" },
      }),
    });
    const staleBody = await staleResponse.json();
    assert.equal(staleResponse.status, 409, JSON.stringify(staleBody));
    assert.equal(staleBody.code, "WORKSPACE_EDIT_SCOPE_STALE");
    assert.equal(currentPageRevision(httpRoot, "01_page")?.revision, 7);
    fs.rmSync(path.join(httpRoot, "_agent", "run-ledger.v1.json"), { force: true });
  });

  it("does not partially record a deck revision when a later workspace target is stale", async () => {
    const base = await httpEndpoint();
    fs.rmSync(path.join(httpRoot, "_agent", "ai-review-lock.v1.json"), { force: true });
    fs.rmSync(path.join(httpRoot, "_agent", "run-ledger.v1.json"), { force: true });
    writeTwoPageProject(httpRoot, "First baseline", "Second baseline");
    const baseline = loadProject(httpRoot);
    const firstSha = stableSha256({ id: "01_page", ...baseline.pages[0].page });
    const secondSha = stableSha256({ id: "02_page", ...baseline.pages[1].page });
    writeReviewLedger(httpRoot, firstSha, 6);
    const ledgerFile = path.join(httpRoot, "_agent", "run-ledger.v1.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    ledger.facts.push({
      type: "page.revision-committed",
      factId: "second-page-before-human-edit",
      at: "2026-09-06T00:00:00.000Z",
      contextEpochId: "review-human-edit-epoch",
      pageId: "02_page",
      revision: 6,
      pageSha256: secondSha,
    });
    fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    // Page one now needs synchronization, but page two's requested revision is
    // deliberately stale. Validation must finish before revision 7 is written.
    writeTwoPageProject(httpRoot, "First human edit", "Second baseline");
    await openHttpRoot(base);
    const response = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        workspaceEdit: {
          authorizationId: "deck-with-late-stale-page",
          kind: "deck",
          pageId: "01_page",
          elementIds: [],
          targetPages: [
            { pageId: "01_page", revision: 6, pageSha256: firstSha },
            { pageId: "02_page", revision: 5, pageSha256: secondSha },
          ],
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "WORKSPACE_EDIT_SCOPE_STALE");
    assert.equal(currentPageRevision(httpRoot, "01_page")?.revision, 6);
    assert.equal(currentPageRevision(httpRoot, "02_page")?.revision, 6);
    fs.rmSync(ledgerFile, { force: true });
  });

  it("keeps pages scopes as exact subsets and reports outside or missing pages at verify", async () => {
    const base = await httpEndpoint();
    fs.rmSync(path.join(httpRoot, "_agent", "ai-review-lock.v1.json"), { force: true });
    fs.rmSync(path.join(httpRoot, "_agent", "run-ledger.v1.json"), { force: true });
    writeThreePageProject(httpRoot, "First baseline", "Second baseline", "Third baseline");
    writeWorkspaceReviewLedger(httpRoot);
    await openHttpRoot(base);
    const targetPage = (pageId) => {
      const current = currentPageRevision(httpRoot, pageId);
      assert.ok(current);
      return { pageId, revision: current.revision, pageSha256: current.pageSha256 };
    };

    const wholeDeckAsPages = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        workspaceEdit: {
          authorizationId: "explicit-pages-cover-deck",
          kind: "pages",
          pageId: "01_page",
          elementIds: [],
          targetPages: [targetPage("01_page"), targetPage("02_page"), targetPage("03_page")],
        },
      }),
    });
    const wholeDeckBody = await wholeDeckAsPages.json();
    assert.equal(wholeDeckAsPages.status, 200, JSON.stringify(wholeDeckBody));
    assert.equal(wholeDeckBody.lock.scope.kind, "pages");
    assert.deepEqual(
      wholeDeckBody.lock.scope.targetPages.map((page) => page.pageId),
      ["01_page", "02_page", "03_page"],
    );
    assert.equal(releaseReviewAiLock(httpRoot, wholeDeckBody.lock.token).released, true);

    const subsetResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        workspaceEdit: {
          authorizationId: "exact-pages-subset",
          kind: "pages",
          pageId: "01_page",
          elementIds: [],
          targetPages: [targetPage("01_page"), targetPage("03_page")],
        },
      }),
    });
    const subset = await subsetResponse.json();
    assert.equal(subsetResponse.status, 200, JSON.stringify(subset));
    assert.deepEqual(subset.lock.scope.targetPageIds, ["01_page", "03_page"]);

    writeThreePageProject(httpRoot, "First target changed", "Second outside changed", "Third baseline");
    const outsideResponse = await fetch(`${base}/api/reviews/ai-lock/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: subset.lock.token, accept: true }),
    });
    const outside = await outsideResponse.json();
    assert.equal(outsideResponse.status, 409, JSON.stringify(outside));
    assert.equal(outside.code, "AI_REVIEW_SCOPE_VIOLATION");
    assert.deepEqual(outside.changedOutsideTargetPageIds, ["02_page"]);
    assert.deepEqual(outside.missingTargetPageIds, []);

    writeTwoPageProject(httpRoot, "First target changed again", "Second baseline");
    const missingResponse = await fetch(`${base}/api/reviews/ai-lock/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: subset.lock.token, accept: true }),
    });
    const missing = await missingResponse.json();
    assert.equal(missingResponse.status, 409, JSON.stringify(missing));
    assert.equal(missing.code, "AI_REVIEW_SCOPE_VIOLATION");
    assert.deepEqual(missing.missingTargetPageIds, ["03_page"]);
    assert.deepEqual(missing.changedOutsideTargetPageIds, []);
    assert.equal(releaseReviewAiLock(httpRoot, subset.lock.token).released, true);
    fs.rmSync(path.join(httpRoot, "_agent", "run-ledger.v1.json"), { force: true });
  });

  it("reports a deleted target before stale-page drift and never falls back to page scope", async () => {
    const base = await httpEndpoint();
    writeProject(httpRoot, { elements: [textElement("title", "Before"), textElement("subtitle", "Detail")] });
    await openHttpRoot(base);
    const comment = await createHttpReview(base, { id: "deleted-target", elementIds: ["subtitle"] });
    writeProject(httpRoot, { elements: [textElement("title", "Before")] });

    const response = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        commentId: comment.id,
        commentRevision: comment.revision,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, "REVIEW_TARGET_MISSING");
    assert.deepEqual(body.missingElementIds, ["subtitle"]);
    assert.match(body.error, /select.*new review comment/i);
  });

  it("reports a stale page scope with a reselect action instead of silently rebinding it", async () => {
    const base = await httpEndpoint();
    writeProject(httpRoot, { elements: [textElement("title", "Before")] });
    await openHttpRoot(base);
    const comment = await createHttpReview(base, { id: "stale-target" });
    writeProject(httpRoot, { elements: [textElement("title", "Changed elsewhere")] });
    const response = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        commentId: comment.id,
        commentRevision: comment.revision,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, "REVIEW_SCOPE_STALE");
    assert.match(body.error, /select.*new review comment/i);
  });

  it("commits applied only after a scoped target changed and rejects no-op or outside changes", async () => {
    const base = await httpEndpoint();
    const beforeElements = [
      textElement("title", "Before"),
      textElement("subtitle", "Detail"),
      textElement("outside", "Keep"),
    ];
    writeProject(httpRoot, { elements: beforeElements });
    await openHttpRoot(base);
    const comment = await createHttpReview(base, {
      id: "verified-apply",
      elementIds: ["title", "subtitle"],
    });
    const lockResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        commentId: comment.id,
        commentRevision: comment.revision,
      }),
    });
    const lockBody = await lockResponse.json();
    assert.equal(lockResponse.status, 200, JSON.stringify(lockBody));
    assert.equal(lockBody.comment.aiStatus, "running");
    assert.deepEqual(lockBody.lock.scope.elementIds, ["title", "subtitle"]);

    const noChange = await fetch(`${base}/api/reviews/ai-lock/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: lockBody.lock.token,
        accept: true,
        commentRevision: lockBody.comment.revision,
      }),
    });
    assert.equal(noChange.status, 409);
    assert.equal((await noChange.json()).code, "AI_REVIEW_NO_TARGET_CHANGE");
    let stored = await fetch(
      `${base}/api/reviews?project=${encodeURIComponent(httpRoot)}&pagePath=${encodeURIComponent("pages/01_page.page")}`,
    ).then((r) => r.json());
    assert.equal(stored.comments.find((entry) => entry.id === comment.id).aiStatus, "running");

    writeProject(httpRoot, {
      elements: [
        textElement("title", "Changed"),
        textElement("subtitle", "Detail"),
        textElement("outside", "Also changed"),
      ],
    });
    const outside = await fetch(`${base}/api/reviews/ai-lock/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: lockBody.lock.token,
        accept: true,
        commentRevision: lockBody.comment.revision,
      }),
    });
    assert.equal(outside.status, 409);
    assert.equal((await outside.json()).code, "AI_REVIEW_SCOPE_VIOLATION");

    writeProject(httpRoot, {
      elements: [textElement("title", "Changed"), textElement("subtitle", "Detail"), textElement("outside", "Keep")],
    });
    const accepted = await fetch(`${base}/api/reviews/ai-lock/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: lockBody.lock.token,
        accept: true,
        commentRevision: lockBody.comment.revision,
      }),
    });
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 200, JSON.stringify(acceptedBody));
    assert.equal(acceptedBody.comment.aiStatus, "applied");
    assert.deepEqual(acceptedBody.changedTargetElementIds, ["title"]);

    const released = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: lockBody.lock.token }),
    });
    assert.equal(released.status, 200);
  });

  it("binds AI snapshot/verify/restore to the lock root and preserves latest review threads", async () => {
    const base = await httpEndpoint();
    writeProject(httpRoot, { title: "Before AI", pageText: "Before AI" });
    const opened = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: httpRoot }),
    });
    assert.equal(opened.status, 200);

    const aiComment = await createHttpReview(base, { id: "ai-review" });
    const lockResponse = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        commentId: "ai-review",
        commentRevision: aiComment.revision,
      }),
    });
    assert.equal(lockResponse.status, 200);
    const lock = (await lockResponse.json()).lock;
    const guardFile = path.join(httpRoot, "_agent", "ai-review-lock.v1.json");
    assert.equal(fs.existsSync(guardFile), true);
    const persistedGuard = JSON.parse(fs.readFileSync(guardFile, "utf8"));
    assert.equal(persistedGuard.pageSha256, lock.pageSha256);
    assert.equal(persistedGuard.pageBody.elements[0].elementId, "title");

    const otherRoot = fixture();
    writeProject(otherRoot, { title: "Other project" });
    // Live sessions are per project: opening another project no longer
    // disturbs the locked review, and the lock keeps guarding its own root.
    const otherOpen = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: otherRoot }),
    });
    assert.equal(otherOpen.status, 200);
    assert.equal(fs.existsSync(guardFile), true);
    assert.equal(fs.existsSync(path.join(otherRoot, "_agent", "review-threads.v1.json")), false);

    const imageSource = path.join(otherRoot, "source.png");
    fs.writeFileSync(
      imageSource,
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
        "hex",
      ),
    );
    const imageProject = await fetch(`${base}/api/load-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src: imageSource }),
    });
    assert.equal(imageProject.status, 200);
    const createdDir = (await imageProject.json()).path;
    assert.ok(createdDir && createdDir.includes(`output${path.sep}img-`));
    fs.rmSync(createdDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(guardFile), true);

    const wrongSnapshot = await fetch(`${base}/api/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiLockToken: "wrong-token", label: "AI 修改前" }),
    });
    assert.equal(wrongSnapshot.status, 409);
    assert.equal((await wrongSnapshot.json()).code, "AI_REVIEW_LOCK_MISMATCH");

    const snapshotResponse = await fetch(`${base}/api/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockToken: lock.token, label: "AI 修改前", note: "ai-review:ai-review:01_page" }),
    });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.lockRoot, path.resolve(httpRoot));
    assert.equal(
      fs.existsSync(path.join(httpRoot, ".versions", snapshot.version.id, "_agent", "ai-review-lock.v1.json")),
      false,
    );

    const lateComment = await fetch(`${base}/api/reviews`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: httpRoot,
        pagePath: "pages/01_page.page",
        comment: { id: "collaborator", text: "keep me", scope: { kind: "page", elementIds: [] } },
      }),
    });
    assert.equal(lateComment.status, 200);
    const latestReviewBytes = fs.readFileSync(path.join(httpRoot, "_agent", "review-threads.v1.json"));
    const conversationFile = path.join(httpRoot, "_agent", "assistant-conversation.v1.json");
    const conversationBytes = JSON.stringify({
      version: 1,
      mode: "edit",
      messages: [{ id: "later", text: "keep this conversation", mode: "edit" }],
    });
    fs.writeFileSync(conversationFile, conversationBytes);
    const questionsFile = path.join(httpRoot, "_agent", "assistant-questions.v1.json");
    const questionsBytes = JSON.stringify([
      { id: "selected", status: "answered", answer: { answers: [{ id: "theme", selected: ["深紫"] }] } },
    ]);
    fs.writeFileSync(questionsFile, questionsBytes);
    const submissionsFile = path.join(httpRoot, "_agent", "comment-submissions.v1.json");
    const submissionBytes = JSON.stringify({
      version: 1,
      submissions: [{ id: "later-accepted-request", status: "preparing" }],
    });
    fs.writeFileSync(submissionsFile, submissionBytes);
    const attemptFile = path.join(httpRoot, "_agent", "attempt.v1.json");
    fs.writeFileSync(attemptFile, JSON.stringify({ attemptId: "latest-turn", startedAt: "2026-09-20T00:00:00Z" }));

    writeProject(httpRoot, {
      title: "AI changed title",
      pageText: "AI changed title element",
      theme: { colors: { primary: "#654321" } },
    });
    const verifyResponse = await fetch(`${base}/api/reviews/ai-lock/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: lock.token }),
    });
    assert.equal(verifyResponse.status, 200);
    const verified = await verifyResponse.json();
    assert.equal(verified.scopeViolation, true);
    assert.equal(verified.deckTitleChanged, true);
    assert.equal(verified.deckThemeChanged, true);

    const wrongRestore = await fetch(`${base}/api/versions/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: snapshot.version.id, lockToken: "wrong-token" }),
    });
    assert.equal(wrongRestore.status, 409);

    const unrelatedRestore = await fetch(`${base}/api/versions/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "v999", lockToken: lock.token }),
    });
    assert.equal(unrelatedRestore.status, 409);
    assert.equal((await unrelatedRestore.json()).code, "AI_REVIEW_SNAPSHOT_MISMATCH");

    const restoreResponse = await fetch(`${base}/api/versions/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: snapshot.version.id, lockToken: lock.token }),
    });
    assert.equal(restoreResponse.status, 200);
    const restored = await restoreResponse.json();
    assert.equal(restored.reviewsPreserved, true);
    assert.equal(
      fs.readFileSync(conversationFile, "utf8"),
      conversationBytes,
      "document rollback keeps later chat messages",
    );
    assert.equal(
      fs.readFileSync(questionsFile, "utf8"),
      questionsBytes,
      "document rollback keeps later native question answers",
    );
    assert.equal(JSON.parse(fs.readFileSync(attemptFile, "utf8")).attemptId, "latest-turn");
    assert.equal(
      fs.readFileSync(submissionsFile, "utf8"),
      submissionBytes,
      "rollback preserves the later submission receipt",
    );
    assert.equal(loadProject(httpRoot).presentation.title, "Before AI");
    const reviews = readReviewThreads(httpRoot);
    assert.equal(
      reviews.pages["pages/01_page.page"].some(
        (comment) => comment.id === "collaborator" && comment.text === "keep me",
      ),
      true,
    );
    assert.deepEqual(fs.readFileSync(path.join(httpRoot, "_agent", "review-threads.v1.json")), latestReviewBytes);
    assert.equal(fs.existsSync(path.join(httpRoot, "_agent", "ai-review-lock.v1.json")), true);

    const released = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: lock.token }),
    });
    assert.equal(released.status, 200);
    assert.equal(fs.existsSync(path.join(httpRoot, "_agent", "ai-review-lock.v1.json")), false);
  });

  it("preserves the pre-edit deck as V1 and retires the destructive legacy refine route", async () => {
    const base = await httpEndpoint();
    fs.rmSync(path.join(httpRoot, ".versions"), { recursive: true, force: true });
    writeProject(httpRoot, { title: "Original deck", pageText: "Original cover title" });

    const opened = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: httpRoot }),
    });
    assert.equal(opened.status, 200);

    const changed = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "setBackground", color: "#FFFFFF" }),
    });
    assert.equal(changed.status, 200);

    const versionsResponse = await fetch(`${base}/api/versions`);
    assert.equal(versionsResponse.status, 200);
    const versionState = await versionsResponse.json();
    const versions = versionState.versions;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].id, "v1");
    assert.equal(versions[0].label, "V1");
    assert.equal(versions[0].note, "baseline:original");
    assert.equal(versionState.currentVersionId, undefined);

    const previewResponse = await fetch(`${base}/api/versions/v1`);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.model.elements.find((element) => element.id === "title")?.text, "Original cover title");

    const legacyRefine = await fetch(`${base}/api/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "色调太黄了，能不能以红白色调来做" }),
    });
    assert.equal(legacyRefine.status, 410);
    assert.equal((await legacyRefine.json()).code, "LEGACY_REFINE_REMOVED");

    const savedCurrent = await fetch(`${base}/api/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "V2" }),
    });
    assert.equal(savedCurrent.status, 200);
    const currentState = await fetch(`${base}/api/versions`).then((response) => response.json());
    assert.equal(currentState.currentVersionId, "v2");
  });

  it("routes editor chat through the DSH Agent instead of the removed rule fallback", () => {
    const client = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const instruction = fs.readFileSync(new URL("../public/workspace-edit-instruction.js", import.meta.url), "utf8");
    const submitStart = client.indexOf('$("work-form")?.addEventListener("submit"');
    const openStart = client.indexOf('api("/api/open"', submitStart);
    assert.ok(submitStart > 0 && openStart > submitStart);
    const submitFlow = client.slice(submitStart, openStart);
    assert.doesNotMatch(submitFlow, /\/api\/refine/);
    assert.match(client, /\/slides\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/turn/);
    assert.match(instruction, /用户原话是修改意图，不是要写进幻灯片的文案/);
  });

  it("honors explicit whole-deck intent and refreshes changed pages on the right canvas", () => {
    const client = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const instruction = fs.readFileSync(new URL("../public/workspace-edit-instruction.js", import.meta.url), "utf8");
    const scopeHelper = fs.readFileSync(new URL("../public/work-agent-scope.js", import.meta.url), "utf8");
    const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    assert.match(client, /from "\.\/work-agent-scope\.js"/);
    assert.match(scopeHelper, /function targetFromAssistantIntent/);

    assert.match(client, /pages: targetPages/);
    assert.match(instruction, /整份文稿的授权页面依次为/);
    assert.match(instruction, /只修改用户要求涉及且确实需要变化的内容/);
    assert.match(instruction, /已经符合要求的页面可以保持不变/);
    assert.match(instruction, /逐页检查/);
    assert.match(instruction, /不能改动无关内容来凑写入页数/);
    assert.match(client, /requiresEveryTargetPage/);
    assert.doesNotMatch(instruction, /必须修改整份文稿的全部/);
    assert.doesNotMatch(instruction, /不得因页面看起来接近目标而跳过/);
    assert.match(client, /async function refreshAiReviewCanvas/);
    assert.match(client, /body: JSON\.stringify\(\{ path: project, page: pageIndex \}\)/);
    assert.doesNotMatch(html, /id="agent-live-preview"/);
    assert.match(html, /id="editor-generation-toggle"/);
    assert.match(css, /\.editor-generation:not\(\.is-expanded\)/);
  });

  it("opens an in-progress empty project as a clean editor placeholder", async () => {
    const root = fixture();
    createEmptyProject(root, { title: "等待首张页面" });
    const base = await httpEndpoint();
    const response = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    assert.equal(response.status, 200);
    const opened = await response.json();
    assert.equal(opened.model.generationPlaceholder, true);
    assert.equal(opened.model.pageCount, 0);
    assert.deepEqual(opened.model.elements, []);
    assert.deepEqual(opened.thumbs, []);

    // Restore the shared HTTP server's default fixture for subsequent checks.
    await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: httpRoot }),
    });
  });

  it("hands generation into a transparent, locked editor instead of a split preview", () => {
    const hub = fs.readFileSync(new URL("../public/hub.js", import.meta.url), "utf8");
    const client = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

    const launch = fs.readFileSync(new URL("../public/launch-flow.js", import.meta.url), "utf8");
    assert.match(hub, /location\.replace\(launchHref\(launchId\)\)/);
    assert.match(launch, /function handoffToLiveEditor/);
    assert.match(
      launch,
      /history\.replaceState\(null, "", editorHref\(projectPath, \{ workspace: true, sessionId, live: true \}\)\)/,
    );
    assert.match(client, /function generationInteractionLocked/);
    assert.match(client, /"awaiting-project"/);
    assert.match(client, /generationPlaceholder/);
    assert.match(client, /完成后才开放 Agent 修改与编辑工具/);
    assert.match(html, /id="editor-generation-now"/);
    assert.match(html, /id="work-generation-lock"/);
    // The insert row is #insert-toolbar / .insert-toolbar now (renamed from the
    // retired .insert-pill), so the live-generation lock must hide that selector.
    assert.match(css, /\.app\.is-live-generation [^{]*\.insert-toolbar/);
    assert.match(css, /\.generation-canvas-placeholder/);
  });
});

describe("editor attachment lifecycle", () => {
  it("uploads readable context, returns it by opaque ID, and deletes that exact upload", async () => {
    const base = await httpEndpoint();
    const uploadedResponse = await fetch(`${base}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "agent-facts.md",
        data: `data:text/markdown;base64,${Buffer.from("# Facts\nRevenue: 42", "utf8").toString("base64")}`,
      }),
    });
    assert.equal(uploadedResponse.status, 200);
    const uploaded = await uploadedResponse.json();
    assert.equal(uploaded.name, "agent-facts.md");
    assert.equal(uploaded.parsed, true);
    assert.equal(uploaded.chars, 19);
    assert.doesNotMatch(JSON.stringify(uploaded), /Revenue: 42/);

    const contextResponse = await fetch(`${base}/api/attachments/${encodeURIComponent(uploaded.id)}`);
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.id, uploaded.id);
    assert.equal(context.parsed, true);
    assert.equal(context.text, "# Facts\nRevenue: 42");

    const deleted = await fetch(`${base}/api/attachments/${encodeURIComponent(uploaded.id)}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).id, uploaded.id);
    assert.equal((await fetch(`${base}/api/attachments/${encodeURIComponent(uploaded.id)}`)).status, 404);
  });

  it("rejects an unsupported image before assigning an attachment ID", async () => {
    const base = await httpEndpoint();
    const response = await fetch(`${base}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "not-supported.png",
        data: `data:image/png;base64,${Buffer.from("not-an-image", "utf8").toString("base64")}`,
      }),
    });
    assert.equal(response.status, 415);
    const body = await response.json();
    assert.equal(body.code, "UNSUPPORTED_AGENT_ATTACHMENT");
    assert.equal(body.id, undefined);
  });
});

describe("page-targeted notes persistence", () => {
  it("writes a debounced note to its captured page after navigation changes the current page", async () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "deck.pptd"),
      `${JSON.stringify({
        version: "v2",
        title: "Notes target",
        size: [960, 540],
        pages: ["pages/01.page", "pages/02.page"],
      })}\n`,
    );
    for (const name of ["01.page", "02.page"]) {
      fs.writeFileSync(path.join(root, "pages", name), `${JSON.stringify({ pageType: "content", elements: [] })}\n`);
    }
    const base = await httpEndpoint();
    await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, page: 0 }),
    });
    await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "goToPage", index: 1 }),
    });
    const saved = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "setNotes", pageIndex: 0, notes: "must stay on page one" }),
    });
    assert.equal(saved.status, 200);
    const live = await fetch(`${base}/api/model`).then((response) => response.json());
    assert.equal(live.model.pageIndex, 1);
    assert.equal(live.model.notes, "");
    await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "goToPage", index: 0 }),
    });
    const target = await fetch(`${base}/api/model`).then((response) => response.json());
    assert.equal(target.model.pageIndex, 0);
    assert.equal(target.model.notes, "must stay on page one");
    await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: httpRoot, page: 0 }),
    });
  });
});

describe("isolated project rendering", () => {
  it("returns another project's model without replacing the editor's global project", async () => {
    const otherRoot = fixture();
    writeProject(otherRoot, { title: "Background raster deck", pageText: "Raster only" });
    const base = await httpEndpoint();
    await openHttpRoot(base);
    const before = await fetch(`${base}/api/model`).then((response) => response.json());
    const selected = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "select", elementId: "title" }),
    });
    assert.equal(selected.status, 200);
    const isolated = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openslides-project-view": "isolated",
      },
      body: JSON.stringify({ path: otherRoot, page: 0 }),
    });
    const isolatedBody = await isolated.json();
    assert.equal(isolated.status, 200, JSON.stringify(isolatedBody));
    assert.equal(isolatedBody.isolated, true);
    assert.equal(isolatedBody.model.title, "Background raster deck");

    const health = await fetch(`${base}/api/health`).then((response) => response.json());
    assert.equal(path.resolve(health.project), path.resolve(httpRoot));
    const current = await fetch(`${base}/api/model`).then((response) => response.json());
    assert.equal(current.model.title, before.model.title);
    const edited = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "setText", text: "Still the global project" }),
    });
    const editedBody = await edited.json();
    assert.equal(edited.status, 200, JSON.stringify(editedBody));
    assert.equal(editedBody.model.elements.find((element) => element.id === "title")?.text, "Still the global project");
  });
});

describe("cross-page AI review batch lock", () => {
  const batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openkimi-review-batch-"));
  const pages = ["pages/01_page.page", "pages/02_page.page"];

  function resetBatchRoot() {
    fs.rmSync(path.join(batchRoot, "_agent"), { recursive: true, force: true });
    writeTwoPageProject(batchRoot, "First page", "Second page");
  }

  async function openBatchRoot(base) {
    const response = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: batchRoot, page: 0 }),
    });
    assert.equal(response.status, 200, await response.text());
  }

  /**
   * @param {string} base
   * @param {string} pagePath
   * @param {number} index
   * @returns {Promise<{id: string, revision: number, scope: {pageRevision: number | null}}>}
   */
  async function createBatchReview(base, pagePath, index) {
    const response = await fetch(`${base}/api/reviews`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: batchRoot,
        pagePath,
        comment: {
          id: `batch-${index}`,
          text: `batch note ${index}`,
          scope: { kind: "elements", elementIds: [`0${index}_page-title`] },
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return /** @type {{id: string, revision: number, scope: {pageRevision: number | null}}} */ (
      /** @type {unknown} */ (body.comment)
    );
  }

  /** @param {Array<{id: string, revision: number}>} comments */
  const batchItems = (comments) =>
    comments.map((comment, index) => ({
      pagePath: pages[index],
      commentId: comment.id,
      commentRevision: comment.revision,
    }));

  const lockGuard = path.join(batchRoot, "_agent", "ai-review-lock.v1.json");

  it("takes one project lock for comments on different pages", async () => {
    resetBatchRoot();
    const base = await httpEndpoint();
    await openBatchRoot(base);
    const comments = [await createBatchReview(base, pages[0], 1), await createBatchReview(base, pages[1], 2)];
    const response = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, items: batchItems(comments) }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.items.length, 2);
    assert.deepEqual(
      body.items.map((item) => item.pagePath),
      pages,
    );
    const guard = JSON.parse(fs.readFileSync(lockGuard, "utf8"));
    assert.equal(guard.items.length, 2, "guard file must record every batched comment");
    for (const pagePath of pages) {
      assert.equal(readReviewThreads(batchRoot).pages[pagePath][0].aiStatus, "running");
    }
    const cancelled = await fetch(`${base}/api/reviews/ai-lock/batch/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, token: body.token }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal(fs.existsSync(lockGuard), false, "cancel must release the guard file");
  });

  it("promotes every manually edited page to a current ledger revision before dispatch", async () => {
    resetBatchRoot();
    const before = loadProject(batchRoot);
    writeReviewLedger(batchRoot, stableSha256({ id: "01_page", ...before.pages[0].page }));
    const base = await httpEndpoint();
    await openBatchRoot(base);
    const comments = [await createBatchReview(base, pages[0], 1), await createBatchReview(base, pages[1], 2)];
    assert.equal(comments[1].scope.pageRevision, null);
    const response = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, items: batchItems(comments) }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.items.every((item) => Number.isInteger(item.pageRevision) && item.pageRevision > 0));
    assert.equal(body.items[1].pageSha256, currentPageRevision(batchRoot, "02_page").pageSha256);
    await fetch(`${base}/api/reviews/ai-lock/batch/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, token: body.token }),
    });
  });

  it("refuses the whole batch when one comment revision is stale", async () => {
    resetBatchRoot();
    const base = await httpEndpoint();
    await openBatchRoot(base);
    const first = await createBatchReview(base, pages[0], 1);
    const second = await createBatchReview(base, pages[1], 2);
    // A human edits the second comment: its revision moves on, so the snapshot
    // the batch was built from is stale.
    const bumped = await fetch(`${base}/api/reviews`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: batchRoot,
        pagePath: pages[1],
        comment: { ...second, text: "edited by a human", revision: second.revision },
      }),
    });
    assert.equal(bumped.status, 200);

    const response = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, items: batchItems([first, second]) }),
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "REVIEW_BATCH_CONFLICT");
    assert.deepEqual(body.stale, [
      {
        pagePath: pages[1],
        commentId: second.id,
        reason: "REVIEW_COMMENT_CONFLICT",
      },
    ]);
    // All-or-nothing: the healthy comment must not have been marked running and
    // no lock may be left behind.
    for (const pagePath of pages) {
      const stored = readReviewThreads(batchRoot).pages[pagePath][0];
      assert.notEqual(stored.aiStatus, "running", `${pagePath} must stay untouched`);
    }
    assert.equal(fs.existsSync(lockGuard), false);
  });

  it("fails a preparing submission that has no running comment", async () => {
    const root = fixture();
    writeProject(root);
    const submission = createCommentSubmission(root, [], "review brief");
    const base = await httpEndpoint();

    const response = await fetch(`${base}/api/reviews?project=${encodeURIComponent(root)}&all=1`);
    assert.equal(response.status, 200);
    const receipts = readCommentSubmissions(root);
    assert.equal(receipts.find((entry) => entry.id === submission.id)?.status, "failed");
  });

  it("reports review lock status without exposing its token", async () => {
    const root = fixture();
    writeProject(root);
    const base = await httpEndpoint();
    const acquired = acquireReviewAiLock(root, { pagePath: "page-01" });
    assert.ok(acquired.lock);
    const token = acquired.lock.token;
    const statusUrl = (value) => {
      const query = new URLSearchParams({ project: root, token: value });
      return `${base}/api/reviews/ai-lock/status?${query}`;
    };

    const ownResponse = await fetch(statusUrl(token));
    const own = await ownResponse.json();
    assert.equal(ownResponse.status, 200);
    assert.deepEqual(Object.keys(own).sort(), ["active", "expiresAt", "recoverable"]);
    assert.deepEqual({ active: own.active, recoverable: own.recoverable }, { active: true, recoverable: true });
    assert.equal(JSON.stringify(own).includes(token), false);

    const otherResponse = await fetch(statusUrl("another-token"));
    const other = await otherResponse.json();
    assert.equal(otherResponse.status, 200);
    assert.deepEqual({ active: other.active, recoverable: other.recoverable }, { active: true, recoverable: false });

    const escapedUrl = new URL(statusUrl("token"));
    escapedUrl.searchParams.set("project", path.resolve(root, "..", "outside-project"));
    const escaped = await fetch(escapedUrl);
    assert.notEqual(escaped.status, 200);

    const released = await fetch(`${base}/api/reviews/ai-lock`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: root, token }),
    });
    assert.equal(released.status, 200);
    const inactiveResponse = await fetch(statusUrl(token));
    const inactive = await inactiveResponse.json();
    assert.equal(inactiveResponse.status, 200);
    assert.deepEqual(inactive, { active: false, recoverable: false });
  });

  it("does not delete a durable guard when the in-memory lease expires", () => {
    const root = fixture();
    const acquired = acquireReviewAiLock(root, { pagePath: "page-01" });
    assert.ok(acquired.lock);
    const guard = path.join(root, "_agent", "ai-review-lock.v1.json");
    const live = reviewAiLockByToken(acquired.lock.token);
    assert.ok(live);
    live.expiresAt = Date.now() - 1;

    assert.equal(reviewAiLockByToken(acquired.lock.token), undefined);
    assert.equal(fs.existsSync(guard), true);
  });

  it("apply resolves every batched comment and releases the lock", async () => {
    resetBatchRoot();
    const base = await httpEndpoint();
    await openBatchRoot(base);
    const comments = [await createBatchReview(base, pages[0], 1), await createBatchReview(base, pages[1], 2)];
    const acquired = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, items: batchItems(comments) }),
    }).then((response) => response.json());

    assert.ok(acquired.submission.id, "HTTP response carries the submission identity");
    assert.equal(acquired.submission.status, "preparing");
    for (const pagePath of pages)
      assert.equal(readReviewThreads(batchRoot).pages[pagePath][0].aiSubmissionId, acquired.submission.id);
    // A successful turn must actually affect every authorized page.
    for (const pagePath of pages) {
      const file = path.join(batchRoot, pagePath);
      const body = JSON.parse(fs.readFileSync(file, "utf8"));
      body.elements[0].content.text += " updated";
      fs.writeFileSync(file, JSON.stringify(body));
    }
    const applied = await fetch(`${base}/api/reviews/ai-lock/batch/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, token: acquired.token }),
    });
    const appliedBody = await applied.json();
    assert.equal(applied.status, 200, JSON.stringify(appliedBody));
    assert.equal(appliedBody.applied.length, 2);
    const receipts = JSON.parse(
      fs.readFileSync(path.join(batchRoot, "_agent", "comment-submissions.v1.json"), "utf8"),
    ).submissions;
    assert.equal(receipts.find((item) => item.id === acquired.submission.id).status, "applied");
    for (const pagePath of pages) {
      const stored = readReviewThreads(batchRoot).pages[pagePath][0];
      assert.equal(stored.aiStatus, "applied", `${pagePath} must be auto-resolved`);
    }
    assert.equal(fs.existsSync(lockGuard), false);
  });

  it("rejects partial same-page completion and outside-page changes before accepting both comments", async () => {
    resetBatchRoot();
    const file = path.join(batchRoot, pages[0]);
    const before = JSON.parse(fs.readFileSync(file, "utf8"));
    before.elements.push(textElement("subtitle", "Second target"));
    fs.writeFileSync(file, JSON.stringify(before));
    const outsideFile = path.join(batchRoot, pages[1]);
    const outsideBytes = fs.readFileSync(outsideFile);
    const base = await httpEndpoint();
    await openBatchRoot(base);
    const first = await createBatchReview(base, pages[0], 1);
    const second = await fetch(`${base}/api/reviews`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: batchRoot,
        pagePath: pages[0],
        comment: { id: "second-target", text: "red", scope: { kind: "elements", elementIds: ["subtitle"] } },
      }),
    }).then((response) => response.json());
    const acquired = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: batchRoot,
        items: [first, second.comment].map((comment) => ({
          pagePath: pages[0],
          commentId: comment.id,
          commentRevision: comment.revision,
        })),
      }),
    }).then((response) => response.json());
    assert.ok(acquired.token, JSON.stringify(acquired));
    const apply = () =>
      fetch(`${base}/api/reviews/ai-lock/batch/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: batchRoot, token: acquired.token }),
      });
    const partial = structuredClone(before);
    partial.elements[0].content.color = "#B3261E";
    fs.writeFileSync(file, JSON.stringify(partial));
    const incomplete = await apply();
    const incompleteBody = await incomplete.json();
    assert.equal(incomplete.status, 409);
    assert.equal(incompleteBody.code, "REVIEW_BATCH_INCOMPLETE");
    assert.deepEqual(incompleteBody.verification.missingCommentIds, [second.comment.id]);
    assert.ok(fs.existsSync(lockGuard), "failed acceptance retains protection for rollback");
    assert.ok(readReviewThreads(batchRoot).pages[pages[0]].every((comment) => comment.aiStatus === "running"));
    partial.elements[1].content.color = "#B3261E";
    fs.writeFileSync(file, JSON.stringify(partial));
    const outside = JSON.parse(outsideBytes);
    outside.elements[0].content.text = "unauthorized";
    fs.writeFileSync(outsideFile, JSON.stringify(outside));
    const violation = await apply();
    assert.equal(violation.status, 409);
    assert.equal((await violation.json()).code, "REVIEW_BATCH_SCOPE_VIOLATION");
    fs.writeFileSync(outsideFile, outsideBytes);
    const complete = await apply();
    const completeBody = await complete.json();
    assert.equal(complete.status, 200, JSON.stringify(completeBody));
    assert.deepEqual(completeBody.verification.pageResults[0].changedElementIds, ["01_page-title", "subtitle"]);
    assert.ok(readReviewThreads(batchRoot).pages[pages[0]].every((comment) => comment.aiStatus === "applied"));
    assert.equal(fs.existsSync(lockGuard), false);
  });

  it("cancel keeps every batched comment actionable and releases the lock", async () => {
    resetBatchRoot();
    const base = await httpEndpoint();
    await openBatchRoot(base);
    const comments = [await createBatchReview(base, pages[0], 1), await createBatchReview(base, pages[1], 2)];
    const acquired = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, items: batchItems(comments) }),
    }).then((response) => response.json());

    const cancelled = await fetch(`${base}/api/reviews/ai-lock/batch/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, token: acquired.token }),
    });
    const cancelBody = await cancelled.json();
    assert.equal(cancelled.status, 200, JSON.stringify(cancelBody));
    for (const pagePath of pages) {
      const stored = readReviewThreads(batchRoot).pages[pagePath][0];
      assert.notEqual(stored.aiStatus, "applied", `${pagePath} must stay unresolved`);
      assert.notEqual(stored.aiStatus, "running", `${pagePath} must be retryable`);
    }
    assert.equal(fs.existsSync(lockGuard), false);
  });

  it("rejects an empty or oversized batch before touching any comment", async () => {
    resetBatchRoot();
    const base = await httpEndpoint();
    await openBatchRoot(base);
    const empty = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, items: [] }),
    });
    assert.equal(empty.status, 400);

    const oversized = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: batchRoot,
        items: Array.from({ length: 51 }, (_, index) => ({
          pagePath: pages[index % pages.length],
          commentId: `overflow-${index}`,
          commentRevision: 1,
        })),
      }),
    });
    const overflowBody = await oversized.json();
    assert.equal(oversized.status, 400, JSON.stringify(overflowBody));
    assert.match(overflowBody.error, /50/);
    assert.equal(fs.existsSync(lockGuard), false);
  });

  it("fails closed comments orphaned by a dead batch instead of running forever", async () => {
    resetBatchRoot();
    const base = await httpEndpoint();
    await openBatchRoot(base);
    const comment = await createBatchReview(base, pages[0], 1);
    const acquired = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, items: batchItems([comment]) }),
    }).then((response) => response.json());
    assert.ok(acquired.token, JSON.stringify(acquired));
    assert.equal(readReviewThreads(batchRoot).pages[pages[0]][0].aiStatus, "running");

    // A crash leaves the durable guard behind but drops the in-memory lease.
    // While the guard lease is still live another server may own the batch —
    // the reconcile must not touch it.
    releaseReviewAiLock(path.resolve(batchRoot), acquired.token);
    const liveGuard = {
      version: 1,
      token: acquired.token,
      expiresAt: Date.now() + 60_000,
      items: acquired.items,
    };
    fs.writeFileSync(lockGuard, `${JSON.stringify(liveGuard, null, 2)}\n`, "utf8");
    const untouched = await fetch(`${base}/api/reviews?project=${encodeURIComponent(batchRoot)}&all=1`).then(
      (response) => response.json(),
    );
    assert.equal(untouched.pages[pages[0]][0].aiStatus, "running", "live guard must be honoured");

    // Once the lease is dead too, the next inbox read fails the comment
    // closed so the user can resubmit it.
    fs.writeFileSync(
      lockGuard,
      `${JSON.stringify({ ...liveGuard, expiresAt: Date.now() - 1_000 }, null, 2)}\n`,
      "utf8",
    );
    const healed = await fetch(`${base}/api/reviews?project=${encodeURIComponent(batchRoot)}&all=1`).then((response) =>
      response.json(),
    );
    const healedComment = healed.pages[pages[0]][0];
    assert.equal(healedComment.aiStatus, "failed");
    assert.ok(healedComment.aiError, "orphaned comment must carry a retryable error");
    const receipts = JSON.parse(
      fs.readFileSync(path.join(batchRoot, "_agent", "comment-submissions.v1.json"), "utf8"),
    ).submissions;
    assert.equal(receipts.find((item) => item.id === acquired.submission.id).status, "failed");
    assert.equal(fs.existsSync(lockGuard), false, "stale guard must not keep blocking the write gate");

    // The failed comment is resubmittable: a fresh batch takes it.
    const resubmitted = await fetch(`${base}/api/reviews/ai-lock/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, items: batchItems([healedComment]) }),
    }).then((response) => response.json());
    assert.ok(resubmitted.token, JSON.stringify(resubmitted));
    await fetch(`${base}/api/reviews/ai-lock/batch/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: batchRoot, token: resubmitted.token }),
    });
  });
});
