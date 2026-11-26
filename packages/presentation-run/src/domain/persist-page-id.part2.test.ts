import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import type { SkillPageInput } from "./skill-pages.js";
import { executeGenerateTool, persistWrittenPages } from "./agent-tools.js";
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

describe("structural page-list edit guard", () => {
  function fixture(insertIndex: number) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "structural-edit-"));
    createEmptyProject(root, { title: "Structural" });
    persistAll(root, [
      pageWithCopy("p1", "cover", "Cover"),
      pageWithCopy("p2", "content", "Second"),
      pageWithCopy("p3", "content", "Third"),
    ]);
    const project = loadProject(root);
    const projectPages = project.pages.map((entry) => ({
      pageId: entry.path.replace(/^pages\//, "").replace(/\.page$/, ""),
      pagePath: entry.path,
      pageSha256: stableSha256({
        id: entry.path.replace(/^pages\//, "").replace(/\.page$/, ""),
        ...entry.page,
      }),
    }));
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/p1.page",
        expiresAt: Date.now() + 60_000,
        scope: {
          kind: "deck",
          pageId: "p1",
          elementIds: [],
          targetPageIds: ["p1", "p2", "p3"],
          structureOnly: true,
          insertIndex,
        },
        projectPages,
      }),
    );
    const state = {
      brief: "Structural",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [],
      projectRoot: root,
    };
    const sha = (id: string) =>
      stableSha256({
        ...loadProject(root).pages.find((p) => p.path === `pages/${id}.page`)!.page,
        id,
      });
    return { root, state, sha };
  }

  it("writes a new page without CAS and inserts it at insertIndex", () => {
    const f = fixture(1);
    const p2Bytes = fs.readFileSync(path.join(f.root, "pages/p2.page"), "utf8");
    const result = persistWrittenPages(f.state, [pageWithCopy("new_closing", "final", "再见页")]);
    assert.equal(result.ok, true, JSON.stringify(result));
    const order = loadProject(f.root).pages.map((entry) => entry.path);
    assert.equal(order.length, 4);
    assert.equal(order[1], "pages/new_closing.page");
    assert.equal(fs.readFileSync(path.join(f.root, "pages/p2.page"), "utf8"), p2Bytes);
  });

  it("appends when insertIndex reaches the end and keeps write order for sequential inserts", () => {
    const f = fixture(3);
    assert.equal(persistWrittenPages(f.state, [pageWithCopy("n1", "final", "第一页新增")]).ok, true);
    assert.equal(persistWrittenPages(f.state, [pageWithCopy("n2", "final", "第二页新增")]).ok, true);
    const order = loadProject(f.root).pages.map((entry) => entry.path);
    assert.deepEqual(order.slice(3), ["pages/n1.page", "pages/n2.page"]);
  });

  it("lands sequential mid-deck inserts after the pages this turn already added", () => {
    const f = fixture(1);
    assert.equal(persistWrittenPages(f.state, [pageWithCopy("n1", "content", "插入一")]).ok, true);
    assert.equal(persistWrittenPages(f.state, [pageWithCopy("n2", "content", "插入二")]).ok, true);
    const order = loadProject(f.root).pages.map((entry) => entry.path);
    assert.deepEqual(order, ["pages/p1.page", "pages/n1.page", "pages/n2.page", "pages/p2.page", "pages/p3.page"]);
  });

  it("rejects writes to existing pages even with a valid CAS", () => {
    const f = fixture(3);
    const result = persistWrittenPages(f.state, [pageWithCopy("p2", "content", "不许改")], {
      expectedPageSha256: f.sha("p2"),
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("structural guard must not allow editing an existing page");
    assert.equal(result.error, "review_scope_violation");
    assert.match(JSON.stringify(loadProject(f.root).pages.find((p) => p.path === "pages/p2.page")!.page), /Second/);
  });

  it("rejects a multi-page structural write and a stale CAS on a new page", () => {
    const f = fixture(3);
    const multi = persistWrittenPages(f.state, [pageWithCopy("n1", "final", "一"), pageWithCopy("n2", "final", "二")]);
    assert.equal(multi.ok, false);
    if (multi.ok) assert.fail("structural writes stay single-page like every write_page call");
    const staleCas = persistWrittenPages(f.state, [pageWithCopy("n1", "final", "一")], {
      expectedPageSha256: "f".repeat(64),
    });
    assert.equal(staleCas.ok, false);
    if (staleCas.ok) assert.fail("a fabricated CAS must not bless a new page");
    assert.equal(staleCas.error, "page_revision_conflict");
  });

  it("a non-structural deck guard still cannot create pages", () => {
    const f = fixture(3);
    fs.writeFileSync(
      path.join(f.root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/p1.page",
        expiresAt: Date.now() + 60_000,
        scope: { kind: "deck", pageId: "p1", elementIds: [], targetPageIds: ["p1", "p2", "p3"] },
      }),
    );
    const result = persistWrittenPages(f.state, [pageWithCopy("n1", "final", "新页")]);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("a plain deck scope must not grow the page list");
    assert.equal(result.error, "page_revision_required");
  });

  it("whitelists editable baseline pages while every other existing page stays frozen", () => {
    const f = fixture(3);
    const lock = JSON.parse(fs.readFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), "utf8"));
    lock.scope.editablePageIds = ["p2"];
    fs.writeFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), JSON.stringify(lock));
    // Whitelisted page: CAS-guarded write succeeds.
    const allowed = persistWrittenPages(f.state, [pageWithCopy("p2", "content", "改成这样")], {
      expectedPageSha256: f.sha("p2"),
    });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.match(JSON.stringify(loadProject(f.root).pages.find((p) => p.path === "pages/p2.page")!.page), /改成这样/);
    // Whitelisted page still requires CAS.
    const noCas = persistWrittenPages(f.state, [pageWithCopy("p2", "content", "无校验")]);
    assert.equal(noCas.ok, false);
    if (noCas.ok) assert.fail("an editable baseline page still needs its CAS");
    assert.equal(noCas.error, "page_revision_required");
    // Non-whitelisted page stays frozen even with a valid CAS.
    const denied = persistWrittenPages(f.state, [pageWithCopy("p3", "content", "不许改")], {
      expectedPageSha256: f.sha("p3"),
    });
    assert.equal(denied.ok, false);
    if (denied.ok) assert.fail("editablePageIds is a whitelist, not a blanket grant");
    assert.equal(denied.error, "review_scope_violation");
    assert.match(JSON.stringify(loadProject(f.root).pages.find((p) => p.path === "pages/p3.page")!.page), /Third/);
    // Adding still works alongside the editable whitelist.
    assert.equal(persistWrittenPages(f.state, [pageWithCopy("n1", "final", "新页")]).ok, true);
    assert.equal(loadProject(f.root).pages.length, 4);
  });

  it("delete_pages removes only the authorized page, updates the manifest and the file", () => {
    const f = fixture(3);
    const lock = JSON.parse(fs.readFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), "utf8"));
    lock.scope.deletablePageIds = ["p2"];
    fs.writeFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), JSON.stringify(lock));
    const result = executeGenerateTool("delete_pages", { pageIds: ["p2"] }, f.state);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.existsSync(path.join(f.root, "pages/p2.page")), false);
    assert.deepEqual(
      loadProject(f.root).pages.map((entry) => entry.path),
      ["pages/p1.page", "pages/p3.page"],
    );
    // Remaining page content untouched.
    assert.match(fs.readFileSync(path.join(f.root, "pages/p3.page"), "utf8"), /Third/);
  });

  it("delete_pages refuses pages outside the authorized set and reports missing ids", () => {
    const f = fixture(3);
    const lock = JSON.parse(fs.readFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), "utf8"));
    lock.scope.deletablePageIds = ["p2"];
    fs.writeFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), JSON.stringify(lock));
    const denied = executeGenerateTool("delete_pages", { pageIds: ["p2", "p3"] }, f.state);
    assert.equal(denied.ok, false);
    assert.equal((denied.payload as { error?: string } | undefined)?.error, "review_scope_violation");
    assert.equal(loadProject(f.root).pages.length, 3, "nothing may be removed on a denied call");
    const missing = executeGenerateTool("delete_pages", { pageIds: ["p2", "ghost"] }, f.state);
    assert.equal(missing.ok, false);
    assert.equal(
      (missing.payload as { error?: string } | undefined)?.error,
      "review_scope_violation",
      "unauthorized ghost id must fail before deletion",
    );
    assert.equal(loadProject(f.root).pages.length, 3);
  });

  it("delete_pages without a deletable grant is refused even under a structural lock", () => {
    const f = fixture(3);
    const denied = executeGenerateTool("delete_pages", { pageIds: ["p2"] }, f.state);
    assert.equal(denied.ok, false);
    assert.equal((denied.payload as { error?: string } | undefined)?.error, "review_scope_violation");
    assert.equal(loadProject(f.root).pages.length, 3);
  });

  it("reorder_pages applies exactly the authorized permutation and touches no page content", () => {
    const f = fixture(3);
    const lock = JSON.parse(fs.readFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), "utf8"));
    delete lock.scope.insertIndex;
    lock.scope.reorderPageIds = ["p3", "p1", "p2"];
    fs.writeFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), JSON.stringify(lock));
    const bytesBefore = Object.fromEntries(
      loadProject(f.root).pages.map((entry) => [entry.path, fs.readFileSync(path.join(f.root, entry.path), "utf8")]),
    );
    const result = executeGenerateTool("reorder_pages", { pageIds: ["p3", "p1", "p2"] }, f.state);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      loadProject(f.root).pages.map((entry) => entry.path),
      ["pages/p3.page", "pages/p1.page", "pages/p2.page"],
    );
    for (const [p, bytes] of Object.entries(bytesBefore)) {
      assert.equal(fs.readFileSync(path.join(f.root, p), "utf8"), bytes, `${p} content must be byte-identical`);
    }
  });

  it("reorder_pages refuses a different order and is absent without the grant", () => {
    const f = fixture(3);
    const lock = JSON.parse(fs.readFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), "utf8"));
    delete lock.scope.insertIndex;
    lock.scope.reorderPageIds = ["p3", "p1", "p2"];
    fs.writeFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), JSON.stringify(lock));
    const wrong = executeGenerateTool("reorder_pages", { pageIds: ["p1", "p3", "p2"] }, f.state);
    assert.equal(wrong.ok, false);
    assert.equal((wrong.payload as { error?: string } | undefined)?.error, "review_scope_violation");
    const partial = executeGenerateTool("reorder_pages", { pageIds: ["p3", "p1"] }, f.state);
    assert.equal(partial.ok, false);
    assert.deepEqual(
      loadProject(f.root).pages.map((entry) => entry.path),
      ["pages/p1.page", "pages/p2.page", "pages/p3.page"],
      "nothing moves on a refused call",
    );
    delete lock.scope.reorderPageIds;
    fs.writeFileSync(path.join(f.root, "_agent", "ai-review-lock.v1.json"), JSON.stringify(lock));
    const noGrant = executeGenerateTool("reorder_pages", { pageIds: ["p3", "p1", "p2"] }, f.state);
    assert.equal(noGrant.ok, false);
    assert.equal((noGrant.payload as { error?: string } | undefined)?.error, "review_scope_violation");
  });
});

describe("full rewrite lock", () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rewrite-edit-"));
    createEmptyProject(root, { title: "Rewrite" });
    persistAll(root, [
      pageWithCopy("p1", "cover", "Cover"),
      pageWithCopy("p2", "content", "Second"),
      pageWithCopy("p3", "content", "Third"),
    ]);
    const project = loadProject(root);
    const projectPages = project.pages.map((entry) => ({
      pageId: entry.path.replace(/^pages\//, "").replace(/\.page$/, ""),
      pagePath: entry.path,
      pageSha256: stableSha256({
        id: entry.path.replace(/^pages\//, "").replace(/\.page$/, ""),
        ...entry.page,
      }),
    }));
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/p1.page",
        expiresAt: Date.now() + 60_000,
        scope: {
          kind: "deck",
          pageId: "p1",
          elementIds: [],
          targetPageIds: ["p1", "p2", "p3"],
          rewrite: true,
        },
        projectPages,
      }),
    );
    const state = {
      brief: "Rewrite",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [],
      projectRoot: root,
    };
    const sha = (id: string) =>
      stableSha256({
        ...loadProject(root).pages.find((p) => p.path === `pages/${id}.page`)!.page,
        id,
      });
    return { root, state, sha };
  }

  it("rewrites a baseline page under CAS and appends a brand-new page id", () => {
    const f = fixture();
    const edited = persistWrittenPages(f.state, [pageWithCopy("p2", "content", "重写后的第二页")], {
      expectedPageSha256: f.sha("p2"),
    });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.match(
      JSON.stringify(loadProject(f.root).pages.find((p) => p.path === "pages/p2.page")!.page),
      /重写后的第二页/,
    );
    // A page id the manifest never had needs no CAS — it appends at the end.
    const added = persistWrittenPages(f.state, [pageWithCopy("w1", "final", "新大纲页")]);
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.deepEqual(
      loadProject(f.root).pages.map((entry) => entry.path),
      ["pages/p1.page", "pages/p2.page", "pages/p3.page", "pages/w1.page"],
    );
  });

  it("still requires CAS on existing pages and never invents a page id outside the write", () => {
    const f = fixture();
    const noCas = persistWrittenPages(f.state, [pageWithCopy("p2", "content", "无校验重写")]);
    assert.equal(noCas.ok, false);
    if (noCas.ok) assert.fail("rewrite is not a free pass on baseline pages");
    assert.equal(noCas.error, "page_revision_required");
    const stale = persistWrittenPages(f.state, [pageWithCopy("p2", "content", "旧基线")], {
      expectedPageSha256: "f".repeat(64),
    });
    assert.equal(stale.ok, false);
    assert.equal((stale as { error?: string }).error, "page_revision_conflict");
    assert.match(JSON.stringify(loadProject(f.root).pages.find((p) => p.path === "pages/p2.page")!.page), /Second/);
  });

  it("delete_pages may drop any baseline page under a rewrite lock", () => {
    const f = fixture();
    const result = executeGenerateTool("delete_pages", { pageIds: ["p1", "p3"] }, f.state);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      loadProject(f.root).pages.map((entry) => entry.path),
      ["pages/p2.page"],
    );
    assert.equal(fs.existsSync(path.join(f.root, "pages/p1.page")), false);
    const denied = executeGenerateTool("delete_pages", { pageIds: ["ghost"] }, f.state);
    assert.equal(denied.ok, false);
    assert.equal((denied.payload as { error?: string } | undefined)?.error, "review_scope_violation");
  });

  it("reorder_pages under rewrite accepts any changed permutation of the live manifest", () => {
    const f = fixture();
    const reordered = executeGenerateTool("reorder_pages", { pageIds: ["p3", "p2", "p1"] }, f.state);
    assert.equal(reordered.ok, true, JSON.stringify(reordered));
    assert.deepEqual(
      loadProject(f.root).pages.map((entry) => entry.path),
      ["pages/p3.page", "pages/p2.page", "pages/p1.page"],
    );
    // After deleting a page the remaining manifest is the reorderable set.
    assert.equal(executeGenerateTool("delete_pages", { pageIds: ["p2"] }, f.state).ok, true);
    const survivors = executeGenerateTool("reorder_pages", { pageIds: ["p1", "p3"] }, f.state);
    assert.equal(survivors.ok, true, JSON.stringify(survivors));
    // Identity order and incomplete lists are refused.
    const identity = executeGenerateTool("reorder_pages", { pageIds: ["p1", "p3"] }, f.state);
    assert.equal(identity.ok, false);
    const partial = executeGenerateTool("reorder_pages", { pageIds: ["p1", "p3", "p2"] }, f.state);
    assert.equal(partial.ok, false, "a deleted page is no longer part of the manifest");
  });
});
