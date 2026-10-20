import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach } from "node:test";

const httpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openkimi-review-http-"));
/**
 * @param {string} root
 * @param {{title?: string, pageText?: string, theme?: Record<string, unknown>, elements?: Array<Record<string, unknown>>}} [options]
 */
function writeProject(root, { title = "Review deck", pageText = "Before", theme = {}, elements } = {}) {
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "deck.pptd"),
    `${JSON.stringify({
      version: "v2",
      title,
      size: [960, 540],
      theme,
      pages: ["pages/01_page.page"],
    })}\n`,
  );
  fs.writeFileSync(
    path.join(root, "pages", "01_page.page"),
    `${JSON.stringify({
      pageType: "content",
      elements: elements ?? [
        {
          elementId: "title",
          elementType: "text",
          bounds: [80, 80, 800, 60],
          content: { text: pageText, fontSize: 32 },
        },
      ],
    })}\n`,
  );
}

/** @param {string} root @param {string} firstText @param {string} secondText */
function writeTwoPageProject(root, firstText, secondText) {
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "deck.pptd"),
    `${JSON.stringify({
      version: "v2",
      title: "Two-page review deck",
      size: [960, 540],
      theme: {},
      pages: ["pages/01_page.page", "pages/02_page.page"],
    })}\n`,
  );
  for (const [name, text] of [
    ["01_page", firstText],
    ["02_page", secondText],
  ]) {
    fs.writeFileSync(
      path.join(root, "pages", `${name}.page`),
      `${JSON.stringify({
        pageType: "content",
        elements: [textElement(`${name}-title`, text)],
      })}\n`,
    );
  }
}

/** @param {string} root @param {string} firstText @param {string} secondText @param {string} thirdText */
function writeThreePageProject(root, firstText, secondText, thirdText) {
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  const entries = [
    ["01_page", firstText],
    ["02_page", secondText],
    ["03_page", thirdText],
  ];
  fs.writeFileSync(
    path.join(root, "deck.pptd"),
    `${JSON.stringify({
      version: "v2",
      title: "Three-page review deck",
      size: [960, 540],
      theme: {},
      pages: entries.map(([name]) => `pages/${name}.page`),
    })}\n`,
  );
  for (const [name, text] of entries) {
    fs.writeFileSync(
      path.join(root, "pages", `${name}.page`),
      `${JSON.stringify({
        pageType: "content",
        elements: [textElement(`${name}-title`, text)],
      })}\n`,
    );
  }
}
writeProject(httpRoot);
// Must be set before the dynamic import: server.mjs reads it to choose the
// project that its HTTP handler owns.
process.env.OPEN_SLIDESTUDIO_PROJECT = httpRoot;
const {
  acquireReviewAiLock,
  captureWorkspaceEditScope,
  readReviewThreads,
  releaseReviewAiLock,
  reviewAiLockByToken,
  renewReviewAiLock,
  reviewDeckDelta,
  reviewPageDelta,
  sanitizeReviewThread,
  server,
  upsertReviewThread,
} = await import("./server.mjs");
const { createEmptyProject, loadProject } = await import("../../../packages/pptd-v2/dist/index.js");
const { currentPageRevision, inspectRunLedger, stableSha256 } =
  await import("../../../packages/presentation-run/dist/index.js");
const { editorReviewScopeFromEdit } = await import("../../../packages/dsh-slides-host/dist/routes.js");
const { createCommentSubmission, readCommentSubmissions } = await import("./comment-submissions.mjs");

/** @type {string[]} */
const roots = [];
const native = {
  pptd: {
    /** @param {string} _root @param {() => unknown} fn */
    withProjectWriteLock(_root, fn) {
      return fn();
    },
  },
};

/** @returns {string} */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openkimi-review-cas-"));
  roots.push(root);
  return root;
}

/** @returns {Promise<string>} */
async function httpEndpoint() {
  if (!server.listening) await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not read the review server address");
  return `http://127.0.0.1:${address.port}`;
}

/** @param {string} base */
async function openHttpRoot(base) {
  const response = await fetch(`${base}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: httpRoot, page: 0 }),
  });
  assert.equal(response.status, 200);
}

/**
 * @param {string} base
 * @param {{id?: string, text?: string, kind?: string, elementIds?: string[], project?: string}} [options]
 */
async function createHttpReview(
  base,
  { id, text = "review", kind = "elements", elementIds = ["title"], project = httpRoot } = {},
) {
  const response = await fetch(`${base}/api/reviews`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project,
      pagePath: "pages/01_page.page",
      comment: { id, text, scope: { kind, elementIds } },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.comment;
}

/** @param {string} elementId @param {string} text */
function textElement(elementId, text) {
  return {
    elementId,
    elementType: "text",
    bounds: [80, 80, 800, 60],
    content: { text, fontSize: 32 },
  };
}

/** @param {string} root @param {string} pageSha256 @param {number} [revision] */
function writeReviewLedger(root, pageSha256, revision = 6) {
  const at = "2026-09-06T00:00:00.000Z";
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "run-ledger.v1.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: "review-human-edit-session",
        createdAt: at,
        updatedAt: at,
        sourcePack: {
          manifestSha256: "a".repeat(64),
          requirementsId: "b".repeat(64),
          requirements: [],
        },
        facts: [
          {
            type: "page.revision-committed",
            factId: "page-before-human-edit",
            at,
            contextEpochId: "review-human-edit-epoch",
            pageId: "01_page",
            revision,
            pageSha256,
          },
          {
            type: "page.raster-committed",
            factId: "raster-before-human-edit",
            at,
            pageId: "01_page",
            revision,
            pageSha256,
            rasterSha256: "c".repeat(64),
            src: "_agent/rasters/01_page.png",
            width: 960,
            height: 540,
            layoutGateVersion: "rendered-layout-gate-v8",
            layoutStatus: "pass",
            layoutIssues: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/** @param {string} root @param {number} [revision] */
function writeWorkspaceReviewLedger(root, revision = 6) {
  const at = "2026-09-06T00:00:00.000Z";
  const project = loadProject(root);
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "run-ledger.v1.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: "workspace-review-session",
        createdAt: at,
        updatedAt: at,
        sourcePack: {
          manifestSha256: "a".repeat(64),
          requirementsId: "b".repeat(64),
          requirements: [],
        },
        facts: project.pages.map((entry) => {
          const pageId = path.basename(entry.path, ".page");
          return {
            type: "page.revision-committed",
            factId: `workspace-${pageId}`,
            at,
            contextEpochId: "workspace-review-epoch",
            pageId,
            revision,
            pageSha256: stableSha256({ id: pageId, ...entry.page }),
          };
        }),
      },
      null,
      2,
    )}\n`,
  );
}

/** @param {string} root @param {string} commentId */
function findReviewStatus(root, commentId) {
  const record = readReviewThreads(root);
  return record.pages["pages/01_page.page"]?.find(
    /** @param {{id: string, aiStatus?: unknown}} comment */ (comment) => comment.id === commentId,
  )?.aiStatus;
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(httpRoot, { recursive: true, force: true });
});

export {
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
  server,
  upsertReviewThread,
  createEmptyProject,
  loadProject,
  currentPageRevision,
  inspectRunLedger,
  stableSha256,
  editorReviewScopeFromEdit,
  createCommentSubmission,
  readCommentSubmissions,
  roots,
  native,
  fixture,
  httpEndpoint,
  openHttpRoot,
  createHttpReview,
  textElement,
  writeReviewLedger,
  writeWorkspaceReviewLedger,
  findReviewStatus,
};
