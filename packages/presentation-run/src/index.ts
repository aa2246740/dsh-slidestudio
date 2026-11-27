export type {
  PresentationRun,
  PresentationCommand,
  CommandContext,
  CommandReceipt,
  WriteAuthorityRefusal,
  WriteAuthorityRunner,
  RunInspection,
  DesignDirective,
  ExecutionBlocker,
  ExecutionDelivery,
  ExecutionModel,
  ExecutionPlan,
  ExecutionPlanPage,
  ExecutionPlanKind,
  ExecutionProjection,
  ExecutionRecovery,
  ExecutionRecoveryKind,
  ExecutionStatus,
  ExecutionStatusKind,
} from "./types.js";
export { projectExecution, type ProjectExecutionInput } from "./execution.js";
export { inspectProjectExecution, type ProjectExecutionObservationInput } from "./execution-observation.js";
export { parseCanonicalPagePlan, TODO_EXHIBIT_KINDS, type CanonicalPlanPage } from "./domain/page-plan.js";
export {
  canonicalPageId,
  canonicalPagePath,
  validatePlanPageIds,
  resolveProjectPageIdentities,
  resolvePagePathForMutation,
  type ProjectIdentityResolution,
  type PlanPageValidation,
  type ResolveMutationPathResult,
} from "./domain/page-identity.js";
export type {
  GenerationActivity,
  GenerationActivityEvent,
  GenerationActivitySnapshot,
  GenerationActivityStage,
} from "./generation-activity.js";
export {
  generationActivityFromLedger,
  generationActivityEventsFromTraceRows,
  inspectGenerationActivity,
  inspectGenerationActivitySnapshot,
  readProduceTraceEvents,
} from "./generation-activity.js";
export { createPresentationRun, type PresentationRunDeps } from "./run.js";
export {
  loadReferenceCatalog,
  filterCatalog,
  resolveRepoRoot,
  buildCatalogDto,
  resolveCatalogPreviewFile,
  type CatalogDto,
  type CatalogFormat,
  type CatalogPreview,
  type CatalogStyle,
  EXPECTED_SOURCE_FILES,
  EXPECTED_VISUAL_FILES,
} from "./catalog.js";
export { assertChartEvidence } from "./chart-gate.js";
export {
  inspectCapabilities,
  inspectProjectCapabilities,
  projectBoundProvider,
  persistPresentationRunProvider,
  visualReviewIsClaimable,
  hostedProduceToolNames,
  GROK_PROVIDER_ID,
} from "./capabilities.js";
export type {
  CapabilitySnapshot,
  CapabilityFlag,
  CapabilityVia,
  InspectCapabilitiesInput,
  ModelInputModality,
  VisionMode,
} from "./types.js";
export {
  rasterRuntimeReady,
  pinnedPlaywrightRuntimePath,
  repoPlaywrightRuntimeFile,
  readPageRaster,
  savePageRaster,
  pageRasterRel,
} from "./domain/page-raster.js";
export { grokWebSearch, createGrokImageSearchPort, XAI_API_BASE as GROK_XAI_API_BASE } from "./domain/grok-hosted.js";
export {
  createImagePort,
  grokImageConfigFromEnv,
  imageConfigFromEnv,
  GROK_IMAGINE_MODEL,
} from "./domain/image-port.js";
export { CAPABILITY_LEDGER, ledgerFate } from "./capability-ledger.js";
export {
  listSourceReceipts,
  recordSourceReceipt,
  consultedAdoptedExecuted,
  requireConsultAdoptBeforeWrite,
} from "./receipts.js";
export { exportEditablePptx, readVerifiedDelivery } from "./export-deck.js";
export {
  backgroundColorWriteAuthority,
  type BackgroundColorWriteAuthority,
  type BackgroundColorWriteAuthorityInput,
} from "./domain/background-color-authority.js";
export {
  runDomainHand,
  writeDomainRuntime,
  initializeRunLedger,
  hasExplicitUserDesign,
} from "./domain/domain-hands.js";
export type { DomainRuntime } from "./domain/domain-hands.js";
export {
  parseSkillPage,
  countRawChartElements,
  normalizeChartInput,
  DROPPED_CHART_DETAIL,
  type SkillPageInput,
} from "./domain/skill-pages.js";
export {
  isCloserPage,
  pageHasReadableCopy,
  pageHasVisibleContent,
  pageText,
  persistPageKey,
  persistPagePathFromId,
  pageIdMatchesFile,
  isLeftoverContentBasename,
  isPlaceholderReviewIssue,
  writePageSchemaIssues,
  writePageSchemaError,
  writePageColorIssues,
  isWritePageCloser,
  tableEmptyCellIssues,
  requestedExhibitIssues,
  chartSlotWithoutExhibitIssues,
  composedPageLeftoverIssues,
  renderedLayoutBlocksCompose,
  isHostOpenedSeedPage,
  reusedFullBleedSrcIssue,
  REUSED_COVER_SRC_DETAIL,
  EMPTY_CLOSER_PRODUCE_NEXT,
  HOST_SEED_PRODUCE_NEXT,
} from "./domain/layout-qa.js";
export {
  PRODUCE_GATES_ID,
  PRODUCE_GATE_REL_FILES,
  inspectProduceGates,
  assertProduceGates,
  type ProduceGateReport,
  type ProduceGateApi,
} from "./produce-gates.js";
export {
  inferDeckIntent,
  briefWithoutNegatedDocTypes,
  classifyBriefKind,
  type BriefKind,
} from "./domain/compose-ir.js";
export {
  pageCountRequirementFromBrief,
  minimumPageCount,
  pageCountRequirementSummary,
  pageCountFits,
  pageCountPlanHint,
  pageCountDeliveryHint,
  type PageCountRequirement,
} from "./domain/page-count-requirement.js";
export {
  normalizeReportRequirements,
  planningReportRequirements,
  isEnforceableReportRequirement,
  materialPartDependency,
  perPageResponsibilityDependency,
  materialDependenciesForRequirements,
  checkReportMaterialDependencies,
  REPORT_REQUIREMENT_ROLES,
  REPORT_MATERIAL_DEPENDENCY_REASONS,
  type ReportRequirement,
  type ReportRequirementRole,
  type ReportRequirementOrigin,
  type ReportRequirementMaterial,
  type ReportMaterialDependency,
  type ReportMaterialDependencyReason,
  type ReportMaterialKind,
  type ReportMaterialDependencyCheck,
  type UnreadMaterialDependency,
  type UnreadableMaterialDependency,
} from "./domain/report-requirements.js";
export {
  CLARIFICATION_AUTHORITY_ERRORS,
  checkPlanningReportRequirements,
  clarificationAnswerCheck,
  persistPlanningAuthority,
  persistPlanningReportRequirements,
  readClarificationRecords,
  readRecordedReportRequirements,
  requirementAuthorityIssue,
  resolvePlanningReportRequirements,
  supersededClarificationIssue,
  type ClarificationAnswerCheck,
  type ClarificationAuthorityError,
  type ClarificationRecord,
  type PlanningReportRequirementCheck,
  type RequirementAuthorityIssue,
} from "./domain/report-authority.js";
export { designAuthorityRefusal, resolvePlanDeclarations } from "./domain/plan-declarations.js";
export {
  HUB_CHOICE_SOURCE,
  authorityCatalogPackId,
  designAuthorityDecision,
  designAuthorityMaterialId,
  designAuthoritySourceIssue,
  effectiveCatalogPackId,
  decidedCatalogPackIsExplicit,
  isHubChoiceAuthority,
  normalizeDesignAuthority,
  readDesignAuthority,
  readHubDesignSystemId,
  resolvePlanningDesignAuthority,
  resolvePlanningStyleAuthority,
  sameDesignAuthorityDecision,
  type DesignAuthority,
  type DesignAuthorityIssue,
  type DesignAuthorityOrigin,
  type DesignAuthorityReading,
  type DesignAuthoritySourceInput,
  type PlanningDesignAuthority,
  type PlanningStyleAuthority,
} from "./domain/design-authority.js";
export { conversationPageCount, conversationPageCountRequirement } from "./domain/conversation-requirements.js";
export {
  KIND_THEME_PACK_ERROR,
  MISSING_THEME_PACK_ERROR,
  PACK_COLOR_ERROR,
  parseThemePackId,
  canonicalDesignSourceId,
  canonicalizeAdoptedSourceIds,
  catalogPackPaletteHexes,
  chosenThemePacksFrom,
  kindThemePackDisagreement,
  kindThemePackIssue,
  requiredPackFamilies,
  sourceIdList,
  extractColorPaletteHexes,
  packColorWriteContext,
  packColorWriteContextFrom,
  type ChosenThemePack,
  type KindThemePackIssue,
  type PackColorWriteContext,
} from "./domain/theme-pack.js";
export * from "./index-ports.js";
export { packColorSourceIds, projectPackColorContext, runtimeDesignSystemId } from "./domain/pack-color-context.js";
export { missingOperatingFactsReason, reportBriefNeedsFacts, NEED_DATA_REASON } from "./domain/report-facts.js";
export { pageRevisionSha256 } from "./domain/hashing.js";
export {
  ensureRunLedger,
  stableSha256,
  readRunLedger,
  inspectRunLedger,
  currentPageRevision,
  recordPageRevision,
  authorizePageEdit,
  authorizePageEdits,
  recordTodo,
  readCommittedPagePlan,
  recordExportSucceeded,
  type ExportSucceededFact,
  recordMaterialChunk,
  materialChunksRead,
  type MaterialChunkFact,
  recordWebSearchExecuted,
  contextFromToolArgs,
  currentVisualReviewsMissing,
} from "./domain/run-ledger.js";
export {
  applyWritePageProvenance,
  applySkippedWritePageProvenance,
  detectMaterialFigures,
  extractPeriodLabels,
  extractStrongNumbers,
  materialFiguresHint,
  missingQuotedValues,
  pageTextForFigures,
  recordMaterialFiguresFact,
  recordPageProvenanceFact,
  sessionMaterialReadings,
  significantDigits,
  splitChunkPages,
  type MaterialFigureMatch,
  type MaterialFigureReading,
  type MaterialFiguresFact,
  type MaterialFiguresReport,
  type PageProvenanceFact,
  type PageRevisionRef,
} from "./domain/material-figures.js";
export {
  buildDeliveryProvenance,
  writeDeliveryProvenance,
  DELIVERY_PROVENANCE_REL,
  PROVENANCE_SUMMARY_MAX_BYTES,
  type DeliveryProvenance,
  type DeliveryMaterialProvenance,
  type DeliveryPageDetection,
  type DeliveryPageProvenance,
} from "./domain/delivery-provenance.js";
export {
  conflictLines,
  numberConflictLine,
  styleConflictLines,
  type DeliveryConflict,
  type DeliveryNumberConflict,
  type DeliveryStyleConflict,
  type PageNumberConflict,
} from "./domain/delivery-conflicts.js";
export { recordPageConflictsFact, type PageConflictsFact } from "./domain/page-conflicts.js";
export {
  MaterialPackError,
  MATERIAL_CHUNK_BYTES,
  MATERIAL_TABLE_MAX_ROWS,
  MATERIAL_MAX_ORIGINAL_BYTES,
  MATERIAL_MAX_LOGO_BYTES,
  readMaterialsManifest,
  verifyMaterial,
  packageBytesOf,
  verifiedMaterialImage,
  materialCapabilityEntries,
  type MaterialChunk,
  type MaterialReadResult,
  type MaterialKind,
  type MaterialManifestEntry,
  type MaterialCapabilityEntry,
  type VerifiedMaterial,
} from "./domain/material-pack.js";
export {
  ALL_IMAGES_ID,
  OVERVIEW_MAX_TILES,
  OVERVIEW_PDF_MAX_PAGES,
  type OverviewPlan,
  type OverviewTile,
} from "./domain/material-overview.js";
export {
  FONT_CLASS_FONTS,
  MATERIAL_NOTE_USES,
  readMaterialNotes,
  type FontClass,
  type MaterialNotes,
  type StoredMaterialNotes,
} from "./domain/material-notes.js";
export type { MaterialNotesFact, MaterialOverviewFact } from "./domain/material-view-facts.js";
export {
  MATERIAL_QUERY_LIMITS,
  queryMaterialTable,
  runMaterialQuery,
  type ExecutedQuery,
  type MaterialQueryResult,
} from "./domain/material-query.js";
export { DERIVE_OPS, FILTER_OPS, MEASURE_OPS } from "./domain/material-query-schema.js";
export {
  QUERY_RESULTS_REL,
  readQueryResult,
  type MaterialQueryFact,
  type PageComputedFiguresFact,
  type StoredQueryResult,
} from "./domain/material-query-ledger.js";
export type { QueryableMaterial } from "./domain/material-table.js";
export { parsePeriodMap, type PeriodMap, type PeriodMapFact } from "./domain/period-map.js";
export { parseUserColors, readUserColors, type UserColor } from "./domain/user-colors.js";
export {
  MISSING_ITEM_SUFFIX,
  parseMissingItemRequests,
  type MissingItem,
  type MissingItemsFact,
} from "./domain/missing-items.js";
export { currentAdoptedSourceSelection } from "./domain/design-adoption.js";
export { adoptedTemplateFontPolicy, type TemplateFontPolicy } from "./domain/template-font-policy.js";
export {
  readMaterialChunk,
  materialChunkCount,
  materialPartText,
  tableWindow,
  defaultTablePart,
  parseDelimitedText,
  type MaterialRenderOptions,
} from "./domain/material-content.js";
export {
  templateMaterialPartDescriptorsFromData,
  type TemplateMaterialPart,
  type TemplateMaterialPartDescriptorInput,
} from "./domain/material-template-text.js";
export { PDF_TABLES_PART, pdfTablesPartText } from "./domain/material-pdf-tables.js";
export {
  hasOfficeCharts,
  OFFICE_CHARTS_PART,
  officeChartsPartText,
  officeChartsSupported,
} from "./domain/material-office-charts.js";
export {
  docxStyleHintDetail,
  docxStyleHints,
  isDocxMaterial,
  materialStyleHints,
  nonAdoptableMaterialMessage,
  pdfStyleHintDetail,
  pdfStyleHints,
  styleHintDetail,
} from "./domain/material-style-hints.js";
export {
  PALETTE_PART,
  paletteMaterialPart,
  withPaletteParts,
  type PaletteMaterial,
  type PaletteMaterialPart,
} from "./domain/palette-source.js";
export {
  EMPTY_HOSTED_WEB_SEARCH,
  MISSING_HOSTED_WEB_SEARCH_RECEIPT,
  USER_BRIEF_QUERY_MAX_CHARS,
  briefNeedsLiveWebSearch,
  grok46WouldCallWebSearch,
  hostedResearchNeedsWebSearchReceipt,
  hostedWebSearchHasEvidence,
  ledgerHasSuccessfulWebSearch,
  liveWebSearchQueryForBrief,
  queriesFromUserBrief,
  toolSchemaHasQueriesArray,
  webSearchQueriesFromArgs,
} from "./domain/hosted-web-search.js";
export type { GrokFacingTool, HostedWebSearchCall } from "./domain/hosted-web-search.js";

export { readActiveReviewGuard, reviewWriteTargets, reviewWriteTargetForPage } from "./domain/review-write-scope.js";
export { layoutEditGrant } from "./domain/layout-edit-scope.js";
export { recordLayoutRevision } from "./domain/layout-ledger.js";
export {
  editorTurnAuthorityLost,
  editorTurnRecorded,
  LAPSED_EDITOR_WRITE_TOOLS,
  recordEditorTurn,
} from "./domain/editor-turn-authority.js";
export { currentLayoutRevision } from "./domain/layout-ledger.js";
export { savedLayoutSha256 } from "./domain/layout-saved.js";
export {
  componentAspects,
  hasValidTemplateKit,
  loadTemplateKit,
  parseComponentRef,
  type KitAsset,
  type KitComponent,
  type LoadedTemplateKit,
} from "./domain/template-kit.js";
export {
  resolveTemplateComponent,
  type ComponentRefusal,
  type ComponentUse,
  type ResolvedComponent,
} from "./domain/template-component-gates.js";
export {
  expandTemplateComponent,
  type ComponentTarget,
  type ExpandedElement,
} from "./domain/template-component-expand.js";
export {
  applySmartArtTexts,
  planSmartArtTexts,
  type SmartArtTextsPlan,
  type SmartArtTextsVerdict,
} from "./domain/template-smartart-texts.js";
export { recordTemplateComponentUsed } from "./domain/template-component-ledger.js";
export { rebuildNodesFromImage, imageToDataUrl } from "./domain/image-rebuild.js";
export type { ImageRebuildConfig, RebuildNode } from "./domain/image-rebuild.js";
export { listMedia, mediaExists, mediaId, saveMediaFile } from "./domain/media-store.js";
export * from "./reference-budget.js";
