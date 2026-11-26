/**
 * How a write_page outcome reads to the model. Split out of tools.ts, which is at its line budget;
 * the functions are moved verbatim.
 */
import type { WritePageOutcome } from "./outcome.js";

function layoutIssueLabel(issue: unknown): string {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return String(issue);
  const rec = issue as Record<string, unknown>;
  return String(rec.code ?? rec.kind ?? rec.detail ?? "unknown-layout-issue");
}

export function formatWritePageOutcome(value: unknown): string {
  const rec = value as WritePageOutcome;
  const feedback = [
    ...(rec.normalized ?? []).map((move) => `normalized: ${move}`),
    ...(rec.warnings ?? []).map((warning) => `warning: ${warning}`),
    ...(rec.hint && rec.outcome !== "written" ? [`hint: ${rec.hint}`] : []),
  ];
  const feedbackSuffix = feedback.length ? ` ${feedback.join(" ")}` : "";
  if (rec.outcome === "skipped-identical") {
    const status = rec.layoutStatus ?? "unavailable";
    const base =
      `page already current; do not create another file. pageId=${rec.pageId} ` +
      `revision=${rec.revision} deterministicLayoutStatus=${status}`;
    if (status === "pass") {
      return `${base}. Deterministic browser QA passed; this does not claim a visual-review pass.${feedbackSuffix}`;
    }
    const issues = (rec.layoutIssues ?? []).map(layoutIssueLabel).filter(Boolean).join(", ");
    const evidence = issues ? ` issues=${issues}` : rec.renderNote ? ` note=${rec.renderNote}` : "";
    const next =
      status === "fail"
        ? "Rewrite this page to resolve the listed layout issues, then call render_page again."
        : "Retry render_page when the pinned editor raster is available; do not compose yet.";
    return `${base}.${evidence} ${next}${feedbackSuffix}`;
  }
  if (rec.outcome === "revise-requires-change") {
    return `revise requires a different body for ${rec.pageId} revision ${rec.revision}${feedbackSuffix}`;
  }
  return JSON.stringify(value);
}
