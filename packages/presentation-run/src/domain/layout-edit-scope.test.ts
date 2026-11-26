import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import type { ToolExecution } from "./agent-tools.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { EDITOR_AUTHORITY_LOST_DETAIL, recordEditorTurn } from "./editor-turn-authority.js";
import { holdProjectLockUntilLeaseLapses, leaseFile } from "./editor-lapse.testkit.js";
import { ensureRunLedger } from "./run-ledger.js";

const context = { commandId: "layout-edit-scope", contextEpochId: "layout-edit-epoch" };

/** Tool payloads are JSON receipts; each test reads the named fields it asserts. */
type Receipt = Omit<ToolExecution, "payload"> & { payload: Record<string, unknown> };

async function call(root: string, name: string, args: Record<string, unknown>): Promise<Receipt> {
  const result = await runDomainHand(name, { ...args, __openSlideStudio: context }, root);
  return { ...result, payload: result.payload as Record<string, unknown> };
}

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-edit-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "版式" });
  writeDomainRuntime(root, { brief: "制作 4 页带统一版式的汇报。" });
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
  return root;
}

const logo = (x: number) => ({
  elementId: "logo",
  elementType: "image",
  bounds: [x, 20, 80, 40],
  src: "media/logo-a.png",
});
const master = {
  scope: "master",
  id: "main",
  name: "母版",
  elements: [
    {
      elementId: "footer",
      elementType: "text",
      bounds: [80, 500, 600, 40],
      content: { text: "页脚", fontSize: 20 },
    },
  ],
};
const bodyLayout = (x: number) => ({
  scope: "layout",
  id: "body",
  name: "正文",
  masterId: "main",
  elements: [logo(x)],
});

/** The lock the editor writes for an AI turn: a page-scope grant with the turn's own scope fields. */
function writeLock(root: string, scope: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({
      pagePath: "pages/page-1.page",
      scope: { kind: "page", pageId: "page-1", targetPageIds: ["page-1"], ...scope },
      expiresAt: Date.now() + 60_000,
    }),
  );
}

const layoutGrant = { editableMeta: ["layouts"], layoutId: "body", layoutName: "正文" };

it("a page-mode lock refuses write_layout in Chinese and leaves the layout unchanged", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const first = await call(root, "write_layout", bodyLayout(860));
  assert.equal(first.ok, true, first.detail);
  const before = JSON.stringify(loadProject(root).presentation.layouts);
  writeLock(root, {});
  const moved = await call(root, "write_layout", {
    ...bodyLayout(40),
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.payload.error, "layout_scope_refused");
  assert.match(String(moved.detail), /编辑版式/);
  assert.equal(JSON.stringify(loadProject(root).presentation.layouts), before);
});

it("a layout-mode lock writes its own layout with the current hash and refuses a stale one", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const first = await call(root, "write_layout", bodyLayout(860));
  assert.equal(first.ok, true, first.detail);
  writeLock(root, layoutGrant);
  const moved = await call(root, "write_layout", {
    ...bodyLayout(40),
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  assert.equal(moved.ok, true, moved.detail);
  assert.equal(moved.payload.outcome, "written");
  assert.equal(moved.payload.revision, 2);
  const stale = await call(root, "write_layout", {
    ...bodyLayout(10),
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.payload.error, "layout_stale");
});

it("a layout-mode lock refuses another layout, the master and an unhashed write in Chinese", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const first = await call(root, "write_layout", bodyLayout(860));
  assert.equal(first.ok, true, first.detail);
  const before = JSON.stringify(loadProject(root).presentation);
  writeLock(root, layoutGrant);
  const other = await call(root, "write_layout", {
    scope: "layout",
    id: "cover",
    name: "封面",
    elements: [logo(860)],
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  assert.equal(other.payload.error, "layout_scope_refused");
  assert.match(String(other.detail), /只能修改版式『正文』/);
  const masterWrite = await call(root, "write_layout", {
    ...master,
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  assert.equal(masterWrite.payload.error, "layout_scope_refused");
  assert.match(String(masterWrite.detail), /只能修改版式『正文』/);
  const unhashed = await call(root, "write_layout", bodyLayout(40));
  assert.equal(unhashed.payload.error, "layout_scope_refused");
  assert.match(String(unhashed.detail), /expectedLayoutSha256/);
  assert.equal(JSON.stringify(loadProject(root).presentation), before);
});

it("an accepted layout-mode turn whose lease lapsed cannot write any layout", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const first = await call(root, "write_layout", bodyLayout(860));
  assert.equal(first.ok, true, first.detail);
  recordEditorTurn(root, { authorizationId: "layout-lapse" });
  writeLock(root, layoutGrant);
  // The browser closed. The accepted turn keeps running, but its lease has lapsed.
  fs.rmSync(leaseFile(root));
  const before = JSON.stringify(loadProject(root).presentation);
  const moved = await call(root, "write_layout", {
    ...bodyLayout(40),
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  assert.equal(moved.ok, false, moved.detail);
  assert.equal(moved.payload.error, "layout_scope_refused");
  assert.equal(moved.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  const cover = await call(root, "write_layout", {
    scope: "layout",
    id: "cover",
    name: "封面",
    elements: [logo(860)],
  });
  assert.equal(cover.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  const again = await call(root, "write_layout", master);
  assert.equal(again.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(JSON.stringify(loadProject(root).presentation), before);
});

it("an accepted page-mode turn whose lease lapsed cannot write a layout", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const first = await call(root, "write_layout", bodyLayout(860));
  assert.equal(first.ok, true, first.detail);
  recordEditorTurn(root, { authorizationId: "page-lapse" });
  writeLock(root, {});
  fs.rmSync(leaseFile(root));
  const before = JSON.stringify(loadProject(root).presentation);
  const moved = await call(root, "write_layout", {
    ...bodyLayout(40),
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  assert.equal(moved.ok, false, moved.detail);
  assert.equal(moved.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(JSON.stringify(loadProject(root).presentation), before);
});

it("a generation run with no lock and no editor turn record still defines masters and layouts", async (t) => {
  const root = fixture(t);
  const defined = await call(root, "write_layout", master);
  assert.equal(defined.ok, true, defined.detail);
  const body = await call(root, "write_layout", bodyLayout(860));
  assert.equal(body.ok, true, body.detail);
  assert.equal(body.payload.outcome, "written");
  assert.equal(body.payload.revision, 1);
});

it("a layout-mode lease that lapses while the write waits for the project lock is refused inside the lock", async (t) => {
  const root = fixture(t);
  assert.equal((await call(root, "write_layout", master)).ok, true);
  const first = await call(root, "write_layout", bodyLayout(860));
  assert.equal(first.ok, true, first.detail);
  recordEditorTurn(root, { authorizationId: "layout-in-lock" });
  writeLock(root, layoutGrant);
  const before = JSON.stringify(loadProject(root).presentation);
  const holder = await holdProjectLockUntilLeaseLapses(root);
  const moved = await call(root, "write_layout", {
    ...bodyLayout(40),
    expectedLayoutSha256: first.payload.layoutSha256,
  });
  await holder.released;
  assert.equal(moved.ok, false, moved.detail);
  assert.equal(moved.detail, EDITOR_AUTHORITY_LOST_DETAIL);
  assert.equal(JSON.stringify(loadProject(root).presentation), before);
});
