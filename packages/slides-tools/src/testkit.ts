/** Offline fixtures for slide tool tests: temp projects, a recording presentation stub and contexts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, saveProject, type DeckLayout, type Page } from "@open-slidestudio/pptd-v2";
import type { CommandReceipt, PresentationCommand, PresentationRun } from "@open-slidestudio/presentation-run";
import type { SlideCaller, SlideToolContext } from "./contract.js";
import type { SlideToolRuntimeDeps } from "./tool-kit.js";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `slides-tools-${prefix}-`));
}

/** A PPTD project on disk with the given pages (and optional layouts). */
export function makeProject(
  pages: readonly { readonly file: string; readonly page: Page }[],
  layouts?: DeckLayout[],
): string {
  const root = tempDir("project");
  const project = createEmptyProject(root, { title: "fixture" });
  project.presentation.pages = pages.map(({ file }) => `pages/${file}`);
  if (layouts) project.presentation.layouts = layouts;
  project.pages = pages.map(({ file, page }) => ({ path: `pages/${file}`, page }));
  saveProject(project);
  return root;
}

export type RecordedCommand = { readonly name: string; readonly args: Record<string, unknown> };

/** A presentation-run stand-in that records commands and answers from `reply`. */
export function recordingPresentation(reply: (command: PresentationCommand) => Partial<CommandReceipt> = () => ({})): {
  presentation: PresentationRun;
  calls: RecordedCommand[];
} {
  const calls: RecordedCommand[] = [];
  const presentation: PresentationRun = {
    async execute(command) {
      calls.push({ name: command.name, args: structuredClone(command.args) as Record<string, unknown> });
      return {
        ok: true,
        name: command.name,
        summary: `${command.name} ok`,
        detail: `${command.name} ok`,
        payload: {},
        ...reply(command),
      } as CommandReceipt;
    },
    open: () => Promise.reject(new Error("unused")),
    inspect: () => Promise.reject(new Error("unused")),
    hydrate: () => undefined,
    epochFor: () => "epoch-test",
  };
  return { presentation, calls };
}

export function runtimeDeps(
  presentation: PresentationRun,
  extra: Partial<SlideToolRuntimeDeps> = {},
): SlideToolRuntimeDeps {
  return { presentation, editorBaseUrl: "http://127.0.0.1:55200", ...extra };
}

export function contextFor(
  projectRoot: string,
  caller: SlideCaller = { kind: "mcp", id: "mcp:client-a" },
  callId = `call-${Math.random().toString(36).slice(2)}`,
): SlideToolContext {
  return { projectId: path.basename(projectRoot), projectRoot, callId, caller, acceptsImageContent: true };
}

export function textPage(id: string, elements: Page["elements"], extra: Partial<Page> = {}): Page {
  return { id, pageType: "content", elements, ...extra } as Page;
}
