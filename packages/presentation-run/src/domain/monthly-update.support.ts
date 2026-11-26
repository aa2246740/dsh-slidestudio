import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DELIVERY_PROVENANCE_REL } from "./delivery-provenance.js";
import { runDomainHand } from "./domain-hands.js";
import { recordStructuralReview } from "./run-ledger.js";

const CONTEXT = { commandId: "monthly", contextEpochId: "monthly-epoch" };

type PeriodMismatch = { page: string; source: string[]; sourcePages: number[] } | null;

function call(root: string, name: string, args: Record<string, unknown>, commandId = name) {
  return runDomainHand(name, { ...args, __openSlideStudio: { ...CONTEXT, commandId } }, root);
}

export async function composedMismatches(root: string): Promise<(PeriodMismatch | undefined)[]> {
  recordStructuralReview(root, true, []);
  const composed = await call(root, "compose_deck", { title: "九月月报" });
  assert.equal(composed.ok, true, composed.detail);
  const file = JSON.parse(fs.readFileSync(path.join(root, DELIVERY_PROVENANCE_REL), "utf8")) as {
    pages: { detected: { periodMismatch: PeriodMismatch } | null }[];
  };
  return file.pages.map((entry) => entry.detected?.periodMismatch);
}
