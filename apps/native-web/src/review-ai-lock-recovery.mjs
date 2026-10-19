import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{
 *   activeReviewAiLock: (root: string) => object | undefined,
 *   readReviewAiGuardFile: (root: string) => {expiresAt?: number} | undefined,
 *   readReviewThreads: (root: string) => {pages: Record<string, unknown>, revision: number},
 *   readCommentSubmissions: (root: string) => Array<{id?: string, status?: string}>,
 *   removeReviewAiGuard: (root: string) => void,
 *   finishCommentSubmission: (root: string, id: string, status: string, error: string) => void,
 *   nonEmptyString: (value: unknown) => string | undefined,
 *   reviewThreadsRelativePath: string
 * }} ReviewAiRecoveryDependencies
 */

/**
 * @param {{pptd: {withProjectWriteLock: (root: string, task: () => boolean) => boolean}}} native
 * @param {string} root
 * @param {ReviewAiRecoveryDependencies} dependencies
 */
export function reconcileOrphanedAiReviews(native, root, dependencies) {
  const key = path.resolve(root);
  try {
    if (dependencies.activeReviewAiLock(key)) return false;
    const initialGuard = dependencies.readReviewAiGuardFile(key);
    if (initialGuard && Number(initialGuard.expiresAt) > Date.now()) return false;
    const initialRecord = dependencies.readReviewThreads(key);
    const initialSubmissions = dependencies.readCommentSubmissions(key);
    const hasRunningThreads = Object.values(initialRecord.pages).some(
      (threads) => Array.isArray(threads) && threads.some((thread) => thread?.aiStatus === "running"),
    );
    const hasPreparingSubmissions = initialSubmissions.some((entry) => entry?.status === "preparing");
    const hasExpiredGuard = initialGuard && Number(initialGuard.expiresAt) <= Date.now();
    if (!hasExpiredGuard && !hasRunningThreads && !hasPreparingSubmissions) return false;
    return native.pptd.withProjectWriteLock(key, () => {
      if (dependencies.activeReviewAiLock(key)) return false;
      const guard = dependencies.readReviewAiGuardFile(key);
      if (guard && Number(guard.expiresAt) > Date.now()) return false;
      const record = dependencies.readReviewThreads(root);
      const submissions = dependencies.readCommentSubmissions(root);
      const orphanedSubmissionIds = new Set(
        submissions
          .filter((entry) => entry?.status === "preparing")
          .map((entry) => dependencies.nonEmptyString(entry.id))
          .filter((id) => id !== undefined),
      );
      const pages = { ...record.pages };
      let touched = false;
      for (const [pagePath, threads] of Object.entries(pages)) {
        if (!Array.isArray(threads)) continue;
        const next = threads.map((thread) => {
          if (thread?.aiStatus !== "running") return thread;
          touched = true;
          return {
            ...thread,
            revision: (Number.isInteger(thread.revision) ? thread.revision : 0) + 1,
            aiStatus: "failed",
            aiError: "AI 修改中断（会话或服务已重启），请重新提交",
          };
        });
        pages[pagePath] = next;
      }
      if (touched) writeReviewThreads(root, record, pages, dependencies.reviewThreadsRelativePath);
      for (const submissionId of orphanedSubmissionIds) {
        dependencies.finishCommentSubmission(root, submissionId, "failed", "interrupted before the batch finished");
      }
      if (guard && Number(guard.expiresAt) <= Date.now()) dependencies.removeReviewAiGuard(key);
      return touched || orphanedSubmissionIds.size > 0;
    });
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @param {string} token
 * @param {{
 *   activeReviewAiLock: (root: string) => {token: string, expiresAt: number} | undefined,
 *   readReviewAiGuardFile: (root: string) => {expiresAt?: number} | undefined
 * }} dependencies
 */
export function reviewAiLockStatus(root, token, dependencies) {
  const memoryLock = dependencies.activeReviewAiLock(root);
  const guard = dependencies.readReviewAiGuardFile(root);
  const durableExpiresAt = Number(guard?.expiresAt);
  const durableActive = Number.isFinite(durableExpiresAt) && durableExpiresAt > Date.now();
  const active = Boolean(memoryLock || durableActive);
  const expiresAt = Math.max(memoryLock?.expiresAt || 0, durableActive ? durableExpiresAt : 0);
  return {
    active,
    recoverable: Boolean(memoryLock && memoryLock.token === token),
    ...(active && Number.isFinite(expiresAt) ? { expiresAt } : {}),
  };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @param {{
 *   native: {pptd: {withProjectWriteLock: (root: string, task: () => boolean) => boolean}},
 *   json: (res: import("node:http").ServerResponse, status: number, body: unknown) => void,
 *   reviewProjectPath: (project: string | null) => string,
 *   requestOriginAllowed: (req: import("node:http").IncomingMessage, url: URL) => boolean,
 *   nonEmptyString: (value: unknown) => string | undefined,
 *   reconcile: (native: unknown, root: string) => boolean,
 *   status: (root: string, token: string) => object
 * }} dependencies
 * @returns {boolean}
 */
export function handleReviewAiLockStatus(req, res, url, dependencies) {
  if (req.method !== "GET" || url.pathname !== "/api/reviews/ai-lock/status") return false;
  if (!dependencies.requestOriginAllowed(req, url)) {
    dependencies.json(res, 403, { error: "cross-site review status rejected" });
    return true;
  }
  try {
    const reviewRoot = dependencies.reviewProjectPath(url.searchParams.get("project"));
    const token = dependencies.nonEmptyString(url.searchParams.get("token"));
    if (!token) {
      dependencies.json(res, 400, { error: "token is required", code: "REVIEW_LOCK_TOKEN_REQUIRED" });
      return true;
    }
    dependencies.reconcile(dependencies.native, reviewRoot);
    dependencies.json(res, 200, dependencies.status(reviewRoot, token));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    dependencies.json(res, code === "REVIEW_PROJECT_NOT_FOUND" ? 404 : 400, {
      error: error instanceof Error ? error.message : String(error),
      ...(code ? { code } : {}),
    });
  }
  return true;
}

/**
 * @param {string} root
 * @param {{pages: Record<string, unknown>, revision: number}} record
 * @param {Record<string, unknown>} pages
 * @param {string} relativePath
 */
function writeReviewThreads(root, record, pages, relativePath) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    temp,
    `${JSON.stringify({ ...record, revision: record.revision + 1, updatedAt: new Date().toISOString(), pages }, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(temp, file);
}
