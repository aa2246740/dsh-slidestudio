/** Canonical write_page outcome and decision shapes (host-neutral, type-only). */
type WritePageRenderEvidence = {
  readonly layoutStatus?: "pass" | "fail" | "unavailable";
  readonly layoutIssues?: readonly unknown[];
  readonly renderNote?: string;
};

type WritePageFeedback = {
  readonly normalized?: readonly string[];
  readonly warnings?: readonly string[];
  /** Non-blocking Chinese provenance/period hint from the run ledger; never a gate. */
  readonly hint?: string;
};

export type WritePageOutcome =
  | ({
      readonly outcome: "written";
      readonly pageId: string;
      readonly revision: number;
      readonly pageSha256: string;
      readonly fontNotes?: readonly string[];
    } & WritePageRenderEvidence &
      WritePageFeedback)
  | ({
      readonly outcome: "skipped-identical";
      readonly pageId: string;
      readonly revision: number;
      readonly pageSha256: string;
    } & WritePageRenderEvidence &
      WritePageFeedback)
  | ({
      readonly outcome: "replayed";
      readonly pageId: string;
      readonly revision: number;
      readonly pageSha256: string;
    } & WritePageRenderEvidence &
      WritePageFeedback)
  | ({
      readonly outcome: "conflict";
      readonly toolCallId: string;
      readonly detail: string;
    } & WritePageFeedback)
  | ({
      readonly outcome: "revise-requires-change";
      readonly pageId: string;
      readonly revision: number;
      readonly pageSha256: string;
    } & WritePageFeedback)
  | ({
      readonly outcome: "rejected";
      readonly detail: string;
      readonly error?: string;
      readonly next?: string;
      readonly missingReferenceChunks?: readonly unknown[];
      readonly painted?: false;
    } & WritePageFeedback);

export type WritePageDecision =
  | { readonly action: "write"; readonly pageId: string; readonly pageSha256: string }
  | {
      readonly action: "skip";
      readonly outcome: Extract<WritePageOutcome, { outcome: "skipped-identical" }>;
    }
  | {
      readonly action: "reject";
      readonly outcome: Extract<WritePageOutcome, { outcome: "revise-requires-change" | "rejected" }>;
    };

export type DesignDirective =
  { readonly kind: "self-directed" } | { readonly kind: "explicit-style"; readonly designSystemId: string };

export type SliceRuntimePayload = {
  readonly brief: string;
  readonly design: DesignDirective;
  readonly editorBaseUrl: string;
  readonly strictExecution: true;
};
