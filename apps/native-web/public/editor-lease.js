/**
 * Browser side of the editor-human writer lease. The server takes the lease
 * on every human write; this client gives it back as soon as the tab goes
 * away (pagehide / beforeunload, optionally a hidden document) so a waiting
 * agent can re-acquire, and turns a lease refusal into readable copy.
 */
import { t } from "./i18n.js";

export const EDITOR_LEASE_RELEASE_ENDPOINT = "/api/lease/release";
const LEASE_CODES = new Set(["WRITER_LEASE_CONFLICT", "WRITER_LEASE_BUSY"]);
const UNLOAD_DEDUPE_MS = 1_000;

/** Chinese source copy (translation keys) for each lease refusal. */
export const EDITOR_LEASE_MESSAGES = {
  "hub-run": "AI 正在生成或修改这份文稿，暂时不能手动编辑。请等待本轮生成结束后再试。",
  "editor-human": "这份文稿正在另一个编辑器中修改。请关闭那边的编辑页面或稍后再试。",
  mcp: "外部智能体正在写入这份文稿，请稍后再试。",
  other: "这份文稿正被其他写入方占用，请稍后再试。",
  busy: "文稿写入锁暂时被占用，请稍后重试。",
};

/**
 * @typedef {{ error?: string, code?: string, outcome?: string, holder?: { kind?: string } | null }} LeaseRefusalBody
 * @typedef {{
 *   addEventListener: (type: string, listener: (event: Event) => void) => void,
 *   removeEventListener: (type: string, listener: (event: Event) => void) => void,
 * }} ListenerTarget
 * @typedef {ListenerTarget & { visibilityState?: string }} DocumentTarget
 * @typedef {{
 *   project: () => string,
 *   tabId: string | (() => string),
 *   fetch?: typeof fetch,
 *   sendBeacon?: ((url: string, data: Blob) => boolean) | null,
 *   windowTarget?: ListenerTarget | null,
 *   documentTarget?: DocumentTarget | null,
 *   endpoint?: string,
 *   now?: () => number,
 * }} EditorLeaseClientOptions
 */

/**
 * @param {number} status
 * @param {unknown} body
 * @returns {body is LeaseRefusalBody}
 */
export function isEditorLeaseRefusal(status, body) {
  if (status !== 409 && status !== 503) return false;
  const code = body && typeof body === "object" ? /** @type {LeaseRefusalBody} */ (body).code : undefined;
  return typeof code === "string" && LEASE_CODES.has(code);
}

/**
 * User-facing message for a lease refusal body (409 conflict or 503 busy).
 * @param {LeaseRefusalBody | null | undefined} body
 * @returns {string}
 */
export function editorLeaseRefusalMessage(body) {
  if (body?.code === "WRITER_LEASE_BUSY") return t(EDITOR_LEASE_MESSAGES.busy);
  const kind = body?.holder?.kind;
  if (kind === "hub-run" || kind === "editor-human" || kind === "mcp") return t(EDITOR_LEASE_MESSAGES[kind]);
  return t(EDITOR_LEASE_MESSAGES.other);
}

/**
 * Error text for a failed editor API call: the lease copy for a writer-lease
 * refusal, otherwise the server's own error, otherwise the HTTP status text.
 * @param {number} status
 * @param {{ error?: unknown } | null | undefined} body
 * @param {string} statusText
 * @returns {string}
 */
export function editorApiErrorMessage(status, body, statusText) {
  if (isEditorLeaseRefusal(status, body)) return editorLeaseRefusalMessage(body);
  return typeof body?.error === "string" && body.error ? body.error : statusText;
}

/** @returns {((url: string, data: Blob) => boolean) | null} */
function defaultBeacon() {
  const nav = typeof navigator === "undefined" ? null : navigator;
  return nav && typeof nav.sendBeacon === "function" ? nav.sendBeacon.bind(nav) : null;
}

/** @returns {ListenerTarget | null} */
function defaultWindow() {
  return typeof window === "undefined" ? null : window;
}

/**
 * @param {EditorLeaseClientOptions} opts
 */
function resolveOptions(opts) {
  return {
    fetchImpl: opts.fetch ?? (typeof fetch === "function" ? fetch : null),
    beacon: opts.sendBeacon === undefined ? defaultBeacon() : opts.sendBeacon,
    windowTarget: opts.windowTarget === undefined ? defaultWindow() : opts.windowTarget,
    documentTarget: opts.documentTarget ?? null,
    endpoint: opts.endpoint || EDITOR_LEASE_RELEASE_ENDPOINT,
    now: opts.now ?? Date.now,
    tabId: typeof opts.tabId === "function" ? opts.tabId : () => String(opts.tabId),
    project: opts.project,
  };
}

/**
 * @param {ReturnType<typeof resolveOptions>} o
 * @returns {string}
 */
function currentProject(o) {
  try {
    return String(o.project() || "");
  } catch {
    return "";
  }
}

/**
 * @param {ReturnType<typeof resolveOptions>} o
 * @param {string} [projectOverride] release a project other than the current one (e.g. before switching)
 * @returns {string | null}
 */
function payloadFor(o, projectOverride) {
  const project = projectOverride || currentProject(o);
  if (!project) return null;
  return JSON.stringify({ project, tabId: o.tabId() });
}

/**
 * @param {ReturnType<typeof resolveOptions>} o
 * @param {string} payload
 * @returns {boolean}
 */
function tryBeacon(o, payload) {
  if (!o.beacon) return false;
  try {
    // text/plain keeps the beacon CORS-safelisted in every browser.
    return o.beacon(o.endpoint, new Blob([payload], { type: "text/plain;charset=UTF-8" }));
  } catch {
    return false;
  }
}

/**
 * @param {ReturnType<typeof resolveOptions>} o
 * @param {string} payload
 * @returns {Promise<Response | null>}
 */
async function postRelease(o, payload) {
  if (!o.fetchImpl) return null;
  try {
    return await o.fetchImpl(o.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    });
  } catch {
    return null;
  }
}

/**
 * Create the tab's lease client. Call `attach()` once the editor opens a
 * project, `release()` when the editing session ends explicitly, and
 * `detach()` to remove the unload listeners.
 * @param {EditorLeaseClientOptions} opts
 */
export function createEditorLeaseClient(opts) {
  const o = resolveOptions(opts);
  let lastUnloadAt = Number.NEGATIVE_INFINITY;
  let lastUnloadPayload = "";

  /** Best-effort release while the page is going away (never awaits). */
  function releaseOnUnload() {
    const payload = payloadFor(o);
    if (!payload) return false;
    const at = o.now();
    if (payload === lastUnloadPayload && at - lastUnloadAt < UNLOAD_DEDUPE_MS) return true;
    lastUnloadAt = at;
    lastUnloadPayload = payload;
    if (tryBeacon(o, payload)) return true;
    void postRelease(o, payload);
    return true;
  }

  /**
   * Explicit end of the editing session. Pass `{ project }` to release the
   * previous project right before the tab switches to another one.
   * @param {{ project?: string }} [opts]
   * @returns {Promise<{ released: boolean } | null>}
   */
  async function release(opts = {}) {
    const payload = payloadFor(o, opts.project);
    if (!payload) return null;
    const res = await postRelease(o, payload);
    if (!res || !res.ok) return null;
    const body = await res.json().catch(() => null);
    return { released: Boolean(body && body.released) };
  }

  const onUnload = () => {
    releaseOnUnload();
  };
  const onVisibility = () => {
    if (o.documentTarget?.visibilityState === "hidden") releaseOnUnload();
  };

  function attach() {
    o.windowTarget?.addEventListener("pagehide", onUnload);
    o.windowTarget?.addEventListener("beforeunload", onUnload);
    o.documentTarget?.addEventListener("visibilitychange", onVisibility);
  }

  function detach() {
    o.windowTarget?.removeEventListener("pagehide", onUnload);
    o.windowTarget?.removeEventListener("beforeunload", onUnload);
    o.documentTarget?.removeEventListener("visibilitychange", onVisibility);
  }

  return { attach, detach, release, releaseOnUnload };
}
