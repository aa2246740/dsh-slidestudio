import type { GenerationActivity } from "./generation-activity.js";
import type { RunLedgerInspection } from "./domain/run-ledger.js";

export type RunId = string;

export type DesignDirective =
  | { readonly kind: "self-directed" }
  | { readonly kind: "explicit-style"; readonly designSystemId: string };

export type OpenRunInput = {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly brief: string;
  readonly editorBaseUrl: string;
  readonly design: DesignDirective;
  readonly provider: { readonly providerId: string; readonly modelId: string };
};

export type RunHandle = {
  readonly runId: RunId;
  readonly sessionId: string;
  readonly projectRoot: string;
};

export type CommandContext = {
  readonly runId: RunId;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly projectRoot: string;
  readonly abortSignal: AbortSignal;
};

export type PresentationCommand = {
  readonly name: string;
  readonly args: Record<string, unknown>;
};

export type CommandReceipt = {
  readonly ok: boolean;
  readonly name: string;
  readonly summary: string;
  readonly detail: string;
  readonly payload: Record<string, unknown>;
};

export type SourceReceiptState = "available" | "consulted" | "adopted" | "executed";

export type SourceReceipt = {
  readonly sourceId: string;
  readonly state: SourceReceiptState;
  readonly toolCallId?: string;
  readonly pageId?: string;
};

export type RunInspection = {
  readonly runId: RunId;
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly brief: string;
  readonly design: DesignDirective;
  readonly provider: { readonly providerId: string; readonly modelId: string };
  readonly pageCount: number;
  readonly title: string;
  /** Manifest page order as pageIds — ledger.pages is revision order instead. */
  readonly pageOrder: readonly string[];
  readonly hostDirected: false;
  readonly categoryId: undefined;
  readonly designSystemId: string | undefined;
  readonly receipts: readonly SourceReceipt[];
  readonly catalog: { readonly sourceFiles: number; readonly visualFiles: number };
  readonly capabilities: CapabilitySnapshot;
  readonly composed: boolean;
  readonly exported: boolean;
  readonly visualReviewMissing: boolean;
  /** Durable run-ledger inspection for the editor's read-only generation history. */
  readonly ledger: RunLedgerInspection;
  readonly pages: RunLedgerInspection["pages"];
  readonly structuralReview: RunLedgerInspection["structuralReview"];
  readonly composeReady: boolean;
  readonly composeBlockers: readonly string[];
  readonly activity: GenerationActivity;
  readonly execution?: ExecutionProjection;
};

export type ExecutionStatusKind =
  | "planning"
  | "authoring"
  | "reviewing"
  | "ready-to-compose"
  | "ready-to-export"
  | "exporting"
  | "paused"
  | "failed"
  | "blocked"
  | "delivered";

export type ExecutionBlocker = Readonly<{
  code: string;
  detail: string;
  pageIds: readonly string[];
  next: string | null;
}>;

export type ExecutionPlanKind = "missing" | "legacy-incomplete" | "complete";

export type ExecutionPlanPage = Readonly<{
  pageId: string;
  title: string;
  layoutFamily: string;
  exhibits: readonly string[];
  purpose?: string;
}>;

export type ExecutionPlan = Readonly<{
  kind: ExecutionPlanKind;
  pages?: readonly ExecutionPlanPage[];
}>;

export type ExecutionRecoveryKind = "none" | "wait-or-stop" | "continue" | "resolve";

export type ExecutionRecovery = Readonly<{
  kind: ExecutionRecoveryKind;
  reason?: string;
}>;

export type ExecutionModel = Readonly<{
  provider: string;
  model: string;
  reasoningEffort?: string;
}>;

export type ExecutionDelivery = Readonly<{
  artifactPath: string;
  artifactSha256: string;
  artifactBytes: number;
  reportPath: string;
  reportSha256: string;
  slideCount: number;
  inputFingerprint: string;
}>;

export type ExecutionStatus = Readonly<{
  kind: ExecutionStatusKind;
  delivery?: ExecutionDelivery;
}>;

export type ExecutionProjection = Readonly<{
  status: ExecutionStatus;
  blockers: readonly ExecutionBlocker[];
  next: string | null;
  plan: ExecutionPlan;
  recovery: ExecutionRecovery;
  attemptId: string | null;
  model: ExecutionModel;
  delivery?: ExecutionDelivery;
}>;

/** Hub chips and produce inspect_capabilities share this object. */
export type CapabilityVia = "env" | "pi-xai-hosted" | "native";

export type CapabilityFlag = {
  readonly configured: boolean;
  readonly via: CapabilityVia;
};

export type VisionMode = "none" | "main-model" | "reviewer";

export type ModelInputModality = "text" | "image";

export type CapabilitySnapshot = {
  readonly research: CapabilityFlag;
  readonly imageSearch: CapabilityFlag;
  readonly imageGenerate: CapabilityFlag;
  readonly vision: {
    readonly mode: VisionMode;
    readonly via: CapabilityVia;
    readonly modelAcceptsImages?: boolean;
    readonly unavailableReason?: "disabled" | "provider-unavailable" | "model-input-unsupported" | "raster-unavailable";
  };
  readonly runtime: { readonly kind: "dsh" };
  /** Alias of research.configured for older produce gates. */
  readonly web: boolean;
  readonly render: boolean;
  readonly exportPptx: boolean;
  readonly note: string;
};

export type InspectCapabilitiesInput = {
  readonly env?: NodeJS.ProcessEnv;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly ready?: boolean;
  /** Exact provider/model metadata. Absent means unknown; an explicit omission is negative. */
  readonly modelInputModalities?: readonly ModelInputModality[];
  /** Override the Playwright probe. Default: editor URL + runnable pinned runtime. */
  readonly rasterReady?: boolean;
  /**
   * The signed-in route carries a provider-native search plan (DSH.app
   * dsh-oauth native-tools: model first, DSH function tools stripped).
   * Host mounts no competing web_search executor for these routes.
   */
  readonly nativeSearch?: boolean;
};

export type PresentationRun = {
  open(input: OpenRunInput): Promise<RunHandle>;
  execute(command: PresentationCommand, context: CommandContext): Promise<CommandReceipt>;
  inspect(runId: RunId): Promise<RunInspection>;
  hydrate(projectRoot: string): RunHandle | undefined;
  epochFor(sessionId: string): string;
};
