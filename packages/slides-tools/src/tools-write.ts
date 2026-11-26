/** Whole-page and element-subset writes: `write_page` and `edit_elements`. */
import {
  SLIDE_FONTS,
  canonicalEditElementsIssues,
  canonicalWritePageIssues,
  editElementsJsonSchema,
  normalizeWritePageDialect,
  normalizeWritePageLineArrows,
  writePageProviderJsonSchema,
  type CanonicalEditElementsArgs,
} from "@open-slidestudio/pptd-v2";
import { SlideToolArgsError, type SlideToolContext, type SlideToolDefinition } from "./contract.js";
import { prepareElementEdit } from "./edit-elements.js";
import { readPageFromProject } from "./read-page.js";
import { expandComponentArgs, recordComponentUses, writtenPageTarget } from "./template-components.js";
import {
  isLeaseRefusalData,
  leaseRefusal,
  result,
  runAuthorizedSideEffect,
  sessionKeyOf,
  slideTool,
  validateArgs,
  type SlideToolRuntimeDeps,
} from "./tool-kit.js";
import { executeWritePageOnce, replayOrRun } from "./write-page-execute.js";
import { withNormalizedPageResult } from "./write-page-feedback.js";
import { dropOwnLayoutCopyIds, withoutLayoutCopies } from "./write-page-layout.js";
import { formatWritePageOutcome } from "./write-page-outcome-format.js";
import { writePageSerial } from "./write-page-serial.js";
import { normalizeNumericPageText } from "./write-page-text.js";
import { normalizeWritePageArgs, unwrapToolValue } from "./write-page.js";

export const WRITE_PAGE_DESCRIPTION = `Write one COMPLETE PPTD v2 page in one call. Host accepts only one write_page at a time: wait for this result before the next page. This is whole-page replacement, never element append: every call must include the full elements[] array. Never omit elements — a background-only page is rejected; a photo cover still carries its title and subtitle as elements above the background. Elements use elementId, elementType, bounds [x,y,w,h], and content.text. Text fontSize/fontFamily/color/alignment fields belong directly on content; content.style is only a string theme reference such as $title, never an object. fontFamily must be one of ${SLIDE_FONTS.map((font) => font.name).join(", ")}; any other face is rewritten to the closest one and the result lists fontNotes. Prefer {latin, ea} so Latin and Chinese are named separately. layoutRole belongs on the element. Chart elements take series[].type bar, line, area, pie, doughnut, radar, scatter or waterfall (bar and line series may combine); the optional chart grouping is clustered (default), stacked or percentStacked and applies to bar charts only (a stacked bar is type bar with grouping stacked, never a series type). radar needs at least 3 categories; doughnut takes one series with no negative values. Put element fill/line fields inside the owning element; optional page-level metadata is background, notes, and animations. Editing uses the same page id. Treat the complete page from read_page as the baseline, preserve its background/notes/animations, and pass its pageSha256 as expectedPageSha256; an editor review lock rejects stale edits. layoutStatus=pass is overflow-only, not a rewrite seal. The same pageId may be rewritten until review_pages records a current structural pass for that revision. After structural pass, rewrite only if the current revision has explicit editor edit authorization, review_pages names the page failing, or review_page says revise. An authorized editor edit uses read_page and expectedPageSha256; do not manufacture a visual review to enable it. Optional provenance {basis material|mock|mixed|own, materials, quoted, note} records where this page's figures come from; it is stored in the run ledger, never in the page file, and a quoted value that is not in the chunks read this session, or a material figure relabelled with a different period, returns a non-blocking Chinese hint. elements must be a JSON array, not a JSON-encoded string. A page with a layoutId inherits that layout's elements; never redraw one of them on the page. A template component may stand in for a decoration group: an element {elementType:"component", ref:"material:<id>#<componentId>", bounds:[x,y,w,h]} copied from the template's read_material part kit (read it fully first; the template needs the decorations or photos use declared in commit_design). The Host expands it into native elements; it never creates a page, and the page's own text is still written by you. A SmartArt component (its kit entry says smartart) is page-only and may also carry texts: one entry per node in reading order — an entry is the node text or a list of its paragraphs (the first paragraph is the main line). A process component re-lays out evenly to the entry count; every other kind must match its node count exactly. The expansion is ordinary shapes, so the export carries no diagram part.`;

const EDIT_ELEMENTS_DESCRIPTION =
  "Replace exactly the selected elements in an active editor element review. Pass only the authorized target elements, but each must be one COMPLETE canonical native PPTD element with its existing elementId. The Host reads the current authoritative page, preserves every other element, page metadata, and element order, then executes the same canonical write_page persistence path. Call read_page immediately before this tool and pass its current pageSha256 as expectedPageSha256. Do not wrap arguments or send aliases. When replacing a picture, resend the element with only src changed (keep bounds, fit, crop and cropShape exactly as read_page returned them); when updating a chart from a table, replace only data.rows with the table's numbers and keep its series, grouping and colors. This tool is unavailable outside a live server-verified elements scope.";

type NormalizedWrite = { clean: Record<string, unknown>; normalized: string[] };

/** Provider-dialect normalization shared by validation and execution (pure). */
function normalizeWriteArgs(args: Record<string, unknown>): NormalizedWrite {
  let clean = structuredClone(args);
  if (typeof clean.elements === "string") {
    try {
      clean.elements = JSON.parse(clean.elements);
    } catch {
      // Left as a string so the normalizer reports the JSON-array refusal.
    }
  }
  clean = unwrapToolValue(clean) as Record<string, unknown>;
  const normalized = normalizeWritePageDialect(clean);
  clean = withoutLayoutCopies(normalizeWritePageArgs(clean));
  normalizeWritePageLineArrows(clean);
  return { clean, normalized };
}

function assertCanonicalPage(clean: Record<string, unknown>, normalized: readonly string[]): void {
  const probe = structuredClone(clean);
  normalizeNumericPageText(probe);
  const issues = canonicalWritePageIssues(probe);
  if (issues.length) {
    throw new SlideToolArgsError([...normalized.map((move) => `normalized: ${move}`), ...issues]);
  }
}

function componentScope(deps: SlideToolRuntimeDeps, ctx: SlideToolContext) {
  return () => ({
    projectRoot: ctx.projectRoot,
    contextEpochId: deps.presentation.epochFor(sessionKeyOf(ctx)),
  });
}

async function runWritePage(deps: SlideToolRuntimeDeps, ctx: SlideToolContext, args: Record<string, unknown>) {
  const { clean, normalized } = normalizeWriteArgs(args);
  const scope = componentScope(deps, ctx);
  const components = expandComponentArgs(clean, "page", scope);
  if (!components.ok) return result(components.outcome);
  // Keep the original numbers so matching text can keep leading zeros.
  const textSource = structuredClone(clean);
  assertCanonicalPage(clean, normalized);
  const schema = writePageProviderJsonSchema() as Record<string, unknown>;
  return writePageSerial.enqueue(sessionKeyOf(ctx), async () => {
    const refusal = leaseRefusal(deps, ctx);
    if (refusal) return refusal;
    const baseline = readPageFromProject(ctx.projectRoot, String(clean.id));
    normalizeNumericPageText(textSource, baseline);
    dropOwnLayoutCopyIds(ctx.projectRoot, textSource);
    validateArgs(deps, { ...schema, additionalProperties: false }, textSource);
    const outcome = await replayOrRun(
      ctx.projectRoot,
      "write_page",
      textSource,
      ctx.callId,
      () => executeWritePageOnce(deps, ctx, structuredClone(textSource)),
      (write) => runAuthorizedSideEffect(deps, ctx, write),
    );
    if (isLeaseRefusalData(outcome)) return result(outcome);
    const written = writtenPageTarget(outcome);
    if (written) runAuthorizedSideEffect(deps, ctx, () => recordComponentUses(scope, components.uses, written));
    return result(withNormalizedPageResult(outcome, normalized));
  });
}

export function writePageTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "write_page",
    description: WRITE_PAGE_DESCRIPTION,
    schema: writePageProviderJsonSchema() as Record<string, unknown>,
    closed: true,
    readOnly: false,
    concurrencySafe: true,
    render: (data) => formatWritePageOutcome(data),
    // Normalize first, then validate: only display text has a narrow provider
    // compatibility path; everything else is rejected before any project access.
    validate(args) {
      const { clean, normalized } = normalizeWriteArgs(args);
      if (
        Array.isArray(clean.elements) &&
        clean.elements.some((el) => (el as { elementType?: unknown })?.elementType === "component")
      ) {
        return;
      }
      assertCanonicalPage(clean, normalized);
    },
    execute: (args, ctx) => runWritePage(deps, ctx, args),
  });
}

async function runEditElements(deps: SlideToolRuntimeDeps, ctx: SlideToolContext, args: Record<string, unknown>) {
  const clean = structuredClone(args);
  const outcome = await replayOrRun(
    ctx.projectRoot,
    "edit_elements",
    clean,
    ctx.callId,
    async () => {
      const prepared = prepareElementEdit(ctx.projectRoot, clean as unknown as CanonicalEditElementsArgs);
      if (!prepared.ok) return prepared.outcome;
      const merged = structuredClone(prepared.page) as unknown as Record<string, unknown>;
      const issues = canonicalWritePageIssues(merged);
      if (issues.length) {
        return {
          outcome: "rejected",
          error: "ELEMENT_EDIT_CANONICAL_PAGE_INVALID",
          detail: issues.join("; "),
          painted: false,
        };
      }
      return executeWritePageOnce(deps, ctx, merged);
    },
    (write) => runAuthorizedSideEffect(deps, ctx, write),
  );
  return result(outcome);
}

export function editElementsTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  const schema = { ...(editElementsJsonSchema() as Record<string, unknown>), additionalProperties: false };
  return slideTool(deps, {
    name: "edit_elements",
    description: EDIT_ELEMENTS_DESCRIPTION,
    schema,
    readOnly: false,
    render: (data) => formatWritePageOutcome(data),
    validate(args) {
      const issues = canonicalEditElementsIssues(args);
      if (issues.length) throw new SlideToolArgsError(issues);
      validateArgs(deps, schema, args);
    },
    execute: (args, ctx) => runEditElements(deps, ctx, args),
  });
}
