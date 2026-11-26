import crypto from "node:crypto";
import path from "node:path";
import { readReviewAiGuardFile, removeReviewAiGuard, writeReviewAiGuard } from "./review-ai-guard.mjs";

// The durable guard file lives in review-ai-guard.mjs; these re-exports keep the module's
// historical import surface for server.mjs and the review fixtures.
export { readReviewAiGuardFile, removeReviewAiGuard, writeReviewAiGuard };

export const REVIEW_AI_LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * @typedef {{pageId?: string, pagePath?: string, pageSha256?: string, revision?: number, [key: string]: unknown}} ReviewAiPageRecord
 * @typedef {{
 *   root: string,
 *   token: string,
 *   pagePath: string,
 *   expiresAt: number,
 *   createdAt: string,
 *   renewedAt?: number,
 *   commentId?: string,
 *   commentRevision?: number,
 *   scope?: {
 *     commentId?: string,
 *     kind?: string,
 *     elementIds?: string[],
 *     pageId?: string,
 *     pagePath?: string,
 *     pageSha256?: string,
 *     targetPageIds?: string[],
 *     targetPages?: ReviewAiPageRecord[],
 *     deletablePageIds?: string[],
 *     editablePageIds?: string[],
 *     editableMeta?: string[],
 *     expectedAddCount?: number,
 *     insertIndex?: number,
 *     metaOnly?: boolean,
 *     reorderPageIds?: string[],
 *     rewrite?: boolean,
 *     structureOnly?: boolean,
 *   },
 *   pageSha256?: string,
 *   pageBody?: Record<string, unknown>,
 *   items?: ReviewAiPageRecord[],
 *   deckState?: Record<string, unknown>,
 *   projectPages?: ReviewAiPageRecord[],
 *   snapshotVersionId?: string,
 *   restored?: boolean,
 *   submissionId?: string,
 *   workspaceVerified?: boolean,
 * }} ReviewAiLock
 */

/** @type {Map<string, ReviewAiLock>} */
export const reviewAiLocks = new Map();

/** @param {string} root */
export function activeReviewAiLock(root) {
  const key = path.resolve(root);
  const lock = reviewAiLocks.get(key);
  if (!lock) return undefined;
  if (lock.expiresAt <= Date.now()) {
    reviewAiLocks.delete(key);
    return undefined;
  }
  return lock;
}

/** @param {unknown} token */
export function reviewAiLockByToken(token) {
  const expected = typeof token === "string" ? token.trim() : "";
  if (!expected) return undefined;
  for (const root of reviewAiLocks.keys()) {
    const lock = activeReviewAiLock(root);
    if (lock?.token === expected) return lock;
  }
  return undefined;
}

/**
 * @param {unknown} token
 * @param {{writeGuard?: (root: string, lock: ReviewAiLock) => void}} options
 */
export function renewReviewAiLock(token, { writeGuard = writeReviewAiGuard } = {}) {
  const lock = reviewAiLockByToken(token);
  if (!lock) return undefined;
  const durable = readReviewAiGuardFile(lock.root);
  if (durable && durable.token !== lock.token) return undefined;
  // The browser did call; a failed guard write below is the server's fault, so it still counts
  // as proof that the holding tab is alive (see comment-batch-settle.mjs).
  lock.renewedAt = Date.now();
  const next = { ...lock, expiresAt: Date.now() + REVIEW_AI_LOCK_TTL_MS };
  writeGuard(lock.root, next);
  lock.expiresAt = next.expiresAt;
  return lock;
}

/**
 * @param {string} root
 * @param {{
 *   pagePath?: unknown,
 *   commentId?: unknown,
 *   commentRevision?: unknown,
 *   scope?: unknown,
 *   pageSha256?: unknown,
 *   pageBody?: unknown,
 *   deckState?: unknown,
 *   projectPages?: unknown,
 *   items?: unknown,
 * }} options
 * @param {(value: unknown) => string} normalizePagePath
 */
export function acquireReviewAiLock(
  root,
  { pagePath, commentId, commentRevision, scope, pageSha256, pageBody, deckState, projectPages, items } = {},
  normalizePagePath,
) {
  const key = path.resolve(root);
  const current = activeReviewAiLock(key);
  if (current) return { conflict: true, lock: current };
  const durable = readReviewAiGuardFile(key);
  if (durable && Number(durable.expiresAt) > Date.now()) return { conflict: true };
  /** @type {ReviewAiLock} */
  const lock = {
    token: crypto.randomUUID(),
    root: key,
    pagePath: normalizePagePath(pagePath),
    commentId: typeof commentId === "string" && commentId.trim() ? commentId.trim() : undefined,
    commentRevision: Number.isSafeInteger(commentRevision) ? Number(commentRevision) : undefined,
    scope:
      scope && typeof scope === "object" ? /** @type {ReviewAiLock["scope"]} */ (structuredClone(scope)) : undefined,
    pageSha256: typeof pageSha256 === "string" && pageSha256.trim() ? pageSha256.trim() : undefined,
    pageBody:
      pageBody && typeof pageBody === "object"
        ? /** @type {Record<string, unknown>} */ (structuredClone(pageBody))
        : undefined,
    items:
      Array.isArray(items) && items.length ? /** @type {ReviewAiPageRecord[]} */ (structuredClone(items)) : undefined,
    deckState:
      deckState && typeof deckState === "object"
        ? /** @type {Record<string, unknown>} */ (structuredClone(deckState))
        : undefined,
    projectPages: Array.isArray(projectPages)
      ? /** @type {ReviewAiPageRecord[]} */ (structuredClone(projectPages))
      : undefined,
    snapshotVersionId: undefined,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + REVIEW_AI_LOCK_TTL_MS,
    renewedAt: Date.now(),
  };
  writeReviewAiGuard(key, lock);
  reviewAiLocks.set(key, lock);
  return { conflict: false, lock };
}

/**
 * @param {string} root
 * @param {unknown} token
 */
export function releaseReviewAiLock(root, token) {
  const key = path.resolve(root);
  const current = activeReviewAiLock(key);
  if (!current) return { released: true };
  if (!token || token !== current.token) return { released: false, lock: current };
  const durable = readReviewAiGuardFile(key);
  if (durable && durable.token !== current.token) return { released: false };
  reviewAiLocks.delete(key);
  if (durable) removeReviewAiGuard(key);
  return { released: true };
}

/**
 * The assistant request id a pre-edit snapshot records. A comment batch is identified by the
 * server-issued submission id, which its reply message carries as `reviewSubmissionId`, so the
 * reply gets its 查看修改前 link; a client-supplied id is honoured only for workspace edits.
 * @param {ReviewAiLock | undefined} lock
 * @param {unknown} requested the request body's `assistantRequestId`
 * @returns {string | undefined}
 */
export function snapshotAssistantRequestId(lock, requested) {
  if (!lock) return undefined;
  if (lock.submissionId) return lock.submissionId;
  return !lock.commentId && typeof requested === "string" ? requested : undefined;
}
