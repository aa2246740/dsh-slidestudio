/** Canonical slide tool names in registration order (no runtime imports; safe for any bundle). */
export const CANONICAL_SLIDE_TOOL_NAMES = [
  "open_project",
  "inspect_capabilities",
  "list_references",
  "read_reference",
  "list_materials",
  "read_material",
  "query_material",
  "view_material",
  "record_material_notes",
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
  "web_search",
  "search_image",
  "generate_image",
  "export_deck",
  "open_in_editor",
] as const;

export type CanonicalSlideToolName = (typeof CANONICAL_SLIDE_TOOL_NAMES)[number];

/**
 * Tools outside the frozen canonical contract. `createSlideTools` builds them
 * only when a host opts in through `include`, so existing hosts see no change.
 */
export const OPT_IN_SLIDE_TOOL_NAMES = ["patch_page_elements"] as const;

export type OptInSlideToolName = (typeof OPT_IN_SLIDE_TOOL_NAMES)[number];

/** Tools that never take the project writer lease. */
export const READ_ONLY_SLIDE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "inspect_capabilities",
  "list_references",
  "read_reference",
  "list_materials",
  "read_material",
  "query_material",
  "view_material",
  "read_page",
  "open_in_editor",
]);
