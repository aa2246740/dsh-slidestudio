/**
 * The durable record of an accepted editor turn. The review lease (ai-review-lock) lasts 15
 * minutes and disappears once its browser stops renewing it, but the turn it authorised can keep
 * running. The record tells every write of that turn that it is still an editor turn, so the write
 * fails closed instead of falling through to generation's write surface (master and layout
 * definitions, and cleanup deletes).
 */
import fs from "node:fs";
import path from "node:path";
import type { ToolExecution } from "./agent-tools.js";
import { readActiveReviewGuard } from "./review-write-scope.js";

const RECORD_REL = path.join("_agent", "editor-turn.v1.json");

/** The refusal for an editor write whose lease has expired or was lost. It names no tool. */
export const EDITOR_AUTHORITY_LOST_DETAIL =
  "编辑授权已过期或已失效（例如浏览器关闭或超时）。本轮不能再修改文稿，请重新打开编辑器后再试。";

/**
 * Tools that change the deck or its plan. An accepted editor turn whose lease lapsed may call none
 * of them: generation's write surface is never granted to a turn that was an editor edit.
 */
export const LAPSED_EDITOR_WRITE_TOOLS: readonly string[] = [
  "write_page",
  "write_layout",
  "edit_elements",
  "edit_page_background",
  "batch_remove_footers",
  "delete_pages",
  "reorder_pages",
  "update_deck",
  "write_todo",
  "compose_deck",
  "commit_design",
];

/**
 * Records the accepted editor turn, or clears the record when the turn is not an editor edit.
 * Called where a new attempt starts, so a record from an earlier turn never authorises a later one.
 */
export function recordEditorTurn(projectRoot: string, accepted: { authorizationId: string } | undefined): void {
  const file = path.join(projectRoot, RECORD_REL);
  if (!accepted) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    version: 1,
    authorizationId: accepted.authorizationId,
    acceptedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** True when an accepted editor turn is recorded on the project, whether or not its lease is live. */
export function editorTurnRecorded(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, RECORD_REL));
}

/** True when an accepted editor turn exists but no active review lease authorises it now. */
export function editorTurnAuthorityLost(projectRoot: string): boolean {
  return editorTurnRecorded(projectRoot) && !readActiveReviewGuard(projectRoot);
}

/**
 * The refusal a write returns when its accepted editor turn lost authority while it waited for the
 * project write lock. It names no tool and changes nothing.
 */
export function editorAuthorityLostReceipt(name: string): ToolExecution {
  return {
    name,
    ok: false,
    summary: "编辑授权已失效",
    detail: EDITOR_AUTHORITY_LOST_DETAIL,
    payload: { error: "review_scope_violation", painted: false },
  };
}
