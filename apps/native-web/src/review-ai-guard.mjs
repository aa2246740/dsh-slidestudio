import fs from "node:fs";
import path from "node:path";

/**
 * The durable, cross-process half of the AI review lease: `_agent/ai-review-lock.v1.json`.
 * The DSH Host write gate reads this file, so every write is an atomic rename and only the
 * fields the Host needs are persisted. Memory-only lease facts (for example `renewedAt`, the
 * last time the holding browser proved it was alive) never reach the disk.
 */

export const REVIEW_AI_LOCK_REL = path.join("_agent", "ai-review-lock.v1.json");

/**
 * @typedef {{
 *   token: string,
 *   pagePath: string,
 *   expiresAt: number,
 *   createdAt: string,
 *   commentId?: string,
 *   commentRevision?: number,
 *   scope?: unknown,
 *   pageSha256?: string,
 *   pageBody?: unknown,
 *   items?: unknown[],
 *   projectPages?: unknown[],
 * }} ReviewAiGuardSource
 */

/** The exact on-disk shape; optional arrays are omitted when empty so the single-comment
 * contract keeps its legacy bytes.
 * @param {ReviewAiGuardSource} lock */
export function reviewAiGuardRecord(lock) {
  return {
    version: 1,
    token: lock.token,
    pagePath: lock.pagePath,
    commentId: lock.commentId,
    scope: lock.scope,
    commentRevision: lock.commentRevision,
    pageSha256: lock.pageSha256,
    // Immutable element-scope baseline for the Host's prospective write gate.
    pageBody: lock.pageBody,
    ...(Array.isArray(lock.items) && lock.items.length ? { items: lock.items } : {}),
    // Structural edits need the page-set baseline so sequential writes keep landing after the
    // pages this same turn already inserted.
    ...(Array.isArray(lock.projectPages) && lock.projectPages.length ? { projectPages: lock.projectPages } : {}),
    createdAt: lock.createdAt,
    expiresAt: lock.expiresAt,
  };
}

/**
 * @param {string} root
 * @param {ReviewAiGuardSource} lock
 */
export function writeReviewAiGuard(root, lock) {
  const file = path.join(root, REVIEW_AI_LOCK_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(reviewAiGuardRecord(lock), null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

/** @param {string} root */
export function removeReviewAiGuard(root) {
  fs.rmSync(path.join(root, REVIEW_AI_LOCK_REL), { force: true });
}

/**
 * A missing, unreadable or non-object guard reads as absent.
 * @param {string} root
 * @returns {Record<string, any> | undefined}
 */
export function readReviewAiGuardFile(root) {
  try {
    const file = path.join(root, REVIEW_AI_LOCK_REL);
    if (!fs.existsSync(file)) return undefined;
    /** @type {unknown} */
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `task` with the durable guard lifted and always puts it back, so a snapshot taken by
 * `task` never captures the coordination file while the server still owns the review.
 * Without a lock the task runs unchanged.
 * @template T
 * @param {string} root
 * @param {ReviewAiGuardSource | undefined} lock
 * @param {() => T} task
 * @returns {T}
 */
export function withReviewAiGuardLifted(root, lock, task) {
  if (!lock) return task();
  removeReviewAiGuard(root);
  try {
    return task();
  } finally {
    writeReviewAiGuard(root, lock);
  }
}
