import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import * as pptd from "@open-slidestudio/pptd-v2";
import * as store from "@open-slidestudio/project-store";
import { readReviewAiGuardFile, writeReviewAiGuard } from "./review-ai-guard.mjs";
import { RESTORE_PRESERVED_AGENT_FILES, restoreVersionWithinLock } from "./review-version-restore.mjs";
import { captureProjectFiles, restoreProjectFiles, waitForTestBarrier } from "./server-files.mjs";

const REVIEWS_REL = "_agent/review-threads.v1.json";
const native = { pptd, store };

/** @type {string[]} */
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string} text */
function pageBytes(text) {
  return `${JSON.stringify({
    pageType: "content",
    elements: [{ elementId: "title", elementType: "text", bounds: [80, 80, 800, 60], content: { text, fontSize: 32 } }],
  })}\n`;
}

/** A one-page deck snapshotted as its first version, then edited by "the AI". */
function projectWithSnapshot() {
  const root = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "review-restore-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "deck.pptd"),
    `${JSON.stringify({ version: "v2", title: "Restore", size: [960, 540], theme: {}, pages: ["pages/01.page"] })}\n`,
  );
  fs.writeFileSync(path.join(root, "pages/01.page"), pageBytes("Before"));
  const before = store.snapshotVersion(root, { label: "AI 修改前" });
  fs.writeFileSync(path.join(root, "pages/01.page"), pageBytes("After AI"));
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(path.join(root, REVIEWS_REL), '{"latest":"reviews"}');
  fs.writeFileSync(path.join(root, "_agent/comment-submissions.v1.json"), '{"latest":"receipts"}');
  return { root, id: before.id };
}

function hostSpy() {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    host: {
      ensureSession: (/** @type {unknown} */ _native, /** @type {string} */ root) => {
        calls.push(`ensure:${root}`);
        return `session:${root}`;
      },
      persistLiveSession: (/** @type {unknown} */ _native, /** @type {string} */ session) => {
        calls.push(`persist:${session}`);
      },
      openLiveSession: (/** @type {unknown} */ _native, /** @type {string} */ root) => {
        calls.push(`open:${root}`);
        return `reopened:${root}`;
      },
      reviewThreadsRel: REVIEWS_REL,
    },
  };
}

const lockFor = (/** @type {string} */ root) => ({
  token: "lease-1",
  root,
  pagePath: "pages/01.page",
  createdAt: new Date().toISOString(),
  expiresAt: Date.now() + 60_000,
});

describe("restoring a pre-edit version inside one write-locked transaction", () => {
  it("restores pages, keeps the latest conversation and reviews, and keeps an AI lease guarded", () => {
    const { root, id } = projectWithSnapshot();
    const reviewLock = lockFor(root);
    writeReviewAiGuard(root, reviewLock);
    const { host, calls } = hostSpy();
    const result = restoreVersionWithinLock(native, { restoreRoot: root, projectRoot: root, id, reviewLock }, host);
    assert.ok(!("missing" in result));
    assert.equal(fs.readFileSync(path.join(root, "pages/01.page"), "utf8"), pageBytes("Before"));
    assert.equal(fs.readFileSync(path.join(root, REVIEWS_REL), "utf8"), '{"latest":"reviews"}');
    assert.equal(
      fs.readFileSync(path.join(root, "_agent/comment-submissions.v1.json"), "utf8"),
      '{"latest":"receipts"}',
    );
    assert.equal(readReviewAiGuardFile(root)?.token, "lease-1");
    assert.equal(result.beforeRestore.label, "恢复前");
    assert.equal(result.restored.label, `从 ${id} 恢复`);
    assert.equal(result.versions.length, 3);
    assert.equal(result.session, `reopened:${root}`);
    // An AI lease never persists the live editor session over the AI's pages first.
    assert.deepEqual(calls, [`open:${root}`]);
    for (const version of result.versions) {
      const archived = path.join(store.versionDir(root, version.id), "_agent", "ai-review-lock.v1.json");
      assert.equal(fs.existsSync(archived), false, `${version.id} must not archive the guard`);
    }
  });

  it("persists the live session first when a person restores without a lease", () => {
    const { root, id } = projectWithSnapshot();
    const { host, calls } = hostSpy();
    const result = restoreVersionWithinLock(native, { restoreRoot: root, projectRoot: root, id }, host);
    assert.ok(!("missing" in result));
    assert.deepEqual(calls, [`ensure:${root}`, `persist:session:${root}`, `open:${root}`]);
    assert.equal(readReviewAiGuardFile(root), undefined);
  });

  it("reports an unknown version as missing and touches nothing", () => {
    const { root } = projectWithSnapshot();
    const { host, calls } = hostSpy();
    const result = restoreVersionWithinLock(native, { restoreRoot: root, projectRoot: root, id: "v99" }, host);
    assert.deepEqual(result, { missing: true });
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(path.join(root, "pages/01.page"), "utf8"), pageBytes("After AI"));
  });

  it("puts the guard back even when the destructive restore fails", () => {
    const { root, id } = projectWithSnapshot();
    const reviewLock = lockFor(root);
    writeReviewAiGuard(root, reviewLock);
    const failing = {
      pptd,
      store: {
        ...store,
        restoreVersion: () => {
          throw new Error("disk full");
        },
      },
    };
    assert.throws(
      () => restoreVersionWithinLock(failing, { restoreRoot: root, projectRoot: root, id, reviewLock }, hostSpy().host),
      /disk full/,
    );
    assert.equal(readReviewAiGuardFile(root)?.token, "lease-1");
  });

  it("names every agent file a restore keeps current", () => {
    assert.ok(RESTORE_PRESERVED_AGENT_FILES.includes("assistant-conversation.v1.json"));
    assert.ok(RESTORE_PRESERVED_AGENT_FILES.includes("comment-submissions.v1.json"));
    assert.equal(Object.isFrozen(RESTORE_PRESERVED_AGENT_FILES), true);
  });
});

describe("project file capture and test barriers", () => {
  it("round-trips present and absent files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "server-files-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "kept.json"), "kept");
    const captured = captureProjectFiles(root, ["kept.json", "nested/absent.json"]);
    fs.writeFileSync(path.join(root, "kept.json"), "changed");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested/absent.json"), "appeared");
    restoreProjectFiles(root, captured);
    assert.equal(fs.readFileSync(path.join(root, "kept.json"), "utf8"), "kept");
    assert.equal(fs.existsSync(path.join(root, "nested/absent.json")), false);
  });

  it("passes an unarmed barrier and releases an armed one", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "barrier-"));
    roots.push(dir);
    const name = "NATIVE_WEB_TEST_BARRIER_FIXTURE";
    const saved = process.env[name];
    t.after(() => {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    });
    delete process.env[name];
    waitForTestBarrier(name, "reached", "fixture");
    process.env[name] = dir;
    waitForTestBarrier(name, "reached", "fixture");
    assert.equal(fs.existsSync(path.join(dir, "reached")), false, "an unarmed barrier does not stop");
    fs.writeFileSync(path.join(dir, "arm"), "");
    fs.writeFileSync(path.join(dir, "release"), "");
    waitForTestBarrier(name, "reached", "fixture");
    assert.equal(fs.existsSync(path.join(dir, "reached")), true);
    assert.equal(fs.existsSync(path.join(dir, "arm")), false);
  });
});
