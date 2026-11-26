/**
 * Deterministic hashing helpers shared by the run ledger and its fact
 * recorders. Extracted from run-ledger.ts so fact-recording modules can reuse
 * them without growing that file past its module budget.
 */
import crypto from "node:crypto";
import { ownPageBody, type Page } from "@open-slidestudio/pptd-v2";

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function stableValue(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stableValue);
  const rec = asRecord(raw);
  if (!rec) return raw;
  return Object.fromEntries(
    Object.keys(rec)
      .sort()
      .map((key) => [key, stableValue(rec[key])]),
  );
}

export function stableSha256(raw: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(raw) ?? null))
    .digest("hex");
}

export function bytesSha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Revision identity of a page: its own body and id. Master and layout copies and an inherited
 * background are left out, so a layout edit does not make every using page a new revision.
 * Pages without layouts hash exactly as before.
 */
export function pageRevisionSha256(page: unknown, id: string): string {
  const rec = asRecord(page) ?? {};
  const own = Array.isArray(rec.elements) ? ownPageBody(rec as unknown as Page) : (rec as Record<string, unknown>);
  return stableSha256({ ...own, id });
}
