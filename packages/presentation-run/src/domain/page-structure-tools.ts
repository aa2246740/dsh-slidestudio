import fs from "node:fs";
import path from "node:path";
import { loadProject, saveProject, withProjectWriteLock, type Theme } from "@open-slidestudio/pptd-v2";
import { pageRevisionSha256 } from "./hashing.js";
import { persistPageKey } from "./page-identity.js";
import { updateDeckThemeRefusals } from "./theme-update-guard.js";
import { readActiveReviewGuard } from "./review-write-scope.js";
import { editorAuthorityLostReceipt, editorTurnAuthorityLost } from "./editor-turn-authority.js";
import type { AgentToolState, ToolExecution } from "./agent-tools.js";
import { currentPageRevision, readCommittedPagePlan, readRunLedger } from "./run-ledger.js";
import { planCoverage } from "./plan-coverage.js";

function generationDeletionIssue(state: AgentToolState, requested: readonly string[]): string | undefined {
  const root = state.projectRoot;
  if (!root || !readRunLedger(root)) return "本次没有生成记录，不能删除页面。";
  if (!requested.length) return "请先提交完整计划，并指定要删除的页面。";
  // Re-read under the project write lock; a concurrent replan may have changed
  // which pages are authorized for cleanup since hands-state was built.
  const extra = new Set(planCoverage(root, readCommittedPagePlan(root)).extra);
  const planned = requested.filter((id) => !extra.has(id));
  if (planned.length) return `页面 ${planned.join("、")} 仍在最新计划中或不在磁盘上，不能删除。`;
  const project = loadProject(root);
  const foreign = requested.filter((id) => {
    const page = project.pages.find((entry) => persistPageKey(entry.path) === id);
    const revision = currentPageRevision(root, id);
    const agentWritten = state.writtenPages?.some((written) => persistPageKey(written.id) === id);
    return !agentWritten || !page || !revision || revision.pageSha256 !== pageRevisionSha256(page.page, id);
  });
  if (foreign.length) return `页面 ${foreign.join("、")} 不是本次 Agent 写入的当前版本，不能删除。`;
  return undefined;
}

/**
 * The persisted workspace-edit guard for page-list changes: kind "deck" plus
 * structureOnly. It authorizes new pages at insertIndex, whitelisted edits via
 * editablePageIds and removals via deletablePageIds; every other existing page
 * must remain byte-identical.
 */
export function structuralEditGuard(guard: ReturnType<typeof readActiveReviewGuard>):
  | {
      insertIndex?: number;
      editablePageIds: ReadonlySet<string>;
      deletablePageIds: ReadonlySet<string>;
      reorderPageIds: string[];
    }
  | undefined {
  const scope = guard?.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return undefined;
  const rec = scope as Record<string, unknown>;
  if (rec.kind !== "deck" || rec.structureOnly !== true) return undefined;
  const insertIndex = Number(rec.insertIndex);
  const idSet = (value: unknown) =>
    new Set(
      (Array.isArray(value) ? value : []).map((id) => persistPageKey(String(id ?? ""))).filter((id) => id.length > 0),
    );
  return {
    insertIndex: Number.isSafeInteger(insertIndex) && insertIndex >= 0 ? insertIndex : undefined,
    editablePageIds: idSet(rec.editablePageIds),
    deletablePageIds: idSet(rec.deletablePageIds),
    // Order is the payload for a reorder — keep the sequence, not a set.
    reorderPageIds: (Array.isArray(rec.reorderPageIds) ? rec.reorderPageIds : [])
      .map((id) => persistPageKey(String(id ?? "")))
      .filter((id) => id.length > 0),
  };
}

/**
 * A full-rewrite lock (kind "deck" + rewrite, never structureOnly) authorizes
 * replacing the whole deck: every baseline page may be rewritten or deleted,
 * new pages may be appended, and the final manifest order is whatever the
 * committed plan demands — the verify step pins that order exactly.
 */
export function rewriteEditGuard(
  guard: ReturnType<typeof readActiveReviewGuard>,
): { baselinePageIds: ReadonlySet<string> } | undefined {
  const scope = guard?.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return undefined;
  const rec = scope as Record<string, unknown>;
  if (rec.kind !== "deck" || rec.rewrite !== true || rec.structureOnly === true) return undefined;
  const baselinePageIds = new Set(
    (Array.isArray(guard?.projectPages) ? guard.projectPages : [])
      .map((entry) => persistPageKey(String((entry as Record<string, unknown>)?.pageId ?? "")))
      .filter((id) => id.length > 0),
  );
  return { baselinePageIds };
}

/** Whether the active editor lock is a full-deck rewrite. */
export function rewriteLockActive(projectRoot: string): boolean {
  return rewriteEditGuard(readActiveReviewGuard(projectRoot)) !== undefined;
}

/**
 * Deck-level metadata authorization ("editableMeta"): the scope may whitelist
 * "title" and/or "theme". A rewrite lock authorizes both implicitly.
 */
function editableMetaGuard(guard: ReturnType<typeof readActiveReviewGuard>): ReadonlySet<string> {
  const scope = guard?.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return new Set();
  const rec = scope as Record<string, unknown>;
  const meta = new Set(
    (Array.isArray(rec.editableMeta) ? rec.editableMeta : [])
      .map((field) => String(field ?? "").trim())
      .filter((field) => field === "title" || field === "theme"),
  );
  return meta;
}

/** The lease the project holds right now. Each call reads it again, so the lock sees the latest state. */
function currentGuard(state: AgentToolState): ReturnType<typeof readActiveReviewGuard> {
  return state.projectRoot ? readActiveReviewGuard(state.projectRoot) : undefined;
}

/**
 * The scope delete_pages needs right now. It is judged before the lock and again inside it,
 * because the lease can lapse while the call waits. Generation cleanup (no lease, no editor
 * record) returns nothing here: its plan check runs under the lock.
 */
function deleteScopeRefusal(state: AgentToolState, requested: readonly string[]): ToolExecution | undefined {
  if (state.projectRoot && editorTurnAuthorityLost(state.projectRoot)) {
    return editorAuthorityLostReceipt("delete_pages");
  }
  const guard = currentGuard(state);
  if (!guard && state.strictLedger === true) return undefined;
  const structural = structuralEditGuard(guard);
  const rewrite = rewriteEditGuard(guard);
  // Under a full-rewrite lock every baseline page is droppable.
  const deletable = structural?.deletablePageIds ?? rewrite?.baselinePageIds ?? new Set<string>();
  const unauthorized = requested.filter((id) => !deletable.has(id));
  if ((!structural && !rewrite) || !deletable.size || !requested.length || unauthorized.length) {
    return {
      name: "delete_pages",
      ok: false,
      summary: "delete outside structural scope",
      detail:
        !structural && !rewrite
          ? "delete_pages needs an active editor structural authorization with deletablePageIds; this turn has none"
          : `delete_pages only removes the pages this turn authorized (${[...deletable].join(", ")}); refusing ${unauthorized.join(", ") || "an empty pageIds"}`,
      payload: { error: "review_scope_violation", painted: false },
    };
  }
  return undefined;
}

/**
 * The scope reorder_pages needs right now, judged before the lock and again inside it. The order
 * must match the authorized permutation exactly, or be a full permutation under a rewrite lock.
 */
function reorderScopeRefusal(state: AgentToolState, requested: readonly string[]): ToolExecution | undefined {
  if (state.projectRoot && editorTurnAuthorityLost(state.projectRoot)) {
    return editorAuthorityLostReceipt("reorder_pages");
  }
  const guard = currentGuard(state);
  const structural = structuralEditGuard(guard);
  const rewrite = rewriteEditGuard(guard);
  const authorized = structural?.reorderPageIds ?? [];
  // The requested order must equal the authorized permutation exactly —
  // same ids, same positions, every baseline page exactly once. Under a
  // full-rewrite lock any permutation of the current manifest is allowed;
  // the verify step pins the final order to the committed plan.
  const exact = structural
    ? authorized.length > 0 &&
      requested.length === authorized.length &&
      requested.every((id, index) => id === authorized[index])
    : false;
  const rewritePermutation =
    rewrite !== undefined &&
    (() => {
      if (!state.projectRoot || !requested.length || new Set(requested).size !== requested.length) return false;
      const current = loadProject(state.projectRoot).pages.map((entry) => persistPageKey(entry.path));
      return (
        requested.length === current.length &&
        requested.every((id) => current.includes(id)) &&
        requested.some((id, index) => id !== current[index])
      );
    })();
  if (exact || rewritePermutation) return undefined;
  return {
    name: "reorder_pages",
    ok: false,
    summary: "reorder outside structural scope",
    detail:
      !structural && !rewrite
        ? "reorder_pages needs an active editor structural authorization with reorderPageIds; this turn has none"
        : structural
          ? `reorder_pages must pass exactly this turn's authorized order (${authorized.join(" → ")}); refusing a different pageIds list`
          : "reorder_pages under a rewrite must pass every current page id exactly once, in the new order",
    payload: { error: "review_scope_violation", painted: false },
  };
}

function deckMetaFields(args: Record<string, unknown>) {
  return {
    titleProvided: typeof args.title === "string",
    themeProvided:
      args.theme !== undefined && args.theme !== null && typeof args.theme === "object" && !Array.isArray(args.theme),
  };
}

/**
 * The deck metadata update_deck may apply now, judged before the lock and again inside it. Theme
 * colour validation needs the loaded project, so it stays under the lock.
 */
function updateDeckScopeRefusal(state: AgentToolState, args: Record<string, unknown>): ToolExecution | undefined {
  if (state.projectRoot && editorTurnAuthorityLost(state.projectRoot)) {
    return editorAuthorityLostReceipt("update_deck");
  }
  const guard = currentGuard(state);
  const rewrite = rewriteEditGuard(guard);
  const meta = editableMetaGuard(guard);
  const { titleProvided, themeProvided } = deckMetaFields(args);
  if (!guard || !state.projectRoot) {
    return {
      name: "update_deck",
      ok: false,
      summary: "deck metadata needs authorization",
      detail: "update_deck needs an active editor authorization with editableMeta covering the requested fields",
      payload: { error: "review_scope_violation", painted: false },
    };
  }
  if (!titleProvided && !themeProvided) {
    return {
      name: "update_deck",
      ok: false,
      summary: "nothing to update",
      detail: "update_deck requires a title and/or theme to apply",
      payload: { error: "invalid_args", painted: false },
    };
  }
  const denied = [
    titleProvided && !(meta.has("title") || rewrite) ? "title" : undefined,
    themeProvided && !(meta.has("theme") || rewrite) ? "theme" : undefined,
  ].filter(Boolean);
  if (denied.length) {
    return {
      name: "update_deck",
      ok: false,
      summary: "deck metadata outside authorized scope",
      detail: `update_deck may only change the fields this turn authorized (editableMeta: ${[...meta].join(", ") || "none"}); refusing ${denied.join(", ")}`,
      payload: { error: "review_scope_violation", painted: false },
    };
  }
  return undefined;
}

export function executePageStructureTool(
  name: string,
  args: Record<string, unknown>,
  state: AgentToolState,
): ToolExecution | undefined {
  if (name === "delete_pages") {
    const requested = [
      ...new Set(
        (Array.isArray(args.pageIds) ? args.pageIds : [])
          .map((id) => persistPageKey(String(id ?? "")))
          .filter((id) => id.length > 0),
      ),
    ];
    const refused = deleteScopeRefusal(state, requested);
    if (refused) return refused;
    let deleted: string[] = [];
    let missing: string[] = [];
    let refusal: string | undefined;
    let scopeRefused: ToolExecution | undefined;
    withProjectWriteLock(state.projectRoot!, () => {
      // The lease may have lapsed while this call waited for the lock, so the scope is judged again.
      scopeRefused = deleteScopeRefusal(state, requested);
      if (scopeRefused) return;
      if (!currentGuard(state) && state.strictLedger === true) {
        refusal = generationDeletionIssue(state, requested);
        if (refusal) return;
      }
      const project = loadProject(state.projectRoot!);
      const wanted = new Set(requested);
      const kept = [];
      for (const loaded of project.pages) {
        if (wanted.has(persistPageKey(loaded.path))) {
          deleted.push(persistPageKey(loaded.path));
          fs.rmSync(path.join(state.projectRoot!, loaded.path), { force: true });
        } else kept.push(loaded);
      }
      missing = requested.filter((id) => !deleted.includes(id));
      project.pages = kept;
      project.presentation.pages = kept.map((page) => page.path);
      saveProject(project);
    });
    if (scopeRefused) return scopeRefused;
    if (refusal) {
      return {
        name,
        ok: false,
        summary: "不能删除页面",
        detail: refusal,
        payload: { error: "generation_delete_refused", painted: false },
      };
    }
    state.writtenPages = state.writtenPages?.filter((page) => !deleted.includes(persistPageKey(page.id)));
    if (state.skillDeck) {
      state.skillDeck.pages = state.skillDeck.pages.filter((page) => !deleted.includes(persistPageKey(page.id)));
    }
    if (missing.length) {
      return {
        name,
        ok: false,
        summary: "page not found",
        detail: `pageIds not on disk: ${missing.join(", ")} — read the page list again`,
        payload: { error: "page_not_found", missing, deleted, painted: false },
      };
    }
    return {
      name,
      ok: true,
      summary: `deleted ${deleted.length} 页`,
      detail: `已删除 ${deleted.join("、")}；其余页面与顺序不变。`,
      payload: { deleted, painted: false },
    };
  }

  if (name === "reorder_pages") {
    const requested = (Array.isArray(args.pageIds) ? args.pageIds : []).map((id) => persistPageKey(String(id ?? "")));
    const refused = reorderScopeRefusal(state, requested);
    if (refused) return refused;
    let missing: string[] = [];
    let scopeRefused: ToolExecution | undefined;
    withProjectWriteLock(state.projectRoot!, () => {
      scopeRefused = reorderScopeRefusal(state, requested);
      if (scopeRefused) return;
      const project = loadProject(state.projectRoot!);
      const byId = new Map(project.pages.map((entry) => [persistPageKey(entry.path), entry]));
      missing = requested.filter((id) => !byId.has(id));
      if (missing.length) return;
      // Reorder touches the manifest only — page files are never rewritten.
      project.pages = requested.map((id) => byId.get(id)!);
      project.presentation.pages = project.pages.map((page) => page.path);
      saveProject(project);
    });
    if (scopeRefused) return scopeRefused;
    if (missing.length) {
      return {
        name,
        ok: false,
        summary: "page not found",
        detail: `pageIds not on disk: ${missing.join(", ")} — read the page list again`,
        payload: { error: "page_not_found", missing, painted: false },
      };
    }
    return {
      name,
      ok: true,
      summary: `重排 ${requested.length} 页`,
      detail: `页面顺序已调整为 ${requested.join(" → ")}；页面内容均未改动。`,
      payload: { reordered: requested, painted: false },
    };
  }

  if (name === "update_deck") {
    const refused = updateDeckScopeRefusal(state, args);
    if (refused) return refused;
    const { titleProvided, themeProvided } = deckMetaFields(args);
    let applied: string[] = [];
    let refusals: string[] = [];
    let scopeRefused: ToolExecution | undefined;
    withProjectWriteLock(state.projectRoot!, () => {
      // The lease may have lapsed while this call waited for the lock, so the scope is judged again.
      scopeRefused = updateDeckScopeRefusal(state, args);
      if (scopeRefused) return;
      const project = loadProject(state.projectRoot!);
      if (themeProvided) {
        refusals = updateDeckThemeRefusals(project, args.theme as Theme);
        if (refusals.length) return;
      }
      if (titleProvided) project.presentation.title = String(args.title).trim();
      if (themeProvided) project.presentation.theme = structuredClone(args.theme) as typeof project.presentation.theme;
      saveProject(project);
      applied = [titleProvided ? "标题" : "", themeProvided ? "主题" : ""].filter(Boolean);
    });
    if (scopeRefused) return scopeRefused;
    if (refusals.length) {
      return {
        name,
        ok: false,
        summary: "主题颜色无效，未保存",
        detail: `文稿未改动；${refusals.join(" ")}`,
        payload: { error: "invalid_color", painted: false },
      };
    }
    return {
      name,
      ok: true,
      summary: `更新文稿${applied.join("、")}`,
      detail: `文稿${applied.join("、")}已更新；页面内容均未改动。`,
      payload: {
        updatedMeta: [titleProvided ? "title" : "", themeProvided ? "theme" : ""].filter(Boolean),
        painted: false,
      },
    };
  }

  return undefined;
}
