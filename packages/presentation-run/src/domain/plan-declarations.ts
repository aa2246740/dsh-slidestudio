/**
 * Validate the planning metadata a `commit_design` / `write_todo` call carries.
 *
 * The command seam resolves all three declarations before it records anything,
 * so a rejected aspect, colour or requirement leaves no half-written plan. The
 * style pack id passed here is the *effective* authority, never the stale Hub
 * binding, so a decision that replaced the pack is honoured before this check.
 */
import { resolvePlanningDesignAspects, type DesignAspects } from "./design-aspects.js";
import { resolvePlanningReportRequirements } from "./report-authority.js";
import type { ReportRequirement } from "./report-requirements.js";
import { resolvePlanningUserColors, type UserColor } from "./user-colors.js";
import type { CommandReceipt } from "../types.js";

/** A style-authority refusal keeps its stable code for the UI and transcript. */
export function designAuthorityRefusal(
  name: string,
  issue: Readonly<{ code: string; detail: string; questionId?: string }>,
): CommandReceipt {
  return {
    ok: false,
    name,
    summary: "design authority rejected",
    detail: issue.detail,
    payload: {
      error: issue.code,
      ...(issue.questionId ? { questionId: issue.questionId, next: "ask_user_question" } : {}),
      painted: false,
    },
  };
}

export type PlanDeclarations = Readonly<{
  designAspects: DesignAspects;
  userColors: readonly UserColor[];
  reportRequirements: readonly ReportRequirement[];
}>;

export type PlanDeclarationsResult =
  ({ readonly ok: true } & PlanDeclarations) | { readonly ok: false; readonly detail: string };

function detailOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function resolvePlanDeclarations(input: {
  projectRoot: string;
  args: Record<string, unknown>;
  adoptedSourceIds: readonly string[];
  /** The effective catalog pack; "" means the current authority grants no catalog pack. */
  stylePackId: string;
}): PlanDeclarationsResult {
  let designAspects: DesignAspects;
  try {
    designAspects = resolvePlanningDesignAspects(
      input.projectRoot,
      input.adoptedSourceIds,
      input.args,
      input.stylePackId,
    );
  } catch (error) {
    return { ok: false, detail: detailOf(error, "设计用途校验失败，请重新声明") };
  }
  let userColors: readonly UserColor[];
  try {
    userColors = resolvePlanningUserColors(input.projectRoot, input.args);
  } catch (error) {
    return { ok: false, detail: detailOf(error, "userColors 校验失败，请重新声明") };
  }
  try {
    const reportRequirements = resolvePlanningReportRequirements(input.projectRoot, input.args);
    return { ok: true, designAspects, userColors, reportRequirements };
  } catch (error) {
    return { ok: false, detail: detailOf(error, "reportRequirements 校验失败，请重新声明") };
  }
}
