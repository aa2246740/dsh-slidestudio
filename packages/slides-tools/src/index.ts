/**
 * @open-slidestudio/slides-tools — the host-agnostic slide tool contract
 * consumed by the DSH Hub run, the MCP server and the core agent loop.
 * This package must never depend on a host SDK.
 */
export * from "./contract.js";
export * from "./schema-dsl.js";
export * from "./project-lease.js";
export {
  capabilitiesFor,
  defineSlideTool,
  leaseRefusal,
  present,
  result,
  sessionKeyOf,
  slideTool,
  toJsonRecord,
  validateArgs,
  withRuntimeGates,
  type OpenedSlideProject,
  type SlideProjectPort,
  type SlideSchemaValidator,
  type SlideToolRuntimeDeps,
  type SlideToolSpec,
} from "./tool-kit.js";
export {
  createSlideTools,
  listCanonicalSlideTools,
  slideToolSchemaBytes,
  slideToolSetSchemaBytes,
  toolSchemasSnapshot,
  type CreateSlideToolsOptions,
  type SlideToolSchemaEntry,
} from "./suite.js";
export * from "./tool-names.js";
export { SLIDES_DIRECTOR_PERSONA, SLIDES_DIRECTOR_PERSONA_LINES } from "./persona.js";
export {
  briefForDirectorSession,
  directorBrief,
  pagesHintForBrief,
  type DirectorBriefOptions,
} from "./director-brief.js";
export { initialDeckMessage, turnTextWithAttachments } from "./turn-message.js";
export { editorUrlFor } from "./tools-project.js";
export { WEB_SEARCH_DESCRIPTION } from "./tools-research.js";
export { WRITE_PAGE_DESCRIPTION, patchPageElementsTool } from "./tools-write.js";
export {
  PATCH_PAGE_ELEMENTS_DESCRIPTION,
  PATCH_PAGE_ELEMENTS_SCHEMA,
  PATCH_PAGE_ELEMENTS_TOOL_NAME,
  pagePatchIssues,
  preparePagePatch,
  type PageElementPatch,
  type PatchPageElementsArgs,
  type PreparedPagePatch,
} from "./page-patch.js";
export { DESIGN_CONTRACT_KIND, designContractCard, type DesignContractCard } from "./design-contract.js";
export { autoRenderWriteOutcome, replayOrRun } from "./write-page-execute.js";
export { pageRasterContent } from "./tools-visual.js";
export { aiReviewPageVersionConflict, readPageFromProject } from "./read-page.js";
export { formatWritePageOutcome } from "./write-page-outcome-format.js";
export { commandHash, lookupToolReceipt, recordToolReceipt } from "./receipts.js";
export { yamlExistsForPage } from "./page-files.js";
export * from "./produce-edit-scope.js";
export { activeElementEditScope, prepareElementEdit, type PreparedElementEdit } from "./edit-elements.js";
export { briefForOpenProject, readSliceRuntimeFile, writeSliceRuntime } from "./runtime.js";
export type { DesignDirective, SliceRuntimePayload, WritePageDecision, WritePageOutcome } from "./outcome.js";
export { renderPageToolContent, shouldAttachPageRaster, pageRasterModelContent } from "./page-raster-content.js";
export { VISION_ONLY_TOOL_NAMES, visionUnavailableDetail } from "./vision-tools.js";
export { materialAcceptsImageInput } from "./material-tools.js";
export {
  applyTraceTruthGuard,
  guardAssistantMessageTruth,
  readLedgerTruth,
  TRUTH_GUARD_MARKER,
} from "./trace-truth-guard.js";
export { toolResultMessage } from "./tool-result-message.js";
export { TOOL_INVALID_ARGS_WARNING_PREFIX, invalidArgsStreakWarning } from "./tool-argument-feedback.js";
export {
  attachmentsStoreDir,
  materializeSessionAttachments,
  MaterialVerificationError,
  prepareSessionMaterials,
  readMaterialsManifest,
  verifySessionMaterials,
  writeSessionMaterials,
  type MaterialsManifest,
  type PreparedMaterial,
} from "./material-store.js";
export type { EditorAttachment, MaterialKind, MaterialPart, GenerationFormat } from "./material-input.js";
export {
  ImageCodecUnavailableError,
  isImageCodecUnavailable,
  loadImageCodec,
  setImageCodecLoader,
} from "./image-codec.js";
export { composeImageOverview, overviewGrid, IMAGE_OVERVIEW_SCHEMA } from "./image-overview.js";
export { PLAN_DESIGN_PARAMETERS, localizePlanArgIssues } from "./design-aspects-parameter.js";
export { writePageSerial, reviewPageGate, writePageGate, type ExclusiveSessionGate } from "./write-page-serial.js";
export {
  addCapabilityTools,
  applyProduceStagePolicy,
  applyProjectEditScopes,
  layoutStageActive,
  MATERIAL_SLIDE_TOOL_NAMES,
  projectHasMaterials,
  SCOPED_SLIDE_TOOL_NAMES,
  toolRefusalMessage,
  type ProduceStagePolicy,
} from "./tool-allowlist.js";
