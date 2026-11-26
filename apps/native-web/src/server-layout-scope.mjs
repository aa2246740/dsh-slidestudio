/**
 * Layout grants for editor AI turns started from layout mode (masters-layouts §5.2). A layout lock
 * names one layout. The anchor page and every page that uses that layout may take its copies, but
 * no page may change its own content and no other master or layout may move. Every other workspace
 * lock may move no master or layout at all.
 *
 * Pure helpers: server.mjs calls them while capturing a workspace-edit scope, acquiring its AI
 * lock, and verifying the result. None of them writes to disk.
 */
import path from "node:path";
import { picked } from "./layout-routes.mjs";

/** @typedef {import("@open-slidestudio/pptd-v2").LoadedPage} LoadedPage */
/** @typedef {import("@open-slidestudio/pptd-v2").PptdProject} PptdProject */
/** @typedef {import("../types/server/contracts.js").PageBaseline} PageBaseline */
/** @typedef {import("../types/server/contracts.js").ReviewLock} ReviewLock */
/**
 * @typedef {{
 *   layoutId: string,
 *   layoutName: string,
 *   definition: Record<string, unknown> | undefined,
 *   pageIds: string[],
 * }} LayoutGrant
 * @typedef {{ editableMeta?: unknown, layoutId?: unknown, layoutShas?: Record<string, string> }} LayoutScopeFields
 */

const LAYOUT = "layout/";
/** The editableMeta entry that turns a page lock into a layout lock. */
export const LAYOUT_EDITABLE_META = "layouts";

/**
 * @param {string} message
 * @param {string} code
 */
function scopeError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {LayoutScopeFields | undefined} scope
 * @returns {string | undefined} the layout a lock grants, or undefined for a lock without one
 */
export function grantedLayoutId(scope) {
  const editable = scope?.editableMeta;
  if (!Array.isArray(editable) || !editable.includes(LAYOUT_EDITABLE_META)) return undefined;
  return typeof scope?.layoutId === "string" ? scope.layoutId : "";
}

/**
 * Validates the layout half of a raw `workspaceEdit` request. A layout grant is a page-kind lock
 * that names one layoutId and nothing else: no deck metadata, no metaOnly, no structure, no
 * rewrite and no elements. Returns undefined when the request asks for no layout, so the caller's
 * own title/theme validation runs unchanged.
 * @param {Record<string, unknown>} raw the request's workspaceEdit object
 * @returns {{ editableMeta: ["layouts"], layoutId: string } | undefined}
 */
export function captureLayoutGrant(raw) {
  const editable = raw?.editableMeta;
  if (!Array.isArray(editable) || !editable.includes(LAYOUT_EDITABLE_META)) return undefined;
  const layoutId = typeof raw.layoutId === "string" ? raw.layoutId.trim() : "";
  const elementIds = Array.isArray(raw.elementIds) ? raw.elementIds : [];
  const refused =
    raw.kind !== "page" ||
    new Set(editable).size !== 1 ||
    !layoutId ||
    raw.metaOnly === true ||
    raw.structureOnly === true ||
    raw.rewrite === true ||
    elementIds.length > 0;
  if (refused) {
    throw scopeError(
      "a layout workspace edit is a page-kind lock that names one layoutId only",
      "WORKSPACE_EDIT_SCOPE_INVALID",
    );
  }
  return { editableMeta: [LAYOUT_EDITABLE_META], layoutId };
}

/** @param {LoadedPage} entry */
const pageIdOf = (entry) => path.basename(entry.path, ".page");

/**
 * What a workspace lock judges about one page: its stored hash (copies included), its own content
 * (copies and inherited background removed) and the layout it uses.
 * @param {LoadedPage} entry
 * @param {{ stableSha256: (value: unknown) => string }} presentation the presentation-run module
 * @param {Pick<typeof import("@open-slidestudio/pptd-v2"), "ownPageBody">} pptd the pptd-v2 module
 * @returns {PageBaseline}
 */
export function pageFacts(entry, presentation, pptd) {
  const pageId = pageIdOf(entry);
  return {
    pageId,
    pagePath: entry.path,
    pageSha256: presentation.stableSha256({ id: pageId, ...entry.page }),
    ownPageSha256: presentation.stableSha256({ id: pageId, ...pptd.ownPageBody(entry.page) }),
    layoutId: entry.page.layoutId,
  };
}

/**
 * The hash of every master and layout over the fields the agent hashes, keyed `master/<id>` or
 * `layout/<id>`.
 * @param {PptdProject["presentation"]} deck
 * @param {(value: unknown) => string} stableSha256
 * @returns {Record<string, string>}
 */
export function definitionShas(deck, stableSha256) {
  /** @type {Record<string, string>} */
  const shas = {};
  for (const entry of deck.masters ?? []) {
    shas[`master/${entry.id}`] = stableSha256(picked("master", entry));
  }
  for (const entry of deck.layouts ?? []) {
    shas[`${LAYOUT}${entry.id}`] = stableSha256(picked("layout", entry));
  }
  return shas;
}

/**
 * The layout a lock grants and the pages it covers, in deck order. The anchor page is always
 * covered, with every page that uses the layout. Undefined for a lock that grants no layout.
 * A requested page outside that set means the client's view is stale, so the lock is refused.
 * @param {PptdProject} project
 * @param {LayoutScopeFields | undefined} scope
 * @param {string} anchorPageId
 * @param {string[]} requestedPageIds
 * @returns {LayoutGrant | undefined}
 */
export function layoutGrant(project, scope, anchorPageId, requestedPageIds) {
  const layoutId = grantedLayoutId(scope);
  if (layoutId === undefined) return undefined;
  const layout = (project.presentation.layouts ?? []).find((entry) => entry.id === layoutId);
  if (!layout) {
    throw scopeError(`layout not found: ${layoutId}`, "WORKSPACE_EDIT_SCOPE_INVALID");
  }
  const pageIds = project.pages
    .filter((entry) => pageIdOf(entry) === anchorPageId || entry.page.layoutId === layoutId)
    .map(pageIdOf);
  if (requestedPageIds.some((pageId) => !pageIds.includes(pageId))) {
    throw scopeError(
      "workspace edit target pages do not match the pages using this layout",
      "WORKSPACE_EDIT_SCOPE_STALE",
    );
  }
  return {
    layoutId,
    layoutName: layout.name || layoutId,
    definition: picked("layout", layout),
    pageIds,
  };
}

/**
 * The hash that write_layout must echo for a layout: that of the saved layout, the same definition
 * the turn shows beside it. The run ledger is not asked, because a version restore leaves it naming
 * a newer revision than the file holds.
 * @param {{ savedLayoutSha256: (root: string, scope: "master" | "layout", id: string) => string }} presentation
 * @param {string} root
 * @param {string} layoutId
 * @returns {string}
 */
export function expectedLayoutSha256(presentation, root, layoutId) {
  return presentation.savedLayoutSha256(root, "layout", layoutId);
}

/**
 * The `layout` block an AI-lock acquisition returns beside the lock, for layout-edit-turn.js.
 * @param {LayoutGrant | undefined} grant
 * @param {{ savedLayoutSha256: (root: string, scope: "master" | "layout", id: string) => string }} presentation
 * @param {string} root
 */
export function layoutLockPayload(grant, presentation, root) {
  if (!grant) return undefined;
  return {
    id: grant.layoutId,
    name: grant.layoutName,
    layoutSha256: expectedLayoutSha256(presentation, root, grant.layoutId),
    definition: grant.definition,
  };
}

/**
 * The pages a layout grant changed on their own content, and those whose copies moved although they
 * do not use the granted layout.
 * @param {PageBaseline[]} beforePages
 * @param {PageBaseline[]} afterPages
 * @param {string} layoutId
 */
function pageViolations(beforePages, afterPages, layoutId) {
  const before = new Map(beforePages.map((entry) => [entry.pageId, entry]));
  const now = new Map(afterPages.map((entry) => [entry.pageId, entry]));
  const pageIds = [...new Set([...before.keys(), ...now.keys()])];
  const ownChangedPageIds = pageIds.filter(
    (pageId) => before.get(pageId)?.ownPageSha256 !== now.get(pageId)?.ownPageSha256,
  );
  const unauthorizedLayoutCopyPageIds = pageIds.filter(
    (pageId) =>
      before.get(pageId)?.pageSha256 !== now.get(pageId)?.pageSha256 && now.get(pageId)?.layoutId !== layoutId,
  );
  return { ownChangedPageIds, unauthorizedLayoutCopyPageIds };
}

/**
 * Judges the definitions and pages that a workspace lock let move, on top of the verdict the page
 * and deck checks already reached. A layout grant may move its own layout and the copies of the
 * pages that use it, but no page may change its own content. Any other moved definition is a
 * violation, and so is any definition moving in a turn without a layout grant.
 * @param {any} record the verdict so far
 * @param {Pick<ReviewLock, "projectPages"> & { scope?: LayoutScopeFields }} lock the acquired lock
 * @param {{ pages: PageBaseline[], definitions: Record<string, string> }} after the verification
 *   snapshot: the current pages and definitions
 */
export function judgeWorkspaceRecord(record, lock, after) {
  const layoutId = grantedLayoutId(lock.scope);
  const grantedKey = layoutId === undefined ? undefined : `${LAYOUT}${layoutId}`;
  /** @type {Record<string, string>} */
  const beforeShas = lock.scope?.layoutShas ?? {};
  const keys = [...new Set([...Object.keys(beforeShas), ...Object.keys(after.definitions)])];
  const moved = keys.filter((key) => beforeShas[key] !== after.definitions[key]);
  const foreignMoved = moved.some((key) => key !== grantedKey);
  const changedLayoutIds = moved.filter((key) => key.startsWith(LAYOUT)).map((key) => key.slice(LAYOUT.length));
  if (layoutId === undefined) {
    return { ...record, changedLayoutIds, scopeViolation: record.scopeViolation || foreignMoved };
  }
  const { ownChangedPageIds, unauthorizedLayoutCopyPageIds } = pageViolations(
    lock.projectPages ?? [],
    after.pages,
    layoutId,
  );
  const grantedMoved = moved.includes(grantedKey ?? "");
  return {
    ...record,
    changed: record.changed || grantedMoved,
    targetChanged: record.targetChanged || grantedMoved,
    scopeViolation:
      record.scopeViolation || foreignMoved || ownChangedPageIds.length > 0 || unauthorizedLayoutCopyPageIds.length > 0,
    changedLayoutIds,
    ownChangedPageIds,
    unauthorizedLayoutCopyPageIds,
  };
}
