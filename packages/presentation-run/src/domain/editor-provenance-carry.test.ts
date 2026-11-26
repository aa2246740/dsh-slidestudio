import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import type { ProvenanceDeclaration } from "@open-slidestudio/pptd-v2";
import { persistWrittenPages, type ToolExecution } from "./agent-tools.js";
import { buildDeliveryProvenance } from "./delivery-provenance.js";
import { recordEditorTurn } from "./editor-turn-authority.js";
import { recordPageProvenanceFact, type PageProvenanceFact } from "./material-figures.js";
import { loadPlaybook } from "./playbook.js";
import {
  ensureRunLedger,
  readRunLedger,
  recordPageRevision,
  recordTodo,
  type DeckComposedFact,
  type RunToolContext,
} from "./run-ledger.js";
import type { SkillPageInput } from "./skill-pages.js";
import { withWritePageRevision } from "./write-page-result.js";

const PAGE_ID = "p2";
const BASE_BODY = "二季度收入 1,234.5 万元，同比增长 12.5%";
const context: RunToolContext = { commandId: "cmd-edit", contextEpochId: "epoch-edit" };
const written: ToolExecution = {
  name: "write_page",
  ok: true,
  summary: "ok",
  detail: "ok",
  payload: { page: { id: PAGE_ID } },
};

function pageInput(): SkillPageInput {
  return {
    id: PAGE_ID,
    pageType: "content",
    elements: [
      {
        elementId: "bg",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color: "#FFFFFF" },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 40, 800, 60],
        content: { text: "收入趋势", fontSize: 32, color: "#111111" },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [80, 140, 800, 60],
        content: { text: BASE_BODY, fontSize: 20, color: "#111111" },
      },
    ],
  };
}

function setText(root: string, elementId: string, text: string): void {
  const project = loadProject(root);
  const loaded = project.pages.find((entry) => entry.path === `pages/${PAGE_ID}.page`)!;
  const element = loaded.page.elements.find((entry) => entry.elementId === elementId) as {
    content: { text: string };
  };
  element.content.text = text;
  saveProject(project);
}

function persistedPage(root: string) {
  return loadProject(root).pages.find((entry) => entry.path === `pages/${PAGE_ID}.page`)!.page;
}

/** The ledger revision a persisted page would get, as the post-write step records it. */
function recordCurrentRevision(root: string) {
  return recordPageRevision(root, context, PAGE_ID, { ...persistedPage(root), id: PAGE_ID });
}

type FixtureOptions = {
  declaration?: ProvenanceDeclaration | null;
  editorTurn?: boolean;
  lease?: "live" | "expired" | "none";
  baseline?: boolean;
};

/** A page at revision 1 (optionally declared) and an editor lease whose baseline is that page. */
function fixture(t: TestContext, options: FixtureOptions = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-provenance-carry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "carry" });
  persistWrittenPages({
    brief: "carry",
    playbook: loadPlaybook({ hostDefaults: false }),
    todos: [],
    researchNotes: [],
    writtenPages: [pageInput()],
    projectRoot: root,
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  recordTodo(root, context, [{ pageId: PAGE_ID, title: "收入趋势", layoutFamily: "content", exhibits: ["none"] }]);
  const first = recordCurrentRevision(root);
  assert.equal(first.revision, 1);
  const declaration = options.declaration === undefined ? { basis: "material" as const } : options.declaration;
  if (declaration) {
    recordPageProvenanceFact(root, context, {
      pageId: PAGE_ID,
      revision: first.revision,
      pageSha256: first.pageSha256,
      declaration,
    });
  }
  if (options.editorTurn !== false) recordEditorTurn(root, { authorizationId: "turn-1" });
  if (options.lease !== "none") {
    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: `pages/${PAGE_ID}.page`,
        expiresAt: Date.now() + (options.lease === "expired" ? -1 : 60_000),
        scope: { kind: "elements", pageId: PAGE_ID, elementIds: ["title"] },
        ...(options.baseline === false ? {} : { pageBody: persistedPage(root) }),
      }),
    );
  }
  return root;
}

function declarationsOf(root: string): PageProvenanceFact[] {
  return readRunLedger(root)!.facts.filter(
    (fact): fact is PageProvenanceFact => fact.type === "page.provenance-declared" && fact.pageId === PAGE_ID,
  );
}

function latestDeclaration(root: string) {
  return declarationsOf(root).at(-1);
}

function commitEdit(root: string, args: Record<string, unknown> = {}): void {
  withWritePageRevision(root, context, written, args);
}

describe("editor provenance carry", () => {
  it("carries a material declaration over a wording-only edit and records where it came from", (t) => {
    const root = fixture(t);
    setText(root, "title", "收入走势（修订）");
    commitEdit(root);

    const latest = latestDeclaration(root);
    assert.equal(latest?.revision, 2);
    assert.deepEqual(latest?.declaration, { basis: "material" });
    assert.equal(latest?.carriedFromRevision, 1);
    assert.equal(declarationsOf(root).length, 2);
  });

  it("carries an own declaration with its note unchanged", (t) => {
    const declaration = { basis: "own" as const, note: "团队自拟目标" };
    const root = fixture(t, { declaration });
    setText(root, "title", "目标说明");
    commitEdit(root);

    const latest = latestDeclaration(root);
    assert.equal(latest?.revision, 2);
    assert.deepEqual(latest?.declaration, declaration);
    assert.equal(latest?.carriedFromRevision, 1);
  });

  it("does not carry when a number changed", (t) => {
    const root = fixture(t);
    setText(root, "body", "二季度收入 1,234.6 万元，同比增长 12.5%");
    commitEdit(root);

    assert.equal(latestDeclaration(root)?.revision, 1);
    assert.equal(declarationsOf(root).length, 1);
  });

  it("does not carry when a number was added, removed or changed its unit", (t) => {
    for (const body of [
      "二季度收入 1,234.5 万元，同比增长 12.5%，占比 30%",
      "二季度收入 1,234.5 万元",
      "二季度收入 12.5 万元，同比增长 1,234.5%",
    ]) {
      const root = fixture(t);
      setText(root, "body", body);
      commitEdit(root);
      assert.equal(latestDeclaration(root)?.revision, 1, body);
    }
  });

  it("carries when the same numbers only move within the page text", (t) => {
    const root = fixture(t);
    setText(root, "body", "同比增长 12.5%，二季度收入 1,234.5 万元");
    commitEdit(root);
    assert.equal(latestDeclaration(root)?.revision, 2);
  });

  it("lets an explicit provenance win over the carried one", (t) => {
    const root = fixture(t);
    setText(root, "title", "收入走势（示意）");
    commitEdit(root, { provenance: { basis: "mock", note: "示意" } });

    const latest = latestDeclaration(root);
    assert.equal(latest?.revision, 2);
    assert.deepEqual(latest?.declaration, { basis: "mock", note: "示意" });
    assert.equal(latest?.carriedFromRevision, undefined);
    assert.equal(declarationsOf(root).length, 2);
  });

  it("does not carry outside an editor turn", (t) => {
    const root = fixture(t, { editorTurn: false });
    setText(root, "title", "生成回合重写");
    commitEdit(root);
    assert.equal(latestDeclaration(root)?.revision, 1);
  });

  it("does not carry without a live guard", (t) => {
    for (const lease of ["expired", "none"] as const) {
      const root = fixture(t, { lease });
      setText(root, "title", "无有效授权");
      commitEdit(root);
      assert.equal(latestDeclaration(root)?.revision, 1, lease);
    }
  });

  it("does not carry when the guard has no baseline page", (t) => {
    const root = fixture(t, { baseline: false });
    setText(root, "title", "没有基线");
    commitEdit(root);
    assert.equal(latestDeclaration(root)?.revision, 1);
  });

  it("does not carry when the previous revision declared nothing", (t) => {
    const root = fixture(t, { declaration: null });
    setText(root, "title", "此前无声明");
    commitEdit(root);
    assert.equal(declarationsOf(root).length, 0);
  });

  it("does not carry a declaration made for a different revision than the baseline", (t) => {
    const root = fixture(t);
    // The lock baseline is revision 1 but the page moved to revision 2 (with its own explicit
    // declaration) before this edit, so revision 1's declaration says nothing about it.
    setText(root, "body", "二季度收入 9.9 万元");
    const second = recordCurrentRevision(root);
    recordPageProvenanceFact(root, context, {
      pageId: PAGE_ID,
      revision: second.revision,
      pageSha256: second.pageSha256,
      declaration: { basis: "mock" },
    });
    setText(root, "body", BASE_BODY);
    commitEdit(root);

    const latest = latestDeclaration(root);
    assert.equal(latest?.revision, 2, "only the explicit revision-2 declaration exists");
    assert.deepEqual(latest?.declaration, { basis: "mock" });
  });

  it("chains a second wording-only edit under the same lease", (t) => {
    const root = fixture(t);
    setText(root, "title", "第一次改标题");
    commitEdit(root);
    setText(root, "title", "第二次改标题");
    commitEdit(root);

    const latest = latestDeclaration(root);
    assert.equal(latest?.revision, 3);
    assert.equal(latest?.carriedFromRevision, 2);
    assert.deepEqual(latest?.declaration, { basis: "material" });
  });

  it("carries an explicit declaration over the next number-preserving edit under the same lease", (t) => {
    for (const declaration of [{ basis: "material" as const }, { basis: "own" as const, note: "团队自拟目标" }]) {
      const root = fixture(t);
      setText(root, "title", "第一次改标题");
      commitEdit(root, { provenance: declaration });
      assert.equal(latestDeclaration(root)?.carriedFromRevision, undefined);

      setText(root, "title", "第二次改标题");
      commitEdit(root);

      const latest = latestDeclaration(root);
      assert.equal(latest?.revision, 3, declaration.basis);
      assert.deepEqual(latest?.declaration, declaration);
      assert.equal(latest?.carriedFromRevision, 2);
      assert.equal(declarationsOf(root).length, 3);
    }
  });

  it("keeps carrying an explicit declaration along a longer wording-only chain", (t) => {
    const root = fixture(t);
    setText(root, "title", "第一次改标题");
    commitEdit(root, { provenance: { basis: "own", note: "自拟" } });
    for (const title of ["第二次", "第三次", "第四次"]) {
      setText(root, "title", title);
      commitEdit(root);
    }
    const latest = latestDeclaration(root);
    assert.equal(latest?.revision, 5);
    assert.equal(latest?.carriedFromRevision, 4);
    assert.deepEqual(latest?.declaration, { basis: "own", note: "自拟" });
  });

  it("does not carry an explicit declaration over an edit that changed a number", (t) => {
    for (const body of [
      "二季度收入 1,234.6 万元，同比增长 12.5%",
      "二季度收入 1,234.5 万元，同比增长 12.5%，占比 30%",
      "二季度收入 1,234.5 万元",
      "二季度收入 12.5 万元，同比增长 1,234.5%",
    ]) {
      const root = fixture(t);
      setText(root, "title", "第一次改标题");
      commitEdit(root, { provenance: { basis: "material" } });
      setText(root, "body", body);
      commitEdit(root);
      assert.equal(latestDeclaration(root)?.revision, 2, body);
      assert.equal(declarationsOf(root).length, 2, body);
    }
  });

  it("does not carry an explicit declaration made for different numbers back onto the baseline's numbers", (t) => {
    const root = fixture(t);
    setText(root, "body", "二季度收入 7.7 万元");
    commitEdit(root, { provenance: { basis: "mock", note: "示意" } });
    setText(root, "body", BASE_BODY);
    commitEdit(root);

    const latest = latestDeclaration(root);
    assert.equal(latest?.revision, 2);
    assert.deepEqual(latest?.declaration, { basis: "mock", note: "示意" });
    assert.equal(declarationsOf(root).length, 2);
  });

  it("an explicit declaration in a chain reaches the delivery provenance", (t) => {
    const sealed = {
      contextEpochId: context.contextEpochId,
      deckSha256: "d".repeat(64),
      pageRevisions: { [PAGE_ID]: {} },
    } as unknown as DeckComposedFact;
    const root = fixture(t);
    setText(root, "title", "第一次改标题");
    commitEdit(root, { provenance: { basis: "material" } });
    setText(root, "title", "第二次改标题");
    commitEdit(root);
    assert.deepEqual(buildDeliveryProvenance(root, sealed).file.pages[0]?.declared, {
      basis: "material",
    });
  });

  it("a carried declaration reaches the delivery provenance and a changed number does not", (t) => {
    const sealed = {
      contextEpochId: context.contextEpochId,
      deckSha256: "d".repeat(64),
      pageRevisions: { [PAGE_ID]: {} },
    } as unknown as DeckComposedFact;

    const carried = fixture(t);
    setText(carried, "title", "收入走势（修订）");
    commitEdit(carried);
    const kept = buildDeliveryProvenance(carried, sealed).file.pages[0];
    assert.deepEqual(kept?.declared, { basis: "material" });

    const changed = fixture(t);
    setText(changed, "body", "二季度收入 7.7 万元");
    commitEdit(changed);
    const lost = buildDeliveryProvenance(changed, sealed).file.pages[0];
    assert.equal(lost?.declared, null);
  });
});
