/** The single canonical slide tool suite and its schema inspector. */
import type { PresentationRun } from "@open-slidestudio/presentation-run";
import type { SlideToolDefinition, SlideToolRender } from "./contract.js";
import { batchRemoveFootersTool } from "./batch-footers.js";
import { materialToolDefinitions } from "./material-tools.js";
import { withComponentRefGuard } from "./template-components.js";
import { CANONICAL_SLIDE_TOOL_NAMES, OPT_IN_SLIDE_TOOL_NAMES } from "./tool-names.js";
import type { SlideToolRuntimeDeps } from "./tool-kit.js";
import { commitDesignTool, writeTodoTool } from "./tools-plan.js";
import {
  deletePagesTool,
  editPageBackgroundTool,
  readPageTool,
  reorderPagesTool,
  updateDeckTool,
} from "./tools-page.js";
import {
  inspectCapabilitiesTool,
  listReferencesTool,
  openInEditorTool,
  openProjectTool,
  readReferenceTool,
} from "./tools-project.js";
import { generateImageTool, searchImageTool, webSearchTool } from "./tools-research.js";
import { composeDeckTool, exportDeckTool, renderPageTool, reviewPagesTool, reviewPageTool } from "./tools-visual.js";
import { editElementsTool, patchPageElementsTool, writePageTool } from "./tools-write.js";
import { writeLayoutTool } from "./write-layout.js";

export type CreateSlideToolsOptions = {
  /** Tool names a host does not expose. */
  readonly exclude?: ReadonlySet<string>;
  /** Opt-in tools (`OPT_IN_SLIDE_TOOL_NAMES`) to build as well; none by default. */
  readonly include?: ReadonlySet<string>;
};

function optInTools(deps: SlideToolRuntimeDeps, include?: ReadonlySet<string>): SlideToolDefinition[] {
  return include?.has("patch_page_elements") ? [patchPageElementsTool(deps)] : [];
}

/** Build every canonical slide tool bound to one runtime. */
export function createSlideTools(
  deps: SlideToolRuntimeDeps,
  options: CreateSlideToolsOptions = {},
): SlideToolDefinition[] {
  const defs = [
    openProjectTool(deps),
    inspectCapabilitiesTool(deps),
    listReferencesTool(deps),
    readReferenceTool(deps),
    ...materialToolDefinitions(deps),
    commitDesignTool(deps),
    writeTodoTool(deps),
    readPageTool(deps),
    editElementsTool(deps),
    editPageBackgroundTool(deps),
    batchRemoveFootersTool(deps),
    deletePagesTool(deps),
    reorderPagesTool(deps),
    updateDeckTool(deps),
    writePageTool(deps),
    writeLayoutTool(deps),
    renderPageTool(deps),
    reviewPageTool(deps),
    reviewPagesTool(deps),
    composeDeckTool(deps),
    webSearchTool(deps),
    searchImageTool(deps),
    generateImageTool(deps),
    exportDeckTool(deps),
    openInEditorTool(deps),
    ...optInTools(deps, options.include),
  ];
  return defs.filter((def) => !options.exclude?.has(def.name)).map(withComponentRefGuard);
}

const INSPECTION_PRESENTATION: PresentationRun = {
  execute: () => Promise.reject(new Error("schema inspection never executes tools")),
  open: () => Promise.reject(new Error("schema inspection never opens runs")),
  inspect: () => Promise.reject(new Error("schema inspection never inspects runs")),
  hydrate: () => undefined,
  epochFor: () => "inspection",
};

/** Canonical definitions for inspection only (their bodies refuse to run). */
export function listCanonicalSlideTools(options: CreateSlideToolsOptions = {}): SlideToolDefinition[] {
  return createSlideTools({ presentation: INSPECTION_PRESENTATION, editorBaseUrl: "http://127.0.0.1:0" }, options);
}

/** Bytes one tool costs in a provider request: its name, description and parameter schema as JSON. */
export function slideToolSchemaBytes(def: Pick<SlideToolDefinition, "name" | "description" | "inputSchema">): number {
  return Buffer.byteLength(
    JSON.stringify({ name: def.name, description: def.description, parameters: def.inputSchema }),
    "utf8",
  );
}

/** Total schema bytes of the named tools (canonical and opt-in); unknown names are ignored. */
export function slideToolSetSchemaBytes(names: Iterable<string>): number {
  const byName = new Map(
    listCanonicalSlideTools({ include: new Set(OPT_IN_SLIDE_TOOL_NAMES) }).map((def) => [def.name, def]),
  );
  let total = 0;
  for (const name of new Set(names)) {
    const def = byName.get(name);
    if (def) total += slideToolSchemaBytes(def);
  }
  return total;
}

export type SlideToolSchemaEntry = {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
  readonly render: "json" | "vision" | "text";
  readonly concurrencySafe: boolean;
};

function renderKind(render: SlideToolRender): SlideToolSchemaEntry["render"] {
  return typeof render === "function" ? "text" : render;
}

/** JSON snapshot of the canonical contract, keyed by tool name in registration order. */
export function toolSchemasSnapshot(): Record<string, SlideToolSchemaEntry> {
  const byName = new Map(listCanonicalSlideTools().map((def) => [def.name, def]));
  const out: Record<string, SlideToolSchemaEntry> = {};
  for (const name of CANONICAL_SLIDE_TOOL_NAMES) {
    const def = byName.get(name);
    if (!def) throw new Error(`canonical tool ${name} is not registered`);
    out[name] = JSON.parse(
      JSON.stringify({
        description: def.description,
        inputSchema: def.inputSchema,
        readOnly: def.readOnly,
        render: renderKind(def.render),
        concurrencySafe: def.concurrencySafe === true,
      }),
    ) as SlideToolSchemaEntry;
  }
  return out;
}
