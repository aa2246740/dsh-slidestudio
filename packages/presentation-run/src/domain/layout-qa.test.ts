import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import {
  isCloserPage,
  pageHasReadableCopy,
  pageHasVisibleContent,
  pageCoverage,
  reviewSkillPages,
  persistPageKey,
  pageIdMatchesFile,
  EMPTY_CLOSER_PRODUCE_NEXT,
  HOST_SEED_PRODUCE_NEXT,
  composedPageLeftoverIssues,
  renderedLayoutBlocksCompose,
  isHostOpenedSeedPath,
  writePageSchemaIssues,
  writePageSchemaError,
  reusedFullBleedSrcIssue,
  photoExhibitIssues,
} from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import {
  executeGenerateTool,
  orderComposedPagesByPlan,
  persistWrittenPages,
  type AgentToolState,
} from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import { packColorWriteContextFrom, PACK_COLOR_ERROR } from "./theme-pack.js";

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

describe("empty closer gate", () => {
  it("treats last/final/closing pages as closers and navy-only as unreadable", () => {
    assert.equal(isCloserPage({ id: "closing", pageType: "final" }), true);
    assert.equal(isCloserPage({ id: "p20", pageType: "content" }, 19, 19), true);
    assert.equal(isCloserPage({ id: "cover", pageType: "cover" }, 0, 19), false);
    assert.equal(pageHasReadableCopy({ elements: [navy] }), false);
    assert.equal(
      pageHasReadableCopy({
        elements: [
          navy,
          textEl("title", "澄光生活 · 结束页", [80, 140, 760, 80], 36),
          textEl("recap", "7月营收 1,860 万，预算达成 93%。", [80, 240, 760, 72], 18),
        ],
      }),
      true,
    );
  });

  it("fails compose-mode QA when the closer has no copy", () => {
    const review = reviewSkillPages(
      [
        {
          id: "cover",
          pageType: "cover",
          elements: [navy, textEl("t", "澄光生活 2026年7月经营月报封面标题", [80, 160, 800, 80], 36)],
        },
        { id: "closing", pageType: "final", elements: [navy] },
      ],
      { mode: "compose" },
    );
    assert.equal(review.ok, false);
    assert.ok(
      review.issues.some(
        (issue) => issue.pageId === "closing" && issue.code === "empty" && /readable copy/.test(issue.message),
      ),
    );
  });

  it("write_page and compose_deck refuse an empty closer without painting", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const state: AgentToolState = {
      brief: "a closer test deck",
      playbook,
      todos: [],
      researchNotes: [],
      writtenPages: [
        {
          id: "cover",
          pageType: "cover",
          elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
        },
        { id: "closing", pageType: "final", elements: [navy] },
      ],
    };
    const write = executeGenerateTool("write_page", { id: "closing", pageType: "final", elements: [navy] }, state);
    assert.equal(write.ok, false);
    assert.equal((write.payload as { error?: string }).error, "empty_closer");
    assert.equal((write.payload as { painted?: boolean }).painted, false);
    const compose = executeGenerateTool("compose_deck", { title: "closer test" }, state);
    assert.equal(compose.ok, false);
    assert.equal((compose.payload as { error?: string }).error, "empty_closer");
  });

  it("compose checks the last page — a copied middle page named closing cannot mask a thin real closer", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const state: AgentToolState = {
      brief: "a middle-closer deck",
      playbook,
      todos: [],
      researchNotes: [],
      writtenPages: [
        {
          id: "cover",
          pageType: "cover",
          elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
        },
        {
          id: "closing",
          pageType: "final",
          elements: [
            navy,
            textEl("t1", "中间页不是收尾页但带了可读标题", [80, 160, 800, 40], 18),
            textEl("t2", "中间页的可读内容让 find 提前命中", [80, 220, 800, 40], 18),
          ],
        },
        { id: "body", pageType: "content", elements: [navy] },
      ],
    };
    const compose = executeGenerateTool("compose_deck", { title: "middle closer" }, state);
    assert.equal(compose.ok, false);
    assert.equal((compose.payload as { error?: string }).error, "empty_closer");
    assert.equal((compose.payload as { pageId?: string }).pageId, "body");
  });

  it("orders the composed manifest by write_todo order, not write order", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compose-order-"));
    const project = createEmptyProject(root, { title: "order" });
    const page = (pageType: string, texts: string[]) => ({
      pageType,
      elements: [navy, ...texts.map((text, index) => textEl(`t${index}`, text, [80, 160 + index * 60, 800, 40], 18))],
    });
    // Disk order is the generation write order: cover, summary, metrics.
    project.pages = [
      { path: "pages/01_cover.page", page: page("cover", ["封面标题足够长了用于测试"]) },
      { path: "pages/03_summary.page", page: page("final", ["总结一内容足够", "总结二内容足够"]) },
      {
        path: "pages/02_metrics.page",
        page: page("content", ["指标一内容足够", "指标二内容足够"]),
      },
    ];
    project.presentation.pages = project.pages.map((loaded) => loaded.path);
    saveProject(project);
    orderComposedPagesByPlan(root, [
      { pageId: "1_cover", title: "封面" },
      { pageId: "2_metrics", title: "指标" },
      { pageId: "3_summary", title: "总结" },
    ]);
    const reloaded = loadProject(root);
    assert.deepEqual(reloaded.presentation.pages, [
      "pages/01_cover.page",
      "pages/02_metrics.page",
      "pages/03_summary.page",
    ]);
  });

  it("patches the closer in place and does not unlink leftover pages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "closer-persist-"));
    const project = createEmptyProject(root, { title: "closer persist" });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    project.pages = [
      { path: "pages/1_cover.page", page: { pageType: "cover", elements: cover.elements } },
      { path: "pages/02_final.page", page: { pageType: "final", elements: [navy] } },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    const emptyCloser: SkillPageInput = { id: "02_final", pageType: "final", elements: [navy] };
    const filledCloser: SkillPageInput = {
      id: "02_final",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "澄光生活 · 结束页", [80, 140, 760, 80], 36),
        textEl("recap", "7月营收 1,860 万，预算达成 93%。", [80, 240, 760, 72], 18),
        textEl("ask", "8月拍板：华北续约 / 华东履约 / 华南库存。", [80, 330, 760, 64], 16),
      ],
    };
    const playbook = loadPlaybook({ hostDefaults: false });
    persistWrittenPages({
      brief: "a closer test deck",
      playbook,
      todos: [],
      researchNotes: [],
      writtenPages: [filledCloser],
      skillDeck: { title: "closer persist", pages: [cover, emptyCloser] },
      projectRoot: root,
    });
    const patched = loadProject(root);
    assert.equal(patched.pages.length, 2);
    assert.equal(fs.existsSync(path.join(root, "pages/1_cover.page")), true);
    assert.ok(pageHasReadableCopy({ elements: patched.pages[1]!.page.elements }));
    const state: AgentToolState = {
      brief: "a closer test deck",
      playbook,
      todos: [],
      researchNotes: [],
      writtenPages: [cover, emptyCloser],
      skillDeck: { title: "closer persist", pages: [cover, emptyCloser] },
      projectRoot: root,
    };
    const write = executeGenerateTool(
      "write_page",
      {
        id: filledCloser.id,
        pageType: filledCloser.pageType,
        elements: filledCloser.elements,
      },
      state,
    );
    assert.equal(write.ok, true);
    assert.equal((write.payload as { painted?: boolean }).painted, false);
    const after = loadProject(root);
    assert.equal(after.pages.length, 2);
    assert.ok(pageHasReadableCopy({ elements: after.pages[1]!.page.elements }));
    assert.ok((state.skillDeck?.pages.at(-1)?.elements.filter((el) => el.elementType === "text").length ?? 0) >= 2);
  });

  it("refuses an empty last written page even when pageType is content", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const emptyLast: SkillPageInput = {
      id: "15_decision_cash",
      pageType: "content",
      elements: [navy],
    };
    const state: AgentToolState = {
      brief: "a closer test deck",
      playbook,
      todos: [],
      researchNotes: [],
      writtenPages: [cover, emptyLast],
    };
    const write = executeGenerateTool("write_page", { id: emptyLast.id, pageType: "content", elements: [navy] }, state);
    assert.equal(write.ok, false);
    assert.equal((write.payload as { error?: string }).error, "empty_closer");
    assert.equal((write.payload as { next?: string }).next, "write_page");
    assert.equal((write.payload as { painted?: boolean }).painted, false);
  });

  it("with a committed plan, a short section page written mid-plan is not the closer, and the plan's last page still is", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-closer-"));
    const project = createEmptyProject(root, { title: "plan closer" });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    project.pages = [{ path: "pages/1_cover.page", page: { pageType: "cover", elements: cover.elements } }];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    const state: AgentToolState = {
      brief: "a plan closer deck",
      playbook,
      todos: [
        { pageId: "1_cover", title: "封面" },
        { pageId: "2_section", title: "章节" },
        { pageId: "3_next_steps", title: "收尾" },
      ],
      researchNotes: [],
      writtenPages: [cover],
      projectRoot: root,
    };
    const section = [
      textEl("num", "01", [742, 280, 120, 125], 80),
      textEl("ttl", "运营数据总览", [80, 200, 600, 80], 40),
    ];
    const mid = executeGenerateTool(
      "write_page",
      { id: "2_section", pageType: "section", elements: [navy, ...section] },
      state,
    );
    assert.notEqual((mid.payload as { error?: string }).error, "empty_closer", mid.detail);
    assert.equal(mid.ok, true, mid.detail);
    const last = executeGenerateTool(
      "write_page",
      { id: "3_next_steps", pageType: "content", elements: [navy, ...section] },
      state,
    );
    assert.equal(last.ok, false);
    assert.equal((last.payload as { error?: string }).error, "empty_closer");
  });

  it("compose_deck bounces to write_page when leftover last YAML is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leftover-compose-"));
    const project = createEmptyProject(root, { title: "beilu leftover" });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "北麓制造 2026 上半年经营汇报封面", [80, 160, 800, 80], 36)],
    };
    const filledFinal: SkillPageInput = {
      id: "16_final",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "结束页 · 本次董事会要拍的板", [52, 80, 760, 60], 32),
        textEl("recap", "营收 23.84 亿元，毛利率 24.6%，现金流 3.42 亿元由负转正。", [52, 176, 856, 60], 14),
        textEl("ask", "下半年要拍的板：投票选定 1.0 亿产能投资方案。", [52, 294, 856, 80], 20),
      ],
    };
    project.pages = [
      { path: "pages/01_cover.page", page: { pageType: "cover", elements: cover.elements } },
      { path: "pages/15_final.page", page: { pageType: "final", elements: filledFinal.elements } },
      { path: "pages/16_content.page", page: { pageType: "content", elements: [navy] } },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    const playbook = loadPlaybook({ hostDefaults: false });
    const state: AgentToolState = {
      brief: "a closer test deck",
      playbook,
      todos: [],
      researchNotes: [],
      writtenPages: [cover, filledFinal],
      projectRoot: root,
    };
    const first = executeGenerateTool("compose_deck", { title: "北麓 H1" }, state);
    assert.equal(first.ok, false);
    assert.equal((first.payload as { error?: string }).error, "empty_closer");
    assert.equal((first.payload as { next?: string }).next, "write_page");
    assert.equal(first.detail, EMPTY_CLOSER_PRODUCE_NEXT);
    assert.equal(pageHasReadableCopy({ elements: loadProject(root).pages.at(-1)!.page.elements }), false);
    const again = executeGenerateTool("compose_deck", { title: "北麓 H1" }, state);
    assert.equal(again.ok, false);
    assert.equal((again.payload as { error?: string }).error, "empty_closer");
  });

  it("does not wipe a written closer when a later empty skillDeck persists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "closer-nowipe-"));
    const project = createEmptyProject(root, { title: "closer nowipe" });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const onFifteen = "ON_15_FINAL_ONLY";
    const filledFifteen: SkillPageInput = {
      id: "15_final",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "十五结束页不是十六", [52, 80, 760, 60], 32),
        textEl("recap", onFifteen, [52, 176, 856, 60], 14),
        textEl("ask", "不要把十六写进十五。", [52, 294, 856, 80], 20),
      ],
    };
    const filledFinal: SkillPageInput = {
      id: "16_final",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "结束页 · 本次要拍的板", [52, 80, 760, 60], 32),
        textEl("recap", "营收 23.84 亿元，毛利率 24.6%，现金流转正。", [52, 176, 856, 60], 14),
        textEl("ask", "下半年投票选定 1.0 亿产能方案。", [52, 294, 856, 80], 20),
      ],
    };
    const emptyCash: SkillPageInput = {
      id: "15_decision_cash",
      pageType: "content",
      elements: [navy],
    };
    const emptyFinal: SkillPageInput = { id: "16_final", pageType: "final", elements: [navy] };
    project.pages = [
      { path: "pages/01_cover.page", page: { pageType: "cover", elements: cover.elements } },
      {
        path: "pages/15_final.page",
        page: { pageType: "final", elements: filledFifteen.elements },
      },
      { path: "pages/16_content.page", page: { pageType: "content", elements: [navy] } },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    persistWrittenPages({
      brief: "a closer test deck",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [cover, filledFinal, emptyCash],
      skillDeck: { title: "stale", pages: [cover, emptyFinal] },
      projectRoot: root,
    });
    const after = loadProject(root);
    const fifteen = after.pages.find((page) => page.path.endsWith("15_final.page"));
    const leftover = after.pages.find((page) => page.path.endsWith("16_content.page"));
    const sixteen = after.pages.find((page) => page.path.endsWith("16_final.page"));
    assert.ok(fifteen);
    assert.ok(leftover);
    assert.ok(sixteen);
    assert.match(JSON.stringify(fifteen!.page.elements), /ON_15_FINAL_ONLY/);
    assert.equal(pageHasReadableCopy({ elements: leftover!.page.elements }), false);
    assert.ok(pageHasReadableCopy({ elements: sixteen!.page.elements }));
    assert.match(JSON.stringify(sixteen!.page.elements), /23\.84/);
    persistWrittenPages({
      brief: "a closer test deck",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [cover, emptyFinal],
      skillDeck: { title: "stale", pages: [cover, emptyFinal] },
      projectRoot: root,
    });
    const again = loadProject(root);
    const fifteenAgain = again.pages.find((page) => page.path.endsWith("15_final.page"));
    const sixteenAgain = again.pages.find((page) => page.path.endsWith("16_final.page"));
    assert.match(JSON.stringify(fifteenAgain!.page.elements), /ON_15_FINAL_ONLY/);
    assert.ok(pageHasReadableCopy({ elements: sixteenAgain!.page.elements }));
    assert.match(JSON.stringify(sixteenAgain!.page.elements), /23\.84/);
  });

  it("write_page empty_closer fires on last disk leftover *_content, not only pageType final", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leftover-write-"));
    const project = createEmptyProject(root, { title: "beilu leftover write" });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "北麓制造 2026 上半年经营汇报封面", [80, 160, 800, 80], 36)],
    };
    project.pages = [
      { path: "pages/01_cover.page", page: { pageType: "cover", elements: cover.elements } },
      { path: "pages/15_final.page", page: { pageType: "final", elements: cover.elements } },
      { path: "pages/16_content.page", page: { pageType: "content", elements: [navy] } },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    const write = executeGenerateTool(
      "write_page",
      { id: "16_content", pageType: "content", elements: [navy] },
      {
        brief: "a closer test deck",
        playbook: loadPlaybook({ hostDefaults: false }),
        todos: [],
        researchNotes: [],
        writtenPages: [cover],
        projectRoot: root,
      },
    );
    assert.equal(write.ok, false);
    assert.equal((write.payload as { error?: string }).error, "empty_closer");
    assert.equal((write.payload as { next?: string }).next, "write_page");
    assert.equal(pageHasReadableCopy({ elements: loadProject(root).pages.at(-1)!.page.elements }), false);
  });

  it("does not overlay closer copy onto leftover until produce write_page", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-overlay-"));
    const project = createEmptyProject(root, { title: "no overlay" });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const filledFinal: SkillPageInput = {
      id: "16_final",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "结束页 · 本次要拍的板", [52, 80, 760, 60], 32),
        textEl("recap", "营收 23.84 亿元，毛利率 24.6%，现金流转正。", [52, 176, 856, 60], 14),
        textEl("ask", "下半年投票选定 1.0 亿产能方案。", [52, 294, 856, 80], 20),
      ],
    };
    project.pages = [
      { path: "pages/01_cover.page", page: { pageType: "cover", elements: cover.elements } },
      { path: "pages/15_final.page", page: { pageType: "final", elements: filledFinal.elements } },
      { path: "pages/16_content.page", page: { pageType: "content", elements: [navy] } },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    persistWrittenPages({
      brief: "a closer test deck",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [cover],
      projectRoot: root,
    });
    const after = loadProject(root);
    assert.equal(pageHasReadableCopy({ elements: after.pages.at(-1)!.page.elements }), false);
    assert.equal(after.pages.length, 3);
  });
});

function tableEl(id: string, header: string[], body: string[][]): SkillPageInput["elements"][number] {
  return {
    elementId: id,
    elementType: "table",
    bounds: [40, 160, 880, 280],
    columnWidths: header.map(() => 880 / header.length),
    rows: [header.map((text) => ({ text })), ...body.map((row) => row.map((text) => ({ text })))],
  };
}
