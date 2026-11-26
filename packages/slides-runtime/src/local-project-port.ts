/**
 * Standalone project port: `open_project` creates
 * `<dataRoot>/output/dsh-slices/run-<id>` with a presentation-run binding that
 * names the runtime's LLM route, so SlideStudio can produce decks without any
 * host. Hosts with their own project store pass their own `SlideProjectPort`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import type { PresentationRun } from "@open-slidestudio/presentation-run";
import type { OpenedSlideProject, SlideProjectPort } from "@open-slidestudio/slides-tools";
import type { LlmRoute } from "./llm-port.js";
import type { ProjectBinding } from "./tool-adapter.js";

export const LOCAL_SLICES_REL = path.join("output", "dsh-slices");
const RUN_BINDING_REL = path.join("_agent", "presentation-run.v1.json");

export type LocalProjectPortOptions = {
  readonly dataRoot: string;
  readonly editorBaseUrl: string;
  readonly presentation: PresentationRun;
  readonly sessionId: string;
  readonly route: () => LlmRoute;
  /** Called when a project becomes bound (created or reopened). */
  readonly onBind: (binding: ProjectBinding) => void;
  readonly current: () => ProjectBinding | undefined;
};

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function displayRootOf(dataRoot: string, projectRoot: string): string {
  return path.relative(dataRoot, projectRoot).split(path.sep).join("/");
}

function writeRunBinding(options: LocalProjectPortOptions, projectRoot: string, brief: string): void {
  const route = options.route();
  writeJsonAtomic(path.join(projectRoot, RUN_BINDING_REL), {
    projectRoot,
    sessionId: options.sessionId,
    brief,
    editorBaseUrl: options.editorBaseUrl,
    design: { kind: "self-directed" },
    provider: {
      providerId: route.providerId,
      modelId: route.modelId,
      ready: true,
      modelInputModalities: [...route.inputModalities],
    },
    runId: options.sessionId,
    contextEpochId: `runtime-${crypto.randomUUID()}`,
  });
}

function allocate(dataRoot: string): string {
  const root = path.join(dataRoot, LOCAL_SLICES_REL);
  fs.mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(root, `run-${crypto.randomBytes(5).toString("hex")}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a new project directory");
}

export function localProjectPort(options: LocalProjectPortOptions): SlideProjectPort {
  const design: OpenedSlideProject["design"] = { kind: "self-directed" };
  return {
    peekExisting: () => options.current()?.projectRoot,
    open({ title, initialize }) {
      const bound = options.current();
      if (bound) {
        return { created: false, ...bound, displayRoot: bound.projectId, design };
      }
      const projectRoot = allocate(options.dataRoot);
      try {
        createEmptyProject(projectRoot, { title });
        writeRunBinding(options, projectRoot, title);
        const refusal = initialize?.(projectRoot, design);
        if (refusal) {
          fs.rmSync(projectRoot, { recursive: true, force: true });
          return { created: false, projectId: "", projectRoot, displayRoot: "", design, initialized: true, refusal };
        }
        options.presentation.hydrate(projectRoot);
      } catch (error) {
        fs.rmSync(projectRoot, { recursive: true, force: true });
        throw error;
      }
      const binding = { projectId: displayRootOf(options.dataRoot, projectRoot), projectRoot };
      options.onBind(binding);
      return { created: true, ...binding, displayRoot: binding.projectId, design, initialized: Boolean(initialize) };
    },
    rollbackCreated(projectRoot) {
      const inside = path
        .resolve(projectRoot)
        .startsWith(`${path.resolve(options.dataRoot, LOCAL_SLICES_REL)}${path.sep}`);
      if (inside) fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}
