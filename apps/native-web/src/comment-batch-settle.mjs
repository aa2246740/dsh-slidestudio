/**
 * Decisions for a comment batch whose browser stopped looking after it.
 *
 * The browser that submits a batch owns its lease token and is the only party that normally
 * verifies, applies or rolls the batch back. Once that page is refreshed or closed nobody renews
 * the lease, and the project stays locked until the fifteen-minute TTL runs out. These pure
 * functions say when the server may finish the job itself and what a late original tab is told
 * afterwards. Reading files, verifying and restoring live in comment-batch-settler.mjs.
 */

/**
 * The browser renews every 25 s. 90 s is more than three missed renewals and also covers the
 * roughly 60 s timer throttling of a background tab, so a tab that is merely hidden is not
 * mistaken for a closed one. Change it together with the interval in public/ai-lock-lifecycle.js.
 */
export const ABANDONED_LEASE_MS = 90_000;

export const SETTLED_RETENTION_MS = 30 * 60_000;
export const SETTLED_MAX_ENTRIES = 32;

/** @typedef {"wait" | "apply" | "cancel-unaccepted"} AbandonedBatchAction */
/** @typedef {{ renewedAt?: number, createdAt?: string, items?: unknown[], submissionId?: string }} BatchLockFacts */
/** @typedef {{ outcome: "applied" | "failed" | "cancelled", root: string, pagePath?: string,
 * failure?: string, code?: string, applied?: unknown[], snapshotVersionId?: string, submissionId?: string }} SettledBatch */

/** Only a cross-page batch with a persisted receipt is settled by the server.
 * @param {BatchLockFacts | undefined} lock */
const isBatchLock = (lock) => Boolean(lock?.items?.length && lock.submissionId);

/** @param {BatchLockFacts | undefined} lock @param {number} now */
export function leaseAbandoned(lock, now) {
  if (!lock || !isBatchLock(lock)) return false;
  const last =
    typeof lock.renewedAt === "number" && Number.isFinite(lock.renewedAt)
      ? lock.renewedAt
      : Date.parse(lock.createdAt ?? "");
  return Number.isFinite(last) && now - last > ABANDONED_LEASE_MS;
}

/**
 * `apply` means the Host took the batch and every turn since then is over; the caller still runs
 * the normal verification, so a turn that failed after a complete in-scope edit is judged on the
 * document, not on the turn status. `cancel-unaccepted` means nothing proves the Host took it.
 * Unreadable conversation or journal is missing evidence, so it waits.
 * @param {{ lock?: BatchLockFacts, messages?: unknown, events?: unknown, now: number }} input
 * @returns {AbandonedBatchAction}
 */
export function abandonedBatchAction({ lock, messages, events, now }) {
  if (!lock || !leaseAbandoned(lock, now)) return "wait";
  if (!Array.isArray(messages) || !Array.isArray(events)) return "wait";
  /** @type {{ at?: unknown, status?: unknown }[]} */
  const turns = events.filter((event) => event?.kind === "turn" && event.name === "turn");
  /** @type {{ at?: unknown } | undefined} */
  const accepted = messages.find((message) => message?.reviewSubmissionId === lock.submissionId);
  if (!accepted) {
    const lockedAt = Date.parse(lock.createdAt ?? "");
    if (!Number.isFinite(lockedAt)) return "wait";
    // A turn after the lock without this batch's receipt may be the Host working on it.
    const started = turns.some((turn) => !(Date.parse(String(turn.at)) < lockedAt));
    return started ? "wait" : "cancel-unaccepted";
  }
  const acceptedAt = Date.parse(String(accepted.at));
  if (!Number.isFinite(acceptedAt)) return "wait";
  const since = turns.filter((turn) => Date.parse(String(turn.at)) >= acceptedAt);
  const over = since.length > 0 && since.every((turn) => ["complete", "failed"].includes(String(turn.status)));
  return over ? "apply" : "wait";
}

/** @param {Map<string, SettledBatch & { at: number }>} ledger @param {string} token @param {SettledBatch} entry @param {number} now */
export function rememberSettled(ledger, token, entry, now) {
  ledger.delete(token);
  ledger.set(token, { ...entry, at: now });
  while (ledger.size > SETTLED_MAX_ENTRIES) {
    const oldest = ledger.keys().next();
    if (oldest.done) break;
    ledger.delete(oldest.value);
  }
}

/** @param {Map<string, SettledBatch & { at: number }>} ledger @param {unknown} token @param {number} now */
export function recallSettled(ledger, token, now) {
  if (typeof token !== "string") return undefined;
  const entry = ledger.get(token);
  if (!entry) return undefined;
  if (now - entry.at > SETTLED_RETENTION_MS) {
    ledger.delete(token);
    return undefined;
  }
  return entry;
}

/**
 * What the original tab hears when it reports in after the server finished the batch. Applied is
 * never turned into a failure, and nothing is verified or restored a second time.
 * @param {SettledBatch} entry @param {"applied" | "failed" | "cancelled"} requested
 */
export function lateBatchResult(entry, requested) {
  if (entry.outcome === "applied") {
    return {
      ok: true,
      outcome: "applied",
      applied: entry.applied ?? [],
      released: true,
      settled: true,
    };
  }
  if (requested === "applied") {
    return entry.outcome === "cancelled"
      ? { error: "这批批注没有被 AI 接收，服务端已取消", code: "REVIEW_BATCH_CANCELLED" }
      : {
          error: entry.failure || "AI 修改失败，已恢复修改前版本",
          code: entry.code || "REVIEW_BATCH_SETTLED_FAILED",
        };
  }
  return { ok: true, outcome: entry.outcome, applied: [], released: true, settled: true };
}
