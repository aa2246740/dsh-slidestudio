// Client resilience helpers for plain-HTTP deployments and long assistant turns.
// Pure ES module: every browser global (crypto, storage, document, fetch, timers)
// is injectable so node tests can drive it without a DOM.
import { t } from "./i18n.js";

/** @typedef {Record<string, unknown>} Dict */
/** @typedef {{ randomUUID?: () => string, getRandomValues?: (a: Uint8Array<ArrayBuffer>) => unknown }} CryptoLike */
/** @typedef {Pick<Storage, "getItem" | "setItem">} StorageLike */
/** @typedef {{ setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (id: any) => void }} TimersLike */

/** @param {Uint8Array} bytes */
function fillPseudoRandom(bytes) {
  let seed = Date.now() >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    bytes[i] = (seed ^ Math.floor(Math.random() * 256)) & 0xff;
  }
}

/**
 * RFC 4122 v4 id. `crypto.randomUUID` only exists on secure (HTTPS / localhost)
 * origins; a plain-HTTP LAN address falls back to getRandomValues, then to a
 * time-seeded generator.
 * @param {CryptoLike | Crypto | undefined} [source]
 */
export function safeRandomUUID(source = globalThis.crypto) {
  if (typeof source?.randomUUID === "function") {
    try {
      return source.randomUUID();
    } catch {
      // Insecure context: fall through to the manual generator.
    }
  }
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") source.getRandomValues(bytes);
  else fillPseudoRandom(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable per-tab id (sessionStorage survives reload but not tab duplication).
 * @param {{ storage?: StorageLike, crypto?: CryptoLike | Crypto }} [options]
 */
export function editorTabId(options = {}) {
  try {
    const storage = options.storage ?? globalThis.sessionStorage;
    let id = storage.getItem("oss:tabId");
    if (!id) {
      id = safeRandomUUID(options.crypto ?? globalThis.crypto);
      storage.setItem("oss:tabId", id);
    }
    return id;
  } catch {
    return "default";
  }
}

/**
 * Hard and stalled limits of one review turn. A full-deck turn rewrites every
 * page and needs far more time than a scoped edit.
 * @param {boolean} allPages
 */
export const reviewTurnTimeouts = (allPages) =>
  allPages
    ? { hardTimeoutMs: 1_800_000, stalledTimeoutMs: 600_000 }
    : { hardTimeoutMs: 240_000, stalledTimeoutMs: 120_000 };

/**
 * Whether a state-poll failure is a temporary transport problem (retry) rather
 * than a real answer from the server.
 * @param {unknown} err
 */
export function transientAiReviewStateError(err) {
  const r = err && typeof err === "object" ? /** @type {Dict} */ (err) : {};
  return (
    r.code === "AI_STATE_UNAVAILABLE" ||
    err instanceof TypeError ||
    ["AbortError", "TimeoutError"].includes(String(r.name || ""))
  );
}

/**
 * Run one paint; a throwing paint is logged and swallowed so the polling or
 * SSE chain that scheduled it keeps running.
 * @template T
 * @param {(arg: T) => void} fn
 * @param {T} arg
 * @param {{ warn: (...args: unknown[]) => void }} [log]
 */
export function safePaint(fn, arg, log = console) {
  try {
    fn(arg);
    return true;
  } catch (e) {
    log.warn("Generation paint failed:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * The activity shown while the generation state cannot be read: the last known
 * activity, marked disconnected, with a reassuring error detail.
 * @template {Dict} T
 * @param {T | null} current
 * @returns {Omit<T, "connectionState" | "error"> & { connectionState: "disconnected", error: { detail: string } }}
 */
export function disconnectedActivity(current) {
  return {
    ...(current ?? /** @type {T} */ ({})),
    connectionState: "disconnected",
    error: {
      detail: t("生成状态暂时不可用；编辑仍受保护，正在重连并等待本次会话的最终状态。"),
    },
  };
}

/** Exponential poll backoff: 1.2 s, 2.4 s … capped at 10 s. @param {number} attempt 1-based */
export const pollBackoffDelay = (attempt) => Math.min(10_000, 1200 * 2 ** Math.min(Math.max(attempt, 1) - 1, 4));

/**
 * Submission lock that releases itself when a request never settles, so a lost
 * response cannot leave the composer disabled forever.
 * @param {{ timeoutMs?: number, onTimeout: () => void, timers?: TimersLike }} options
 */
export function createSubmitLockWatchdog({ timeoutMs = 60_000, onTimeout, timers = globalThis }) {
  /** @type {unknown} */
  let timer = null;
  let active = false;
  const stop = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };
  return {
    get active() {
      return active;
    },
    /** @param {boolean} next */
    set(next) {
      active = Boolean(next);
      stop();
      if (!active) return;
      timer = timers.setTimeout(() => {
        timer = null;
        if (!active) return;
        active = false;
        onTimeout();
      }, timeoutMs);
    },
    clear() {
      active = false;
      stop();
    },
  };
}

/**
 * Browsers throttle or drop EventSource streams in background tabs. When the
 * tab becomes visible again, reopen the stream and poll once immediately.
 * @param {{ doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">, shouldResume: () => boolean, reconnect: () => void, poll: () => void }} options
 * @returns {() => void} dispose
 */
export function bindVisibilityRecovery({ doc = document, shouldResume, reconnect, poll }) {
  const onChange = () => {
    if (doc.visibilityState !== "visible" || !shouldResume()) return;
    reconnect();
    poll();
  };
  doc.addEventListener("visibilitychange", onChange);
  return () => doc.removeEventListener("visibilitychange", onChange);
}

/** @param {unknown} row */
function isTerminalRow(row) {
  if (!row || typeof row !== "object") return false;
  const r = /** @type {Dict} */ (row);
  if ((r.kind === "agent-status" || r.name === "agent-status") && r.status === "idle") return true;
  return r.kind === "turn" && r.name === "turn" && Boolean(r.status) && r.status !== "running";
}

/** @param {Dict} d */
function isIdleStatusFrame(d) {
  if (d.agentStatus === "idle") return true;
  if (d.status !== "idle") return false;
  return d.type === "agent-status" || d.event === "agent-status" || d.kind === "agent-status";
}

/**
 * Whether an SSE frame says the agent turn is over.
 * @param {unknown} data
 */
export function isTerminalIdleEvent(data) {
  if (!data || typeof data !== "object") return false;
  const d = /** @type {Dict} */ (data);
  if (isIdleStatusFrame(d)) return true;
  return Array.isArray(d.rows) && d.rows.some(isTerminalRow);
}

/**
 * After a terminal idle frame, a reasoning card still marked running would spin
 * forever; settle it.
 * @template {Dict} T
 * @param {T | null} activity
 * @returns {T | null}
 */
export function settleResidualThinking(activity) {
  if (!activity || !Array.isArray(activity.events)) return activity;
  let changed = false;
  const events = activity.events.map((row) => {
    if (
      row &&
      typeof row === "object" &&
      (row.kind === "reasoning" || row.kind === "think") &&
      row.status === "running"
    ) {
      changed = true;
      return { ...row, status: "complete" };
    }
    return row;
  });
  return changed ? { ...activity, agentStatus: "idle", events } : activity;
}

/**
 * Wire an EventSource so that invalid frames are ignored, accepted frames
 * schedule a paint, and a terminal idle frame hands control to the caller.
 * @param {Pick<EventSource, "onmessage"> & { addEventListener?: (type: string, fn: (ev: Event) => void) => void }} source
 * @param {{ isCurrent: () => boolean, accept: (d: unknown) => boolean, schedulePaint: () => void, onTerminalIdle: (accepted: boolean) => void }} handlers
 */
export function bindGenerationLiveSse(source, handlers) {
  /** @param {unknown} raw @param {boolean} [named] */
  const onMessage = (raw, named = false) => {
    if (!handlers.isCurrent()) return;
    try {
      const data = typeof raw === "string" && raw ? JSON.parse(raw) : {};
      const idle = (named && data?.status === "idle") || isTerminalIdleEvent(data);
      const accepted = handlers.accept(data);
      if (idle) return handlers.onTerminalIdle(accepted);
      if (accepted) handlers.schedulePaint();
    } catch {
      // An invalid transport frame never alters the durable project.
    }
  };
  source.onmessage = (ev) => onMessage(ev.data);
  source.addEventListener?.("agent-status", (ev) => onMessage(/** @type {MessageEvent} */ (ev).data, true));
}

/** @param {string} message */
function timeoutError(message) {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

/**
 * `fetch` with a deadline. The request is aborted through an AbortController
 * after `timeoutMs`; a caller signal still aborts it earlier. A timeout rejects
 * with an Error named "TimeoutError" (transient per transientAiReviewStateError).
 * @param {string | URL} input
 * @param {RequestInit} [init]
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, timers?: TimersLike }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(input, init = {}, options = {}) {
  const { timeoutMs = 15_000, fetchImpl = globalThis.fetch } = options;
  const timers = /** @type {TimersLike} */ (options.timers ?? globalThis);
  const message = () => t("请求超时（{seconds} 秒）", { seconds: timeoutMs / 1000 });
  const controller = new AbortController();
  const outer = init.signal;
  let timedOut = false;
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError(message()));
  }, timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw timeoutError(message());
    throw error;
  } finally {
    timers.clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Release the body of a response the caller will not read. A chunked 502 from
 * a proxy with no upstream otherwise keeps the connection open, which blocks
 * network-idle waits (headless page capture) and leaks a socket.
 * @param {Pick<Response, "body" | "bodyUsed"> | null | undefined} response
 */
export async function discardUnreadBody(response) {
  if (!response || response.bodyUsed || !response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Already closed or errored: nothing left to release.
  }
}

/**
 * GET a JSON document; a non-OK status cancels the unread body and yields
 * `null` instead of throwing, so optional data (for example `/slides/catalog`
 * when no kernel listens) degrades to "not loaded yet".
 * @param {string | URL} input
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, timers?: TimersLike }} [options]
 * @returns {Promise<{ ok: true, status: number, data: unknown } | { ok: false, status: number, data: null }>}
 */
export async function fetchJsonOrDiscard(input, options = {}) {
  /** @type {Response} */
  let response;
  try {
    response = await fetchWithTimeout(input, {}, options);
  } catch {
    return { ok: false, status: 0, data: null };
  }
  if (!response.ok) {
    await discardUnreadBody(response);
    return { ok: false, status: response.status, data: null };
  }
  try {
    return { ok: true, status: response.status, data: await response.json() };
  } catch {
    return { ok: false, status: response.status, data: null };
  }
}

/**
 * Memoize an async load while letting a failed or empty load be retried by the
 * next caller (instead of caching the failure for the page lifetime).
 * @template T
 * @param {() => Promise<T | null | undefined>} load
 */
export function createRecoverableLoader(load) {
  /** @type {T | undefined} */
  let value;
  let loaded = false;
  /** @type {Promise<T | undefined> | undefined} */
  let pending;
  return {
    /** @returns {Promise<T | undefined>} */
    get() {
      if (loaded) return Promise.resolve(value);
      pending ??= (async () => {
        try {
          const next = await load();
          if (next !== null && next !== undefined) {
            value = next;
            loaded = true;
          }
        } catch {
          // Keep the previous state; the next get() retries.
        } finally {
          if (!loaded) pending = undefined;
        }
        return value;
      })();
      return pending;
    },
    get loaded() {
      return loaded;
    },
    reset() {
      value = undefined;
      loaded = false;
      pending = undefined;
    },
  };
}

/**
 * Least-recently-used cache with an entry and byte budget. Long editing
 * sessions accumulate thumbnails, decoded images and object URLs; evicting
 * beyond the budget keeps the tab's JS heap bounded. `onEvict` releases
 * external resources (for example `URL.revokeObjectURL`).
 * @template V
 * @param {{ maxEntries?: number, maxBytes?: number, sizeOf?: (value: V) => number, onEvict?: (key: string, value: V) => void }} [options]
 */
export function createBoundedCache(options = {}) {
  const { maxEntries = 200, maxBytes = Infinity, sizeOf = () => 1, onEvict } = options;
  /** @type {Map<string, { value: V, size: number }>} */
  const entries = new Map();
  let bytes = 0;
  /** @param {string} key @param {V} [replacement] */
  const drop = (key, replacement) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.size;
    if (entry.value !== replacement) onEvict?.(key, entry.value);
  };
  const trim = () => {
    while (entries.size > maxEntries || (bytes > maxBytes && entries.size > 0)) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
  };
  return {
    /** @param {string} key */
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    /** @param {string} key @param {V} value */
    set(key, value) {
      drop(key, value);
      const size = Math.max(0, Number(sizeOf(value)) || 0);
      entries.set(key, { value, size });
      bytes += size;
      trim();
    },
    /** @param {string} key */
    delete(key) {
      drop(key);
    },
    clear() {
      for (const key of [...entries.keys()]) drop(key);
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
