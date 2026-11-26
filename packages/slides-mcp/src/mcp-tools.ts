/**
 * MCP-only tools layered on the canonical suite: `bind_project` attaches the
 * session to an existing project, `reacquire_lease` re-takes the writer lease
 * after the human editor preempted and released it, and `import_material`
 * (see import-material.ts) copies an allowed local file into the materials.
 */
import {
  acquireProjectLease,
  defineSlideTool,
  editorUrlFor,
  releaseProjectLease,
  validateArgs,
  withProjectLeaseLock,
  type LeaseAcquireResult,
  type SlideToolDefinition,
  type SlideToolResult,
  type SlideToolRuntimeDeps,
} from "@open-slidestudio/slides-tools";
import { importMaterialTool, type ImportPolicy } from "./import-material.js";
import {
  adoptRunBinding,
  bindSession,
  resolveExistingProject,
  type McpSessionState,
  type ProjectEnv,
} from "./project-port.js";

export const MCP_ONLY_TOOL_NAMES = ["import_material", "reacquire_lease", "bind_project"] as const;

const REREAD_HINT =
  "The human editor may have changed the deck: call read_page for every page you will edit before writing it again.";

function leaseFailure(lease: Exclude<LeaseAcquireResult, { ok: true }>): SlideToolResult {
  return {
    isError: true,
    data: {
      ok: false,
      outcome: lease.outcome,
      error: lease.outcome,
      detail: lease.detail,
      painted: false,
      ...(lease.holder ? { holder: lease.holder } : {}),
    },
  };
}

function gated(deps: SlideToolRuntimeDeps, definition: SlideToolDefinition): SlideToolDefinition {
  const validate = (args: Record<string, unknown>) => validateArgs(deps, definition.inputSchema, args);
  return {
    ...definition,
    validate,
    async execute(args, ctx) {
      validate(args);
      return definition.execute(args, ctx);
    },
  };
}

export function reacquireLeaseTool(deps: SlideToolRuntimeDeps, state: McpSessionState): SlideToolDefinition {
  return gated(
    deps,
    defineSlideTool({
      name: "reacquire_lease",
      description:
        "Explicitly re-take this session's single-writer lease on the bound project after the human editor preempted it (lease-preempted-by-editor) and has since released it. Fails closed with lease-preempted-by-editor while the editor still holds the project. After success, call read_page before editing: the human may have changed pages.",
      parameters: {},
      closed: true,
      readOnly: false,
      async execute(_args, ctx) {
        const lease = acquireProjectLease(ctx.projectRoot, {
          kind: "mcp",
          ownerId: ctx.caller.id,
          ...(ctx.caller.label ? { label: ctx.caller.label } : {}),
          reacquire: true,
          ...(deps.writerLease ? { ttlMs: deps.writerLease.ttlMs } : {}),
        });
        if (!lease.ok) return leaseFailure(lease);
        state.leasedRoots.add(ctx.projectRoot);
        return {
          data: { ok: true, outcome: lease.outcome, expiresAt: lease.lease.expiresAt, next: REREAD_HINT },
        };
      },
    }),
  );
}

export function bindProjectTool(
  deps: SlideToolRuntimeDeps,
  env: ProjectEnv,
  state: McpSessionState,
): SlideToolDefinition {
  return gated(
    deps,
    defineSlideTool({
      name: "bind_project",
      description:
        "Bind this MCP session to an existing SlideStudio project so you can continue editing it. projectId is the project folder name below the data root's output/dsh-slices/ (for example mcp-1a2b3c4d5e or deck-1234abcd); paths are refused. The writer lease is checked first: when another writer holds the project nothing changes on disk. After binding, call read_page before editing existing pages.",
      parameters: {
        projectId: { type: "string", required: true, description: "Project folder name below output/dsh-slices/" },
      },
      closed: true,
      readOnly: false,
      requiresProject: false,
      async execute(args) {
        const resolved = resolveExistingProject(env.dataRoot, args.projectId);
        if (!resolved.ok) {
          return { isError: true, data: { ok: false, error: resolved.error, detail: resolved.detail } };
        }
        const previous = state.binding?.projectRoot;
        const locked = withProjectLeaseLock(resolved.projectRoot, () => {
          const lease = acquireProjectLease(resolved.projectRoot, {
            kind: "mcp",
            ownerId: state.callerId,
            label: state.label,
            ...(deps.writerLease ? { ttlMs: deps.writerLease.ttlMs } : {}),
          });
          if (!lease.ok) return { ok: false as const, refusal: leaseFailure(lease) };
          const adopted = adoptRunBinding(env, state, resolved.projectRoot, resolved.title);
          return { ok: true as const, runSessionId: adopted.runSessionId };
        });
        if (!locked.ok) return locked.refusal;
        state.leasedRoots.add(resolved.projectRoot);
        const binding = bindSession(state, resolved.projectRoot, locked.runSessionId);
        if (previous && previous !== resolved.projectRoot) {
          releaseProjectLease(previous, state.callerId);
          state.leasedRoots.delete(previous);
        }
        return {
          data: {
            ok: true,
            outcome: previous === resolved.projectRoot ? "already-bound" : "bound",
            projectId: binding.projectId,
            projectRoot: binding.displayRoot,
            title: resolved.title,
            editorUrl: editorUrlFor(env.editorBaseUrl, binding.displayRoot),
            next: REREAD_HINT,
          },
        };
      },
    }),
  );
}

/** The MCP-only tools, in the order `tools/list` exposes them after the canonical suite. */
export function mcpOnlyTools(
  deps: SlideToolRuntimeDeps,
  env: ProjectEnv,
  state: McpSessionState,
  policy: ImportPolicy,
): SlideToolDefinition[] {
  return [importMaterialTool(deps, policy), reacquireLeaseTool(deps, state), bindProjectTool(deps, env, state)];
}
