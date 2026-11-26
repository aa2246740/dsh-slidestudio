import fs from "node:fs";
import path from "node:path";
import { writeDomainRuntime } from "@open-slidestudio/presentation-run";
import type { SliceRuntimePayload } from "./outcome.js";

export function writeSliceRuntime(projectRoot: string, payload: SliceRuntimePayload): void {
  if (payload.design.kind === "self-directed") {
    writeDomainRuntime(projectRoot, {
      brief: payload.brief,
      designDirection: "self-directed",
      editorBaseUrl: payload.editorBaseUrl,
      strictExecution: true,
    });
  } else {
    writeDomainRuntime(projectRoot, {
      brief: payload.brief,
      designSystemId: payload.design.designSystemId,
      designDirection: "preset",
      editorBaseUrl: payload.editorBaseUrl,
      strictExecution: true,
    });
  }
  const dshRuntime = path.join(projectRoot, "_agent", "dsh-runtime.json");
  fs.writeFileSync(dshRuntime, `${JSON.stringify(payload, null, 2)}\n`);
}

export function readSliceRuntimeFile(projectRoot: string): Record<string, unknown> {
  const file = path.join(projectRoot, "_agent", "runtime.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function briefForOpenProject(projectRoot: string, title: string): string {
  try {
    const prev = readSliceRuntimeFile(projectRoot);
    const brief = typeof prev.brief === "string" ? prev.brief.trim() : "";
    if (brief) return brief;
  } catch {
    // first open
  }
  return title;
}
