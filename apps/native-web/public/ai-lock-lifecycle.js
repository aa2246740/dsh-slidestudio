import { t } from "./i18n.js";
import { record } from "./comment-submission-data.js";

/** Chinese source key; render it with `t(AI_LOCK_LOST_STATUS)` or `aiLockLostStatus()`. */
export const AI_LOCK_LOST_STATUS = "版本保护已失效 · 修改前版本在历史版本中";

/** Keep in step with ABANDONED_LEASE_MS (90 s) in src/comment-batch-settle.mjs: more than three
 * missed renewals, and above the ~60 s timer throttling of a background tab. */
export const AI_LOCK_RENEW_MS = 25_000;

/** @typedef {"applied" | "failed" | "cancelled"} SettledOutcome */
/** @typedef {((renewed: unknown) => Promise<unknown> | unknown) | null} Release */
/** @typedef {{ setInterval: (callback: () => void, ms: number) => unknown, clearInterval: (handle: any) => void }} LeaseTimers */

export function aiLockLostStatus() {
  return t(AI_LOCK_LOST_STATUS);
}

/** The toast for a tab that keeps its lease because recovery was not proven safe.
 * @param {boolean} uncertain */
export function aiLockHeldMessage(uncertain) {
  return uncertain
    ? t("AI 版本保护状态不确定，请检查生成历程；本标签继续禁止写入。")
    : t("AI 修改尚未完成安全收尾；本标签继续禁止写入。");
}

/** @returns {LeaseTimers} */
function defaultTimers() {
  return {
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle),
  };
}

/**
 * One lease lifecycle per AI edit. A network miss retries next period; only a 409
 * (`AI_REVIEW_LOCK_MISMATCH`) while the timer runs ends it, and reports the loss once.
 * Holding a lock always has a timer; a held lease with a release is let go on its next good renewal.
 * @param {() => Promise<unknown>} renewToken
 * @param {() => void} onLost
 * @param {{ timers?: LeaseTimers, intervalMs?: number }} [options]
 */
export function createAiLockLifecycle(
  renewToken,
  onLost,
  { timers = defaultTimers(), intervalMs = AI_LOCK_RENEW_MS } = {},
) {
  /** @type {unknown} */
  let timer = null;
  const lease = {
    held: false,
    uncertain: false,
    /** @type {Release} */
    release: null,
    get running() {
      return timer !== null;
    },
    /** Keep the project locked (and renewing) until `release` lets it go.
     * @param {Release} [release] */
    hold(release = null) {
      lease.release = release;
      lease.start();
      lease.held = lease.uncertain = true;
    },
    free() {
      lease.held = lease.uncertain = false;
      lease.release = null;
      lease.stop();
    },
    stop() {
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
    },
    async renew() {
      try {
        const renewed = await renewToken();
        lease.uncertain = false;
        return renewed;
      } catch (error) {
        if (record(error).code === "AI_REVIEW_LOCK_MISMATCH" && timer !== null) {
          lease.stop();
          onLost();
        }
        throw error;
      }
    },
    /** Idempotent: a second start keeps the one timer. */
    start() {
      if (timer !== null) return;
      timer = timers.setInterval(() => {
        lease
          .renew()
          .then((renewed) => lease.release?.(renewed))
          .catch(() => (lease.uncertain = true));
      }, intervalMs);
    },
  };
  return lease;
}

/** @typedef {ReturnType<typeof createAiLockLifecycle>} AiLockLease */

/** What the server already did with this lease's batch, from a renew/restore answer.
 * @param {unknown} renewed @returns {SettledOutcome | ""} */
export function settledOutcome(renewed) {
  const settled = record(renewed).settled;
  return settled === "applied" || settled === "failed" || settled === "cancelled" ? settled : "";
}

/** The message for a batch the server failed or cancelled while this tab was away.
 * @param {Exclude<SettledOutcome, "applied">} settled */
export function settledBatchMessage(settled) {
  return settled === "failed"
    ? t("AI 修改没有完成，服务端已恢复修改前版本，批注可重试")
    : t("这批批注没有被 AI 接收，服务端已取消，批注可重试");
}

/** A typed error for a server-settled failure or cancel; `code` lets the caller offer a retry.
 * @param {Exclude<SettledOutcome, "applied">} settled */
export function settledBatchError(settled) {
  return Object.assign(new Error(settledBatchMessage(settled)), { code: "REVIEW_BATCH_CANCELLED", settled });
}

/**
 * The release for a lease held after an unconfirmed acceptance: on the first renewal that reports
 * the batch settled it frees the lease (no stop, no restore) and hands the outcome over.
 * @param {AiLockLease} lease
 * @param {{ onApplied: () => Promise<unknown> | unknown, onFailed: (error: Error) => Promise<unknown> | unknown,
 *   onDone?: () => Promise<unknown> | unknown }} handlers
 * @returns {NonNullable<Release>}
 */
export function releaseWhenSettled(lease, { onApplied, onFailed, onDone }) {
  return async (renewed) => {
    const settled = settledOutcome(renewed);
    if (!settled) return;
    lease.free();
    try {
      if (settled === "applied") await onApplied();
      else await onFailed(settledBatchError(settled));
    } finally {
      await onDone?.();
    }
  };
}

/**
 * The failure path of a turn that may have started: renew first, and when the server already
 * settled the batch skip stop and restore entirely. Otherwise stop the turn, renew again (the
 * stop can be slow) and restore the pre-edit snapshot. Errors propagate so the caller holds the
 * lease.
 * @param {AiLockLease} lease
 * @param {{ stopTurn: () => Promise<unknown>, restoreSnapshot: () => Promise<unknown> }} steps
 * @returns {Promise<SettledOutcome | "">} the server's outcome, or "" when this tab restored
 */
export async function settleOrRestoreBatch(lease, { stopTurn, restoreSnapshot }) {
  const settled = settledOutcome(await lease.renew());
  if (settled) return settled;
  await stopTurn();
  await lease.renew();
  await restoreSnapshot();
  return "";
}
