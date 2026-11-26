import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import type { SkillPageInput } from "./skill-pages.js";
import { persistWrittenPages } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import { stableSha256 } from "./run-ledger.js";

const navy = {
  elementId: "cl-bg",
  elementType: "shape" as const,
  shapeName: "rect" as const,
  bounds: [0, 0, 960, 540] as [number, number, number, number],
  fill: { type: "solid" as const, color: "#06223F" },
};

function textEl(
  id: string,
  text: string,
  bounds: [number, number, number, number],
  fontSize: number,
): SkillPageInput["elements"][number] {
  return {
    elementId: id,
    elementType: "text",
    bounds,
    content: { text, fontSize, color: "#FFFFFF" },
  };
}

function pageWithCopy(id: string, pageType: SkillPageInput["pageType"], title: string): SkillPageInput {
  return {
    id,
    pageType,
    elements: [navy, textEl("t", title, [80, 160, 800, 80], 36)],
  };
}

function persistAll(root: string, pages: SkillPageInput[]): void {
  persistWrittenPages({
    brief: "persist identity inversion",
    playbook: loadPlaybook({ hostDefaults: false }),
    todos: [],
    researchNotes: [],
    writtenPages: pages,
    projectRoot: root,
  });
}

it("batch guard authorizes the per-page union while preserving all other objects and pages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch-scope-persist-"));
  createEmptyProject(root, { title: "Batch" });
  persistAll(root, [
    pageWithCopy("p1", "content", "First"),
    pageWithCopy("p2", "content", "Second"),
    pageWithCopy("p3", "content", "Untouched"),
  ]);
  const before = loadProject(root);
  const p1 = before.pages[0]!;
  const p2 = before.pages[1]!;
  const p3Bytes = fs.readFileSync(path.join(root, before.pages[2]!.path));
  const items = [
    {
      pagePath: p1.path,
      scope: { kind: "elements", pageId: "p1", elementIds: ["t"] },
      pageBody: p1.page,
    },
    {
      pagePath: p1.path,
      scope: { kind: "elements", pageId: "p1", elementIds: ["cl-bg"] },
      pageBody: p1.page,
    },
    {
      pagePath: p2.path,
      scope: { kind: "elements", pageId: "p2", elementIds: ["t"] },
      pageBody: p2.page,
    },
  ];
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({ ...items[0], items, expiresAt: Date.now() + 60_000 }),
  );
  const state = {
    brief: "Batch",
    playbook: loadPlaybook({ hostDefaults: false }),
    todos: [],
    researchNotes: [],
    writtenPages: [],
    projectRoot: root,
  };
  const first = structuredClone(p1.page);
  (first.elements[0] as typeof navy).fill.color = "#333333";
  (first.elements[1] as { content: { text: string } }).content.text = "Both targets";
  assert.deepEqual(
    persistWrittenPages(state, [{ ...first, id: "p1" }], {
      expectedPageSha256: stableSha256({ ...p1.page, id: "p1" }),
    }),
    { ok: true },
  );
  const second = structuredClone(p2.page);
  (second.elements[1] as { content: { text: string } }).content.text = "Second page";
  const sha = stableSha256({ ...p2.page, id: "p2" });
  const outside = structuredClone(second);
  (outside.elements[0] as typeof navy).fill.color = "#444444";
  const denied = persistWrittenPages(state, [{ ...outside, id: "p2" }], {
    expectedPageSha256: sha,
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error, "review_scope_violation");
  assert.deepEqual(persistWrittenPages(state, [{ ...second, id: "p2" }], { expectedPageSha256: sha }), { ok: true });
  assert.deepEqual(fs.readFileSync(path.join(root, before.pages[2]!.path)), p3Bytes);
});
