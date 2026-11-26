/** Page read and structural edit tools. */
import { normalizePageFonts, writePageJsonSchema } from "@open-slidestudio/pptd-v2";
import { readActiveReviewGuard, reviewWriteTargetForPage } from "@open-slidestudio/presentation-run";
import { SlideToolArgsError, type SlideToolContext, type SlideToolDefinition } from "./contract.js";
import { canonicalWritePageIssues } from "@open-slidestudio/pptd-v2";
import { readPageFromProject } from "./read-page.js";
import {
  isLeaseRefusalData,
  present,
  result,
  runAuthorizedSideEffect,
  sessionKeyOf,
  slideTool,
  type SlideToolRuntimeDeps,
} from "./tool-kit.js";
import { executeWritePageOnce, replayOrRun } from "./write-page-execute.js";
import { formatWritePageOutcome } from "./write-page-outcome-format.js";
import { withoutLayoutCopies } from "./write-page-layout.js";
import { writePageSerial } from "./write-page-serial.js";

export function readPageTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "read_page",
    description:
      "Read one current persisted PPTD v2 page by pageId. Strictly read-only: returns the COMPLETE page body plus stable pageSha256 as the baseline before a whole-page write_page edit. Call this immediately before editing an existing page so human changes are preserved.",
    parameters: {
      pageId: { type: "string", required: true, description: "Existing PPTD page id to read" },
    },
    readOnly: true,
    async execute(args, ctx) {
      return result(readPageFromProject(ctx.projectRoot, String(args.pageId ?? "")));
    },
  });
}

function serialReplay(
  deps: SlideToolRuntimeDeps,
  ctx: SlideToolContext,
  name: string,
  args: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  return writePageSerial.enqueue(sessionKeyOf(ctx), () =>
    replayOrRun(ctx.projectRoot, name, args, ctx.callId, run, (write) => runAuthorizedSideEffect(deps, ctx, write)),
  );
}

async function backgroundEdit(deps: SlideToolRuntimeDeps, ctx: SlideToolContext, args: Record<string, unknown>) {
  const { projectRoot } = ctx;
  const target = reviewWriteTargetForPage(readActiveReviewGuard(projectRoot), String(args.pageId));
  if (!target || target.scope.kind === "elements") {
    return {
      outcome: "rejected",
      error: "PAGE_EDIT_SCOPE_REQUIRED",
      detail: "edit_page_background requires an active editor page/deck scope for this page",
      painted: false,
    };
  }
  const baseline = readPageFromProject(projectRoot, String(args.pageId));
  if (baseline.pageSha256 !== String(args.expectedPageSha256).trim().toLowerCase()) {
    return {
      outcome: "rejected",
      error: "PAGE_EDIT_STALE_PAGE",
      detail: "stale-page: read_page again before editing",
      painted: false,
    };
  }
  const { pageSha256, ...readable } = baseline;
  const merged = {
    ...withoutLayoutCopies(readable),
    background: structuredClone(args.background),
    expectedPageSha256: pageSha256,
  };
  const issues = canonicalWritePageIssues(merged);
  if (issues.length) throw new SlideToolArgsError(issues);
  return executeWritePageOnce(deps, ctx, merged);
}

export function editPageBackgroundTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  const pageSchema = writePageJsonSchema() as { properties: Record<string, unknown> };
  return slideTool(deps, {
    name: "edit_page_background",
    description:
      "Change ONLY an existing page background. Use this for background-only edits instead of copying all elements into write_page. Pass pageId, expectedPageSha256 from read_page, and the complete canonical background. The Host preserves every element, text string, style, order, notes and animation verbatim. Available only inside an active editor page/deck scope; stale hashes and element-only scopes are rejected. The same write/render and review gates apply.",
    schema: {
      type: "object",
      required: ["pageId", "expectedPageSha256", "background"],
      properties: {
        pageId: { type: "string" },
        expectedPageSha256: { type: "string" },
        background: pageSchema.properties.background,
      },
    },
    closed: true,
    readOnly: false,
    render: (data) => formatWritePageOutcome(data),
    async execute(args, ctx) {
      return result(await serialReplay(deps, ctx, "edit_page_background", args, () => backgroundEdit(deps, ctx, args)));
    },
  });
}

const PAGE_IDS_SCHEMA = {
  type: "object",
  required: ["pageIds"],
  properties: { pageIds: { type: "array", items: { type: "string" } } },
} as const;

function pageListTool(
  deps: SlideToolRuntimeDeps,
  name: "delete_pages" | "reorder_pages",
  description: string,
): SlideToolDefinition {
  return slideTool(deps, {
    name,
    description,
    schema: structuredClone(PAGE_IDS_SCHEMA) as unknown as Record<string, unknown>,
    closed: true,
    readOnly: false,
    async execute(args, ctx) {
      const clean = { pageIds: Array.isArray(args.pageIds) ? args.pageIds.map(String) : [] };
      return result(
        await serialReplay(deps, ctx, name, clean, async () => {
          const receipt = await present(deps, ctx, name, clean);
          return !receipt.ok && isLeaseRefusalData(receipt.payload) ? receipt.payload : receipt;
        }),
      );
    },
  });
}

export function deletePagesTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return pageListTool(
    deps,
    "delete_pages",
    "During generation, remove only notInPlan pages authored by this run's agent; planned pages and externally changed pages are refused. In editor turns, remove exactly the pages named by the active structural authorization (deletablePageIds), or the rewrite baseline. For a merge, first write the merged content into the surviving editable page. The page list and manifest update atomically; editor verify rolls back results outside its authorized set.",
  );
}

export function reorderPagesTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return pageListTool(
    deps,
    "reorder_pages",
    "Reorder the deck's pages to exactly the authorized final order (reorderPageIds). pageIds must list every existing page once, in the authorized sequence. It changes the manifest order only — no page content is rewritten. Verify rolls everything back if the result differs from the authorized order.",
  );
}

function deckMetaArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  if (typeof args.title === "string") clean.title = args.title;
  const theme = args.theme;
  if (theme !== undefined && theme !== null && typeof theme === "object" && !Array.isArray(theme)) {
    clean.theme = structuredClone(theme);
  }
  return clean;
}

export function updateDeckTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "update_deck",
    description:
      "Change deck-level metadata: the presentation title and/or theme. Only the fields named by the active editor authorization (editableMeta) may be sent — a field outside that whitelist is rejected. Page content and the manifest are untouched. A rewrite lock authorizes both fields. Theme textStyles fontFamily uses the same Office/WPS faces as write_page; an off-list face is rewritten and reported in fontNotes.",
    schema: { type: "object", properties: { title: { type: "string" }, theme: { type: "object" } } },
    closed: true,
    readOnly: false,
    async execute(args, ctx) {
      const clean = deckMetaArgs(args);
      // A theme carries textStyles[].fontFamily; rewrite any off-list face the
      // same way write_page does, before the args are recorded for replay.
      const fontNotes = normalizePageFonts(clean).map(
        (entry) => `字体 ${JSON.stringify(entry.from)} 改成 ${JSON.stringify(entry.to)}`,
      );
      return result(
        await serialReplay(deps, ctx, "update_deck", clean, async () => {
          const receipt = await present(deps, ctx, "update_deck", clean);
          if (!receipt.ok && isLeaseRefusalData(receipt.payload)) return receipt.payload;
          if (!receipt.ok || !fontNotes.length || !receipt.payload || typeof receipt.payload !== "object") {
            return receipt;
          }
          return { ...receipt, payload: { ...receipt.payload, fontNotes } };
        }),
      );
    },
  });
}
