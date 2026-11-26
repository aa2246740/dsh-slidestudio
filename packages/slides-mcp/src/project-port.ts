/**
 * MCP project binding: `open_project` creates `<dataRoot>/output/dsh-slices/mcp-<shortId>`
 * (rolled back atomically when setup fails), `bind_project` attaches a session to an
 * existing PPTD directory below the same root. Both write the presentation-run binding
 * `_agent/presentation-run.v1.json` with the MCP client as the provider route, so the
 * canonical domain tools (capabilities, references, plan, write, review, export) run
 * offline exactly as they do for a Hub run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider, type PresentationRun } from "@open-slidestudio/presentation-run";
import {
  readProjectLease,
  withProjectLeaseLock,
  type OpenedSlideProject,
  type SlideProjectPort,
} from "@open-slidestudio/slides-tools";

export const SLICES_REL = path.join("output", "dsh-slices");
const RUN_BINDING_REL = path.join("_agent", "presentation-run.v1.json");
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SessionBinding = {
  /** Folder name below `output/dsh-slices/` (the `bind_project` id). */
  readonly projectId: string;
  /** Absolute canonical project root. */
  readonly projectRoot: string;
  /** Data-root-relative path; the editor `?project=` value and `ctx.projectId`. */
  readonly displayRoot: string;
  /** Session id recorded in the run binding; keeps receipts and epochs on one run. */
  readonly runSessionId: string;
};

/** Mutable per-MCP-session state shared by the project port and the MCP-only tools. */
export type McpSessionState = {
  readonly sessionId: string;
  readonly callerId: string;
  label: string;
  readonly acceptsImages: boolean;
  binding?: SessionBinding;
  /** Every project root this session took the writer lease on. */
  readonly leasedRoots: Set<string>;
};

export type ProjectEnv = {
  readonly dataRoot: string;
  readonly editorBaseUrl: string;
  readonly presentation: PresentationRun;
};

type Design = OpenedSlideProject["design"];

export function slicesRoot(dataRoot: string): string {
  return path.join(dataRoot, SLICES_REL);
}

export function mcpProvider(state: Pick<McpSessionState, "label" | "acceptsImages">) {
  return {
    providerId: "mcp",
    modelId: state.label,
    ready: true,
    modelInputModalities: state.acceptsImages ? (["text", "image"] as const) : (["text"] as const),
  };
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function readRunBinding(projectRoot: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, RUN_BINDING_REL), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function designOf(binding: Record<string, unknown> | undefined): Design {
  const design = binding?.design as Record<string, unknown> | undefined;
  if (design?.kind === "explicit-style" && typeof design.designSystemId === "string" && design.designSystemId) {
    return { kind: "explicit-style", designSystemId: design.designSystemId };
  }
  return { kind: "self-directed" };
}

/** Write a fresh presentation-run binding for a project this session owns. */
function writeRunBinding(
  env: ProjectEnv,
  state: McpSessionState,
  targetDir: string,
  brief: string,
  recordedRoot = targetDir,
): void {
  writeJsonAtomic(path.join(targetDir, RUN_BINDING_REL), {
    projectRoot: recordedRoot,
    sessionId: state.sessionId,
    brief,
    editorBaseUrl: env.editorBaseUrl,
    design: { kind: "self-directed" },
    provider: mcpProvider(state),
    runId: state.sessionId,
    contextEpochId: `mcp-${crypto.randomUUID()}`,
  });
}

/**
 * Ensure the run binding names this MCP client as the provider route. The caller must
 * hold the writer lease. Returns the session id the binding records.
 */
export function adoptRunBinding(
  env: ProjectEnv,
  state: McpSessionState,
  projectRoot: string,
  brief: string,
): { runSessionId: string; design: Design } {
  const existing = readRunBinding(projectRoot);
  if (!existing) writeRunBinding(env, state, projectRoot, brief);
  else persistPresentationRunProvider(projectRoot, mcpProvider(state));
  env.presentation.hydrate(projectRoot);
  const recorded = readRunBinding(projectRoot);
  const runSessionId = typeof recorded?.sessionId === "string" && recorded.sessionId ? recorded.sessionId : "";
  return { runSessionId: runSessionId || state.sessionId, design: designOf(recorded) };
}

function insideSlices(dataRoot: string, candidate: string): boolean {
  const root = path.resolve(slicesRoot(dataRoot));
  return path.resolve(candidate).startsWith(`${root}${path.sep}`);
}

function bindingFor(projectRoot: string, runSessionId: string): SessionBinding {
  const projectId = path.basename(projectRoot);
  return {
    projectId,
    projectRoot,
    displayRoot: path.join(SLICES_REL, projectId).split(path.sep).join("/"),
    runSessionId,
  };
}

function createStagingDir(dataRoot: string): string {
  const root = slicesRoot(dataRoot);
  fs.mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(root, `.staging-mcp-${crypto.randomBytes(6).toString("hex")}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a staging directory for the new MCP project");
}

function allocateFinalDir(dataRoot: string): string {
  const root = slicesRoot(dataRoot);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(root, `mcp-${crypto.randomBytes(5).toString("hex")}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("could not allocate a new MCP project directory");
}

/** Remove a directory this session created (only below `output/dsh-slices/`). */
export function removeCreatedProject(dataRoot: string, projectRoot: string): void {
  if (insideSlices(dataRoot, projectRoot)) fs.rmSync(projectRoot, { recursive: true, force: true });
}

/**
 * Remove a created directory only while no active foreign writer owns its lease,
 * so a rollback never deletes a project another writer already took over.
 */
function rollbackProjectSafely(dataRoot: string, state: McpSessionState, projectRoot: string): void {
  if (fs.existsSync(projectRoot)) {
    withProjectLeaseLock(projectRoot, () => {
      const lease = readProjectLease(projectRoot);
      if (lease.active && lease.holder && lease.holder.ownerId !== state.callerId) return;
      removeCreatedProject(dataRoot, projectRoot);
    });
  }
  state.leasedRoots.delete(projectRoot);
  if (state.binding?.projectRoot === projectRoot) state.binding = undefined;
}

function publishStagedProject(
  env: ProjectEnv,
  state: McpSessionState,
  staging: string,
  title: string,
  initialFinalDir: string,
): string {
  let finalDir = initialFinalDir;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(staging, finalDir);
      return finalDir;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EEXIST" || code === "ENOTEMPTY") && attempt < 7) {
        finalDir = allocateFinalDir(env.dataRoot);
        writeRunBinding(env, state, staging, title, finalDir);
        continue;
      }
      throw error;
    }
  }
  throw new Error("could not publish the new MCP project directory");
}

/** The `SlideProjectPort` bound to one MCP session. */
export function mcpProjectPort(env: ProjectEnv, state: McpSessionState): SlideProjectPort {
  return {
    peekExisting: () => state.binding?.projectRoot,
    open({ title, initialize }) {
      const bound = state.binding;
      if (bound) {
        return {
          created: false,
          projectId: bound.displayRoot,
          projectRoot: bound.projectRoot,
          displayRoot: bound.displayRoot,
          design: designOf(readRunBinding(bound.projectRoot)),
        };
      }
      const staging = createStagingDir(env.dataRoot);
      const design: Design = { kind: "self-directed" };
      let publishedDir: string | undefined;
      try {
        createEmptyProject(staging, { title });
        const finalDir = allocateFinalDir(env.dataRoot);
        writeRunBinding(env, state, staging, title, finalDir);
        const refusal = initialize?.(staging, design);
        if (refusal) {
          removeCreatedProject(env.dataRoot, staging);
          return {
            created: false,
            projectId: "",
            projectRoot: finalDir,
            displayRoot: "",
            design,
            initialized: true,
            refusal,
          };
        }
        publishedDir = publishStagedProject(env, state, staging, title, finalDir);
        env.presentation.hydrate(publishedDir);
      } catch (error) {
        if (!publishedDir) removeCreatedProject(env.dataRoot, staging);
        else rollbackProjectSafely(env.dataRoot, state, publishedDir);
        throw error;
      }
      const binding = bindingFor(publishedDir, state.sessionId);
      state.binding = binding;
      if (initialize) state.leasedRoots.add(publishedDir);
      return {
        created: true,
        projectId: binding.displayRoot,
        projectRoot: publishedDir,
        displayRoot: binding.displayRoot,
        design,
        initialized: Boolean(initialize),
      };
    },
    rollbackCreated(projectRoot) {
      rollbackProjectSafely(env.dataRoot, state, projectRoot);
    },
  };
}

export type ResolvedProject =
  | { readonly ok: true; readonly projectRoot: string; readonly title: string }
  | { readonly ok: false; readonly error: string; readonly detail: string };

function refuse(error: string, detail: string): ResolvedProject {
  return { ok: false, error, detail };
}

function canonicalSlicesRoot(dataRoot: string): string | undefined {
  try {
    return fs.realpathSync(slicesRoot(dataRoot));
  } catch {
    return undefined;
  }
}

/** Resolve a `bind_project` id to an existing PPTD directory directly below `output/dsh-slices/`. */
export function resolveExistingProject(dataRoot: string, projectId: unknown): ResolvedProject {
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId) || projectId.includes("..")) {
    return refuse(
      "invalid_project_id",
      "projectId must be a folder name below output/dsh-slices (letters, digits, '.', '_', '-'); paths are refused",
    );
  }
  const root = canonicalSlicesRoot(dataRoot);
  if (!root) return refuse("project_not_found", `no project ${projectId} exists below output/dsh-slices`);
  let real: string;
  try {
    real = fs.realpathSync(path.join(root, projectId));
  } catch {
    return refuse("project_not_found", `no project ${projectId} exists below output/dsh-slices`);
  }
  if (path.dirname(real) !== root) {
    return refuse("project_outside_data_root", `project ${projectId} resolves outside output/dsh-slices`);
  }
  if (!fs.statSync(real).isDirectory()) return refuse("project_not_found", `${projectId} is not a project directory`);
  try {
    const project = loadProject(real);
    return { ok: true, projectRoot: real, title: project.presentation.title || projectId };
  } catch (error) {
    return refuse(
      "invalid_pptd_project",
      `${projectId} is not a readable PPTD project: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function bindSession(state: McpSessionState, projectRoot: string, runSessionId: string) {
  state.binding = bindingFor(projectRoot, runSessionId);
  return state.binding;
}
