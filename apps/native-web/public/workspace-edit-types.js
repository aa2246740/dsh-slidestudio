/**
 * @typedef {{
 *   ok: true,
 *   label: string,
 *   pagePath: string,
 *   pageIndex: number,
 *   scope: string,
 *   targetPageId: string,
 *   targetPageIds: string[],
 *   elementIds: string[],
 *   deletablePageIds?: string[],
 *   reorderPageIds?: string[],
 *   editablePageIds?: string[],
 *   editableMeta?: string[],
 *   insertIndex?: number,
 *   expectedAddCount?: number,
 *   lockedTargetPages?: {pageId: string, revision: number, pageSha256: string}[],
 *   rewrite?: boolean,
 *   structureOnly?: boolean,
 * }} WorkspaceEditTarget
 * @typedef {{ok: false, scope: string, label: string, error: string}} InvalidWorkspaceEditTarget
 * @typedef {WorkspaceEditTarget | InvalidWorkspaceEditTarget} WorkspaceEditTargetDecision
 * @typedef {{
 *   snapshotId: string,
 *   snapshotLabel?: string,
 *   sessionId: string,
 *   aiLockToken: string,
 *   before?: {inspection?: {pages?: unknown[]}},
 *   clientRequestId?: string,
 * }} WorkspaceEditRecovery
 * @typedef {{clientRequestId?: string, project?: string, message?: object, requestText?: string, snapshotId?: string, snapshotLabel?: string}} WorkspaceEditReceipt
 * @typedef {{cancelRequested: boolean, settled?: boolean, aiLockToken?: string, stage?: string, receipt?: WorkspaceEditReceipt, recovering?: boolean}} WorkspaceReviewControl
 */

export {};
