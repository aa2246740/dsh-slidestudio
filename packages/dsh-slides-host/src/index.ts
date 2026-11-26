export { name, inject, Config, apply, DSH_THIN_SHELL_SERVICES } from "./plugin.js";
export type { SlidesHostConfig, SlidesHostServices } from "./plugin.js";
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
  CONVERSATION_INTERACTION_TEXT,
  excludedToolsFor,
  sessionProduceToolAllowlist,
} from "./produce-tool-policy.js";
export { resolveUserDshHome } from "./dsh-home.js";
export { SessionRuntimeManager, type TurnAction } from "./session-runtime-manager.js";
export { RuntimeStreamBridge } from "./runtime-stream-bridge.js";
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
