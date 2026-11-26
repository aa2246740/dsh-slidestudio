import assert from "node:assert/strict";
import { plan } from "./authority-run.testkit.js";
import { createPresentationRun } from "./run.js";
import type { PresentationCommand } from "./types.js";

export function colorPage(color: string) {
  return {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "brand",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 600, 400],
        fill: { type: "solid", color },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 80, 480, 80],
        content: { text: "合成项目进展", fontSize: 36, color },
      },
    ],
  };
}

export async function readMissingReferences(
  run: ReturnType<typeof createPresentationRun>,
  ctx: (toolCallId: string) => {
    runId: string;
    sessionId: string;
    toolCallId: string;
    projectRoot: string;
    abortSignal: AbortSignal;
  },
  label: string,
): Promise<void> {
  const references = await run.execute({ name: "list_references", args: {} }, ctx(`${label}-refs`));
  for (const chunk of (references.payload.missingReferenceChunks ?? []) as {
    sourceId: string;
    chunkIndex: number;
  }[]) {
    const read = await run.execute(
      { name: "read_reference", args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex } },
      ctx(`${label}-ref-${chunk.sourceId}-${chunk.chunkIndex}`),
    );
    assert.equal(read.ok, true, read.detail);
  }
}

export function authorityPlan(extra: Record<string, unknown> = {}) {
  return {
    name: "commit_design",
    args: {
      slidePlan: plan(),
      adoptedSourceIds: ["material:brand"],
      designAspects: [{ source: "material:brand", aspects: ["palette", "fonts"] }],
      designAuthority: {
        source: "material:brand",
        origin: { kind: "user-request", text: "按附件品牌的配色和字体做" },
      },
      ...extra,
    },
  } satisfies PresentationCommand;
}
