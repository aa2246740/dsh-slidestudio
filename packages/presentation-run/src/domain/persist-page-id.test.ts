import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { persistPageKey, persistPagePathFromId, pageIdMatchesFile } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import { executeGenerateTool, persistWrittenPages } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
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

function closingElements(id: string, title: string): SkillPageInput["elements"] {
  return [
    navy,
    textEl(`${id}-title`, title, [80, 120, 800, 64], 32),
    textEl(`${id}-recap`, "本页有可读的回顾信息。", [80, 230, 800, 52], 18),
    textEl(`${id}-ask`, "下一步：确认并执行。", [80, 330, 800, 52], 18),
  ];
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

function listedBasenames(root: string): string[] {
  return loadProject(root).pages.map((page) => page.path.replace(/\\/g, "/"));
}

describe("EDITH persist identity round-trip", () => {
  it("id → path → id is persistPageKey for 1_cover, 1_cover.page, 12_div_ops, p01_cover", () => {
    for (const id of ["1_cover", "1_cover.page", "12_div_ops", "12_div_ops.page", "p01_cover", "p01_cover.page"]) {
      const rel = persistPagePathFromId(id);
      assert.equal(persistPageKey(rel), persistPageKey(id), id);
      assert.equal(pageIdMatchesFile(id, rel), true, id);
      assert.doesNotMatch(rel, /coverpage|divopspage|opspage/);
    }
    assert.equal(persistPagePathFromId("1_cover"), "pages/1_cover.page");
    assert.equal(persistPagePathFromId("1_cover.page"), "pages/1_cover.page");
    assert.equal(persistPagePathFromId("12_div_ops"), "pages/12_div_ops.page");
    assert.equal(persistPagePathFromId("p01_cover"), "pages/p01_cover.page");
    assert.equal(pageIdMatchesFile("1_cover.page", "pages/1_coverpage.page"), false);
    assert.equal(pageIdMatchesFile("1_cover", "pages/02_cover.page"), false);
  });

  it("persist id=1_cover twice → one file pages/1_cover.page, never 1_coverpage.page, never 2_cover.page", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "persist-1-cover-"));
    createEmptyProject(root, { title: "persist 1_cover" });
    const cover = pageWithCopy("1_cover", "cover", "封面标题足够长了用于测试");
    persistAll(root, [cover]);
    persistAll(root, [cover]);
    const listed = listedBasenames(root);
    assert.deepEqual(listed, ["pages/1_cover.page"]);
    assert.equal(fs.existsSync(path.join(root, "pages", "1_cover.page")), true);
    assert.equal(fs.existsSync(path.join(root, "pages", "1_coverpage.page")), false);
    assert.equal(fs.existsSync(path.join(root, "pages", "02_cover.page")), false);
    assert.equal(fs.existsSync(path.join(root, "pages", "2_cover.page")), false);
  });

  it("persist id=1_cover.page twice then with 12_div_ops.page does not append leftovers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "persist-dot-id-"));
    createEmptyProject(root, { title: "persist MiniMax ids" });
    const cover = pageWithCopy("1_cover.page", "cover", "封面标题足够长了用于测试");
    const ops = pageWithCopy("12_div_ops.page", "chapter", "商品与运营章节标题足够");
    persistAll(root, [cover]);
    persistAll(root, [cover]);
    persistAll(root, [cover, ops]);
    persistAll(root, [cover, ops]);
    const listed = listedBasenames(root);
    assert.deepEqual(listed, ["pages/1_cover.page", "pages/12_div_ops.page"]);
    assert.equal(listed.includes("pages/1_coverpage.page"), false);
    assert.equal(
      listed.some((rel) => /\/\d+_cover\.page$/.test(rel) && rel !== "pages/1_cover.page"),
      false,
    );
    assert.equal(loadProject(root).pages.length, 2);
  });

  it("persist p01_cover twice stays pages/p01_cover.page", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "persist-p01-"));
    createEmptyProject(root, { title: "persist p01_cover" });
    const cover = pageWithCopy("p01_cover", "cover", "差 140 万不是客单下跌封面");
    persistAll(root, [cover]);
    persistAll(root, [cover]);
    assert.deepEqual(listedBasenames(root), ["pages/p01_cover.page"]);
    assert.equal(fs.existsSync(path.join(root, "pages", "1_cover.page")), false);
  });

  it("runDomainHand writes p2 without replaying stale p1 over a native edit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "domain-page-scope-"));
    createEmptyProject(root, { title: "page scoped domain hand" });
    writeDomainRuntime(root, { brief: "给团队介绍一个简单产品，不是经营月报。" });
    const p1 = await runDomainHand(
      "write_page",
      { id: "p1", pageType: "final", elements: closingElements("p1", "DSH 原始 p1") },
      root,
    );
    assert.equal(p1.ok, true, p1.detail);

    const native = loadProject(root);
    const first = native.pages.find((page) => page.path === "pages/p1.page");
    assert.ok(first);
    const title = first.page.elements.find((element) => element.elementId === "p1-title") as {
      content?: { text?: string };
    };
    assert.ok(title?.content);
    title.content.text = "Native 已编辑 p1";
    saveProject(native);

    const p2 = await runDomainHand(
      "write_page",
      { id: "p2", pageType: "final", elements: closingElements("p2", "DSH 新写 p2") },
      root,
    );
    assert.equal(p2.ok, true, p2.detail);
    const render = await runDomainHand("render_page", { pageId: "p2" }, root);
    assert.equal(render.name, "render_page");

    const after = loadProject(root);
    const p1After = after.pages.find((page) => page.path === "pages/p1.page");
    const p2After = after.pages.find((page) => page.path === "pages/p2.page");
    assert.match(JSON.stringify(p1After?.page.elements), /Native 已编辑 p1/);
    assert.match(JSON.stringify(p2After?.page.elements), /DSH 新写 p2/);
  });

  it("rejects a stale expectedPageSha256 inside the project write transaction", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "domain-page-cas-"));
    createEmptyProject(root, { title: "page CAS" });
    const firstPage = pageWithCopy("p1", "cover", "AI 读取时的标题");
    persistAll(root, [firstPage]);

    const before = loadProject(root);
    const persisted = before.pages.find((page) => page.path === "pages/p1.page");
    assert.ok(persisted);
    const staleSha256 = stableSha256({ ...persisted.page, id: "p1" });

    const title = persisted.page.elements.find((element) => element.elementId === "t") as {
      content?: { text?: string };
    };
    assert.ok(title?.content);
    title.content.text = "人类在 AI 写入前的新标题";
    saveProject(before);

    const state = {
      brief: "page CAS",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [firstPage],
      projectRoot: root,
    };
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/p1.page",
        expiresAt: Date.now() + 60_000,
      }),
    );
    const missing = persistWrittenPages(state, [pageWithCopy("p1", "cover", "没有 CAS 的 AI 修改")]);
    assert.equal(missing.ok, false);
    if (missing.ok) assert.fail("an active AI review guard must require CAS");
    assert.equal(missing.error, "page_revision_required");

    const result = persistWrittenPages(state, [pageWithCopy("p1", "cover", "AI 的旧基线修改")], {
      expectedPageSha256: staleSha256,
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("stale CAS must not succeed");
    assert.equal(result.error, "page_revision_conflict");
    assert.match(JSON.stringify(loadProject(root).pages[0]?.page.elements), /人类在 AI 写入前的新标题/);
    assert.doesNotMatch(JSON.stringify(loadProject(root).pages[0]?.page.elements), /AI 的旧基线修改/);

    const latest = loadProject(root).pages[0];
    assert.ok(latest);
    const currentSha256 = stableSha256({ ...latest.page, id: "p1" });
    const accepted = persistWrittenPages(state, [pageWithCopy("p1", "cover", "基于最新读取的 AI 修改")], {
      expectedPageSha256: currentSha256,
    });
    assert.equal(accepted.ok, true);
    assert.match(JSON.stringify(loadProject(root).pages[0]?.page.elements), /基于最新读取的 AI 修改/);
  });
});

describe("human element review write guard", () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-write-scope-"));
    createEmptyProject(root, { title: "Preserve deck title" });
    const page = pageWithCopy("p1", "cover", "Before");
    persistAll(root, [page, pageWithCopy("p2", "content", "Other page")]);
    const project = loadProject(root);
    project.presentation.title = "Human deck title";
    saveProject(project);
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    const scope = { kind: "elements", pageId: "p1", elementIds: ["t"] };
    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/p1.page",
        expiresAt: Date.now() + 60_000,
        scope,
        pageBody: project.pages[0]!.page,
      }),
    );
    const state = {
      brief: "Old generation title must not overwrite human title",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [page],
      projectRoot: root,
    };
    const sha = (id = "p1") =>
      stableSha256({
        ...loadProject(root).pages.find((p) => p.path === `pages/${id}.page`)!.page,
        id,
      });
    return { root, state, page, sha };
  }

  it("rejects unselected edits, metadata, reorder and page changes before any bytes change", () => {
    const f = fixture();
    const files = ["deck.pptd", "pages/p1.page", "pages/p2.page"];
    const before = files.map((file) => fs.readFileSync(path.join(f.root, file), "utf8"));
    const changedOutside = structuredClone(pageWithCopy("p1", "cover", "After"));
    changedOutside.elements[0]!.bounds = [1, 0, 960, 540];
    const changedMeta = { ...pageWithCopy("p1", "cover", "After"), notes: "Unauthorized notes" };
    const reordered = pageWithCopy("p1", "cover", "After");
    reordered.elements.reverse();
    for (const proposed of [
      changedOutside,
      changedMeta,
      reordered,
      pageWithCopy("p2", "content", "Unauthorized page"),
    ]) {
      const result = persistWrittenPages(f.state, [proposed], {
        expectedPageSha256: f.sha(proposed.id),
      });
      assert.equal(result.ok, false);
      if (result.ok) assert.fail("out-of-scope write must fail");
      assert.equal(result.error, "review_scope_violation");
      assert.deepEqual(
        files.map((file) => fs.readFileSync(path.join(f.root, file), "utf8")),
        before,
      );
    }
  });

  it("allows only the selected target and preserves the deck title and other page", () => {
    const f = fixture();
    const other = fs.readFileSync(path.join(f.root, "pages/p2.page"), "utf8");
    const result = persistWrittenPages(f.state, [pageWithCopy("p1", "cover", "After")], {
      expectedPageSha256: f.sha(),
    });
    assert.equal(result.ok, true);
    assert.equal(loadProject(f.root).presentation.title, "Human deck title");
    assert.equal(fs.readFileSync(path.join(f.root, "pages/p2.page"), "utf8"), other);
    assert.match(JSON.stringify(loadProject(f.root).pages[0]!.page), /After/);
  });

  it("honors multi-element and explicit page/deck scopes without relaxing version checks", () => {
    for (const scope of [
      { kind: "elements", pageId: "p1", elementIds: ["t", "cl-bg"] },
      { kind: "page", pageId: "p1", elementIds: [] },
      { kind: "pages", pageId: "p2", elementIds: [], targetPageIds: ["p2"] },
      { kind: "deck", pageId: "p1", elementIds: [], targetPageIds: ["p1", "p2"] },
    ]) {
      const f = fixture();
      fs.writeFileSync(
        path.join(f.root, "_agent", "ai-review-lock.v1.json"),
        JSON.stringify({
          pagePath: "pages/p1.page",
          expiresAt: Date.now() + 60_000,
          scope,
          pageBody: loadProject(f.root).pages[0]!.page,
        }),
      );
      const id = scope.kind === "deck" || scope.kind === "pages" ? "p2" : "p1";
      const proposed = structuredClone(pageWithCopy(id, id === "p1" ? "cover" : "content", "After"));
      proposed.elements[0]!.bounds = [1, 0, 959, 540];
      const noCas = persistWrittenPages(f.state, [proposed]);
      assert.equal(noCas.ok, false, scope.kind);
      const accepted = persistWrittenPages(f.state, [proposed], { expectedPageSha256: f.sha(id) });
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
      assert.equal(loadProject(f.root).presentation.title, "Human deck title");
      if (scope.kind === "pages") {
        const outside = persistWrittenPages(f.state, [pageWithCopy("p1", "cover", "Outside subset")], {
          expectedPageSha256: f.sha("p1"),
        });
        assert.equal(outside.ok, false);
        if (outside.ok) assert.fail("pages scope must reject a page outside its exact target set");
        assert.equal(outside.error, "review_scope_violation");
      }
    }
  });

  it("keeps the original protected baseline across repeated edits and external changes", () => {
    const f = fixture();
    for (const title of ["First correction", "Second correction"]) {
      assert.equal(
        persistWrittenPages(f.state, [pageWithCopy("p1", "cover", title)], {
          expectedPageSha256: f.sha(),
        }).ok,
        true,
      );
    }
    // An unrelated writer bypasses the editor lease. A fresh read/CAS must not
    // legitimize that mutation as part of this element-scoped review.
    const changed = loadProject(f.root);
    changed.pages[0]!.page.elements[0]!.bounds = [1, 0, 959, 540];
    saveProject(changed);
    const proposed = structuredClone(pageWithCopy("p1", "cover", "Third correction"));
    proposed.elements[0]!.bounds = [1, 0, 959, 540];
    const before = fs.readFileSync(path.join(f.root, "pages/p1.page"), "utf8");
    const rejected = persistWrittenPages(f.state, [proposed], { expectedPageSha256: f.sha() });
    assert.equal(rejected.ok, false);
    if (rejected.ok) assert.fail("fresh CAS must not replace original review baseline");
    assert.equal(rejected.error, "review_scope_violation");
    assert.equal(fs.readFileSync(path.join(f.root, "pages/p1.page"), "utf8"), before);
  });

  it("fails closed if an element scope loses its original baseline", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/p1.page",
        expiresAt: Date.now() + 60_000,
        scope: { kind: "elements", pageId: "p1", elementIds: ["t"] },
      }),
    );
    const result = persistWrittenPages(f.state, [pageWithCopy("p1", "cover", "After")], {
      expectedPageSha256: f.sha(),
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("must not silently recapture a missing baseline");
    assert.equal(result.error, "review_scope_violation");
    assert.doesNotMatch(JSON.stringify(loadProject(f.root).pages[0]!.page), /After/);
  });
});
