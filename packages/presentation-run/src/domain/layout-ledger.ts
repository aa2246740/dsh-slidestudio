/**
 * Layout revision facts. Each committed master or layout appends one `layout.revision-committed`
 * fact, written by the agent (write_layout) or by the editor. Compose requires one per layout a
 * page uses; the host can never be the author (masters-layouts architecture §3.20).
 */
import { appendFact, factId, nowIso, readRunLedger, type RunLedgerV1, type RunToolContext } from "./run-ledger.js";

export type LayoutScope = "master" | "layout";

export type LayoutRevisionFact = Readonly<{
  type: "layout.revision-committed";
  factId: string;
  at: string;
  contextEpochId: string;
  scope: LayoutScope;
  layoutId: string;
  revision: number;
  layoutSha256: string;
  source: "agent" | "editor";
}>;

function layoutKey(scope: LayoutScope, layoutId: string): string {
  return `${scope}/${layoutId}`;
}

export function latestLayoutFacts(ledger: RunLedgerV1): Map<string, LayoutRevisionFact> {
  const layouts = new Map<string, LayoutRevisionFact>();
  for (const fact of ledger.facts) {
    if (fact.type === "layout.revision-committed") {
      layouts.set(layoutKey(fact.scope, fact.layoutId), fact);
    }
  }
  return layouts;
}

/** The latest committed revision of one master or layout, or undefined before its first commit. */
export function currentLayoutRevision(
  root: string,
  scope: LayoutScope,
  layoutId: string,
): LayoutRevisionFact | undefined {
  const ledger = readRunLedger(root);
  if (!ledger) return undefined;
  return latestLayoutFacts(ledger).get(layoutKey(scope, layoutId));
}

/** Appends the next revision of a changed layout. An unchanged sha keeps the current fact. */
export function recordLayoutRevision(
  root: string,
  context: RunToolContext,
  input: { scope: LayoutScope; layoutId: string; layoutSha256: string; source: "agent" | "editor" },
): LayoutRevisionFact {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const current = latestLayoutFacts(ledger).get(layoutKey(input.scope, input.layoutId));
  if (current?.layoutSha256 === input.layoutSha256) return current;
  const payload = {
    contextEpochId: context.contextEpochId,
    scope: input.scope,
    layoutId: input.layoutId,
    revision: (current?.revision ?? 0) + 1,
    layoutSha256: input.layoutSha256,
    source: input.source,
  };
  const fact: LayoutRevisionFact = {
    type: "layout.revision-committed",
    factId: factId("layout.revision-committed", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}
