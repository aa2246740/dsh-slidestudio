import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { composedPageLeftoverIssues, writePageSchemaError, writePageSchemaIssues } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import { listSourceReceipts } from "../receipts.js";
import { packColorWriteContextFrom } from "./theme-pack.js";
import type { RunLedgerV1 } from "./run-ledger.js";

export function leftoverComposeBlockers(root: string): string[] {
  if (!fs.existsSync(path.join(root, "deck.pptd"))) return [];
  try {
    const seen = new Set<string>();
    const blockers: string[] = [];
    for (const issue of composedPageLeftoverIssues(loadProject(root).pages)) {
      if (seen.has(issue.message)) continue;
      seen.add(issue.message);
      blockers.push(issue.message);
    }
    return blockers;
  } catch (error) {
    return [`project unreadable: ${error instanceof Error ? error.message : String(error)}`];
  }
}

export function yamlStructureBlockers(root: string, persistPageKey: (name: string) => string): string[] {
  const blockers: string[] = [];
  if (!fs.existsSync(path.join(root, "deck.pptd"))) return blockers;
  try {
    const project = loadProject(root);
    const last = project.pages.at(-1);
    const lastBasename = last ? path.basename(last.path, ".page") : undefined;
    const diskPageCount = project.pages.length;
    const adoptedSourceIds: string[] = [];
    let designSystemId: string | undefined;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8")) as {
        designSystemId?: unknown;
      };
      if (typeof rec.designSystemId === "string" && rec.designSystemId.trim()) {
        designSystemId = rec.designSystemId.trim();
      }
    } catch {
      designSystemId = undefined;
    }
    for (const row of listSourceReceipts(root)) {
      if (row.state === "adopted" || row.state === "executed") adoptedSourceIds.push(row.sourceId);
    }
    const packCtx = packColorWriteContextFrom({ designSystemId, adoptedSourceIds });
    for (const loaded of project.pages) {
      const page: SkillPageInput = {
        id: persistPageKey(loaded.path),
        pageType: loaded.page.pageType,
        elements: loaded.page.elements,
        background: loaded.page.background,
      };
      const ctx = {
        lastDiskBasename: lastBasename,
        diskPageCount,
        theme: project.presentation.theme,
        ...packCtx,
      };
      const err = writePageSchemaError(writePageSchemaIssues(page, ctx), page, ctx);
      if (err) blockers.push(`${page.id}: ${err.error}`);
    }
  } catch (error) {
    blockers.push(`project unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return blockers;
}

function legacyExecutionPolicy(root: string): NonNullable<RunLedgerV1["sourcePack"]["executionPolicy"]> {
  const runtimePath = path.join(root, "_agent", "runtime.json");
  if (fs.existsSync(runtimePath)) {
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as Record<string, unknown>;
      const strict = runtime.strictExecution === true;
      return {
        currentRenderedLayoutRequired:
          strict && typeof runtime.editorBaseUrl === "string" && runtime.editorBaseUrl.trim().length > 0,
        structuralReviewRequired: strict,
      };
    } catch {
      return { currentRenderedLayoutRequired: true, structuralReviewRequired: true };
    }
  }
  const bindingPath = path.join(root, "_agent", "presentation-run.v1.json");
  if (!fs.existsSync(bindingPath)) {
    return { currentRenderedLayoutRequired: false, structuralReviewRequired: false };
  }
  try {
    const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
    const boundToEditor = typeof binding.editorBaseUrl === "string" && binding.editorBaseUrl.trim().length > 0;
    return {
      currentRenderedLayoutRequired: boundToEditor,
      structuralReviewRequired: true,
    };
  } catch {
    return { currentRenderedLayoutRequired: true, structuralReviewRequired: true };
  }
}

export function executionPolicyFor(
  root: string,
  ledger: RunLedgerV1,
): NonNullable<RunLedgerV1["sourcePack"]["executionPolicy"]> {
  return ledger.sourcePack.executionPolicy ?? legacyExecutionPolicy(root);
}
