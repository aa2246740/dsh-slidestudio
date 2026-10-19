import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REVIEW_AI_LOCK_TTL_MS = 15 * 60 * 1000;
const REVIEW_AI_LOCK_REL = path.join("_agent", "ai-review-lock.v1.json");

/**
 * @typedef {{pageId?: string, pagePath?: string, pageSha256?: string, revision?: number, [key: string]: unknown}} ReviewAiPageRecord
 * @typedef {{
 *   root: string,
 *   token: string,
 *   pagePath: string,
 *   expiresAt: number,
 *   createdAt: string,
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

/**
 * @param {string} root
 * @param {ReviewAiLock} lock
 */
export function writeReviewAiGuard(root, lock) {
  const file = path.join(root, REVIEW_AI_LOCK_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    temp,
    `${JSON.stringify(
      {
        version: 1,
        token: lock.token,
        pagePath: lock.pagePath,
        commentId: lock.commentId,
        scope: lock.scope,
        commentRevision: lock.commentRevision,
        pageSha256: lock.pageSha256,
        pageBody: lock.pageBody,
        ...(Array.isArray(lock.items) && lock.items.length ? { items: lock.items } : {}),
        ...(Array.isArray(lock.projectPages) && lock.projectPages.length ? { projectPages: lock.projectPages } : {}),
        createdAt: lock.createdAt,
        expiresAt: lock.expiresAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.renameSync(temp, file);
}

/** @param {string} root */
export function removeReviewAiGuard(root) {
  fs.rmSync(path.join(root, REVIEW_AI_LOCK_REL), { force: true });
}

/** @param {string} root */
export function readReviewAiGuardFile(root) {
  try {
    const file = path.join(root, REVIEW_AI_LOCK_REL);
    if (!fs.existsSync(file)) return undefined;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

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
