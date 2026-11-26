/**
 * Who may write a master or layout right now. A generation run (no lock) may define any of them.
 * An editor turn started from layout mode holds a lock that grants one layout (editableMeta
 * "layouts"); it may write only that layout, and only with the hash it read. Every other editor
 * turn is a page edit and may not write a layout.
 */
import type { LayoutScope } from "./layout-ledger.js";
import { EDITOR_AUTHORITY_LOST_DETAIL, editorTurnRecorded } from "./editor-turn-authority.js";
import { readActiveReviewGuard } from "./review-write-scope.js";

export type LayoutScopeRefusal = { error: "layout_scope_refused"; detail: string };

/** The layout the active lock grants for layout editing, or undefined when it grants none. */
export function layoutEditGrant(projectRoot: string): { layoutId: string; layoutName: string } | undefined {
  const scope = readActiveReviewGuard(projectRoot)?.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return undefined;
  const fields = scope as Record<string, unknown>;
  const editable: unknown = fields.editableMeta;
  if (!Array.isArray(editable) || !editable.includes("layouts")) return undefined;
  const layoutId = typeof fields.layoutId === "string" ? fields.layoutId : "";
  const layoutName = typeof fields.layoutName === "string" && fields.layoutName ? fields.layoutName : layoutId;
  return { layoutId, layoutName };
}

function refusal(detail: string): LayoutScopeRefusal {
  return { error: "layout_scope_refused", detail };
}

/** The refusal for a write_layout the active lock does not grant, or undefined when it may proceed. */
export function layoutWriteRefusal(
  projectRoot: string,
  scope: LayoutScope,
  id: string,
  expectedSha: string | undefined,
): LayoutScopeRefusal | undefined {
  if (!readActiveReviewGuard(projectRoot)) {
    // Without a live lease, only a turn that never was an editor edit may define layouts. An
    // accepted editor turn whose lease lapsed is refused instead of falling through to generation.
    return editorTurnRecorded(projectRoot) ? refusal(EDITOR_AUTHORITY_LOST_DETAIL) : undefined;
  }
  const grant = layoutEditGrant(projectRoot);
  if (!grant) {
    return refusal("当前是页面修改，不能修改版式。如需修改版式，请在「编辑版式」里打开该版式后再试。");
  }
  if (scope !== "layout" || id !== grant.layoutId) {
    return refusal(`本轮只能修改版式『${grant.layoutName}』，请在「编辑版式」里打开它后再试。`);
  }
  if (expectedSha === undefined) {
    return refusal(`修改版式『${grant.layoutName}』需要带上 expectedLayoutSha256（读到的当前版本哈希）。`);
  }
  return undefined;
}
