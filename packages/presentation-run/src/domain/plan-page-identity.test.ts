import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRunLedger, inspectRunLedger, recordPageRevision, recordTodo } from "./run-ledger.js";
import { executeGenerateTool, type AgentToolState } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import type { SkillPageInput } from "./skill-pages.js";
import { createEmptyProject, saveProject } from "@open-slidestudio/pptd-v2";
import { readRunLedger } from "./run-ledger.js";

const EPOCH = "epoch-1";
const context = { commandId: "cmd-1", contextEpochId: EPOCH };

function ledgerRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-page-identity-"));
  ensureRunLedger(root, {
    manifestSha256: "m",
    requirementsId: "r",
    requirements: [],
  });
  return root;
}

function todoItems(ids: readonly string[]) {
  return ids.map((pageId) => ({
    pageId,
    title: `Title ${pageId}`,
    layoutFamily: "content",
    exhibits: [],
  }));
}

function blockersFor(root: string): readonly string[] {
  // Coverage now checks disk SSOT, so these identity-only fixtures also persist
  // their synthetic pages rather than treating ledger facts as document files.
  const project = createEmptyProject(root, { title: "Identity fixture" });
  project.pages = (readRunLedger(root)?.facts ?? []).flatMap((fact) =>
    fact.type === "page.revision-committed"
      ? [{ path: `pages/${fact.pageId}.page`, page: contentPage(fact.pageId) }]
      : [],
  );
  project.presentation.pages = project.pages.map((entry) => entry.path);
  saveProject(project);
  return inspectRunLedger(root, EPOCH, {
    ...process.env,
    SLIDESTUDIO_VISION_REVIEWER: "plan-page-identity-test",
  }).composeBlockers;
}

const navy = {
  elementId: "bg",
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

function contentPage(id: string): SkillPageInput {
  return {
    id,
    pageType: "content",
    elements: [
      navy,
      textEl("t", "标题足够长了用于测试", [80, 80, 800, 40], 28),
      textEl("b", "正文足够长了用于测试内容", [80, 140, 800, 40], 16),
    ],
  };
}

function toolState(todos: AgentToolState["todos"], writtenPages: SkillPageInput[]): AgentToolState {
  return {
    brief: "a closer test deck",
    playbook: loadPlaybook({ hostDefaults: false }),
    todos,
    researchNotes: [],
    writtenPages,
  };
}

describe("plan to pages identity gate", () => {
  it("matching todo pageIds and pages report no identity blocker", () => {
    const root = ledgerRoot();
    recordTodo(root, context, todoItems(["a", "b"]));
    recordPageRevision(root, context, "a", { id: "a" });
    recordPageRevision(root, context, "b", { id: "b" });
    const blockers = blockersFor(root);
    assert.ok(!blockers.some((blocker) => /missing pages|not in todo/.test(blocker)), blockers.join("; "));
  });

  it("extra pages are named as pages not in todo", () => {
    const root = ledgerRoot();
    recordTodo(root, context, todoItems(["a", "b"]));
    recordPageRevision(root, context, "a", { id: "a" });
    recordPageRevision(root, context, "b", { id: "b" });
    recordPageRevision(root, context, "c", { id: "c" });
    const blockers = blockersFor(root);
    const extra = blockers.find((blocker) => blocker.includes("pages not in todo"));
    assert.ok(extra, blockers.join("; "));
    assert.match(extra!, /c/);
  });

  it("unwritten plan pages are named as missing pages", () => {
    const root = ledgerRoot();
    recordTodo(root, context, todoItems(["a", "b"]));
    recordPageRevision(root, context, "a", { id: "a" });
    const blockers = blockersFor(root);
    const missing = blockers.find((blocker) => blocker.includes("missing pages"));
    assert.ok(missing, blockers.join("; "));
    assert.match(missing!, /b/);
  });

  it("same count with different identity still blocks", () => {
    const root = ledgerRoot();
    recordTodo(root, context, todoItems(["a", "b"]));
    recordPageRevision(root, context, "a", { id: "a" });
    recordPageRevision(root, context, "c", { id: "c" });
    const blockers = blockersFor(root);
    assert.ok(
      blockers.some((blocker) => blocker.includes("missing pages") && blocker.includes("b")),
      blockers.join("; "),
    );
    assert.ok(
      blockers.some((blocker) => blocker.includes("pages not in todo") && blocker.includes("c")),
      blockers.join("; "),
    );
  });

  it("write_page refuses a page id outside the plan but allows a rewrite", () => {
    const pageA = contentPage("a");
    const state = toolState(
      [
        { pageId: "a", title: "Title a", layoutFamily: "content", exhibits: [] },
        { pageId: "b", title: "Title b", layoutFamily: "content", exhibits: [] },
      ],
      [pageA],
    );
    const refused = executeGenerateTool(
      "write_page",
      {
        id: "c",
        pageType: "content",
        elements: contentPage("c").elements,
      },
      state,
    );
    assert.equal(refused.ok, false);
    assert.equal((refused.payload as { error?: string }).error, "not_in_plan");
    assert.match(refused.detail, /not in the current plan/);
    const rewrite = executeGenerateTool(
      "write_page",
      {
        id: "a",
        pageType: "content",
        elements: contentPage("a").elements,
      },
      state,
    );
    assert.equal(rewrite.ok, true);
  });

  it("legacy todo facts without pageIds keep the cardinality blocker", () => {
    const root = ledgerRoot();
    const file = path.join(root, "_agent", "run-ledger.v1.json");
    const ledger = JSON.parse(fs.readFileSync(file, "utf8")) as {
      facts: Array<Record<string, unknown>>;
    };
    ledger.facts.push({
      type: "todo.committed",
      factId: "legacy-todo",
      at: new Date().toISOString(),
      contextEpochId: EPOCH,
      todoSha256: "legacy",
      itemCount: 2,
    });
    fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
    recordPageRevision(root, context, "a", { id: "a" });
    recordPageRevision(root, context, "b", { id: "b" });
    recordPageRevision(root, context, "c", { id: "c" });
    const blockers = blockersFor(root);
    assert.ok(
      blockers.some((blocker) => /todo has 2 pages but 3 current page revisions exist/.test(blocker)),
      blockers.join("; "),
    );
  });
});
