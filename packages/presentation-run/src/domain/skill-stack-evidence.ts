/**
 * Skill-stack evidence: whether the OpenKimi skill ran as agent tools, read from the run's events
 * and hands log. Split out of domain-hands.ts to keep that module under its budget; moved verbatim.
 */
import fs from "node:fs";
import path from "node:path";

export type SkillStackEvidence = {
  ok: boolean;
  outline: boolean;
  pageWrites: number;
  renderPages: number;
  renderCoverage: boolean;
  visualOrReview: boolean;
  review: boolean;
  compose: boolean;
  oneShotDump: boolean;
  reason: string;
};

export const HANDS_LOG_REL = path.join("_agent", "hands-log.jsonl");

export function appendHandsLog(root: string, row: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.appendFileSync(path.join(root, HANDS_LOG_REL), `${JSON.stringify(row)}\n`, "utf8");
}

/** `--skill` flags vs produce tools that actually executed. */
export function skillsExecutionMode(timed: Array<{ event: string }>): "agent-tools" | "flags-only" {
  const ran = timed.some((e) =>
    /^(tool:think|tool:list_references|tool:read_reference|tool:write_todo|tool:write_page|tool:render_page|tool:review_page|tool:review_pages|tool:compose_deck)/.test(
      e.event,
    ),
  );
  return ran ? "agent-tools" : "flags-only";
}

export function skillStackEvidence(timed: Array<{ event: string }>): SkillStackEvidence {
  const names = timed.map((e) => e.event);
  const outline = names.some((e) => e === "tool:write_todo" || e.startsWith("tool:write_todo:"));
  const pageWrites = names.filter((e) => e === "tool:write_page" || e.startsWith("tool:write_page:")).length;
  const renderPages = names.filter((e) => e === "tool:render_page" || e.startsWith("tool:render_page:")).length;
  const renderCoverage = pageWrites >= 2 && renderPages >= pageWrites;
  const visualOrReview = names.some(
    (e) =>
      e === "tool:render_page" ||
      e.startsWith("tool:render_page:") ||
      e === "tool:review_pages" ||
      e.startsWith("tool:review_pages:"),
  );
  const review = names.some((e) => e === "tool:review_pages" || e.startsWith("tool:review_pages:"));
  const compose = names.some((e) => e === "tool:compose_deck" || e.startsWith("tool:compose_deck:"));
  const oneShotDump = names.some((e) => e === "tool:write:skill-deck.json") && pageWrites === 0 && !outline;
  const ok = outline && pageWrites >= 2 && visualOrReview && review && compose && !oneShotDump;
  const missing: string[] = [];
  if (!outline) missing.push("write_todo");
  if (pageWrites < 2) missing.push(`write_page×${pageWrites} (need ≥2)`);
  if (!visualOrReview) missing.push("render_page|review_pages");
  if (!review) missing.push("review_pages");
  if (!compose) missing.push("compose_deck");
  if (oneShotDump) missing.push("one-shot skill-deck.json dump");
  return {
    ok,
    outline,
    pageWrites,
    renderPages,
    renderCoverage,
    visualOrReview,
    review,
    compose,
    oneShotDump,
    reason: ok ? "OpenKimi stack ran as agent tools" : `skills did not run as agent tools: ${missing.join(", ")}`,
  };
}
