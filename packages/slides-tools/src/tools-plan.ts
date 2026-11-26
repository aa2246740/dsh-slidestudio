/** Plan commitment tools: `commit_design` and `write_todo`. */
import { TODO_EXHIBIT_KINDS, type CommandReceipt } from "@open-slidestudio/presentation-run";
import type { SlideToolDefinition, SlideToolResult } from "./contract.js";
import { PLAN_DESIGN_PARAMETERS } from "./design-aspects-parameter.js";
import { rejectKindThemePack } from "./kind-theme-gate.js";
import { WRITE_TODO_DATA_PARAMETERS, writeTodoItemsParameter } from "./plan-material-params.js";
import { isLeaseRefusalData, present, result, slideTool, type SlideToolRuntimeDeps } from "./tool-kit.js";

export const SLIDE_PLAN_ITEMS_PARAMETER = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageId: { type: "string", required: true },
      title: { type: "string", required: true },
      layoutFamily: { type: "string", required: true },
      exhibits: {
        type: "array",
        required: true,
        items: { type: "string", enum: [...TODO_EXHIBIT_KINDS] },
      },
      note: { type: "string" },
      purpose: { type: "string" },
      layoutId: { type: "string" },
    },
  },
  description:
    "Complete ordered plan: {pageId, title, layoutFamily, exhibits, note?, purpose?, layoutId?}. layoutId names the page layout the page is planned to use. Use an explicit empty exhibits array when none are needed. One page is valid.",
} as const;

function planOutcome(receipt: CommandReceipt): SlideToolResult {
  if (!receipt.ok) {
    if (isLeaseRefusalData(receipt.payload)) return result(receipt.payload);
    return result({
      ...receipt.payload,
      outcome: "rejected",
      error: receipt.payload.error ?? "rejected",
      detail: receipt.detail,
      painted: false,
    });
  }
  return result({ ...receipt.payload, outcome: "committed" });
}

async function commitPlan(
  deps: SlideToolRuntimeDeps,
  name: "commit_design" | "write_todo",
  args: Record<string, unknown>,
  ctx: Parameters<SlideToolDefinition["execute"]>[1],
): Promise<SlideToolResult> {
  const rejected = rejectKindThemePack(ctx.projectRoot, args);
  if (rejected) return result(rejected);
  return planOutcome(await present(deps, ctx, name, args));
}

export function commitDesignTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "commit_design",
    description:
      "Commit the slide plan after list_references reports referencesComplete=true. Pass ordered {pageId, title, layoutFamily, exhibits}[] including a valid single-page plan. Plan items may carry an optional layoutId naming the page's layout. adoptedSourceIds selects ordered visual sources; designAspects declares each source's uses from the user's own words. userColors lists colours the user named, so the page palette checks accept them. Content/data do not require visual adoption but require complete current-epoch part reads. Adopt palette/fonts only when requested; logo-only adoption never changes theme colors or fonts. Put the main brand first. designAuthority names the effective style (catalog pack, material:<id>, or hub-choice) with the user's own words or the exact current answer; it replaces the Hub style as authority, never becomes a catalog designSystemId, and grants no page or layout permission. Host never imports source pages or classifies adoption from brief keywords. Do not invent a host preset id. Plan every page the brief needs.",
    parameters: {
      slidePlan: { ...SLIDE_PLAN_ITEMS_PARAMETER, required: true },
      adoptedSourceIds: {
        type: "array",
        items: { type: "string" },
        description: "Canonical array of source ids actually adopted.",
      },
      ...PLAN_DESIGN_PARAMETERS,
    },
    closed: true,
    readOnly: false,
    execute: (args, ctx) => commitPlan(deps, "commit_design", args, ctx),
  });
}

export function writeTodoTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "write_todo",
    description:
      "Commit the page plan after list_references reports referencesComplete=true. Same plan shape as commit_design: items [{pageId, title, layoutFamily, exhibits}]. Plan items may carry an optional layoutId naming the page's layout. A single-page task is valid. Returns notInPlan and non-blocking hints for orphan pages and differing explicit page counts. Restore orphan ids to the plan or call delete_pages before compose. A rejected preflight leaves the plan unchanged. adoptedSourceIds, per-source designAspects, designAuthority and userColors follow commit_design; omit them to retain the current selection, uses, style decision and colours. Plan every page the brief needs. Uploaded images: put each image id on the page that shows it in items[].materials; declare the rest in materialUse. Updating last month's deck with new data: also pass periodMap, and missingItems for template charts or tables with no new data.",
    parameters: {
      items: { ...writeTodoItemsParameter(SLIDE_PLAN_ITEMS_PARAMETER), required: true },
      ...WRITE_TODO_DATA_PARAMETERS,
      adoptedSourceIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Canonical array of source ids actually adopted. Use material:<id> for an attached PPTX whose palette, fonts, logo, or layout the user wants, or for an image, logo or screenshot (and, without a Hub style pack, a PDF) whose colours the user wants: declare palette for it and read its palette part first.",
      },
      ...PLAN_DESIGN_PARAMETERS,
    },
    closed: true,
    readOnly: false,
    execute: (args, ctx) => commitPlan(deps, "write_todo", args, ctx),
  });
}
