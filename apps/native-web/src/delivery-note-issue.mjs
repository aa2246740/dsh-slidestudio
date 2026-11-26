/**
 * A durable agent fault recorded after the run already completed is a delivery
 * issue, not a failed deck: the pages are written and possibly sealed, only the
 * Agent's closing message is missing. This projection decides when the editor
 * shows the system delivery note instead of an error.
 */
import { record, text } from "./delivery-note-shared.mjs";

/** Waiting for quota resumes the run, so the run is paused, not delivered. */
const WAIT_RESUME_CODES = new Set(["provider-quota", "provider-token-plan", "provider-rate-limit"]);

/** Bounded guards stop a looping turn on purpose; the completed deck needs no note. */
const BOUNDED_GUARD_CODES = new Set([
  "tool-invalid-args-loop",
  "repeated-business-rejection",
  "planning-no-progress-budget",
  "production-no-progress-budget",
  "repeated-invalid-args",
]);

/** @typedef {{code: string, detail: string, sealed: boolean}} DeliveryIssue */

/**
 * @param {{activityPhase: string, fault?: unknown, inspection?: unknown}} input
 *   `fault` is `_agent/dsh-agent-error.json`; `inspection.composed` is the run
 *   ledger's sealed flag (presentation-run inspection).
 * @returns {DeliveryIssue | undefined}
 */
export function projectDeliveryIssue({ activityPhase, fault, inspection }) {
  if (activityPhase !== "complete") return undefined;
  const source = record(fault);
  const code = text(source.code);
  const detail = text(source.detail);
  if (!code || !detail || source.recovering === true) return undefined;
  if (WAIT_RESUME_CODES.has(code) || BOUNDED_GUARD_CODES.has(code)) return undefined;
  return { code, detail, sealed: record(inspection).composed === true };
}
