/**
 * Which canonical tools a project's current state legally exposes. Hosts start
 * from their capability-filtered set and apply these editor/review scopes so
 * every host offers the same write surfaces for the same project state.
 */
import { loadProject } from "@open-slidestudio/pptd-v2";
import {
  editorTurnAuthorityLost,
  editorTurnRecorded,
  LAPSED_EDITOR_WRITE_TOOLS,
  layoutEditGrant,
  readActiveReviewGuard,
  readCommittedPagePlan,
  readRunLedger,
  reviewWriteTargets,
  type CapabilitySnapshot,
} from "@open-slidestudio/presentation-run";
import { activeElementEditScope } from "./edit-elements.js";
import { readMaterialsManifest } from "./material-store.js";
import { PATCH_PAGE_ELEMENTS_TOOL_NAME } from "./page-patch.js";
import { VISION_ONLY_TOOL_NAMES, visionUnavailableDetail } from "./vision-tools.js";
import { editableMetaScope, metaOnlyEditScope, rewriteEditScope, structuralEditScope } from "./produce-edit-scope.js";

/** Tools offered only when a capability or an edit scope enables them. */
export const SCOPED_SLIDE_TOOL_NAMES = [
  "edit_elements",
  "edit_page_background",
  "delete_pages",
  "reorder_pages",
  "update_deck",
  "review_page",
  "view_material",
  "record_material_notes",
  "search_image",
  "generate_image",
] as const;

const META_ONLY_WITHHELD = [
  "write_page",
  "patch_page_elements",
  "write_layout",
  "edit_elements",
  "edit_page_background",
  "batch_remove_footers",
  "delete_pages",
  "reorder_pages",
  "write_todo",
];

const LAYOUT_MODE_WITHHELD = [
  "write_page",
  "patch_page_elements",
  "edit_elements",
  "edit_page_background",
  "batch_remove_footers",
  "delete_pages",
  "reorder_pages",
  "write_todo",
];

/** Capability-gated additions: review needs the raster runtime; material viewing needs image input. */
export function addCapabilityTools(allowed: Set<string>, caps: CapabilitySnapshot): void {
  if (caps.vision.mode !== "none") allowed.add("review_page");
  if (caps.vision.modelAcceptsImages === true) {
    allowed.add("view_material");
    allowed.add("record_material_notes");
  }
  if (caps.imageSearch.configured) allowed.add("search_image");
  if (caps.imageGenerate.configured) allowed.add("generate_image");
}

function applyElementScope(allowed: Set<string>, projectRoot: string): void {
  if (!activeElementEditScope(projectRoot)) return;
  // Element review is an exact-subset operation. Expose one write surface so
  // the model cannot choose whole-page replacement as well.
  const targets = reviewWriteTargets(readActiveReviewGuard(projectRoot));
  if (targets.every(({ scope }) => scope.kind === "elements")) {
    allowed.delete("write_page");
    allowed.delete("patch_page_elements");
  }
  allowed.add("edit_elements");
}

function applyStructureScopes(allowed: Set<string>, projectRoot: string): void {
  const structural = structuralEditScope(projectRoot);
  const guard = readActiveReviewGuard(projectRoot);
  if (!structural && reviewWriteTargets(guard).some(({ scope }) => scope.kind !== "elements")) {
    allowed.add("edit_page_background");
  }
  // Generation cleanup is verified against the latest plan and this run's
  // writes by the domain; editor turns still need their explicit deletion lock.
  const rewrite = rewriteEditScope(projectRoot);
  const generation = !guard && !editorTurnRecorded(projectRoot) && Boolean(readRunLedger(projectRoot));
  if (structural?.deletablePageIds.size || rewrite || generation) allowed.add("delete_pages");
  if (structural?.reorderPageIds.length || rewrite) allowed.add("reorder_pages");
  if (editableMetaScope(projectRoot).size > 0 || rewrite) allowed.add("update_deck");
}

function applyWithholding(allowed: Set<string>, projectRoot: string): void {
  // A metaOnly lock grants deck fields and nothing else.
  if (metaOnlyEditScope(projectRoot)) for (const name of META_ONLY_WITHHELD) allowed.delete(name);
  // A layouts lock grants write_layout alone; any other lock is a page-scope turn without layouts.
  if (layoutEditGrant(projectRoot)) {
    for (const name of LAYOUT_MODE_WITHHELD) allowed.delete(name);
  } else if (readActiveReviewGuard(projectRoot)) {
    allowed.delete("write_layout");
  }
  // An accepted editor turn whose lease lapsed keeps its intent but no write surface.
  if (editorTurnAuthorityLost(projectRoot)) for (const name of LAPSED_EDITOR_WRITE_TOOLS) allowed.delete(name);
}

/** Tools that only read or annotate uploaded materials; useless when a project has none. */
export const MATERIAL_SLIDE_TOOL_NAMES = [
  "list_materials",
  "read_material",
  "query_material",
  "view_material",
  "record_material_notes",
] as const;

/**
 * Stage options for a produce (generation/edit) turn. Every field is optional;
 * an empty policy changes nothing except the layout/patch stage rules below.
 */
export type ProduceStagePolicy = {
  /**
   * Whether the project has uploaded materials. `false` drops the material
   * tools; `true` or omitted keeps them. `projectHasMaterials` reads it from disk.
   */
  readonly hasAttachments?: boolean;
  /** Force write_layout into the turn (for example a template whose layouts aspect is adopted). */
  readonly layouts?: boolean;
  /** Offer `patch_page_elements` whenever write_page is offered. Defaults to true. */
  readonly patchPageElements?: boolean;
};

/** True when the project's materials manifest lists at least one material. */
export function projectHasMaterials(projectRoot: string): boolean {
  return readMaterialsManifest(projectRoot).materials.length > 0;
}

/** Whether write_layout is part of this turn's work: layout mode, existing layouts, or a plan naming one. */
export function layoutStageActive(projectRoot: string | undefined, policy: ProduceStagePolicy = {}): boolean {
  if (policy.layouts === true) return true;
  if (!projectRoot) return false;
  if (layoutEditGrant(projectRoot)) return true;
  try {
    const { presentation } = loadProject(projectRoot);
    if (presentation.layouts?.length || presentation.masters?.length) return true;
  } catch {
    // An unreadable project has no layouts to maintain.
  }
  try {
    return readCommittedPagePlan(projectRoot).some((page) => Boolean(page.layoutId?.trim()));
  } catch {
    return false;
  }
}

/**
 * Slim a produce allowlist to the tools this stage can use (mutates `allowed`).
 * Apply after the edit scopes: write_layout leaves the turn unless the layout
 * stage is active, material tools leave when `hasAttachments === false`, and
 * `patch_page_elements` follows write_page so every lock that withholds
 * whole-page writes withholds patches too.
 */
export function applyProduceStagePolicy(
  allowed: Set<string>,
  projectRoot: string | undefined,
  policy: ProduceStagePolicy = {},
): Set<string> {
  if (!layoutStageActive(projectRoot, policy)) allowed.delete("write_layout");
  if (policy.hasAttachments === false) for (const name of MATERIAL_SLIDE_TOOL_NAMES) allowed.delete(name);
  if (policy.patchPageElements !== false && allowed.has("write_page")) allowed.add(PATCH_PAGE_ELEMENTS_TOOL_NAME);
  else allowed.delete(PATCH_PAGE_ELEMENTS_TOOL_NAME);
  return allowed;
}

/**
 * Apply the project's editor and review scopes to a capability-filtered
 * allowlist (mutates `allowed`). With `produce`, the stage policy runs last.
 */
export function applyProjectEditScopes(
  allowed: Set<string>,
  projectRoot: string,
  produce?: ProduceStagePolicy,
): Set<string> {
  applyElementScope(allowed, projectRoot);
  applyStructureScopes(allowed, projectRoot);
  applyWithholding(allowed, projectRoot);
  if (produce) applyProduceStagePolicy(allowed, projectRoot, produce);
  return allowed;
}

const WRITE_SURFACES = [
  "write_page",
  PATCH_PAGE_ELEMENTS_TOOL_NAME,
  "write_layout",
  "edit_elements",
  "edit_page_background",
  "delete_pages",
  "reorder_pages",
  "write_todo",
  "update_deck",
];

const LAYOUT_REFUSAL = "当前轮次不能修改版式。如需修改版式，请在「编辑版式」里打开该版式后再试。";

/**
 * Why a call outside `allowed` is refused, naming the write surfaces that are
 * available this turn so the model can self-correct. Undefined when allowed.
 */
export function toolRefusalMessage(name: string, allowed: ReadonlySet<string>): string | undefined {
  if (name.startsWith("_") || allowed.has(name)) return undefined;
  if (VISION_ONLY_TOOL_NAMES.has(name)) return `${visionUnavailableDetail(name)}（slides preset forbids ${name}）`;
  // A layout is changed only from layout mode; the refusal says where to go.
  if (name === "write_layout") return LAYOUT_REFUSAL;
  const alternatives = WRITE_SURFACES.filter((tool) => allowed.has(tool));
  return `slides preset forbids ${name}${
    alternatives.length ? `; the write tools available this turn: ${alternatives.join(", ")}` : ""
  }`;
}
