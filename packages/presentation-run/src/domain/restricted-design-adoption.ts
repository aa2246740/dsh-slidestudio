/**
 * A page or element edit lock does not authorize the deck theme or the project's style authority.
 * commit_design / write_todo must therefore refuse an adoption that would move either one while
 * such a lock is live, before any theme, receipt or runtime write: the Host's post-turn check
 * restores the deck but keeps runtime.json, which would leave the authority and the theme apart.
 */
import type { CommandReceipt } from "../types.js";
import { adoptionThemeEffect } from "./design-adoption.js";
import { designAuthorityDecision, type PlanningDesignAuthority } from "./design-authority.js";
import type { DesignAspects } from "./design-aspects.js";
import { readActiveReviewGuard } from "./review-write-scope.js";

const REFUSAL_DETAIL =
  "本轮只授权修改所选的页面或元素，不能更换整套文稿的配色、字体或风格依据。请在整套文稿层面重新发起后再试。";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * True when a live lock is page or element level and names no theme grant. A comment lock or
 * comment batch never covers the theme; a workspace lock does when it is deck level or lists
 * "theme" in editableMeta. The Host's post-turn verification stays the stricter backstop.
 */
export function themeGrantAbsent(projectRoot: string): boolean {
  const guard = readActiveReviewGuard(projectRoot);
  if (!guard) return false;
  const items = Array.isArray(guard.items) ? guard.items : [];
  if (guard.commentId || items.some((item) => record(item)?.commentId)) return true;
  const scope = record(guard.scope);
  if (Array.isArray(scope?.editableMeta) && scope.editableMeta.includes("theme")) return false;
  return scope?.kind !== "deck";
}

export function restrictedDesignAdoptionRefusal(
  name: string,
  projectRoot: string,
  input: Readonly<{
    adopted: readonly string[];
    designAspects: DesignAspects;
    planned: Pick<PlanningDesignAuthority, "authority" | "existing">;
  }>,
): CommandReceipt | undefined {
  if (!themeGrantAbsent(projectRoot)) return undefined;
  const { authority, existing } = input.planned;
  const authorityChanges = authority !== undefined && designAuthorityDecision(authority, existing) !== existing;
  const theme = adoptionThemeEffect(projectRoot, input.adopted, input.designAspects);
  if (!authorityChanges && !theme.changes) return undefined;
  return {
    ok: false,
    name,
    summary: "design adoption outside edit scope",
    detail: REFUSAL_DETAIL,
    payload: { error: "review_scope_violation", painted: false },
  };
}
