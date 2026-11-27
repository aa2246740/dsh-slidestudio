/** Project binding, capability and reference-catalog tools. */
import type { SlideToolDefinition } from "./contract.js";
import { withProjectLeaseLock } from "./project-lease.js";
import { briefForOpenProject, writeSliceRuntime } from "./runtime.js";
import {
  capabilitiesFor,
  leaseRefusal,
  present,
  receiptResult,
  result,
  slideTool,
  type OpenedSlideProject,
  type SlideToolRuntimeDeps,
} from "./tool-kit.js";

const DEFAULT_DECK_TITLE = "DSH SlideStudio slice";

export function openProjectTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "open_project",
    description: "Create or reopen the PPTD project bound to this DSH session. Do not pass a filesystem path.",
    parameters: {
      title: { type: "string", description: "Deck title" },
    },
    readOnly: false,
    requiresProject: false,
    async execute(args, ctx) {
      if (!deps.projects) throw new Error("open_project requires a host project port");
      const title = String(args.title ?? DEFAULT_DECK_TITLE).trim() || DEFAULT_DECK_TITLE;
      const existingRoot = deps.projects.peekExisting?.(ctx);
      if (existingRoot) {
        const refusal = leaseRefusal(deps, { ...ctx, projectRoot: existingRoot });
        if (refusal) return refusal;
      }
      const initialize = (targetRoot: string, design: OpenedSlideProject["design"]) =>
        withProjectLeaseLock(targetRoot, () => {
          const denied = leaseRefusal(deps, { ...ctx, projectRoot: targetRoot });
          if (denied) return denied;
          writeSliceRuntime(targetRoot, {
            brief: briefForOpenProject(targetRoot, title),
            design,
            editorBaseUrl: deps.editorBaseUrl,
            strictExecution: true,
          });
          return undefined;
        });
      const opened = deps.projects.open({ ctx, title, initialize });
      if (opened.refusal) return opened.refusal;
      if (!opened.initialized) {
        try {
          const refusal = initialize(opened.projectRoot, opened.design);
          if (refusal) {
            if (opened.created) deps.projects.rollbackCreated?.(opened.projectRoot, ctx);
            return refusal;
          }
        } catch (error) {
          if (opened.created) deps.projects.rollbackCreated?.(opened.projectRoot, ctx);
          throw error;
        }
      }
      return result({
        outcome: opened.created ? "created" : "reopened",
        projectRoot: opened.displayRoot,
        title,
      });
    },
  });
}

export function inspectCapabilitiesTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "inspect_capabilities",
    description:
      "List vision, search, render, and export capabilities that are actually configured. Do not invent a capability. Hub chips and this tool are the same snapshot.",
    parameters: {},
    readOnly: true,
    async execute(_args, ctx) {
      const caps = capabilitiesFor(deps, ctx);
      deps.presentation.hydrate(ctx.projectRoot);
      await present(deps, ctx, "inspect_capabilities", {});
      return result({ ok: true, summary: caps.note, detail: caps.note, payload: caps });
    },
  });
}

/** Host-neutral link to the native editor for the bound project. */
export function editorUrlFor(editorBaseUrl: string, projectId: string): string {
  const base = editorBaseUrl.replace(/\/+$/, "");
  return `${base}/?project=${encodeURIComponent(projectId)}`;
}

export function openInEditorTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "open_in_editor",
    description:
      "Return the local native editor URL for the bound project so a human can open, inspect and edit the deck. Read-only: it never launches a browser or changes the project.",
    parameters: {},
    closed: true,
    readOnly: true,
    async execute(_args, ctx) {
      return result({
        ok: true,
        projectId: ctx.projectId,
        url: editorUrlFor(deps.editorBaseUrl, ctx.projectId),
      });
    },
  });
}

export function listReferencesTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "list_references",
    description:
      "Check required source-chunk status on demand, not every turn. Without filters, returns compact referencesComplete, requiredReferenceChunks, missingReferenceChunks, next, counts and family/kind totals, with no catalog rows. For a directory, pass family or kind; optional tag narrows the listing. Filtered rows contain only sourceId, kind and chunks. Read every required chunk before commit_design/write_todo. Filters affect only the catalog listing, never the required preflight.",
    parameters: {
      family: {
        type: "string",
        description: "Optional family from familyTotals, such as academic, consulting or general",
      },
      kind: { type: "string", description: "source, visual or design" },
      tag: { type: "string", description: "Optional substring filter" },
    },
    readOnly: true,
    async execute(args, ctx) {
      return receiptResult(await present(deps, ctx, "list_references", args));
    },
  });
}

export function readReferenceTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  return slideTool(deps, {
    name: "read_reference",
    description:
      "Read one OpenKimi source or section chunk (for example openkimi:reference/pptd.md::chart) by sourceId and chunkIndex. Marks the source consulted.",
    parameters: {
      sourceId: { type: "string", required: true },
      chunkIndex: { type: "integer", required: true },
    },
    readOnly: true,
    async execute(args, ctx) {
      const commandArgs =
        deps.confirmReferenceDelivery !== undefined
          ? { ...args, _confirmDelivery: deps.confirmReferenceDelivery }
          : args;
      return receiptResult(await present(deps, ctx, "read_reference", commandArgs));
    },
  });
}
