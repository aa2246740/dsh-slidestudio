/**
 * Public surface of the reference context-budget work: the sectioned v2
 * source manifest, on-demand section gating, delivery-confirmed accounting,
 * model-switch continuity, design-system selection cards and capped
 * rejection details. Re-exported from the package index.
 */
export {
  OPENKIMI_SECTIONED_MANIFEST_VERSION,
  OPENKIMI_SECTIONED_REFERENCE_LAYOUT,
  PINNED_PPTD_SHA256,
  PPTD_ON_DEMAND_GROUP_IDS,
  PPTD_SECTION_GROUP_IDS,
  PPTD_SOURCE_ID,
  SECTION_SOURCE_SEPARATOR,
  createOpenKimiSectionedManifest,
  createSectionedPptdFile,
  isSectionSourceId,
  listSectionedSourceRequirements,
  parseMarkdownSections,
  parseSectionSourceId,
  readOpenKimiSectionChunk,
  requirementFileSha256,
  sectionChunkRefs,
  sectionGroup,
  sectionSourceId,
  sectionedPptd,
  sectionedReferenceAvailable,
  type MarkdownSection,
  type OpenKimiSectionedFile,
  type OpenKimiSectionedManifest,
  type PptdOnDemandGroupId,
  type PptdSectionGroup,
  type PptdSectionGroupId,
  type SectionChunk,
} from "./domain/openkimi-pptd-sections.js";
export {
  ledgerReferenceLayout,
  resolveLedgerReferenceRequirements,
  type LedgerReferenceLayout,
  type LedgerReferenceRequirements,
} from "./domain/reference-layout.js";
export {
  REFERENCE_SECTION_UNREAD_ERROR,
  missingSectionChunks,
  pageReferenceSectionGroups,
  writePageReferencePreflight,
  type MissingReferenceSection,
  type ReferenceSectionRefusal,
} from "./domain/reference-section-gate.js";
export {
  REFERENCE_DELIVERY_ENV,
  REFERENCE_DELIVERY_FLAG_ENV,
  recordReferenceDelivered,
  recordReferenceDeliveredByCommandId,
  recordReferencePrepared,
  referenceDeliveryConfirmationEnabled,
  referenceDeliveryToken,
  type ReferenceChunkIdentity,
  type ReferenceDeliveryOptions,
  type ReferenceDeliveryResult,
} from "./domain/reference-delivery.js";
export {
  isReferenceReadFact,
  type ReferenceChunkPreparedFact,
  type ReferenceEpochCarriedFact,
} from "./domain/reference-facts.js";
export {
  applyModelSwitchContinuity,
  planModelSwitchContinuity,
  type ReferenceContinuityInput,
  type ReferenceContinuityPlan,
  type ReferenceContinuityReason,
} from "./domain/reference-continuity.js";
export type { PersistProviderOptions } from "./capabilities.js";
export {
  buildDesignSystemCards,
  buildDesignSystemDirectory,
  canonicalDesignSystemId,
  designSystemSelectionRows,
  loadDesignSystemCards,
  type DesignSystemCard,
} from "./design-system-cards.js";
export { LIST_REFERENCES_HINT } from "./list-references.js";
export {
  REJECTION_DETAIL_MAX_CHARS,
  WRITE_PAGE_DETAIL_MAX_CHARS,
  capRejectionDetail,
  cappedIssueDetail,
  compactPackColorDetail,
  rankAllowedColors,
} from "./domain/rejection-detail.js";
export { readReferenceResult } from "./domain/reference-hands.js";
