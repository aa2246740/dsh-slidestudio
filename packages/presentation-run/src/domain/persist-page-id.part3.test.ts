import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import type { SkillPageInput } from "./skill-pages.js";
import { executeGenerateTool, persistWrittenPages } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";

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

describe("update_deck metadata guard", () => {
  function fixture(scope: Record<string, unknown>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-meta-"));
    createEmptyProject(root, { title: "原标题" });
    persistAll(root, [pageWithCopy("p1", "cover", "Cover"), pageWithCopy("p2", "content", "Second")]);
    // persistAll runs unguarded and stamps the brief as the deck title —
    // restore the fixture title before the lock goes on.
    const seeded = loadProject(root);
    seeded.presentation.title = "原标题";
    saveProject(seeded);
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/p1.page",
        expiresAt: Date.now() + 60_000,
        scope,
      }),
    );
    const state = {
      brief: "Meta",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [],
      projectRoot: root,
    };
    return { root, state };
  }

  it("renames the deck title only when editableMeta whitelists it", () => {
    const granted = fixture({
      kind: "page",
      pageId: "p1",
      elementIds: [],
      targetPageIds: ["p1"],
      editableMeta: ["title"],
    });
    const ok = executeGenerateTool("update_deck", { title: "季度总结" }, granted.state);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(loadProject(granted.root).presentation.title, "季度总结");
    // Theme stays locked under a title-only grant.
    const denied = executeGenerateTool("update_deck", { theme: { colors: { accent1: "#112233" } } }, granted.state);
    assert.equal(denied.ok, false);
    assert.equal((denied.payload as { error?: string } | undefined)?.error, "review_scope_violation");
  });

  it("rejects every metadata write without an editableMeta grant", () => {
    const denied = fixture({
      kind: "deck",
      pageId: "p1",
      elementIds: [],
      targetPageIds: ["p1", "p2"],
    });
    const result = executeGenerateTool("update_deck", { title: "越权标题" }, denied.state);
    assert.equal(result.ok, false);
    assert.equal(loadProject(denied.root).presentation.title, "原标题");
    const noLock = fixture({});
    fs.rmSync(path.join(noLock.root, "_agent", "ai-review-lock.v1.json"));
    const orphan = executeGenerateTool("update_deck", { title: "无锁" }, noLock.state);
    assert.equal(orphan.ok, false);
    assert.equal(loadProject(noLock.root).presentation.title, "原标题");
  });

  it("a rewrite lock implicitly authorizes both title and theme", () => {
    const f = fixture({
      kind: "deck",
      pageId: "p1",
      elementIds: [],
      targetPageIds: ["p1", "p2"],
      rewrite: true,
    });
    const result = executeGenerateTool(
      "update_deck",
      { title: "重写标题", theme: { colors: { accent1: "#445566" } } },
      f.state,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const project = loadProject(f.root);
    assert.equal(project.presentation.title, "重写标题");
    assert.equal(
      (project.presentation.theme as { colors?: Record<string, string> } | undefined)?.colors?.accent1,
      "#445566",
    );
  });

  it("a structural lock may carry editableMeta alongside page-list grants", () => {
    const f = fixture({
      kind: "deck",
      pageId: "p1",
      elementIds: [],
      targetPageIds: ["p1", "p2"],
      structureOnly: true,
      insertIndex: 2,
      editableMeta: ["theme"],
    });
    const theme = executeGenerateTool("update_deck", { theme: { colors: { accent1: "#aabbcc" } } }, f.state);
    assert.equal(theme.ok, true, JSON.stringify(theme));
    const title = executeGenerateTool("update_deck", { title: "未授权标题" }, f.state);
    assert.equal(title.ok, false);
    assert.equal(loadProject(f.root).presentation.title, "原标题");
  });

  /** Seeds a theme with `primary` and a page-1 text colour that uses `$primary`. */
  function tokenFixture() {
    const f = fixture({
      kind: "deck",
      pageId: "p1",
      elementIds: [],
      targetPageIds: ["p1", "p2"],
      rewrite: true,
    });
    const seeded = loadProject(f.root);
    seeded.presentation.theme = { colors: { primary: "#2563EB" } };
    const p1 = seeded.pages.find((entry) => entry.path.endsWith("p1.page"));
    const text = p1?.page.elements.find((element) => element.elementType === "text") as
      { content: { color?: string } } | undefined;
    assert.ok(text, "page 1 has a text element");
    text.content.color = "$primary";
    saveProject(seeded);
    return f;
  }

  it("refuses a theme that leaves a page colour token unresolved, in Chinese, and saves nothing", () => {
    const f = tokenFixture();
    const refused = executeGenerateTool(
      "update_deck",
      { title: "新标题", theme: { colors: { accent1: "#445566" } } },
      f.state,
    );
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal((refused.payload as { error?: string }).error, "invalid_color");
    assert.match(String(refused.detail), /p1/);
    assert.match(String(refused.detail), /"\$primary" 在主题 colors 中不存在/);
    const after = loadProject(f.root);
    assert.equal(after.presentation.title, "原标题");
    assert.equal(after.presentation.theme?.colors?.primary, "#2563EB");
    assert.equal(after.presentation.theme?.colors?.accent1, undefined);
  });

  it("accepts a theme update that keeps every token a page uses resolvable", () => {
    const f = tokenFixture();
    const ok = executeGenerateTool("update_deck", { theme: { colors: { primary: "#112233" } } }, f.state);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(loadProject(f.root).presentation.theme?.colors?.primary, "#112233");
  });

  it("refuses a theme colour that is not a literal #RRGGBB, in Chinese", () => {
    const f = fixture({
      kind: "deck",
      pageId: "p1",
      elementIds: [],
      targetPageIds: ["p1", "p2"],
      rewrite: true,
    });
    const refused = executeGenerateTool("update_deck", { theme: { colors: { accent1: "2563EB" } } }, f.state);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal((refused.payload as { error?: string }).error, "invalid_color");
    assert.match(String(refused.detail), /主题颜色 colors\.accent1 必须是 #RRGGBB 或 #RRGGBBAA/);
    assert.equal(loadProject(f.root).presentation.theme?.colors?.accent1, undefined);
  });
});
