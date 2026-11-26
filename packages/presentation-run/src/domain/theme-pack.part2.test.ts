import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { executeGenerateTool, type AgentToolState } from "./agent-tools.js";
import { persistPageKey } from "./layout-qa.js";
import { loadPlaybook } from "./playbook.js";
import { stableSha256 } from "./run-ledger.js";
import {
  PACK_COLOR_ERROR,
  extractColorPaletteHexes,
  kindThemePackIssue,
  packColorWriteContextFrom,
} from "./theme-pack.js";
import { BEILU_H1, HARNESS_NOT_MONTHLY } from "./compose-ir.test.js";
import type { SkillPageInput } from "./skill-pages.js";

function fillEl(color: string): SkillPageInput["elements"][number] {
  return {
    elementId: "cl-bg",
    elementType: "shape",
    shapeName: "rect",
    bounds: [0, 0, 960, 540],
    fill: { type: "solid", color },
  };
}

function textEl(
  id: string,
  text: string,
  bounds: [number, number, number, number],
): SkillPageInput["elements"][number] {
  return {
    elementId: id,
    elementType: "text",
    bounds,
    content: { text, fontSize: 18, color: "#FFFFFF" },
  };
}

function coverPage(id: string, title: string, fillColor = "#06223F"): SkillPageInput {
  return {
    id,
    pageType: "cover",
    elements: [fillEl(fillColor), textEl("t", title, [80, 160, 800, 80])],
  };
}

function closerPage(id: string, fillColor = "#06223F"): SkillPageInput {
  return {
    id,
    pageType: "final",
    elements: [
      fillEl(fillColor),
      textEl("title", "结束页 · 结构验收", [52, 80, 760, 60]),
      textEl("recap", "两页均有可读正文，layout-qa 通过。", [52, 176, 856, 60]),
      textEl("ask", "下次只补视觉审查员，不伪造 pass。", [52, 294, 856, 80]),
    ],
  };
}

function stateFor(brief: string, designSystemId?: string): AgentToolState {
  return {
    brief,
    playbook: loadPlaybook({
      designSystemId,
      hostDefaults: false,
    }),
    todos: [],
    researchNotes: [],
    writtenPages: [],
  };
}

describe("adopted pack Color Palette tokens at write and compose", () => {
  it("extracts PART B hexes from pine-green and 澄光 warm-jade", () => {
    const pine = loadPlaybook({
      designSystemId: "consulting/pine-green-strategy",
      hostDefaults: false,
    });
    const jade = loadPlaybook({
      designSystemId: "work/warm-jade-annual-report",
      hostDefaults: false,
    });
    const pineHex = extractColorPaletteHexes(pine.designMarkdown);
    const jadeHex = extractColorPaletteHexes(jade.designMarkdown);
    assert.ok(pineHex.includes("#03522C"));
    assert.ok(pineHex.includes("#FFFFFF"));
    assert.equal(pineHex.includes("#FDC356"), false);
    assert.ok(jadeHex.includes("#FDC356"));
    assert.ok(jadeHex.includes("#FBF9EE"));
    assert.equal(jadeHex.includes("#03522C"), false);
  });

  it("includes observed template colors without widening declared catalog palettes", () => {
    const hexes = extractColorPaletteHexes(
      [
        "【Color Palette】",
        "- accent1: #C00000",
        "",
        "【Observed Colors】",
        "- #00B050: fill；2",
        "",
        "【Fonts Used】",
        "- A font named #112233 is not a color token",
      ].join("\n"),
    );
    assert.deepEqual(hexes, ["#C00000", "#00B050"]);
    const pine = loadPlaybook({
      designSystemId: "consulting/pine-green-strategy",
      hostDefaults: false,
    });
    assert.equal(extractColorPaletteHexes(pine.designMarkdown).includes("#FDC356"), false);
  });

  it("write_page refuses 澄光 amber after pine-green adopt and still writes pine-green hex", () => {
    const foreign = executeGenerateTool(
      "write_page",
      coverPage("cover", "北麓制造 2026 上半年经营汇报", "#FDC356"),
      stateFor(BEILU_H1, "consulting/pine-green-strategy"),
    );
    assert.equal(foreign.ok, false);
    assert.equal((foreign.payload as { error?: string }).error, PACK_COLOR_ERROR);
    assert.equal((foreign.payload as { painted?: boolean }).painted, false);
    const ok = executeGenerateTool(
      "write_page",
      coverPage("cover", "北麓制造 2026 上半年经营汇报", "#03522C"),
      stateFor(BEILU_H1, "consulting/pine-green-strategy"),
    );
    assert.equal(ok.ok, true, ok.detail);
  });

  it("uses an active exact editor scope to override only the target page background color", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-background-override-"));
    createEmptyProject(root, { title: "背景颜色编辑" });
    const state = stateFor(BEILU_H1, "consulting/pine-green-strategy");
    state.projectRoot = root;
    const page = (
      backgroundColor: string,
      shapeColor = "#03522C",
      title = "北麓制造 2026 上半年经营汇报",
    ): SkillPageInput => ({
      id: "p1",
      pageType: "content",
      background: { type: "solid", color: backgroundColor },
      elements: [fillEl(shapeColor), textEl("title", title, [80, 160, 800, 80])],
    });
    const seeded = executeGenerateTool("write_page", page("#03522C"), state);
    assert.equal(seeded.ok, true, seeded.detail);
    const current = loadProject(root).pages[0]!;
    const themeBeforeOverride = structuredClone(loadProject(root).presentation.theme);
    const currentSha256 = () => {
      const loaded = loadProject(root).pages[0]!;
      return stableSha256({ ...loaded.page, id: persistPageKey(loaded.path) });
    };
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    for (const [kind, color] of [
      ["page", "#FDC356"],
      ["pages", "#DDEEFF"],
      ["deck", "#AABBCC"],
    ] as const) {
      fs.writeFileSync(
        path.join(root, "_agent", "ai-review-lock.v1.json"),
        JSON.stringify({
          pagePath: current.path,
          expiresAt: Date.now() + 60_000,
          scope: {
            kind,
            pageId: "p1",
            targetPageIds: ["p1"],
            backgroundColorOverride: true,
          },
        }),
      );
      const changed = executeGenerateTool("write_page", { ...page(color), expectedPageSha256: currentSha256() }, state);
      assert.equal(changed.ok, true, `${kind}: ${changed.detail}`);
      assert.deepEqual(loadProject(root).pages[0]!.page.background, {
        type: "solid",
        color,
      });
      assert.deepEqual(loadProject(root).presentation.theme, themeBeforeOverride);
    }

    const beforeForeignElement = fs.readFileSync(path.join(root, current.path), "utf8");
    const rejectedElement = executeGenerateTool(
      "write_page",
      { ...page("#FDC356", "#FDC356"), expectedPageSha256: currentSha256() },
      state,
    );
    assert.equal(rejectedElement.ok, false);
    assert.equal((rejectedElement.payload as { error?: string }).error, PACK_COLOR_ERROR);
    assert.equal(fs.readFileSync(path.join(root, current.path), "utf8"), beforeForeignElement);

    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: current.path,
        expiresAt: Date.now() + 60_000,
        scope: {
          kind: "elements",
          pageId: "p1",
          targetPageIds: ["p1"],
          elementIds: ["title"],
          backgroundColorOverride: true,
        },
      }),
    );
    const elementScope = executeGenerateTool(
      "write_page",
      { ...page("#FDC356"), expectedPageSha256: currentSha256() },
      state,
    );
    assert.equal(elementScope.ok, false);
    assert.equal((elementScope.payload as { error?: string }).error, PACK_COLOR_ERROR);

    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: current.path,
        expiresAt: Date.now() + 60_000,
        scope: {
          kind: "pages",
          pageId: "p1",
          targetPageIds: ["p2"],
          backgroundColorOverride: true,
        },
      }),
    );
    const outsideTarget = executeGenerateTool(
      "write_page",
      { ...page("#FDC356"), expectedPageSha256: currentSha256() },
      state,
    );
    assert.equal(outsideTarget.ok, false);
    assert.equal((outsideTarget.payload as { error?: string }).error, PACK_COLOR_ERROR);

    fs.writeFileSync(
      path.join(root, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: current.path,
        expiresAt: Date.now() - 1,
        scope: {
          kind: "deck",
          pageId: "p1",
          targetPageIds: ["p1"],
          backgroundColorOverride: true,
        },
      }),
    );
    const expired = executeGenerateTool(
      "write_page",
      { ...page("#FDC356"), expectedPageSha256: currentSha256() },
      state,
    );
    assert.equal(expired.ok, false);
    assert.equal((expired.payload as { error?: string }).error, PACK_COLOR_ERROR);

    fs.unlinkSync(path.join(root, "_agent", "ai-review-lock.v1.json"));
    const retained = page("#AABBCC", "#03522C", "只改标题，保留授权背景");
    const titleOnly = executeGenerateTool("write_page", { ...retained, expectedPageSha256: currentSha256() }, state);
    assert.equal(titleOnly.ok, true, titleOnly.detail);
    assert.deepEqual(loadProject(root).pages[0]!.page.background, {
      type: "solid",
      color: "#AABBCC",
    });

    const beforeUnauthorizedChange = fs.readFileSync(path.join(root, current.path), "utf8");
    const unauthorizedChange = executeGenerateTool(
      "write_page",
      { ...page("#BBAACC"), expectedPageSha256: currentSha256() },
      state,
    );
    assert.equal(unauthorizedChange.ok, false);
    assert.equal((unauthorizedChange.payload as { error?: string }).error, PACK_COLOR_ERROR);
    assert.equal(fs.readFileSync(path.join(root, current.path), "utf8"), beforeUnauthorizedChange);

    const composed = executeGenerateTool("compose_deck", { title: "背景颜色编辑" }, state);
    assert.notEqual((composed.payload as { error?: string } | undefined)?.error, PACK_COLOR_ERROR);
  });

  it("write_page refuses host navy and empty-project $primary after pine-green adopt; pack $primary still writes", () => {
    const navy = executeGenerateTool(
      "write_page",
      coverPage("cover", "北麓制造 2026 上半年经营汇报", "#06223F"),
      stateFor(BEILU_H1, "consulting/pine-green-strategy"),
    );
    assert.equal(navy.ok, false);
    assert.equal((navy.payload as { error?: string }).error, PACK_COLOR_ERROR);
    assert.equal((navy.payload as { painted?: boolean }).painted, false);

    const hostBlue = executeGenerateTool(
      "write_page",
      coverPage("cover", "北麓制造 2026 上半年经营汇报", "#2563EB"),
      stateFor(BEILU_H1, "consulting/pine-green-strategy"),
    );
    assert.equal(hostBlue.ok, false);
    assert.equal((hostBlue.payload as { error?: string }).error, PACK_COLOR_ERROR);

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pack-empty-primary-"));
    createEmptyProject(emptyRoot, { title: "empty primary" });
    const emptyState = stateFor(BEILU_H1, "consulting/pine-green-strategy");
    emptyState.projectRoot = emptyRoot;
    const emptyPrimary = executeGenerateTool(
      "write_page",
      {
        id: "cover",
        pageType: "cover",
        elements: [fillEl("$primary"), textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80])],
      },
      emptyState,
    );
    assert.equal(emptyPrimary.ok, false, emptyPrimary.detail);
    assert.equal((emptyPrimary.payload as { error?: string }).error, PACK_COLOR_ERROR);
    assert.equal((emptyPrimary.payload as { painted?: boolean }).painted, false);
    assert.equal(loadProject(emptyRoot).presentation.theme?.colors?.primary, "#2563EB");

    const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pack-theme-primary-"));
    const project = createEmptyProject(packRoot, { title: "pack primary" });
    const existingTheme = project.presentation.theme ?? { colors: {} };
    project.presentation.theme = {
      ...existingTheme,
      colors: { ...(existingTheme.colors ?? {}), primary: "#03522C" },
    };
    saveProject(project);
    const packState = stateFor(BEILU_H1, "consulting/pine-green-strategy");
    packState.projectRoot = packRoot;
    const packPrimary = executeGenerateTool(
      "write_page",
      {
        id: "cover",
        pageType: "cover",
        elements: [fillEl("$primary"), textEl("t", "北麓制造 2026 上半年经营汇报", [80, 160, 800, 80])],
      },
      packState,
    );
    assert.equal(packPrimary.ok, true, packPrimary.detail);
    assert.equal((packPrimary.payload as { painted?: boolean }).painted, false);
    const reloaded = loadProject(packRoot);
    assert.equal(reloaded.presentation.theme?.colors?.primary, "#03522C");
  });

  it("compose_deck refuses a page that still uses another pack's hard-coded hex", () => {
    const state = stateFor(BEILU_H1, "consulting/pine-green-strategy");
    state.writtenPages = [
      coverPage("cover", "北麓制造 2026 上半年经营汇报", "#FDC356"),
      closerPage("final", "#03522C"),
    ];
    const compose = executeGenerateTool("compose_deck", { title: "北麓 H1" }, state);
    assert.equal(compose.ok, false);
    assert.equal((compose.payload as { error?: string }).error, PACK_COLOR_ERROR);
    assert.equal((compose.payload as { painted?: boolean }).painted, false);
  });

  it("empty adopt for retail-monthly / other / cover-only does not require pack colors", () => {
    const monthly = "澄光生活 2026年7月经营月报。营收 1,860 万，预算达成 93%。约 20 页。";
    const write = executeGenerateTool(
      "write_page",
      coverPage("cover", "澄光生活 2026年7月经营月报", "#FDC356"),
      stateFor(monthly),
    );
    assert.equal(write.ok, true, write.detail);
    assert.equal(kindThemePackIssue({ brief: monthly }), undefined);
    assert.equal(kindThemePackIssue({ brief: HARNESS_NOT_MONTHLY }), undefined);
    const packCtx = packColorWriteContextFrom({});
    assert.equal(packCtx.adoptedPackHexes, undefined);
  });
});
