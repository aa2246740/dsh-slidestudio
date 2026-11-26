export type CapabilityFate = "preserved" | "dsh-native" | "adapted" | "dev-only";

export type CapabilityLedgerRow = {
  readonly id: string;
  readonly owner: "presentation-run" | "dsh-slides-host" | "dsh" | "agent-harness-fixture";
  readonly fate: CapabilityFate;
  readonly notes: string;
};

/**
 * Existing generate capabilities mapped before any production export is deleted.
 * Silent drops are forbidden.
 */
export const CAPABILITY_LEDGER: readonly CapabilityLedgerRow[] = [
  {
    id: "open_project",
    owner: "dsh-slides-host",
    fate: "adapted",
    notes: "DSH session binds a PPTD project",
  },
  {
    id: "inspect_capabilities",
    owner: "presentation-run",
    fate: "preserved",
    notes: "Replaces Host capability card injection",
  },
  {
    id: "list_references",
    owner: "presentation-run",
    fate: "adapted",
    notes: "Exact required/missing chunks first, followed by the full 76-file catalog",
  },
  {
    id: "read_reference",
    owner: "presentation-run",
    fate: "adapted",
    notes: "Exact OpenKimi chunk; no HandsPort",
  },
  {
    id: "list_materials",
    owner: "presentation-run",
    fate: "preserved",
    notes:
      "Uploaded material summaries; PPT templates list design/layouts/slides/tables/charts with UTF-8 sizes and chunk counts, plus smartart and kit (reusable decoration components) only when present; images list palette; PDFs list document and palette with their rendered page-image count",
  },
  {
    id: "read_material",
    owner: "presentation-run",
    fate: "preserved",
    notes:
      "Receipt-backed material chunks: PPT template slide text, tables, charts, SmartArt trees and the kit component list (material:ID#COMPONENT references); document chunks and bounded table windows; image and PDF palette part (measured colours); sha256 per chunk",
  },
  {
    id: "view_material",
    owner: "presentation-run",
    fate: "adapted",
    notes:
      "Normalized JPEG via attachments.saveImage; shapes: image, all-images numbered mosaic, PDF page, PDF page mosaic, template photo; advertised only when the selected model accepts image input (vision.modelAcceptsImages), independent of the raster runtime",
  },
  {
    id: "record_material_notes",
    owner: "presentation-run",
    fate: "adapted",
    notes:
      "Vision-only: the model's per-image conclusions (caption, suggestedUse, fontClass table) stored in _agent/material-notes.v1.json with a material.notes-recorded fact; viewed images with notes may later be replaced by their caption",
  },
  {
    id: "query_material",
    owner: "presentation-run",
    fate: "adapted",
    notes:
      "Read-only deterministic query over a CSV/XLSX material: filter, group, sum/count/avg/min/max, share/yoy/mom/ratio/diff/unit over named columns; no expressions; each call returns rows with a receipt (material and result hashes, row counts) and records a material.query-computed fact; page numbers that equal a result cell are traced in pages[].queries",
  },
  {
    id: "view_design_reference",
    owner: "presentation-run",
    fate: "dev-only",
    notes: "Removed: Pi-era design-preview ceremony; the DSH flow reads design chunks via read_reference",
  },
  {
    id: "commit_design",
    owner: "presentation-run",
    fate: "adapted",
    notes:
      "Agent plan + per-source designAspects and adopted receipts; current-epoch design/palette/content/data read gates; palette/font seeding only for declared aspects (image and Freestyle PDF palettes fill accent slots); Agent-declared userColors only widen pack_color, never the theme; no host preset id",
  },
  {
    id: "write_todo",
    owner: "presentation-run",
    fate: "adapted",
    notes:
      "Plan commit; notInPlan and explicit-count hints; refuse kind/theme pack disagreement; items[].materials and materialUse record where each uploaded image goes (ids checked, never assigned by the Host); periodMap records the monthly period change and missingItems the template charts or tables without new data (each item resolved against a template part read in the current epoch, then recorded as a ledger fact)",
  },
  {
    id: "write_page",
    owner: "presentation-run",
    fate: "preserved",
    notes:
      "PPTD v2 write; chart evidence gate; skip identical; refuse kind/theme pack disagreement; optional provenance declaration + material-figure period hints recorded in the ledger, never blocking; template component references expanded by the Host (template.component-used fact), never creating a page",
  },
  {
    id: "write_layout",
    owner: "presentation-run",
    fate: "preserved",
    notes:
      "Deck master or page layout as a whole replacement; skip identical; refuse kind/theme pack disagreement and off-palette colour once per layout; layout-level QA reported with the write; layout.revision-committed fact; template component references expanded by the Host (template.component-used fact with layoutId)",
  },
  {
    id: "render_page",
    owner: "presentation-run",
    fate: "preserved",
    notes: "Native #slide raster",
  },
  {
    id: "review_page",
    owner: "presentation-run",
    fate: "preserved",
    notes: "Current-revision visual verdict",
  },
  {
    id: "review_pages",
    owner: "presentation-run",
    fate: "preserved",
    notes: "Disk structural / layout review plus missing/extra latest-plan issues",
  },
  {
    id: "delete_pages",
    owner: "presentation-run",
    fate: "adapted",
    notes: "Generation removes only this run's unchanged orphan pages; editor needs explicit scope",
  },
  {
    id: "render_deck",
    owner: "presentation-run",
    fate: "dev-only",
    notes: "Removed: Pi-era deck montage ceremony; review_pages is the deck gate",
  },
  {
    id: "review_deck",
    owner: "presentation-run",
    fate: "dev-only",
    notes: "Removed: Pi-era nine-axis taste review; review_pages is the deck gate",
  },
  {
    id: "compose_deck",
    owner: "presentation-run",
    fate: "preserved",
    notes: "Compose gate; refuse kind/theme pack disagreement; no host paint",
  },
  { id: "export_deck", owner: "presentation-run", fate: "preserved", notes: "Hybrid native PPTX" },
  { id: "think", owner: "dsh", fate: "dsh-native", notes: "DSH agent loop / persona" },
  { id: "plan", owner: "dsh", fate: "dsh-native", notes: "DSH goal/plan rows remain in kernel" },
  { id: "research", owner: "dsh", fate: "dsh-native", notes: "DSH web seam when configured" },
  {
    id: "web_search",
    owner: "presentation-run",
    fate: "preserved",
    notes: "Grok hosted xAI web_search; advertised only when pi-xai is ready",
  },
  {
    id: "search_image",
    owner: "presentation-run",
    fate: "preserved",
    notes: "Optional; advertised only when configured (env port or pi-xai-hosted)",
  },
  {
    id: "generate_image",
    owner: "presentation-run",
    fate: "preserved",
    notes: "Optional; advertised only when configured",
  },
  {
    id: "createPiBrain",
    owner: "agent-harness-fixture",
    fate: "dev-only",
    notes: "Not on the product generate path",
  },
  {
    id: "resolvePlaybookCategory",
    owner: "agent-harness-fixture",
    fate: "dev-only",
    notes: "Removed from Hub/DSH generate",
  },
  {
    id: "resolveGenerateDesign",
    owner: "agent-harness-fixture",
    fate: "dev-only",
    notes: "Removed from Hub/DSH generate",
  },
  {
    id: "host-produce",
    owner: "agent-harness-fixture",
    fate: "dev-only",
    notes: "Must not appear in production graph",
  },
];

export function ledgerFate(id: string): CapabilityLedgerRow | undefined {
  return CAPABILITY_LEDGER.find((row) => row.id === id);
}
