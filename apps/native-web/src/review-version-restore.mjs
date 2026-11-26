import path from "node:path";
import { captureProjectFiles, restoreProjectFiles, waitForRestoreBarrier } from "./server-files.mjs";
import { withReviewAiGuardLifted, writeReviewAiGuard } from "./review-ai-guard.mjs";

/** @typedef {import("./review-ai-guard.mjs").ReviewAiGuardSource} ReviewAiGuardSource */
/** @typedef {import("@open-slidestudio/project-store").VersionMeta} VersionMeta */
/**
 * The slice of the native runtime one restore transaction uses; the server's Native satisfies it.
 * @typedef {{
 *   pptd: { withProjectWriteLock: <T>(root: string, task: () => T) => T },
 *   store: {
 *     listVersions: (root: string) => VersionMeta[],
 *     snapshotVersion: (root: string, options?: { label?: string }) => VersionMeta,
 *     restoreVersion: (root: string, id: string) => void,
 *   },
 * }} RestoreNative
 */
/**
 * The editor-session functions that still live in server.mjs.
 * @template S
 * @typedef {{
 *   ensureSession: (native: any, projectRoot: string) => S,
 *   persistLiveSession: (native: any, session: S, projectRoot: string) => unknown,
 *   openLiveSession: (native: any, root: string) => S,
 *   reviewThreadsRel: string,
 * }} RestoreHost
 */

/** A document version restores pages and their validation ledger. Conversation, provider
 * binding and live turn history stay current across it. */
export const RESTORE_PRESERVED_AGENT_FILES = Object.freeze([
  "comment-submissions.v1.json",
  "assistant-conversation.v1.json",
  "assistant-questions.v1.json",
  "agent-trace.jsonl",
  "attempt.v1.json",
  "dsh-agent-error.json",
  "dsh-rate-limit-wait.json",
  "slice-session.v1.json",
  "presentation-run.v1.json",
  "runtime.json",
  "dsh-runtime.json",
]);

/** @param {string} reviewThreadsRel */
function preservedFiles(reviewThreadsRel) {
  return [reviewThreadsRel, ...RESTORE_PRESERVED_AGENT_FILES.map((name) => `_agent/${name}`)];
}

/**
 * One read/persist/snapshot/restore/reopen transaction under the project write lock. The nested
 * PPTD/store operations are reentrant, so a DSH writer only runs before or after it, never
 * between the automatic pre-restore backup and the destructive restore. The AI review lock, when
 * given, stays guarded on disk for every path out of it; only the lease release removes it.
 * @template S
 * @param {RestoreNative} native
 * @param {{ restoreRoot: string, projectRoot: string, id: string, reviewLock?: ReviewAiGuardSource }} options
 * @param {RestoreHost<S>} host
 * @returns {{ missing: true } | { beforeRestore: VersionMeta, restored: VersionMeta, versions: VersionMeta[], session: S }}
 */
export function restoreVersionWithinLock(native, { restoreRoot, projectRoot, id, reviewLock }, host) {
  return native.pptd.withProjectWriteLock(restoreRoot, () => {
    if (!native.store.listVersions(restoreRoot).some((version) => version.id === id)) {
      return /** @type {{ missing: true }} */ ({ missing: true });
    }
    if (!reviewLock && path.resolve(projectRoot) === restoreRoot) {
      host.persistLiveSession(native, host.ensureSession(native, projectRoot), projectRoot);
    }
    try {
      const kept = captureProjectFiles(restoreRoot, preservedFiles(host.reviewThreadsRel));
      // Snapshots never archive the coordination guard.
      const beforeRestore = withReviewAiGuardLifted(restoreRoot, reviewLock, () =>
        native.store.snapshotVersion(restoreRoot, { label: "恢复前" }),
      );
      waitForRestoreBarrier();
      native.store.restoreVersion(restoreRoot, id);
      // The restored baseline omits the guard. Recreate it before any later file operation can
      // fail, so an in-flight DSH process never sees an unlocked project mid-transaction.
      if (reviewLock) writeReviewAiGuard(restoreRoot, reviewLock);
      restoreProjectFiles(restoreRoot, kept);
      const restored = withReviewAiGuardLifted(restoreRoot, reviewLock, () =>
        native.store.snapshotVersion(restoreRoot, { label: `从 ${id} 恢复` }),
      );
      return {
        beforeRestore,
        restored,
        versions: native.store.listVersions(restoreRoot),
        session: host.openLiveSession(native, restoreRoot),
      };
    } finally {
      if (reviewLock) writeReviewAiGuard(restoreRoot, reviewLock);
    }
  });
}
