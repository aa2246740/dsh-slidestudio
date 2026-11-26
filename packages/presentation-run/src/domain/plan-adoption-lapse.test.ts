import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import type { CommandContext, PresentationRun } from "../index.js";
import { listSourceReceipts } from "../receipts.js";
import { createPresentationRun } from "../run.js";
import type { DesignAspects } from "./design-aspects.js";
import { commitAdoptedDesignSources } from "./design-adoption.js";
import { writeDomainRuntime } from "./domain-hands.js";
import {
  SOURCE_ID,
  T1_COLORS,
  readMissingReferences,
  readTemplateDesign,
  writeTemplate,
} from "./deck-template.testkit.js";
import { EDITOR_AUTHORITY_LOST_DETAIL, recordEditorTurn } from "./editor-turn-authority.js";
import { holdProjectLockUntilLeaseLapses, leaseFile } from "./editor-lapse.testkit.js";
import { readCommittedPagePlan, readRunLedger } from "./run-ledger.js";

/**
 * Plan and design adoption as the Host reaches them: write_todo and commit_design through the real
 * run, and the adoption's own critical section. An accepted editor turn's lease lapses while the
 * write waits for the project write lock, so the write is refused inside the lock and persists
 * nothing. Genuine generation and a live editor lease still commit.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const BRIEF = "给董事会做一份上半年经营汇报。";
const RUNTIME_REL = path.join("_agent", "runtime.json");
const COVER_PLAN = [{ pageId: "cover", title: "公司介绍", layoutFamily: "cover", exhibits: [] }];
const FIRST_PLAN = [{ pageId: "p1", title: "封面", layoutFamily: "cover", exhibits: [] }];
const LAPSING_PLAN = [
  { pageId: "p1", title: "被改写的封面", layoutFamily: "cover", exhibits: [] },
  { pageId: "p2", title: "第二页", layoutFamily: "content", exhibits: [] },
];
/**
 * The declaration run.ts resolves for the attached template by default. A direct adoption call
 * must pass it: an empty list declares nothing, so the palette is never seeded and the lock is
 * never reached.
 */
const PALETTE_ASPECTS: DesignAspects = [{ source: SOURCE_ID, aspects: ["palette", "fonts", "logo"] }];

type Deck = {
  projectRoot: string;
  run: PresentationRun;
  context: Omit<CommandContext, "toolCallId">;
};

/** A deck with the attached template and, when strict, the run ledger every generated deck has. */
async function openDeck(t: TestContext, strictExecution: boolean): Promise<Deck> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-adoption-lapse-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const projectRoot = path.join(temp, "project");
  createEmptyProject(projectRoot, { title: "公司介绍" });
  writeTemplate(projectRoot);
  writeDomainRuntime(projectRoot, {
    brief: BRIEF,
    designDirection: "self-directed",
    strictExecution,
  });
  const run = createPresentationRun({ repoRoot: REPO_ROOT });
  const handle = await run.open({
    projectRoot,
    sessionId: "plan-adoption-lapse",
    brief: BRIEF,
    editorBaseUrl: "http://127.0.0.1:55200",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "offline" },
  });
  return {
    projectRoot,
    run,
    context: {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot,
      abortSignal: new AbortController().signal,
    },
  };
}

/**
 * A project with only the attached template, for the adoption's own critical section. The runtime
 * record is written as `open` writes it; adoption reads it.
 */
function templateProject(t: TestContext): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-adoption-lapse-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const projectRoot = path.join(temp, "project");
  createEmptyProject(projectRoot, { title: "公司介绍" });
  writeTemplate(projectRoot);
  writeDomainRuntime(projectRoot, {
    brief: BRIEF,
    designDirection: "self-directed",
    strictExecution: false,
  });
  return projectRoot;
}

/**
 * A live editor lease at deck level. The browser renews it while the accepted edit runs. A page
 * or element lease does not cover the deck theme, so an adoption under one is refused up front.
 */
function writeLease(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
  fs.writeFileSync(
    leaseFile(projectRoot),
    JSON.stringify({
      pagePath: "pages/p1.page",
      expiresAt: Date.now() + 60_000,
      scope: { kind: "deck", pageId: "p1", targetPageIds: ["p1"] },
    }),
  );
}

/** Everything an adoption writes: the deck with its theme, the runtime record and the receipts. */
function adoptionState(projectRoot: string): string {
  const runtime = path.join(projectRoot, RUNTIME_REL);
  return JSON.stringify({
    project: loadProject(projectRoot),
    runtime: fs.existsSync(runtime) ? fs.readFileSync(runtime, "utf8") : undefined,
    receipts: listSourceReceipts(projectRoot),
  });
}

it("write_todo keeps the committed plan when its lease lapses while the call waits for the project lock", async (t) => {
  const { projectRoot, run, context } = await openDeck(t, true);
  await readTemplateDesign(run, context, projectRoot, "todo-lapse");
  await readMissingReferences(run, context, "todo-lapse");
  // Generation: no lease and no accepted editor turn, so the first plan is written.
  const first = await run.execute(
    { name: "write_todo", args: { items: FIRST_PLAN, adoptedSourceIds: [SOURCE_ID] } },
    { ...context, toolCallId: "todo-first" },
  );
  assert.equal(first.ok, true, first.detail);
  const committed = JSON.stringify(readCommittedPagePlan(projectRoot));
  const ledger = JSON.stringify(readRunLedger(projectRoot));
  // An accepted editor turn holds a live lease. The lease lapses while this write waits for the lock.
  writeLease(projectRoot);
  recordEditorTurn(projectRoot, { authorizationId: "todo-lapse" });
  const holder = await holdProjectLockUntilLeaseLapses(projectRoot);
  const refused = await run.execute(
    { name: "write_todo", args: { items: LAPSING_PLAN, adoptedSourceIds: [SOURCE_ID] } },
    { ...context, toolCallId: "todo-lapse" },
  );
  await holder.released;
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(JSON.stringify(readCommittedPagePlan(projectRoot)), committed);
  assert.equal(JSON.stringify(readRunLedger(projectRoot)), ledger);
});

it("commit_design writes no plan, theme or adoption when its lease lapses while the call waits for the project lock", async (t) => {
  const { projectRoot, run, context } = await openDeck(t, true);
  await readTemplateDesign(run, context, projectRoot, "commit-lapse");
  await readMissingReferences(run, context, "commit-lapse");
  writeLease(projectRoot);
  recordEditorTurn(projectRoot, { authorizationId: "commit-lapse" });
  const before = JSON.stringify([readRunLedger(projectRoot), adoptionState(projectRoot)]);
  // commit_design reaches its plan write first, so the lapse is seen at the plan's lock.
  const holder = await holdProjectLockUntilLeaseLapses(projectRoot);
  const refused = await run.execute(
    { name: "commit_design", args: { slidePlan: COVER_PLAN, adoptedSourceIds: [SOURCE_ID] } },
    { ...context, toolCallId: "commit-lapse" },
  );
  await holder.released;
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(JSON.stringify([readRunLedger(projectRoot), adoptionState(projectRoot)]), before);
  assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, undefined);
});

it("the adoption saves no theme, runtime record or receipt when its lease lapses while it waits for the project lock", async (t) => {
  const projectRoot = templateProject(t);
  writeLease(projectRoot);
  recordEditorTurn(projectRoot, { authorizationId: "adoption-lapse" });
  const before = adoptionState(projectRoot);
  const holder = await holdProjectLockUntilLeaseLapses(projectRoot);
  const saved = commitAdoptedDesignSources(projectRoot, [SOURCE_ID], "adoption-lapse", PALETTE_ASPECTS, [
    { hex: "#1F4E9A", reason: "用户要求主色换成蓝色" },
  ]);
  await holder.released;
  assert.equal(saved.error, EDITOR_AUTHORITY_LOST_DETAIL, JSON.stringify(saved));
  assert.deepEqual(saved.adoptedSourceIds, []);
  assert.equal(adoptionState(projectRoot), before);
  assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, undefined);
});

it("a genuine generation adoption with no editor record still seeds the palette and records the adoption", (t) => {
  const projectRoot = templateProject(t);
  const saved = commitAdoptedDesignSources(projectRoot, [SOURCE_ID], "adoption-generation", PALETTE_ASPECTS);
  assert.equal(saved.error, undefined, saved.error);
  assert.deepEqual(saved.adoptedSourceIds, [SOURCE_ID]);
  assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, T1_COLORS.accent1);
  const runtime = JSON.parse(fs.readFileSync(path.join(projectRoot, RUNTIME_REL), "utf8")) as {
    adoptedSourceIds?: string[];
  };
  assert.deepEqual(runtime.adoptedSourceIds, [SOURCE_ID]);
});

it("a live editor lease still commits the plan and the adopted palette through run.execute", async (t) => {
  const { projectRoot, run, context } = await openDeck(t, true);
  await readTemplateDesign(run, context, projectRoot, "live-editor");
  await readMissingReferences(run, context, "live-editor");
  writeLease(projectRoot);
  recordEditorTurn(projectRoot, { authorizationId: "live-editor" });
  const committed = await run.execute(
    { name: "commit_design", args: { slidePlan: COVER_PLAN, adoptedSourceIds: [SOURCE_ID] } },
    { ...context, toolCallId: "live-editor" },
  );
  assert.equal(committed.ok, true, committed.detail);
  assert.deepEqual(
    readCommittedPagePlan(projectRoot).map((page) => page.pageId),
    ["cover"],
  );
  assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, T1_COLORS.accent1);
});

it("genuine generation keeps write_todo and commit_design through a run ledger, plan and theme", async (t) => {
  const { projectRoot, run, context } = await openDeck(t, true);
  await readTemplateDesign(run, context, projectRoot, "ledger-generation");
  await readMissingReferences(run, context, "ledger-generation");
  const committed = await run.execute(
    { name: "commit_design", args: { slidePlan: COVER_PLAN, adoptedSourceIds: [SOURCE_ID] } },
    { ...context, toolCallId: "ledger-generation" },
  );
  assert.equal(committed.ok, true, committed.detail);
  assert.deepEqual(
    readCommittedPagePlan(projectRoot).map((page) => page.pageId),
    ["cover"],
  );
  assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, T1_COLORS.accent1);
});
