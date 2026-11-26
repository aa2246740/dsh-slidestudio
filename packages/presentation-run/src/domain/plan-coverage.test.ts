import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { persistPageKey } from "./page-identity.js";
import { ensureRunLedger, inspectRunLedger, recordPageRevision, recordTodo } from "./run-ledger.js";
import { buildToolState } from "./hands-tool-state.js";
import { planCoverage } from "./plan-coverage.js";

const context = { commandId: "coverage-fixture", contextEpochId: "coverage-epoch" };
const plan = (...ids: string[]) =>
  ids.map((pageId) => ({
    pageId,
    title: `协作环节 ${pageId}`,
    layoutFamily: "content",
    exhibits: ["none"],
  }));
const page = (id: string) => ({
  id,
  pageType: "content",
  elements: [
    {
      elementId: "title",
      elementType: "text",
      bounds: [80, 80, 800, 70],
      content: { text: "明确协作职责", fontSize: 32 },
    },
    {
      elementId: "body",
      elementType: "text",
      bounds: [80, 200, 800, 160],
      content: { text: "核对输入信息，明确负责人，并记录交付结果。", fontSize: 24 },
    },
  ],
});

function fixture(t: TestContext, brief = "制作 1 页协作流程介绍。"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-coverage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "协作流程" });
  writeDomainRuntime(root, { brief });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  recordTodo(root, context, plan("p09_a"));
  return root;
}

async function call(root: string, name: string, args: Record<string, unknown> = {}) {
  return runDomainHand(name, { ...args, __openSlideStudio: context }, root);
}
function ids(root: string): string[] {
  return loadProject(root).pages.map((entry) => persistPageKey(entry.path));
}
function payload(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  assert.ok(result.payload && typeof result.payload === "object");
  return result.payload as Record<string, unknown>;
}
async function drift(root: string) {
  const written = await call(root, "write_page", page("p09_a"));
  assert.equal(written.ok, true, written.detail);
  return call(root, "write_todo", { items: plan("p09_b") });
}

it("write_todo reports orphan pages without deleting or fabricating pages", async (t) => {
  const root = fixture(t);
  const result = await drift(root);
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(payload(result).notInPlan, ["p09_a"]);
  assert.match(result.detail, /这些已写页面不在新计划中：p09_a。合稿前请把它们放回计划，或用 delete_pages 删除。/);
  assert.deepEqual(ids(root), ["p09_a"]);
});

it("review_pages reports missing and extra plan pages from disk, not the saved buffer", async (t) => {
  const root = fixture(t);
  await drift(root);
  const review = await call(root, "review_pages");
  assert.equal(review.ok, false, review.detail);
  assert.deepEqual(payload(review).missing, ["p09_b"]);
  assert.deepEqual(payload(review).extra, ["p09_a"]);
  assert.match(review.detail, /计划中还没写的页面：p09_b；已写但不在最新计划里的页面：p09_a/);
  const issues = payload(review).issues as { pageId: string; code: string }[];
  assert.ok(issues.some((issue) => issue.pageId === "p09_b"));
  assert.ok(issues.some((issue) => issue.pageId === "p09_a"));
  assert.deepEqual(ids(root), ["p09_a"]);
});

it("the agent can delete its orphan after replanning and then compose the remaining planned page", async (t) => {
  const root = fixture(t);
  await drift(root);
  const written = await call(root, "write_page", page("p09_b"));
  assert.equal(written.ok, true, written.detail);
  const review = await call(root, "review_pages");
  assert.equal(review.ok, false, review.detail);
  assert.deepEqual(payload(review).missing, []);
  assert.deepEqual(payload(review).extra, ["p09_a"]);
  const removed = await call(root, "delete_pages", { pageIds: ["p09_a"] });
  assert.equal(removed.ok, true, removed.detail);
  assert.deepEqual(payload(removed).deleted, ["p09_a"]);
  assert.deepEqual(ids(root), ["p09_b"]);
  assert.equal(fs.existsSync(path.join(root, "pages/p09_a.page")), false);
  const finalReview = await call(root, "review_pages");
  assert.equal(finalReview.ok, true, finalReview.detail);
  const composed = await call(root, "compose_deck", { title: "协作流程" });
  assert.equal(composed.ok, true, composed.detail);
  assert.deepEqual(ids(root), ["p09_b"]);
  assert.equal(inspectRunLedger(root).composed, true);
});

it("generation refuses deleting planned pages in Chinese and leaves the batch untouched", async (t) => {
  const root = fixture(t);
  await drift(root);
  assert.equal((await call(root, "write_page", page("p09_b"))).ok, true);
  const result = await call(root, "delete_pages", { pageIds: ["p09_a", "p09_b"] });
  assert.equal(result.ok, false);
  assert.match(result.detail, /p09_b.*仍在最新计划中.*不能删除/);
  assert.deepEqual(ids(root), ["p09_a", "p09_b"]);
});

it("generation refuses a page not authored by this run and refuses later external changes", async (t) => {
  const root = fixture(t);
  await drift(root);
  const project = loadProject(root);
  project.pages.push({ path: "pages/foreign.page", page: structuredClone(project.pages[0]!.page) });
  project.presentation.pages = project.pages.map((entry) => entry.path);
  saveProject(project);
  const foreign = await call(root, "delete_pages", { pageIds: ["foreign"] });
  assert.equal(foreign.ok, false);
  assert.match(foreign.detail, /foreign.*不是本次 Agent 写入.*不能删除/);
  project.pages[0]!.page.notes = "外部人工修订";
  saveProject(project);
  const changed = await call(root, "delete_pages", { pageIds: ["p09_a"] });
  assert.equal(changed.ok, false);
  assert.match(changed.detail, /p09_a.*不是本次 Agent 写入.*不能删除/);
  assert.deepEqual(ids(root), ["p09_a", "foreign"]);
});

it("write_todo refuses a plan that breaks an explicit count and leaves other totals alone", async (t) => {
  const rejectedRoot = fixture(t, "制作 4 页协作流程介绍。");
  const rejected = await call(rejectedRoot, "write_todo", { items: plan("p09_b") });
  assert.equal(rejected.ok, false, rejected.detail);
  assert.equal(payload(rejected).error, "page_count_mismatch");
  assert.match(rejected.detail, /明确要求.*4.*页.*计划.*1.*页/);

  for (const [brief, count] of [
    ["制作 1 页协作流程介绍。", 1],
    ["制作协作流程介绍。", 1],
  ] as const) {
    const root = fixture(t, brief);
    const result = await call(root, "write_todo", {
      items: plan(...Array(count).fill("p09_b")),
    });
    assert.equal(result.ok, true, result.detail);
    assert.equal(/明确要求.*页.*计划/.test(result.detail), false, result.detail);
  }
});

it("planCoverage canonicalizes ids and uses disk pages rather than revision facts", async (t) => {
  const root = fixture(t);
  await drift(root);
  const before = fs.readFileSync(path.join(root, "deck.pptd"));
  assert.deepEqual(planCoverage(root, plan("pages/p09_b.page")), {
    missing: ["p09_b"],
    extra: ["p09_a"],
  });
  recordPageRevision(root, context, "phantom", { id: "phantom" });
  assert.deepEqual(planCoverage(root, plan("p09_b")), {
    missing: ["p09_b"],
    extra: ["p09_a"],
  });
  assert.deepEqual(fs.readFileSync(path.join(root, "deck.pptd")), before);
});

it("keeps revision evidence for disk page ids with leading zeroes", (t) => {
  const root = fixture(t);
  const project = loadProject(root);
  const authored: (typeof project.pages)[number]["page"] = {
    pageType: "content",
    elements: [],
  };
  project.pages.push({ path: "pages/01_page.page", page: authored });
  project.presentation.pages = project.pages.map((entry) => entry.path);
  saveProject(project);
  recordPageRevision(root, context, "01_page", { ...authored, id: "01_page" });
  recordTodo(root, context, plan("01_page"));

  const status = inspectRunLedger(root);
  assert.deepEqual(planCoverage(root, plan("01_page")), { missing: [], extra: [] });
  assert.ok(status.pages.some((entry) => entry.pageId === "01_page"));
  assert.ok(!status.composeBlockers.some((blocker) => blocker.includes("todo missing pages")));
});

it("buildToolState merges disk pages only for a live structural edit, not generation or rewrite", async (t) => {
  const root = fixture(t);
  await drift(root);
  const lock = path.join(root, "_agent", "ai-review-lock.v1.json");
  for (const scope of [
    undefined,
    { kind: "page", pageId: "p09_a" },
    { kind: "deck", rewrite: true },
    { kind: "deck", structureOnly: true },
  ]) {
    if (scope) fs.writeFileSync(lock, JSON.stringify({ scope, expiresAt: Date.now() + 60_000 }));
    const state = buildToolState(root, { brief: "协作流程" }, { todos: [], writtenPages: [] });
    assert.deepEqual(
      state.todos.map((todo) => todo.pageId),
      scope && "structureOnly" in scope ? ["p09_b", "p09_a"] : ["p09_b"],
    );
  }
});

it("empty disk does not replay the stale buffer and review still reports missing plan pages", async (t) => {
  const root = fixture(t);
  await drift(root);
  assert.equal((await call(root, "delete_pages", { pageIds: ["p09_a"] })).ok, true);
  const review = await call(root, "review_pages");
  assert.equal(review.ok, false);
  assert.deepEqual(payload(review).missing, ["p09_b"]);
  assert.deepEqual(payload(review).extra, []);
  assert.deepEqual(ids(root), []);
});

it("a seeded revision without an agent write is not deletion authority or compose coverage", async (t) => {
  const root = fixture(t, "1 到 3 页协作流程介绍。");
  await drift(root);
  const project = loadProject(root);
  const foreign = { path: "pages/foreign.page", page: structuredClone(project.pages[0]!.page) };
  project.pages.push(foreign);
  project.presentation.pages = project.pages.map((entry) => entry.path);
  saveProject(project);
  recordPageRevision(root, context, "foreign", { ...foreign.page, id: "foreign" });
  const result = await call(root, "delete_pages", { pageIds: ["foreign"] });
  assert.equal(result.ok, false);
  assert.match(result.detail, /foreign.*不是本次 Agent 写入.*不能删除/);
  await call(root, "write_todo", { items: plan("p09_a", "foreign", "absent") });
  const absent = { path: "pages/absent.page", page: structuredClone(foreign.page) };
  project.pages.push(absent);
  project.presentation.pages = project.pages.map((entry) => entry.path);
  saveProject(project);
  assert.equal((await call(root, "review_pages")).ok, true);
  const compose = await call(root, "compose_deck", { title: "协作流程" });
  assert.equal(compose.ok, false);
  assert.match(compose.detail, /todo missing pages: absent/);
});
