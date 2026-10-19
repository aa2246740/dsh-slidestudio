/**
 * @typedef {object} PendingWorkspaceEdit
 * @property {string} project
 * @property {string} sessionId
 * @property {string} aiLockToken
 * @property {string} snapshotId
 * @property {string} [text]
 * @property {{
 *   ok: true,
 *   targetPageIds: string[],
 *   targetPageId: string,
 *   label: string,
 *   scope: string,
 *   elementIds: string[],
 *   pagePath: string,
 *   pageIndex: number,
 *   deletablePageIds?: string[],
 *   reorderPageIds?: string[],
 *   editablePageIds?: string[],
 *   editableMeta?: string[],
 *   insertIndex?: number,
 *   structureOnly?: boolean,
 *   rewrite?: boolean,
 * }} target
 * @property {string} [clientRequestId]
 * @property {{inspection?: {pages?: unknown[]}}} [before]
 */

/**
 * @typedef {object} WorkspaceEditRecoveryContext
 * @property {Storage} storage
 * @property {() => string} currentProject
 * @property {(project: string) => PendingWorkspaceEdit | null} readPending
 * @property {Set<string>} promptedTokens
 * @property {typeof fetch} fetch
 * @property {(route: string) => string} nativeApi
 * @property {() => boolean} controlExecuting
 * @property {(project: string, recover: () => Promise<boolean>) => Promise<boolean>} withProjectLock
 * @property {() => boolean} confirm
 * @property {() => {value: string, dispatchEvent: (event: Event) => boolean} | null} getComposer
 * @property {() => void} onStorageFailure
 * @property {(token: string) => void} settleMatchingControl
 * @property {() => void} repaint
 * @property {() => void} onRecovered
 */

/** @param {string} project */
export const pendingWorkspaceEditKey = (project) => `slides.pending-edit:${project}`;

/** @param {string} project @param {string} token */
export const interruptedWorkspaceEditKey = (project, token) =>
  `slides.interrupted-edit:${encodeURIComponent(project)}:${encodeURIComponent(token)}`;

/** @param {Storage} storage @param {string} project @returns {PendingWorkspaceEdit | null} */
export function readPendingWorkspaceEdit(storage, project) {
  try {
    const pending = JSON.parse(storage.getItem(pendingWorkspaceEditKey(project)) || "null");
    return pending?.project === project &&
      pending?.sessionId &&
      pending?.aiLockToken &&
      pending?.snapshotId &&
      Array.isArray(pending.target.targetPageIds) &&
      pending.target.targetPageIds.length > 0
      ? pending
      : null;
  } catch {
    return null;
  }
}

/** @param {Storage} storage @param {PendingWorkspaceEdit} pending */
export function persistPendingWorkspaceEdit(storage, pending) {
  storage.setItem(pendingWorkspaceEditKey(pending.project), JSON.stringify(pending));
}

/** @param {PendingWorkspaceEdit["target"]} target */
export function isResumableWorkspaceTarget(target) {
  return (
    target?.ok === true &&
    typeof target.targetPageId === "string" &&
    typeof target.label === "string" &&
    typeof target.scope === "string" &&
    Array.isArray(target.elementIds) &&
    typeof target.pagePath === "string" &&
    Number.isSafeInteger(target.pageIndex)
  );
}

/** @param {Storage} storage @param {string} project @param {string} token */
export function clearPendingWorkspaceEdit(storage, project, token) {
  if (readPendingWorkspaceEdit(storage, project)?.aiLockToken === token) {
    storage.removeItem(pendingWorkspaceEditKey(project));
  }
}

/** @param {unknown} left @param {unknown} right */
export function samePendingWorkspaceEdit(left, right) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

/**
 * @param {PendingWorkspaceEdit} pending
 * @param {typeof fetch} fetcher
 * @param {(route: string) => string} nativeApi
 * @returns {Promise<"same-lock" | "active-other" | "stale" | "missing-project" | "unknown">}
 */
export async function inspectPendingWorkspaceEdit(pending, fetcher, nativeApi) {
  try {
    const query = new URLSearchParams({ project: pending.project, token: pending.aiLockToken });
    const statusResponse = await fetcher(`${nativeApi("/api/reviews/ai-lock/status")}?${query}`);
    if (statusResponse.status === 404) {
      const missing = await statusResponse.json().catch(() => null);
      return missing?.code === "REVIEW_PROJECT_NOT_FOUND" ? "missing-project" : "unknown";
    }
    if (!statusResponse.ok) return "unknown";
    const status = await statusResponse.json();
    if (typeof status.active !== "boolean" || typeof status.recoverable !== "boolean") return "unknown";
    if (status.active) return status.recoverable ? "same-lock" : "active-other";
    const sessionResponse = await fetcher(`/slides/state/${encodeURIComponent(pending.sessionId)}`);
    if (sessionResponse.status === 404) return "stale";
    if (!sessionResponse.ok) return "unknown";
    const session = await sessionResponse.json();
    return session?.agentStatus === "idle" ? "stale" : "unknown";
  } catch {
    return "unknown";
  }
}

/** @param {PendingWorkspaceEdit} pending @param {WorkspaceEditRecoveryContext} context */
async function archivePendingEdit(pending, context) {
  const key = pendingWorkspaceEditKey(pending.project);
  const archiveKey = interruptedWorkspaceEditKey(pending.project, pending.aiLockToken);
  const serialized = JSON.stringify(pending);
  try {
    const existing = context.storage.getItem(archiveKey);
    if (existing !== null && existing !== serialized) return false;
    if (existing === null) context.storage.setItem(archiveKey, serialized);
    if (!samePendingWorkspaceEdit(context.readPending(pending.project), pending)) return false;
    context.storage.removeItem(key);
    return true;
  } catch {
    context.onStorageFailure();
    return false;
  }
}

/** @param {PendingWorkspaceEdit} pending @param {WorkspaceEditRecoveryContext} context */
function restoreInstruction(pending, context) {
  const composer = context.getComposer();
  if (!composer) return false;
  const draft = String(composer.value || "");
  const instruction = String(pending.text || "");
  composer.value = draft.trim() ? `${draft.trimEnd()}\n\n${instruction}` : instruction;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  context.settleMatchingControl(pending.aiLockToken);
  context.repaint();
  context.onRecovered();
  return true;
}

/** @param {PendingWorkspaceEdit} pending @param {WorkspaceEditRecoveryContext} context */
async function validatePendingEdit(pending, context) {
  const project = String(pending?.project || "");
  const token = String(pending?.aiLockToken || "");
  if (!project || !token || project !== context.currentProject()) return false;
  if (context.controlExecuting()) return false;
  if (!samePendingWorkspaceEdit(context.readPending(project), pending)) return false;
  return {
    project,
    token,
    state: await inspectPendingWorkspaceEdit(pending, context.fetch, context.nativeApi),
  };
}

/** @param {PendingWorkspaceEdit} pending @param {WorkspaceEditRecoveryContext} context */
async function confirmPendingEdit(pending, context) {
  const project = pending.project;
  const token = pending.aiLockToken;
  if (context.promptedTokens.has(token)) return false;
  context.promptedTokens.add(token);
  if (!context.confirm()) return false;
  if (project !== context.currentProject() || context.controlExecuting()) return false;
  if (!samePendingWorkspaceEdit(context.readPending(project), pending)) return false;
  const state = await inspectPendingWorkspaceEdit(pending, context.fetch, context.nativeApi);
  return state === "stale" || state === "missing-project";
}

/** @param {PendingWorkspaceEdit} pending @param {WorkspaceEditRecoveryContext} context */
async function recoverInsideProjectLock(pending, context) {
  const validation = await validatePendingEdit(pending, context);
  if (!validation) return false;
  if (validation.state === "same-lock") return true;
  if (validation.state !== "stale" && validation.state !== "missing-project") return false;
  if (!(await confirmPendingEdit(pending, context))) return false;
  if (!(await archivePendingEdit(pending, context))) return false;
  restoreInstruction(pending, context);
  return false;
}

/** @param {WorkspaceEditRecoveryContext} context */
export function createWorkspaceEditRecovery(context) {
  /** @param {PendingWorkspaceEdit} pending */
  return async function recoverStalePendingWorkspaceEdit(pending) {
    const project = String(pending?.project || "");
    if (!project || !pending?.aiLockToken || project !== context.currentProject()) return false;
    if (context.controlExecuting()) return false;
    try {
      return await context.withProjectLock(project, () => recoverInsideProjectLock(pending, context));
    } catch {
      return false;
    }
  };
}
