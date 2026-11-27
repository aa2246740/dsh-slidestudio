/**
 * Model-switch continuity for reference reads (sectioned v2 ledgers only).
 *
 * A provider/model switch mints a new context epoch, and every epoch-scoped
 * receipt stops counting. For a project whose plan is already committed that
 * forced the new model to re-read every baseline document before it could
 * finish the remaining pages. This policy carries the baseline requirement
 * reads that were verified in the previous epoch into the new one as explicit
 * `reference.epoch-carried` facts. It never carries on-demand pptd.md sections
 * (a chart page still needs the chart section read by the current model), and
 * it never applies to v1 ledgers, whose accounting stays unchanged.
 */
import { resolveRepoRoot } from "../catalog.js";
import { verifyOpenKimiPack, type VerifiedOpenKimiPack } from "./openkimi-source-pack.js";
import {
  OPENKIMI_SECTIONED_REFERENCE_LAYOUT,
  PPTD_ON_DEMAND_GROUP_IDS,
  parseSectionSourceId,
  sectionGroup,
  type PptdOnDemandGroupId,
} from "./openkimi-pptd-sections.js";
import { isReferenceReadFact, type ReferenceEpochCarriedFact } from "./reference-facts.js";
import { factId, mutateLedger, nowIso, readRunLedger, type RunLedgerV1, type TodoFact } from "./run-ledger.js";

export type ReferenceContinuityReason =
  "eligible" | "no-ledger" | "legacy-v1-ledger" | "same-epoch" | "no-committed-plan" | "no-verified-prior-reads";

type ChunkIdentity = Readonly<{ sourceId: string; fileSha256: string; chunkIndex: number; chunkSha256: string }>;

export type ReferenceContinuityPlan = Readonly<{
  eligible: boolean;
  reason: ReferenceContinuityReason;
  fromEpochId: string;
  toEpochId: string;
  /** Baseline requirement chunks verified in the previous epoch; carried when applied. */
  carry: readonly ChunkIdentity[];
  /** Baseline requirement chunks the new model still has to read itself. */
  stillRequired: readonly { sourceId: string; chunkIndex: number }[];
  /** On-demand pptd.md sections; never carried, gated per page by write_page. */
  onDemandSections: readonly PptdOnDemandGroupId[];
  /** Planned pages without a committed revision: the work the new model still owns. */
  unfinishedPageIds: readonly string[];
}>;

export type ReferenceContinuityInput = Readonly<{
  fromEpochId: string;
  toEpochId: string;
  repoRoot?: string;
}>;

function currentChunkSha256(pack: VerifiedOpenKimiPack, sourceId: string, chunkIndex: number): string | undefined {
  const groupId = parseSectionSourceId(sourceId);
  if (groupId) return sectionGroup(pack, groupId).chunks[chunkIndex]?.sha256;
  return pack.entriesById.get(sourceId)?.chunks[chunkIndex]?.sha256;
}

function latestTodo(ledger: RunLedgerV1): TodoFact | undefined {
  return [...ledger.facts].reverse().find((fact): fact is TodoFact => fact.type === "todo.committed");
}

function unfinishedPages(ledger: RunLedgerV1, todo: TodoFact): string[] {
  const planned = todo.pagePlan?.map((page) => page.pageId) ?? todo.pageIds ?? [];
  const written = new Set(
    ledger.facts.flatMap((fact) => (fact.type === "page.revision-committed" ? [fact.pageId] : [])),
  );
  return planned.filter((pageId) => !written.has(pageId));
}

function verifiedPriorReads(
  ledger: RunLedgerV1,
  pack: VerifiedOpenKimiPack,
  fromEpochId: string,
): { carry: ChunkIdentity[]; stillRequired: { sourceId: string; chunkIndex: number }[] } {
  const carry: ChunkIdentity[] = [];
  const stillRequired: { sourceId: string; chunkIndex: number }[] = [];
  for (const requirement of ledger.sourcePack.requirements) {
    for (const chunkIndex of requirement.chunkIndexes) {
      const chunkSha256 = currentChunkSha256(pack, requirement.sourceId, chunkIndex);
      const read = ledger.facts.some(
        (fact) =>
          isReferenceReadFact(fact) &&
          fact.contextEpochId === fromEpochId &&
          fact.sourceId === requirement.sourceId &&
          fact.fileSha256 === requirement.fileSha256 &&
          fact.chunkIndex === chunkIndex &&
          fact.chunkSha256 === chunkSha256,
      );
      if (read && chunkSha256) {
        carry.push({ sourceId: requirement.sourceId, fileSha256: requirement.fileSha256, chunkIndex, chunkSha256 });
      } else stillRequired.push({ sourceId: requirement.sourceId, chunkIndex });
    }
  }
  return { carry, stillRequired };
}

function ineligible(
  reason: ReferenceContinuityReason,
  input: ReferenceContinuityInput,
  rest: Partial<ReferenceContinuityPlan> = {},
): ReferenceContinuityPlan {
  return {
    eligible: false,
    reason,
    fromEpochId: input.fromEpochId,
    toEpochId: input.toEpochId,
    carry: [],
    stillRequired: [],
    onDemandSections: [],
    unfinishedPageIds: [],
    ...rest,
  };
}

/** Decide, without writing, what a model switch from `fromEpochId` to `toEpochId` may carry. */
export function planModelSwitchContinuity(root: string, input: ReferenceContinuityInput): ReferenceContinuityPlan {
  const ledger = readRunLedger(root);
  if (!ledger) return ineligible("no-ledger", input);
  if (ledger.sourcePack.referenceLayout !== OPENKIMI_SECTIONED_REFERENCE_LAYOUT) {
    return ineligible("legacy-v1-ledger", input);
  }
  if (!input.fromEpochId || input.fromEpochId === input.toEpochId) return ineligible("same-epoch", input);
  const todo = latestTodo(ledger);
  if (!todo) return ineligible("no-committed-plan", input);
  const pack = verifyOpenKimiPack(input.repoRoot ?? resolveRepoRoot());
  const { carry, stillRequired } = verifiedPriorReads(ledger, pack, input.fromEpochId);
  const rest = {
    carry,
    stillRequired,
    onDemandSections: PPTD_ON_DEMAND_GROUP_IDS,
    unfinishedPageIds: unfinishedPages(ledger, todo),
  };
  if (!carry.length) return ineligible("no-verified-prior-reads", input, rest);
  return { eligible: true, reason: "eligible", fromEpochId: input.fromEpochId, toEpochId: input.toEpochId, ...rest };
}

/** Apply {@link planModelSwitchContinuity}: append one carried fact per verified chunk (idempotent). */
export function applyModelSwitchContinuity(root: string, input: ReferenceContinuityInput): ReferenceContinuityPlan {
  const plan = planModelSwitchContinuity(root, input);
  if (!plan.eligible) return plan;
  mutateLedger(root, (current) => {
    const known = new Set(current.facts.map((fact) => fact.factId));
    const at = nowIso();
    const carried: ReferenceEpochCarriedFact[] = plan.carry.flatMap((chunk) => {
      const payload = {
        ...chunk,
        contextEpochId: plan.toEpochId,
        fromEpochId: plan.fromEpochId,
        reason: "model-switch" as const,
      };
      const id = factId("reference.epoch-carried", payload);
      return known.has(id) ? [] : [{ type: "reference.epoch-carried" as const, factId: id, at, ...payload }];
    });
    return carried.length ? { ...current, updatedAt: at, facts: [...current.facts, ...carried] } : current;
  });
  return plan;
}
