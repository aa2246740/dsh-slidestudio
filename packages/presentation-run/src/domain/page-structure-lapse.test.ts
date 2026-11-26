import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { executeGenerateTool, persistWrittenPages, type AgentToolState } from "./agent-tools.js";
import { EDITOR_AUTHORITY_LOST_DETAIL, recordEditorTurn } from "./editor-turn-authority.js";
import { holdProjectLockUntilLeaseLapses, leaseFile } from "./editor-lapse.testkit.js";
import { loadPlaybook } from "./playbook.js";
import { persistPageKey } from "./page-identity.js";
import { recordPageRevision } from "./page-revision-ledger.js";
import { ensureRunLedger, recordTodo } from "./run-ledger.js";
import type { SkillPageInput } from "./skill-pages.js";

const planContext = { commandId: "page-structure-lapse", contextEpochId: "lapse-epoch" };

/** A page the agent wrote: a background rectangle and one title. */
function page(id: string, title: string): SkillPageInput {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#06223F" },
      },
      {
        elementId: "t",
        elementType: "text",
        bounds: [80, 160, 800, 80],
        content: { text: title, fontSize: 36, color: "#FFFFFF" },
      },
    ],
  };
}

function stateFor(root: string, pages: readonly SkillPageInput[], extra: Partial<AgentToolState> = {}): AgentToolState {
  return {
    brief: "编辑授权",
    playbook: loadPlaybook({ hostDefaults: false }),
    todos: [],
    researchNotes: [],
    writtenPages: [...pages],
    projectRoot: root,
    ...extra,
  };
}

/**
 * A generated deck: three agent-written pages, the run ledger every generated deck has, and a
 * committed plan that no longer lists p2. p2 is an extra page, so generation cleanup may delete it.
 * Only the editor authority stands between a lapsed editor turn and that delete.
 */
function fixture(t: TestContext): { root: string; pages: SkillPageInput[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-structure-lapse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "编辑授权" });
  const pages = [page("p1", "封面"), page("p2", "第二页"), page("p3", "第三页")];
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  const written = persistWrittenPages(stateFor(root, pages), pages);
  assert.equal(written.ok, true, JSON.stringify(written));
  recordTodo(
    root,
    planContext,
    ["p1", "p3"].map((pageId) => ({
      pageId,
      title: pageId,
      layoutFamily: "content",
      exhibits: [],
    })),
  );
  // Each current page carries the revision that generation cleanup checks against the disk.
  for (const entry of loadProject(root).pages) {
    const id = persistPageKey(entry.path);
    recordPageRevision(root, planContext, id, { ...entry.page, id });
  }
  return { root, pages };
}

/** The lease an editor turn holds while its authorization is live: a deck-level scope. */
function writeLease(root: string, scope: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    leaseFile(root),
    JSON.stringify({
      pagePath: "pages/p1.page",
      expiresAt: Date.now() + 60_000,
      scope: { kind: "deck", ...scope },
    }),
  );
}

const pageOrder = (root: string) => loadProject(root).pages.map((entry) => entry.path);

it("a lapsed accepted editor turn on a generated deck cannot delete a page as generation cleanup", (t) => {
  const { root, pages } = fixture(t);
  recordEditorTurn(root, { authorizationId: "delete-lapse" });
  // The browser closed and the lease lapsed. The turn is still an editor turn, not generation.
  const before = JSON.stringify(loadProject(root).pages);
  const denied = executeGenerateTool(
    "delete_pages",
    { pageIds: ["p2"] },
    stateFor(root, pages, { strictLedger: true }),
  );
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal((denied.payload as { error?: string } | undefined)?.error, "review_scope_violation");
  assert.equal(denied.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(JSON.stringify(loadProject(root).pages), before);
});

it("genuine generation cleanup still deletes the page the committed plan no longer lists", (t) => {
  const { root, pages } = fixture(t);
  // No editor record and no lease: this is generation, so the same extra page may be removed.
  const deleted = executeGenerateTool(
    "delete_pages",
    { pageIds: ["p2"] },
    stateFor(root, pages, { strictLedger: true }),
  );
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.deepEqual((deleted.payload as { deleted?: string[] }).deleted, ["p2"]);
  assert.equal(loadProject(root).pages.length, 2);
});

it("a structural delete whose lease lapses while it waits for the project lock is refused inside the lock", async (t) => {
  const { root, pages } = fixture(t);
  writeLease(root, { structureOnly: true, deletablePageIds: ["p2"] });
  recordEditorTurn(root, { authorizationId: "delete-in-lock" });
  const before = JSON.stringify(loadProject(root).pages);
  // The lease is still live when the call checks it, then lapses while the call waits for the lock.
  const holder = await holdProjectLockUntilLeaseLapses(root);
  const refused = executeGenerateTool("delete_pages", { pageIds: ["p2"] }, stateFor(root, pages));
  await holder.released;
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(JSON.stringify(loadProject(root).pages), before);
});

it("a structural reorder whose lease lapses while it waits for the project lock is refused inside the lock", async (t) => {
  const { root, pages } = fixture(t);
  writeLease(root, { structureOnly: true, reorderPageIds: ["p3", "p1", "p2"] });
  recordEditorTurn(root, { authorizationId: "reorder-in-lock" });
  const before = pageOrder(root);
  const holder = await holdProjectLockUntilLeaseLapses(root);
  const refused = executeGenerateTool("reorder_pages", { pageIds: ["p3", "p1", "p2"] }, stateFor(root, pages));
  await holder.released;
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.deepEqual(pageOrder(root), before);
});

it("a deck-title edit whose lease lapses while it waits for the project lock is refused inside the lock", async (t) => {
  const { root, pages } = fixture(t);
  writeLease(root, { editableMeta: ["title"] });
  recordEditorTurn(root, { authorizationId: "title-in-lock" });
  const before = loadProject(root).presentation.title;
  const holder = await holdProjectLockUntilLeaseLapses(root);
  const refused = executeGenerateTool("update_deck", { title: "改过的标题" }, stateFor(root, pages));
  await holder.released;
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(loadProject(root).presentation.title, before);
});

it("a lapsed accepted editor turn cannot persist a page write", (t) => {
  const { root, pages } = fixture(t);
  recordEditorTurn(root, { authorizationId: "page-lapse" });
  const before = JSON.stringify(loadProject(root).pages);
  const refused = persistWrittenPages(stateFor(root, pages), [page("p2", "被改写的第二页")]);
  if (refused.ok) assert.fail("a lapsed editor turn must not persist a page");
  assert.equal(refused.error, "review_scope_violation");
  assert.equal(refused.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(JSON.stringify(loadProject(root).pages), before);
});
