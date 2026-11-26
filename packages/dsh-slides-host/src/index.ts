export { name, inject, Config, apply } from "./plugin.js";
export type { SlidesHostConfig } from "./plugin.js";
export {
  SLICE_TOOL_NAMES,
  type DesignDirective,
  type SliceSessionSnapshot,
  type WritePageOutcome,
  type SliceRuntimePayload,
} from "./protocol.js";
export { decideWritePage } from "./write-page.js";
export {
  inspectHubProduceGates,
  assertHubProduceGatesReady,
  emptyWriteIsRejectedByLoadedHost,
  emptyCreateHasNoSeedFromLoadedPptd,
  StaleProduceGatesError,
} from "./produce-gates.js";
export { writeSliceRuntime, readSliceRuntimeFile } from "./runtime.js";
export { acquireProjectLease, releaseProjectLease } from "./lease.js";
export { SliceSessionStore, slugTitle, deckTitleFromBrief, displayDeckTitle } from "./slice-session.js";
export { commandHash } from "./receipts.js";
export { SLIDES_DIRECTOR_PERSONA } from "@open-slidestudio/slides-tools";
export {
  NATIVE_WEB_FORBID_SENTENCE,
  serializeProduceRequestHeader,
  patchProduceAssembly,
} from "./produce-request-header.js";
export {
  DSH_ATTACHMENTS_UNAVAILABLE,
  DshLlmPort,
  toDshGenerateOptions,
  type DshAttachmentService,
  type DshBlockEndPayload,
  type DshGenerateOptions,
  type DshGenerateOptionsLike,
  type DshLlmPortOptions,
  type DshLlmService,
  type DshRequestMessage,
  type DshRequestMessageLike,
  type DshStreamChunk,
} from "./dsh-llm-port.js";
export { DSH_REPLAY_STATE_DIAGNOSTIC, readDshReplayState } from "./dsh-llm-stream.js";
