/**
 * Editor-human single-writer lease. Every human write route calls
 * `guardEditorWrite` before it touches a project: the guard acquires (or
 * renews) the project's `editor-human` writer lease for the browser tab.
 * A Hub run holding the lease answers 409 and is never overwritten; an MCP
 * holder is preempted cleanly (it must re-acquire explicitly once the editor
 * releases). A stuck lease lock answers 503 instead of hanging the server.
 */
import fs from "node:fs";
import os from "node:os";
import { acquireProjectLease, readProjectLease, releaseProjectLease } from "@open-slidestudio/slides-tools";

export const EDITOR_LEASE_KIND = "editor-human";
/** A human tab renews on every write; three idle minutes free the project for agents. */
export const EDITOR_LEASE_TTL_MS = 3 * 60_000;
/** Lease lock wait budget: long enough for a heartbeat, short enough never to stall HTTP. */
export const EDITOR_LEASE_LOCK_TIMEOUT_MS = 500;
export const EDITOR_LEASE_FALLBACK_OWNER = "editor-human:editor";
export const EDITOR_LEASE_DEFAULT_LABEL = "human editor";

const TAB_ID_PATTERN = /^[\w-]{1,64}$/;
const LOCK_TIMEOUT_PATTERN = /timed out waiting for project write lock/i;
const PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * @typedef {"hub-run" | "mcp" | "editor-human"} LeaseKind
 * @typedef {{ kind: LeaseKind, label?: string, expiresAt: string }} PublicLeaseHolder
 * @typedef {{
 *   error: string,
 *   code: "WRITER_LEASE_CONFLICT" | "WRITER_LEASE_BUSY",
 *   outcome: string,
 *   holder: PublicLeaseHolder | null,
 *   retryable?: boolean,
 * }} EditorLeaseRefusalBody
 * @typedef {{ ok: false, status: 409 | 503, body: EditorLeaseRefusalBody }} EditorLeaseRefusal
 * @typedef {{
 *   ok: true,
 *   outcome: "acquired" | "renewed" | "taken-over-expired" | "preempted" | "handed-over" | "skipped" | "unavailable",
 *   lease: PublicLeaseHolder | null,
 *   preempted?: PublicLeaseHolder,
 * }} EditorLeaseGrant
 * @typedef {EditorLeaseGrant | EditorLeaseRefusal} EditorLeaseGuardResult
 * @typedef {{ tabId?: string | null, label?: string, now?: number, lockTimeoutMs?: number }} EditorLeaseOptions
 */

/**
 * Owner id for one browser tab. Ids the server's tab parser would reject (and
 * the shared "default" tab) collapse onto one fallback editor owner.
 * @param {unknown} tabId
 * @returns {string}
 */
export function editorLeaseOwnerId(tabId) {
  const raw = typeof tabId === "string" ? tabId.trim() : "";
  if (!raw || raw === "default" || !TAB_ID_PATTERN.test(raw)) return EDITOR_LEASE_FALLBACK_OWNER;
  return `${EDITOR_LEASE_KIND}:${raw}`;
}

/**
 * @param {{ kind: string, label?: string, expiresAt: string } | undefined | null} holder
 * @returns {PublicLeaseHolder | null}
 */
export function publicLeaseHolder(holder) {
  if (!holder) return null;
  return {
    kind: /** @type {LeaseKind} */ (holder.kind),
    ...(holder.label ? { label: holder.label } : {}),
    expiresAt: holder.expiresAt,
  };
}

/**
 * @param {PublicLeaseHolder | null} holder
 * @returns {string}
 */
function conflictMessage(holder) {
  if (holder?.kind === "hub-run") return "AI 正在生成或修改这份文稿，暂时不能手动编辑。请等待本轮生成结束后再试。";
  if (holder?.kind === "editor-human") return "这份文稿正在另一个编辑器中修改。请关闭那边的编辑页面或稍后再试。";
  if (holder?.kind === "mcp") return "外部智能体正在写入这份文稿，请稍后再试。";
  return "这份文稿正被其他写入方占用，请稍后再试。";
}

/**
 * @param {string} outcome
 * @param {PublicLeaseHolder | null} holder
 * @returns {EditorLeaseRefusal}
 */
function conflictRefusal(outcome, holder) {
  return {
    ok: false,
    status: 409,
    body: { error: conflictMessage(holder), code: "WRITER_LEASE_CONFLICT", outcome, holder },
  };
}

/**
 * @param {string} projectRoot
 * @returns {EditorLeaseRefusal}
 */
function busyRefusal(projectRoot) {
  return {
    ok: false,
    status: 503,
    body: {
      error: "文稿写入锁暂时被占用，请稍后重试。",
      code: "WRITER_LEASE_BUSY",
      outcome: "lock-timeout",
      holder: safeHolder(projectRoot),
      retryable: true,
    },
  };
}

/**
 * Lock-free read used for diagnostics only.
 * @param {string} projectRoot
 * @returns {PublicLeaseHolder | null}
 */
function safeHolder(projectRoot) {
  try {
    const state = readProjectLease(projectRoot);
    return state.active ? publicLeaseHolder(state.holder) : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} error
 * @returns {"busy" | "permission" | null}
 */
function classifyLeaseError(error) {
  if (error instanceof Error && LOCK_TIMEOUT_PATTERN.test(error.message)) return "busy";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return PERMISSION_CODES.has(code) ? "permission" : null;
}

/**
 * @param {string} projectRoot
 * @param {() => EditorLeaseGuardResult} action
 * @returns {EditorLeaseGuardResult}
 */
function withLeaseErrors(projectRoot, action) {
  try {
    return action();
  } catch (error) {
    const kind = classifyLeaseError(error);
    if (kind === "busy") return busyRefusal(projectRoot);
    // A read-only project cannot record a lease; the write path itself then
    // reports its permission error exactly as it did before the lease existed.
    if (kind === "permission") return { ok: true, outcome: "unavailable", lease: null };
    throw error;
  }
}

/**
 * @param {string} projectRoot
 * @param {string} ownerId
 * @param {EditorLeaseOptions} opts
 */
function acquireForEditor(projectRoot, ownerId, opts) {
  return acquireProjectLease(projectRoot, {
    kind: EDITOR_LEASE_KIND,
    ownerId,
    label: opts.label || EDITOR_LEASE_DEFAULT_LABEL,
    ttlMs: EDITOR_LEASE_TTL_MS,
    lockTimeoutMs: opts.lockTimeoutMs ?? EDITOR_LEASE_LOCK_TIMEOUT_MS,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

/**
 * Another tab served by this same editor process may hand the lease over:
 * both are humans whose writes already serialize through disk revisions.
 * @param {string} projectRoot
 * @param {number | undefined} now
 */
function sameServerEditorHolder(projectRoot, now) {
  const state = readProjectLease(projectRoot, now);
  const holder = state.holder;
  if (!state.active || !holder || holder.kind !== EDITOR_LEASE_KIND) return null;
  return holder.pid === process.pid && holder.hostname === os.hostname() ? holder : null;
}

/**
 * @param {import("@open-slidestudio/slides-tools").LeaseAcquireResult} result
 * @param {EditorLeaseGrant["outcome"]} [outcome]
 * @returns {EditorLeaseGuardResult}
 */
function toGuardResult(result, outcome) {
  if (!result.ok) return conflictRefusal(result.outcome, publicLeaseHolder(result.holder));
  const preempted = publicLeaseHolder(result.preempted);
  return {
    ok: true,
    outcome: outcome ?? result.outcome,
    lease: publicLeaseHolder(result.lease),
    ...(preempted ? { preempted } : {}),
  };
}

/**
 * @param {string} projectRoot
 * @param {string} ownerId
 * @param {EditorLeaseOptions} opts
 * @returns {EditorLeaseGuardResult}
 */
function guardOnce(projectRoot, ownerId, opts) {
  const first = acquireForEditor(projectRoot, ownerId, opts);
  if (first.ok || first.outcome !== "lease-conflict" || first.holder.kind !== EDITOR_LEASE_KIND) {
    return toGuardResult(first);
  }
  const sibling = sameServerEditorHolder(projectRoot, opts.now);
  if (!sibling) return toGuardResult(first);
  releaseProjectLease(projectRoot, sibling.ownerId, {
    expectedToken: sibling.token ?? null,
    lockTimeoutMs: opts.lockTimeoutMs ?? EDITOR_LEASE_LOCK_TIMEOUT_MS,
  });
  const second = acquireForEditor(projectRoot, ownerId, opts);
  return toGuardResult(second, second.ok && second.outcome === "acquired" ? "handed-over" : undefined);
}

/**
 * Guard one human write. On `{ ok: false }` answer `json(res, result.status, result.body)`
 * and do not write; on `{ ok: true }` proceed (the lease is held or renewed).
 * @param {string} projectRoot
 * @param {EditorLeaseOptions} [opts]
 * @returns {EditorLeaseGuardResult}
 */
export function guardEditorWrite(projectRoot, opts = {}) {
  // Never create a directory for a project that does not exist: the write
  // route reports its own 404/400 for it.
  if (!projectRoot || !fs.existsSync(projectRoot)) return { ok: true, outcome: "skipped", lease: null };
  const ownerId = editorLeaseOwnerId(opts.tabId);
  return withLeaseErrors(projectRoot, () => guardOnce(projectRoot, ownerId, opts));
}

/**
 * One-line route guard: sends the refusal and returns true when the write must stop.
 * @param {{
 *   res: import("node:http").ServerResponse,
 *   json: (res: import("node:http").ServerResponse, status: number, body: unknown) => unknown,
 *   projectRoot: string,
 *   tabId?: string | null,
 *   label?: string,
 * }} args
 * @returns {boolean}
 */
export function refuseEditorWrite({ res, json, projectRoot, tabId, label }) {
  const result = guardEditorWrite(projectRoot, { tabId, ...(label ? { label } : {}) });
  if (result.ok) return false;
  json(res, result.status, result.body);
  return true;
}

/**
 * Release this tab's lease. Releasing a lease the tab does not hold is a no-op.
 * @param {string} projectRoot
 * @param {{ tabId?: string | null, lockTimeoutMs?: number }} [opts]
 * @returns {{ ok: true, released: boolean } | EditorLeaseRefusal}
 */
export function releaseEditorLease(projectRoot, opts = {}) {
  if (!projectRoot || !fs.existsSync(projectRoot)) return { ok: true, released: false };
  const ownerId = editorLeaseOwnerId(opts.tabId);
  try {
    const released = releaseProjectLease(projectRoot, ownerId, {
      lockTimeoutMs: opts.lockTimeoutMs ?? EDITOR_LEASE_LOCK_TIMEOUT_MS,
    });
    return { ok: true, released };
  } catch (error) {
    const kind = classifyLeaseError(error);
    if (kind === "busy") return busyRefusal(projectRoot);
    if (kind === "permission") return { ok: true, released: false };
    throw error;
  }
}

/**
 * Read-only view for the browser: holder kind/label/expiry, whether this tab
 * holds it, and which agents wait for the editor. Never exposes pids, hosts,
 * tokens or foreign owner ids.
 * @param {string} projectRoot
 * @param {{ tabId?: string | null, now?: number }} [opts]
 */
export function editorLeaseView(projectRoot, opts = {}) {
  if (!projectRoot || !fs.existsSync(projectRoot)) {
    return { active: false, holder: null, mine: false, waiting: [] };
  }
  const state = readProjectLease(projectRoot, opts.now);
  const holder = state.active ? publicLeaseHolder(state.holder) : null;
  return {
    active: Boolean(holder),
    holder,
    mine: Boolean(holder && state.holder?.ownerId === editorLeaseOwnerId(opts.tabId)),
    waiting: state.preempted.map((row) => ({ kind: row.kind, at: row.at })),
  };
}
