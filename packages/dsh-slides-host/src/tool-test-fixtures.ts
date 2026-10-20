import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type { PresentationRun } from "@open-slidestudio/presentation-run";
import { addPlaywrightRuntimeLayout } from "./runtime-test-fixture.js";

export const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

export function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function stubPlaywrightRuntime(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-produce-"));
  const file = path.join(dir, "runtime.mjs");
  fs.writeFileSync(
    file,
    `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub"); }
`,
  );
  addPlaywrightRuntimeLayout(file);
  return file;
}

export function fakeTools(): { defs: ToolDefinition[]; runtime: ToolRuntime } {
  const defs: ToolDefinition[] = [];
  return {
    defs,
    runtime: {
      register(def: ToolDefinition) {
        defs.push(def);
        return () => undefined;
      },
      guard() {
        return () => undefined;
      },
    } as unknown as ToolRuntime,
  };
}

export function stubPresentation(): PresentationRun {
  return {
    execute: async (command) => ({
      ok: true,
      name: command.name,
      summary: `${command.name} ok`,
      detail: `${command.name} ok`,
      payload: { pageId: "1_cover", visualReview: "pass" },
    }),
    open: async () => {
      throw new Error("unused");
    },
    inspect: async () => {
      throw new Error("unused");
    },
    hydrate: () => undefined,
    epochFor: () => "epoch",
  };
}
