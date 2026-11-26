import type { DesignDirective } from "@open-slidestudio/slides-tools";

export type {
  DesignDirective,
  SliceRuntimePayload,
  WritePageDecision,
  WritePageOutcome,
} from "@open-slidestudio/slides-tools";

export const SLICE_TOOL_NAMES = [
  "open_project",
  "inspect_capabilities",
  "list_references",
  "read_reference",
  "list_materials",
  "read_material",
  "view_material",
  "record_material_notes",
  "query_material",
  "commit_design",
  "write_todo",
  "read_page",
  "edit_elements",
  "edit_page_background",
  "batch_remove_footers",
  "delete_pages",
  "reorder_pages",
  "update_deck",
  "write_page",
  "write_layout",
  "render_page",
  "review_page",
  "review_pages",
  "compose_deck",
  "export_deck",
  "web_search",
  "search_image",
  "generate_image",
] as const;

export type SliceToolName = (typeof SLICE_TOOL_NAMES)[number];

export type SliceSessionBinding = {
  readonly version: 1;
  readonly dshSessionId: string;
  readonly projectRoot: string;
  readonly design: DesignDirective;
  readonly provider: { readonly providerId: string; readonly modelId: string };
  readonly createdAt: string;
};

export type ProjectSummary = {
  readonly title: string;
  readonly pageCount: number;
  readonly deckSha256: string;
};

export type PageEvidence = {
  readonly pageId: string;
  readonly revision: number;
  readonly pageSha256: string;
  readonly rasterSha256: string;
  readonly rasterUrl: string;
  readonly reviewVerdict: "pass" | "revise" | "missing";
  readonly layoutStatus: "pass" | "fail" | "unavailable";
};

export type SliceError = {
  readonly code: string;
  readonly detail: string;
  readonly attemptId?: string;
  readonly recovering?: boolean;
};

export type SlicePhase =
  | { readonly kind: "awaiting-project" }
  | { readonly kind: "generating"; readonly lastTool: string }
  | { readonly kind: "page-ready"; readonly cover: PageEvidence }
  | { readonly kind: "complete"; readonly cover: PageEvidence; readonly pageCount: number }
  | { readonly kind: "paused"; readonly detail: string }
  | { readonly kind: "failed"; readonly error: SliceError };

export type RateLimitWait = {
  readonly attempt: number;
  readonly waitMs: number;
  readonly nextRetryAt: number;
  readonly code: string;
};

export type SliceSessionSnapshot = {
  readonly binding: SliceSessionBinding;
  readonly project: ProjectSummary;
  readonly phase: SlicePhase;
  readonly rateLimitWait?: RateLimitWait;
};
