/**
 * Chooses the reference layout of a run ledger. New ledgers use the sectioned
 * v2 layout when the pinned pptd.md is present; an existing ledger keeps the
 * layout it was created with, so v1 ledgers on disk keep their whole-file
 * requirements and their original requirementsId.
 */
import {
  listOpenKimiSourceRequirements,
  type ResolveSourceRequirementsInput,
  type SourceRequirement,
  type VerifiedOpenKimiPack,
} from "./openkimi-source-pack.js";
import {
  OPENKIMI_SECTIONED_REFERENCE_LAYOUT,
  listSectionedSourceRequirements,
  requirementFileSha256,
  sectionedReferenceAvailable,
} from "./openkimi-pptd-sections.js";
import { stableSha256, type ReferenceRequirement, type RunLedgerV1 } from "./run-ledger.js";

export type LedgerReferenceLayout = typeof OPENKIMI_SECTIONED_REFERENCE_LAYOUT | undefined;

export type LedgerReferenceRequirements = Readonly<{
  requirements: readonly ReferenceRequirement[];
  requirementsId: string;
  referenceLayout?: typeof OPENKIMI_SECTIONED_REFERENCE_LAYOUT;
}>;

function toLedgerRequirement(pack: VerifiedOpenKimiPack, requirement: SourceRequirement): ReferenceRequirement {
  const fileSha256 = requirementFileSha256(pack, requirement.sourceId);
  if (!fileSha256) throw new Error(`OpenKimi requirement is missing: ${requirement.sourceId}`);
  return {
    sourceId: requirement.sourceId,
    fileSha256,
    chunkIndexes: requirement.requiredChunkIndexes,
    reason: requirement.kind === "categories" ? "category-guide" : requirement.kind,
  };
}

/** The layout a ledger must use: the existing one's, else v2 when available. */
export function ledgerReferenceLayout(
  pack: VerifiedOpenKimiPack,
  existing: RunLedgerV1 | undefined,
): LedgerReferenceLayout {
  if (existing) return existing.sourcePack.referenceLayout;
  return sectionedReferenceAvailable(pack) ? OPENKIMI_SECTIONED_REFERENCE_LAYOUT : undefined;
}

export function resolveLedgerReferenceRequirements(
  pack: VerifiedOpenKimiPack,
  input: ResolveSourceRequirementsInput,
  layout: LedgerReferenceLayout,
): LedgerReferenceRequirements {
  if (layout !== OPENKIMI_SECTIONED_REFERENCE_LAYOUT) {
    const requirements = listOpenKimiSourceRequirements(pack, input).map((row) => toLedgerRequirement(pack, row));
    // Byte-identical to the pre-v2 id so existing v1 ledgers stay compatible.
    return { requirements, requirementsId: stableSha256({ requirements }) };
  }
  const requirements = listSectionedSourceRequirements(pack, input).map((row) => toLedgerRequirement(pack, row));
  return {
    requirements,
    requirementsId: stableSha256({ requirements, referenceLayout: layout }),
    referenceLayout: layout,
  };
}
