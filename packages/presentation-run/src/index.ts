export type {
  PresentationRun,
  PresentationCommand,
  CommandContext,
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
export type { GenerationActivity, GenerationActivityEvent, GenerationActivitySnapshot, GenerationActivityStage } from "./generation-activity.js";
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
export {
  resolvePlaywrightRuntime,
  runtimeFileReady,
  runtimeLayoutUsable,
  discoverMachinePlaywright,
  machineRuntimeReuse,
  materializeManagedRuntime,
  provisionManagedRuntime,
  playwrightRuntimeSource,
  defaultPlaywrightBrowsersDirs,
  defaultSlidesStateDir,
  managedPlaywrightRuntimeDir,
  managedPlaywrightRuntimeFile,
  codexPlaywrightRuntimeFile,
  PINNED_PLAYWRIGHT_VERSION,
  PINNED_CHROMIUM_REVISION,
} from "./domain/playwright-runtime.js";
export type {
  PlaywrightRuntimeRoots,
  PlaywrightRuntimeResolution,
  PlaywrightRuntimeSource,
  DiscoveredPlaywright,
  ProvisionOptions,
  ProvisionResult,
  RuntimeSourceOptions,
} from "./domain/playwright-runtime.js";
export {
  grokWebSearch,
  createGrokImageSearchPort,
  XAI_API_BASE as GROK_XAI_API_BASE,
} from "./domain/grok-hosted.js";
export {
  createImagePort,
  grokImageConfigFromEnv,
  imageConfigFromEnv,
  imageConfigured,
  GROK_IMAGINE_MODEL,
  IMAGE_GENERATE_PRESETS,
  type ImagePortConfig,
  type ImageGeneratePreset,
  type GeneratedImage,
} from "./domain/image-port.js";
export {
  createImageSearchPort,
  imageSearchConfigFromEnv,
  imageSearchConfigured,
  IMAGE_SEARCH_PRESETS,
  type ImageSearchPortConfig,
  type ImageSearchPreset,
  type ImageSearchPort,
  type ImageSearchHit,
  type ImageSearchNone,
} from "./domain/image-search-port.js";
export type { EndpointTemplate } from "./domain/endpoint-template.js";
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
export { isCloserPage, pageHasReadableCopy, pageHasVisibleContent, pageText, persistPageKey, persistPagePathFromId, pageIdMatchesFile, isLeftoverContentBasename, isPlaceholderReviewIssue, writePageSchemaIssues, writePageSchemaError, writePageColorIssues, isWritePageCloser, tableEmptyCellIssues, chartSlotWithoutExhibitIssues, composedPageLeftoverIssues, renderedLayoutBlocksCompose, isHostOpenedSeedPage, reusedFullBleedSrcIssue, REUSED_COVER_SRC_DETAIL, EMPTY_CLOSER_PRODUCE_NEXT, HOST_SEED_PRODUCE_NEXT } from "./domain/layout-qa.js";
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
  KIND_THEME_PACK_ERROR,
  MISSING_THEME_PACK_ERROR,
  PACK_COLOR_ERROR,
  parseThemePackId,
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
export { missingOperatingFactsReason, reportBriefNeedsFacts, NEED_DATA_REASON } from "./domain/report-facts.js";
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
  recordWebSearchExecuted,
  contextFromToolArgs,
  currentVisualReviewsMissing,
} from "./domain/run-ledger.js";
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
export { rebuildNodesFromImage, imageToDataUrl } from "./domain/image-rebuild.js";
export type { ImageRebuildConfig, RebuildNode } from "./domain/image-rebuild.js";
