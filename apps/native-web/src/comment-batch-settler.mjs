import path from "node:path";
import {
  ABANDONED_LEASE_MS,
  abandonedBatchAction,
  lateBatchResult,
  leaseAbandoned,
  recallSettled,
  rememberSettled,
} from "./comment-batch-settle.mjs";

/**
 * @typedef {{
 *   token: string,
 *   root: string,
 *   pagePath: string,
 *   createdAt?: string,
 *   renewedAt?: number,
 *   items?: unknown[],
 *   submissionId?: string,
 *   snapshotVersionId?: string,
 *   restored?: boolean,
 * }} SettlerLock The lease facts the settler reads; the target's ReviewAiLock satisfies it.
 */
/** @typedef {import("./comment-batch-settle.mjs").SettledBatch} SettledBatch */
/** @typedef {SettledBatch & { at: number }} SettledEntry */
/** @typedef {"applied" | "failed" | "cancelled"} BatchOutcome */
/** @typedef {{ ok?: boolean, error?: string, code?: string, applied?: unknown[] }} FinishResult */
/** @typedef {{ conversation?: { messages?: unknown }, events?: unknown }} BatchActivity */
/**
 * @template N
 * @typedef {{
 *   activeLock: (root: string) => SettlerLock | undefined,
 *   finishBatch: (native: N, root: string, token: string, outcome: BatchOutcome, failure?: string, unaccepted?: boolean) => Promise<FinishResult>,
 *   restoreSnapshot: (native: N, root: string, lock: SettlerLock) => void,
 *   readActivity: (native: N, root: string) => Promise<BatchActivity>,
 *   lockedRoots?: () => Iterable<string>,
 *   onSettled?: (entry: SettledBatch) => void,
 *   now?: () => number,
 *   setInterval?: (callback: () => void, ms: number) => unknown,
 *   clearInterval?: (handle: any) => void,
 * }} SettlerDeps
 */

/** The browser renews every 25 s; sweeping a little faster than the 90 s silence window keeps a
 * closed tab's project locked for at most about two minutes. */
export const SETTLE_SWEEP_MS = 30_000;

/** @param {unknown} handle */
function unrefTimer(handle) {
  const timer = /** @type {{ unref?: () => void } | null} */ (handle && typeof handle === "object" ? handle : null);
  timer?.unref?.();
}

/**
 * Finishes comment batches whose browser went away, using the same verification and rollback the
 * browser would have run, and remembers the result for the original tab if it comes back.
 * Every collaborator is injected (lease store, batch finisher, restore, journal reader, clock and
 * timers) so the server wires it with one call and tests drive it without a server.
 * @template N
 * @param {SettlerDeps<N>} deps
 */
export function createBatchSettler(deps) {
  const { activeLock, finishBatch, restoreSnapshot, readActivity, onSettled } = deps;
  const now = deps.now ?? Date.now;
  /** @type {Map<string, SettledEntry>} */
  const ledger = new Map();
  /** @type {Set<string>} */
  const settling = new Set();

  /** @param {SettlerLock} lock @param {BatchOutcome} outcome @param {Partial<SettledBatch>} [extra] */
  function remember(lock, outcome, extra = {}) {
    /** @type {SettledBatch} */
    const entry = {
      outcome,
      root: lock.root,
      pagePath: lock.pagePath,
      snapshotVersionId: lock.snapshotVersionId,
      submissionId: lock.submissionId,
      ...extra,
    };
    rememberSettled(ledger, lock.token, entry, now());
    try {
      onSettled?.(entry);
    } catch {
      // A reporting callback never undoes a settlement.
    }
  }

  /** @param {N} native @param {string} root @param {SettlerLock} lock */
  async function applyOrRestore(native, root, lock) {
    const applied = await finishBatch(native, root, lock.token, "applied");
    if (applied.ok) {
      remember(lock, "applied", { applied: applied.applied });
      return true;
    }
    if (applied.code !== "REVIEW_BATCH_SCOPE_VIOLATION" && applied.code !== "REVIEW_BATCH_INCOMPLETE") return false;
    // Without the pre-turn snapshot the changes cannot be undone, so the lease stays held.
    if (!lock.snapshotVersionId) return false;
    try {
      restoreSnapshot(native, root, lock);
    } catch {
      return false;
    }
    const failure = String(applied.error).replace("正在恢复修改前版本", "已恢复修改前版本");
    const failed = await finishBatch(native, root, lock.token, "failed", failure);
    if (!failed.ok) return false;
    remember(lock, "failed", { failure, code: applied.code });
    return true;
  }

  /** @param {N} native @param {string} key @param {SettlerLock} lock @param {BatchActivity} [activity] */
  async function settleLocked(native, key, lock, activity) {
    const seen = activity ?? (await readActivity(native, key));
    // The tab may have renewed or finished while the journal was being read.
    const current = activeLock(key);
    if (!current || current.token !== lock.token) return false;
    const action = abandonedBatchAction({
      lock: current,
      messages: seen?.conversation?.messages,
      events: seen?.events,
      now: now(),
    });
    if (action === "wait") return false;
    if (action === "apply") return applyOrRestore(native, key, current);
    const cancelled = await finishBatch(native, key, current.token, "cancelled", undefined, true);
    if (!cancelled.ok) return false;
    remember(current, "cancelled");
    return true;
  }

  /**
   * Settles the project's batch when its browser is gone and the evidence says it is safe.
   * `activity` is what the caller already read; without it the journal is read on demand, and
   * only once the lease has already lapsed.
   * @param {N} native @param {string} root @param {BatchActivity} [activity]
   * @returns {Promise<boolean>} whether the batch was settled
   */
  async function settle(native, root, activity) {
    const key = path.resolve(root);
    const lock = activeLock(key);
    if (!lock || !leaseAbandoned(lock, now()) || settling.has(key)) return false;
    settling.add(key);
    try {
      return await settleLocked(native, key, lock, activity);
    } catch {
      // Settling is opportunistic. A read or write that fails leaves the lease exactly as it was.
      return false;
    } finally {
      settling.delete(key);
    }
  }

  /** Settles every locked project the store knows about; resolves to the roots it settled.
   * @param {N} native @returns {Promise<string[]>} */
  async function sweep(native) {
    const roots = [...(deps.lockedRoots?.() ?? [])];
    const results = await Promise.all(roots.map((root) => settle(native, root)));
    return roots.filter((_, index) => results[index]);
  }

  /**
   * One call starts periodic settlement, so a batch whose every tab is closed is still finished.
   * Returns the stop function. The timer never keeps the process alive.
   * @param {N} native @param {{ intervalMs?: number }} [options]
   */
  function start(native, { intervalMs = SETTLE_SWEEP_MS } = {}) {
    /** @type {(callback: () => void, ms: number) => unknown} */
    const schedule = deps.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms));
    /** @type {(handle: any) => void} */
    const cancel = deps.clearInterval ?? ((timer) => globalThis.clearInterval(timer));
    const handle = schedule(() => void sweep(native).catch(() => undefined), intervalMs);
    unrefTimer(handle);
    return () => cancel(handle);
  }

  return {
    settle,
    sweep,
    start,
    /** @param {unknown} token */
    settled: (token) => recallSettled(ledger, token, now()),
    /** What the original tab hears when it reports in after the server finished its batch.
     * @param {unknown} token @param {BatchOutcome} requested @param {string} root */
    late(token, requested, root) {
      const entry = recallSettled(ledger, token, now());
      return entry && entry.root === path.resolve(root) ? lateBatchResult(entry, requested) : undefined;
    },
  };
}

/** @typedef {ReturnType<typeof createBatchSettler>} BatchSettler */

/**
 * The `/api/reviews/ai-lock/renew` answer. A lease the server settled meanwhile answers 200 with
 * `settled`, so the tab unlocks instead of reporting a lost lock; an unknown token stays 409.
 * @param {unknown} token
 * @param {{ renew: (token: unknown) => { pagePath: string, expiresAt: number } | undefined, settled: (token: unknown) => SettledEntry | undefined }} deps
 * @returns {{ status: 200 | 409, body: Record<string, unknown> }}
 */
export function renewOrSettledReply(token, { renew, settled }) {
  const renewed = renew(token);
  if (renewed)
    return { status: 200, body: { ok: true, lock: { pagePath: renewed.pagePath, expiresAt: renewed.expiresAt } } };
  const entry = settled(token);
  if (entry) {
    return {
      status: 200,
      body: { ok: true, settled: entry.outcome, lock: { pagePath: entry.pagePath, expiresAt: entry.at } },
    };
  }
  return { status: 409, body: { error: "AI review lock is no longer active", code: "AI_REVIEW_LOCK_MISMATCH" } };
}

/**
 * The server already restored this snapshot when it failed the batch; a late restore from the
 * original tab must report that state and restore nothing a second time.
 * @param {BatchSettler} settler @param {unknown} lockToken @param {string} versionId
 * @returns {SettledEntry | undefined}
 */
export function settledRestore(settler, lockToken, versionId) {
  const entry = lockToken ? settler.settled(lockToken) : undefined;
  return entry?.outcome === "failed" && entry.snapshotVersionId === versionId ? entry : undefined;
}

export { ABANDONED_LEASE_MS };
