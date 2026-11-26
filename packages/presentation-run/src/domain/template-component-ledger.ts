/**
 * `template.component-used` facts: one per component the Host expanded into a page or a layout.
 * Page use carries the page id and revision; layout use carries the layout id, the layout's
 * revision and an empty page id. The Host writes these only after the write itself succeeded, so a
 * fact is never a promise. The delivery provenance lists a use only for the revision it was sealed with.
 */
import { appendFact, factId, nowIso, readRunLedger, type RunLedgerV1 } from "./run-ledger.js";

export type TemplateComponentUsedFact = Readonly<{
  type: "template.component-used";
  factId: string;
  at: string;
  contextEpochId: string;
  pageId: string;
  revision: number;
  ref: string;
  kitSha256: string;
  layoutId?: string;
}>;

export type TemplateComponentUse = Readonly<{
  contextEpochId: string;
  ref: string;
  kitSha256: string;
  pageId?: string;
  revision?: number;
  layoutId?: string;
}>;

export function templateComponentFacts(ledger: RunLedgerV1): TemplateComponentUsedFact[] {
  return ledger.facts.filter((fact): fact is TemplateComponentUsedFact => fact.type === "template.component-used");
}

/** Appends the fact for one expanded component; an identical use in one revision is recorded once. */
export function recordTemplateComponentUsed(
  root: string,
  use: TemplateComponentUse,
): TemplateComponentUsedFact | undefined {
  if (!readRunLedger(root)) return undefined;
  const payload = {
    contextEpochId: use.contextEpochId,
    pageId: use.pageId ?? "",
    revision: use.revision ?? 0,
    ref: use.ref,
    kitSha256: use.kitSha256,
    ...(use.layoutId ? { layoutId: use.layoutId } : {}),
  };
  const fact: TemplateComponentUsedFact = {
    type: "template.component-used",
    factId: factId("template.component-used", payload),
    at: nowIso(),
    ...payload,
  };
  appendFact(root, fact);
  return fact;
}
