import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import {
  pageHasVisibleContent,
  pageCoverage,
  reviewSkillPages,
  persistPageKey,
  pageIdMatchesFile,
  writePageSchemaIssues,
  writePageSchemaError,
} from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import { executeGenerateTool, persistWrittenPages, type AgentToolState } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";

function tableEl(id: string, header: string[], body: string[][]): SkillPageInput["elements"][number] {
  return {
    elementId: id,
    elementType: "table",
    bounds: [40, 160, 880, 280],
    columnWidths: header.map(() => 880 / header.length),
    rows: [header.map((text) => ({ text })), ...body.map((row) => row.map((text) => ({ text })))],
  };
}

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

describe("EDITH produce leaks", () => {
  it("1. a full-bleed navy rect is empty even when shape-area coverage is 1", () => {
    assert.equal(pageHasVisibleContent({ elements: [navy] }), false);
    assert.ok(pageCoverage([navy]) >= 0.99);
    const review = reviewSkillPages([{ id: "p12", pageType: "content", elements: [navy] }], {
      mode: "compose",
    });
    assert.equal(review.ok, false);
    assert.ok(review.issues.some((issue) => issue.code === "empty" && /not content/.test(issue.message)));
  });

  it("2. leftover *_content.page cannot close the deck", () => {
    assert.equal(pageIdMatchesFile("16_final", "pages/15_final.page"), false);
    assert.equal(pageIdMatchesFile("16_final", "pages/16_content.page"), false);
    assert.equal(persistPageKey("16_content.page"), "16_content");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leftover-cannot-close-"));
    const project = createEmptyProject(root, { title: "leftover cannot close" });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "北麓制造 2026 上半年经营汇报封面", [80, 160, 800, 80], 36)],
    };
    const leftoverCopy: SkillPageInput = {
      id: "16_content",
      pageType: "content",
      elements: [
        navy,
        textEl("title", "这页还是 leftover content", [52, 80, 760, 60], 32),
        textEl("recap", "有字也不算结束页，因为文件名是 16_content。", [52, 176, 856, 60], 14),
      ],
    };
    project.pages = [
      { path: "pages/01_cover.page", page: { pageType: "cover", elements: cover.elements } },
      {
        path: "pages/16_content.page",
        page: { pageType: "content", elements: leftoverCopy.elements },
      },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    const compose = executeGenerateTool(
      "compose_deck",
      { title: "北麓 H1" },
      {
        brief: "a closer test deck",
        playbook: loadPlaybook({ hostDefaults: false }),
        todos: [],
        researchNotes: [],
        writtenPages: [cover, leftoverCopy],
        projectRoot: root,
      },
    );
    assert.equal(compose.ok, false);
    assert.equal((compose.payload as { error?: string }).error, "empty_closer");
    assert.equal((compose.payload as { next?: string }).next, "write_page");
  });

  it("3. persist id=16_final does not write 15_final.page", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "persist-by-id-"));
    const project = createEmptyProject(root, { title: "persist by id" });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const fifteen: SkillPageInput = {
      id: "15_final",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "十五不是十六", [52, 80, 760, 60], 32),
        textEl("recap", "STAY_ON_FIFTEEN", [52, 176, 856, 60], 14),
        textEl("ask", "不要 remap。", [52, 294, 856, 80], 20),
      ],
    };
    const sixteen: SkillPageInput = {
      id: "16_final",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "十六结束页", [52, 80, 760, 60], 32),
        textEl("recap", "WRITE_SIXTEEN_ONLY", [52, 176, 856, 60], 14),
        textEl("ask", "persist by id.", [52, 294, 856, 80], 20),
      ],
    };
    project.pages = [
      { path: "pages/01_cover.page", page: { pageType: "cover", elements: cover.elements } },
      { path: "pages/15_final.page", page: { pageType: "final", elements: fifteen.elements } },
      { path: "pages/16_content.page", page: { pageType: "content", elements: [navy] } },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    persistWrittenPages({
      brief: "a closer test deck",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [sixteen],
      projectRoot: root,
    });
    const after = loadProject(root);
    const fifteenAfter = after.pages.find((page) => page.path.endsWith("15_final.page"))!;
    const leftover = after.pages.find((page) => page.path.endsWith("16_content.page"))!;
    const sixteenAfter = after.pages.find((page) => page.path.endsWith("16_final.page"));
    assert.match(JSON.stringify(fifteenAfter.page.elements), /STAY_ON_FIFTEEN/);
    assert.doesNotMatch(JSON.stringify(fifteenAfter.page.elements), /WRITE_SIXTEEN_ONLY/);
    assert.equal(pageHasVisibleContent({ elements: leftover.page.elements }), false);
    assert.ok(sixteenAfter);
    assert.match(JSON.stringify(sixteenAfter!.page.elements), /WRITE_SIXTEEN_ONLY/);
  });

  it("4. table header 缺货天数 requires a nonempty body value", () => {
    const page: SkillPageInput = {
      id: "12_stockout",
      pageType: "content",
      elements: [
        navy,
        textEl("title", "澄光生活 · 缺货 SKU", [40, 36, 800, 40], 24),
        tableEl("sku", ["SKU 名称", "缺货天数"], [["青瓷杯套装 6 件", ""]]),
      ],
    };
    const review = reviewSkillPages([page], { mode: "compose" });
    assert.ok(review.issues.some((issue) => issue.code === "empty_cell" && /缺货天数/.test(issue.message)));
    const write = executeGenerateTool(
      "write_page",
      { id: page.id, pageType: page.pageType, elements: page.elements },
      {
        brief: "a closer test deck",
        playbook: loadPlaybook({ hostDefaults: false }),
        todos: [],
        researchNotes: [],
        writtenPages: [
          {
            id: "1_cover",
            pageType: "cover",
            elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
          },
        ],
      },
    );
    assert.equal(write.ok, false);
    assert.equal((write.payload as { error?: string }).error, "empty_cell");
  });

  it("5. write_page rejects overflow, text overlap, omitted bounds, and zero area", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const state = (): AgentToolState => ({
      brief: "a closer test deck",
      playbook,
      todos: [],
      researchNotes: [],
      writtenPages: [cover],
    });
    const overflow = executeGenerateTool(
      "write_page",
      {
        id: "p-overflow",
        pageType: "content",
        elements: [
          navy,
          textEl("t", "溢出标题足够长了", [900, 0, 200, 100], 20),
          textEl("b", "溢出正文足够长了", [40, 200, 400, 40], 16),
        ],
      },
      state(),
    );
    assert.equal(overflow.ok, false);
    assert.equal((overflow.payload as { error?: string }).error, "overflow");
    const overlap = executeGenerateTool(
      "write_page",
      {
        id: "p-overlap",
        pageType: "content",
        elements: [
          navy,
          textEl("a", "重叠标题足够长了", [80, 80, 400, 80], 20),
          textEl("b", "重叠正文足够长了", [100, 100, 400, 80], 16),
        ],
      },
      state(),
    );
    assert.equal(overlap.ok, false);
    assert.equal((overlap.payload as { error?: string }).error, "overlap");
    const zero = executeGenerateTool(
      "write_page",
      {
        id: "p-zero",
        pageType: "content",
        elements: [
          navy,
          {
            elementId: "z",
            elementType: "text",
            bounds: [0, 0, 0, 0],
            content: { text: "零面积标题足够长了", fontSize: 18 },
          },
          textEl("b", "另一段正文足够长了", [40, 200, 400, 40], 16),
        ],
      },
      state(),
    );
    assert.equal(zero.ok, false);
    assert.equal((zero.payload as { error?: string }).error, "zero_area");
    const omitted = executeGenerateTool(
      "write_page",
      {
        id: "p-omitted",
        pageType: "content",
        elements: [
          navy,
          {
            elementId: "t",
            elementType: "text",
            content: { text: "没有 bounds 的标题足够长了", fontSize: 18 },
          },
        ],
      },
      state(),
    );
    assert.equal(omitted.ok, false);
    assert.equal((omitted.payload as { error?: string }).error, "bounds_omitted");
  });

  it("write_page rejects footer-reserve text without layoutRole=footer and does not stamp layout=pass", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const state = (): AgentToolState => ({
      brief: "a closer test deck",
      playbook,
      todos: [],
      researchNotes: [],
      writtenPages: [cover],
    });
    const rejected = executeGenerateTool(
      "write_page",
      {
        id: "p-footer",
        pageType: "content",
        elements: [
          navy,
          textEl("t", "标题足够长了用于测试", [80, 80, 800, 40], 28),
          textEl("b", "正文足够长了用于测试内容", [80, 140, 800, 40], 16),
          textEl("src", "来源：内部核对 7 月数字", [40, 508, 880, 20], 12),
        ],
      },
      state(),
    );
    assert.equal(rejected.ok, false);
    assert.equal((rejected.payload as { error?: string }).error, "footer_zone");
    assert.equal((rejected.payload as { layout?: string }).layout, undefined);
    const allowed = executeGenerateTool(
      "write_page",
      {
        id: "p-footer-ok",
        pageType: "content",
        elements: [
          navy,
          textEl("t", "标题足够长了用于测试", [80, 80, 800, 40], 28),
          textEl("b", "正文足够长了用于测试内容", [80, 140, 800, 40], 16),
          {
            ...textEl("src", "来源：内部核对 7 月数字", [40, 508, 880, 20], 12),
            layoutRole: "footer",
          },
        ],
      },
      state(),
    );
    assert.equal(allowed.ok, true);
    assert.equal((allowed.payload as { layout?: string }).layout, undefined);
  });

  it("write_page rejects unprefixed RRGGBB so it cannot become srgb 000000", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const rejected = executeGenerateTool(
      "write_page",
      {
        id: "19_final",
        pageType: "final",
        elements: [
          {
            elementId: "bg",
            elementType: "shape",
            shapeName: "rect",
            bounds: [0, 0, 960, 540],
            fill: { type: "solid", color: "0E0807" },
          },
          {
            elementId: "recap",
            elementType: "text",
            bounds: [60, 120, 840, 80],
            content: {
              text: "我把一条事故频发的发布线改造成可回滚。",
              fontSize: 18,
              color: "E8DED7",
            },
          },
        ],
      },
      {
        brief: "unprefixed hex inversion",
        playbook,
        todos: [],
        researchNotes: [],
        writtenPages: [cover],
      },
    );
    assert.equal(rejected.ok, false);
    assert.equal((rejected.payload as { error?: string }).error, "invalid_color");
    assert.match(String(rejected.detail), /0E0807|E8DED7/);
    assert.match(String(rejected.detail), /无效颜色不会变成 #000000/);
  });

  it("write_page rejects unresolved $nope and accepts existing $primary", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const rejected = executeGenerateTool(
      "write_page",
      {
        id: "19_final",
        pageType: "final",
        elements: [
          {
            elementId: "bg",
            elementType: "shape",
            shapeName: "rect",
            bounds: [0, 0, 960, 540],
            fill: { type: "solid", color: "#0E0807" },
          },
          {
            elementId: "recap",
            elementType: "text",
            bounds: [60, 120, 840, 80],
            content: {
              text: "我把一条事故频发的发布线改造成可回滚。",
              fontSize: 18,
              color: "$nope",
            },
          },
          {
            elementId: "ask",
            elementType: "text",
            bounds: [60, 312, 840, 80],
            content: {
              text: "下个月请评委给三件事反馈。",
              fontSize: 16,
              color: "#E8DED7",
            },
          },
        ],
      },
      {
        brief: "unresolved theme inversion",
        playbook,
        todos: [],
        researchNotes: [],
        writtenPages: [cover],
      },
    );
    assert.equal(rejected.ok, false);
    assert.equal((rejected.payload as { error?: string }).error, "invalid_color");
    assert.match(String(rejected.detail), /\$nope/);
    assert.match(String(rejected.detail), /无效颜色不会变成 #000000/);
    const theme = { colors: { primary: "#2563EB", text: "#111111" } };
    const officialThemePage: SkillPageInput = {
      id: "19_final",
      pageType: "final",
      elements: [
        {
          elementId: "bg",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 540],
          fill: { type: "solid", color: "$primary" },
        },
        {
          elementId: "recap",
          elementType: "text",
          bounds: [60, 120, 840, 80],
          content: { text: "我把一条事故频发的发布线改造成可回滚。", fontSize: 18, color: "$text" },
        },
        {
          elementId: "ask",
          elementType: "text",
          bounds: [60, 312, 840, 80],
          content: { text: "下个月请评委给三件事反馈。", fontSize: 16, color: "$text" },
        },
      ],
    };
    const allowed = writePageSchemaError(writePageSchemaIssues(officialThemePage, { theme }), officialThemePage, {
      theme,
    });
    assert.equal(allowed, undefined);
  });
});
