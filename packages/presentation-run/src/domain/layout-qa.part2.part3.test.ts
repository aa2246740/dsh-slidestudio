import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";
import {
  HOST_SEED_PRODUCE_NEXT,
  composedPageLeftoverIssues,
  renderedLayoutBlocksCompose,
  isHostOpenedSeedPath,
  writePageSchemaIssues,
  writePageSchemaError,
  reusedFullBleedSrcIssue,
} from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import { executeGenerateTool, persistWrittenPages } from "./agent-tools.js";
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

describe("EDITH produce leaks", () => {
  it("allows only canonical page background color to leave the adopted pack under explicit override", () => {
    const pine = packColorWriteContextFrom({
      designSystemId: "consulting/pine-green-strategy",
    });
    const backgroundOnly: SkillPageInput = {
      id: "p1",
      pageType: "content",
      background: { type: "solid", color: "#FDC356" },
      elements: [textEl("title", "只改页面背景色", [80, 120, 800, 80], 36)],
    };
    const overridden = { ...pine, backgroundColorOverride: true };
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(backgroundOnly, pine), backgroundOnly, pine)?.error,
      PACK_COLOR_ERROR,
    );
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(backgroundOnly, overridden), backgroundOnly, overridden),
      undefined,
    );
    const retained = { ...pine, persistedBackgroundColor: "#FDC356" };
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(backgroundOnly, retained), backgroundOnly, retained),
      undefined,
    );
    const changedWithoutAuthorization: SkillPageInput = {
      ...backgroundOnly,
      background: { type: "solid", color: "#DDEEFF" },
    };
    assert.equal(
      writePageSchemaError(
        writePageSchemaIssues(changedWithoutAuthorization, retained),
        changedWithoutAuthorization,
        retained,
      )?.error,
      PACK_COLOR_ERROR,
    );
    const academic = packColorWriteContextFrom({
      designSystemId: "academic/paper-white-courseware",
    });
    const whiteBackground: SkillPageInput = {
      ...backgroundOnly,
      background: { type: "solid", color: "#FFFFFF" },
      elements: [
        {
          ...backgroundOnly.elements[0]!,
          content: { text: "整稿背景改为纯白", fontSize: 36, color: "#56687A" },
        },
      ],
    };
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(whiteBackground, academic), whiteBackground, academic)?.error,
      PACK_COLOR_ERROR,
    );
    const academicOverride = { ...academic, backgroundColorOverride: true };
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(whiteBackground, academicOverride), whiteBackground, academicOverride),
      undefined,
    );

    const foreignElement: SkillPageInput = {
      ...backgroundOnly,
      background: { type: "solid", color: "#03522C" },
      elements: [
        {
          elementId: "accent",
          elementType: "shape",
          shapeName: "rect",
          bounds: [80, 260, 200, 40],
          fill: { type: "solid", color: "#FDC356" },
        },
        backgroundOnly.elements[0]!,
      ],
    };
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(foreignElement, overridden), foreignElement, overridden)?.error,
      PACK_COLOR_ERROR,
    );

    const invalidBackground: SkillPageInput = {
      ...backgroundOnly,
      background: { type: "solid", color: "white" },
    };
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(invalidBackground, overridden), invalidBackground, overridden)?.error,
      "invalid_color",
    );
  });

  it("createEmptyProject lists zero composed pages; persistWrittenPages lists the agent cover, not a host seed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "empty-create-persist-"));
    const created = createEmptyProject(root, { title: "澄光生活 2026年7月经营月报" });
    assert.equal(created.pages.length, 0);
    assert.deepEqual(created.presentation.pages, []);
    assert.equal(fs.existsSync(path.join(root, "pages", "1_cover.page")), false);
    const cover: SkillPageInput = {
      id: "p01_cover",
      pageType: "cover",
      elements: [
        navy,
        textEl("t1", "差 140 万不是客单下跌", [50, 170, 700, 80], 40),
        textEl("t2", "2026年7月经营月报已核实数字", [50, 270, 800, 40], 16),
      ],
    };
    persistWrittenPages({
      brief: "澄光生活 2026年7月经营月报",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [cover],
      projectRoot: root,
    });
    const after = loadProject(root);
    assert.equal(after.pages.length, 1);
    assert.equal(after.pages[0]!.path, "pages/p01_cover.page");
    assert.equal(
      after.pages.some((page) => isHostOpenedSeedPath(page.path)),
      false,
    );
    assert.equal(
      composedPageLeftoverIssues(after.pages).some((issue) => issue.kind === "host_seed"),
      false,
    );
  });

  it("7. compose does not skip layout QA when writtenPages.length >= 2", () => {
    const playbook = loadPlaybook({ hostDefaults: false });
    const cover: SkillPageInput = {
      id: "1_cover",
      pageType: "cover",
      elements: [navy, textEl("t", "封面标题足够长了用于测试", [80, 160, 800, 80], 36)],
    };
    const emptyBody: SkillPageInput = { id: "12_stockout", pageType: "content", elements: [navy] };
    const closer: SkillPageInput = {
      id: "16_final",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "结束页 · 本次要拍的板", [52, 80, 760, 60], 32),
        textEl("recap", "营收 23.84 亿元，毛利率 24.6%。", [52, 176, 856, 60], 14),
        textEl("ask", "下半年投票选定产能方案。", [52, 294, 856, 80], 20),
      ],
    };
    const compose = executeGenerateTool(
      "compose_deck",
      { title: "layout qa skip" },
      {
        brief: "a closer test deck",
        playbook,
        todos: [],
        researchNotes: [],
        writtenPages: [cover, emptyBody, closer],
      },
    );
    assert.equal(compose.ok, false);
    assert.equal((compose.payload as { error?: string }).error, "layout QA failed");
    assert.ok(
      ((compose.payload as { review?: { issues?: { pageId: string; code: string }[] } }).review?.issues ?? []).some(
        (issue) => issue.pageId === "12_stockout" && issue.code === "empty",
      ),
    );
  });
});

describe("rendered layout compose gate", () => {
  it("keeps legacy missing optional and requires a current pass for strict editor runs", () => {
    assert.equal(renderedLayoutBlocksCompose("fail"), true);
    assert.equal(renderedLayoutBlocksCompose("missing"), false);
    assert.equal(renderedLayoutBlocksCompose("unavailable"), false);
    assert.equal(renderedLayoutBlocksCompose("pass"), false);
    assert.equal(renderedLayoutBlocksCompose("missing", true), true);
    assert.equal(renderedLayoutBlocksCompose("unavailable", true), true);
    assert.equal(renderedLayoutBlocksCompose("fail", true), true);
    assert.equal(renderedLayoutBlocksCompose("pass", true), false);
  });
});

describe("host seed leftover scan", () => {
  const seedPage = {
    path: "pages/1_cover.page",
    page: {
      pageType: "cover" as const,
      elements: [
        {
          elementId: "title",
          elementType: "text" as const,
          bounds: [80, 200, 800, 80] as [number, number, number, number],
          content: { text: "澄光生活 2026年7月经营月报", fontSize: 36, color: "#111111" },
        },
      ],
    },
  };
  const agentCover = {
    path: "pages/p01_cover.page",
    page: {
      pageType: "cover" as const,
      elements: [
        navy,
        textEl("t1", "差 140 万不是客单下跌", [50, 170, 700, 80], 40),
        textEl("t2", "2026年7月经营月报已核实数字", [50, 270, 800, 40], 16),
      ],
    },
  };

  it("rejects seed 1_cover.page listed with a real agent cover; without the seed it does not", () => {
    const withSeed = composedPageLeftoverIssues([seedPage, agentCover]);
    assert.equal(
      withSeed.some((issue) => issue.kind === "host_seed"),
      true,
    );
    assert.equal(withSeed[0]?.message, HOST_SEED_PRODUCE_NEXT);
    const withoutSeed = composedPageLeftoverIssues([agentCover]);
    assert.equal(
      withoutSeed.some((issue) => issue.kind === "host_seed"),
      false,
    );
  });

  it("compose_deck bounces host seed leftover and does not paint YAML", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-seed-compose-"));
    const project = createEmptyProject(root, { title: "澄光生活 2026年7月经营月报" });
    const cover: SkillPageInput = {
      id: "p01_cover",
      pageType: "cover",
      elements: agentCover.page.elements,
    };
    const closer: SkillPageInput = {
      id: "p20_closing",
      pageType: "final",
      elements: [
        navy,
        textEl("title", "结束页 · 7 月一句话", [52, 80, 760, 60], 32),
        textEl("recap", "差 140 万是合同不是客单。", [52, 176, 856, 60], 14),
        textEl("ask", "8 月要客单和续约一起涨。", [52, 294, 856, 80], 20),
      ],
    };
    project.pages = [
      { path: "pages/1_cover.page", page: titleOnlyCoverPage("澄光生活 2026年7月经营月报") },
      { path: "pages/p01_cover.page", page: { pageType: "cover", elements: cover.elements } },
      { path: "pages/p20_closing.page", page: { pageType: "final", elements: closer.elements } },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    const first = executeGenerateTool(
      "compose_deck",
      { title: "澄光月报" },
      {
        brief: "a closer test deck",
        playbook: loadPlaybook({ hostDefaults: false }),
        todos: [],
        researchNotes: [],
        writtenPages: [cover, closer],
        projectRoot: root,
      },
    );
    assert.equal(first.ok, false);
    assert.equal((first.payload as { error?: string }).error, "host_seed");
    assert.equal((first.payload as { next?: string }).next, "write_page");
    assert.equal(first.detail, HOST_SEED_PRODUCE_NEXT);
    assert.equal(loadProject(root).pages[0]?.path, "pages/1_cover.page");
  });
});

describe("chart slot without exhibit", () => {
  it("refuses a 走势/架构 label with an empty slot below it", () => {
    const hollow: SkillPageInput = {
      id: "financials",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 72, 760, 40],
          content: { text: "营收三年翻三倍", fontSize: 26, color: "#001142" },
        },
        {
          elementId: "slot",
          elementType: "text",
          bounds: [40, 186, 540, 18],
          content: { text: "营收与净利率走势（2024–2028E）", fontSize: 13, color: "#001142" },
        },
      ],
    };
    const err = writePageSchemaError(writePageSchemaIssues(hollow), hollow);
    assert.equal(err?.error, "empty_box");
    assert.match(err?.detail ?? "", /走势/);
  });

  it("accepts the same label when a chart occupies the slot", () => {
    const filled: SkillPageInput = {
      id: "financials",
      pageType: "content",
      elements: [
        {
          elementId: "slot",
          elementType: "text",
          bounds: [40, 186, 540, 18],
          content: { text: "营收与净利率走势（2024–2028E）", fontSize: 13, color: "#001142" },
        },
        {
          elementId: "chart",
          elementType: "chart",
          bounds: [40, 214, 540, 220],
          data: {
            cols: ["年", "营收"],
            rows: [
              ["2024", 12],
              ["2028", 53],
            ],
          },
          series: [{ type: "bar", name: "营收", encode: { x: "年", y: "营收" } }],
        },
      ],
    };
    assert.equal(writePageSchemaError(writePageSchemaIssues(filled), filled), undefined);
  });
});

describe("reused full-bleed src", () => {
  const coverSrc = "media/aerial-lifeline-cover.png";
  const siblings = [{ pageId: "cover", src: coverSrc }];

  function photoPage(
    id: string,
    pageType: string,
    src: string,
    bounds: [number, number, number, number],
  ): SkillPageInput {
    return {
      id,
      pageType,
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 40, 400, 40],
          content: { text: "低空医疗物流规模", fontSize: 22, color: "#111111" },
        },
        {
          elementId: "hero",
          elementType: "image",
          bounds,
          src,
        },
      ],
    };
  }

  it("allows a cover full-bleed even when siblings reuse the src", () => {
    const cover = photoPage("cover", "cover", coverSrc, [0, 0, 960, 540]);
    assert.equal(reusedFullBleedSrcIssue(cover, siblings), undefined);
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(cover, { siblingImageSrcs: siblings }), cover, {
        siblingImageSrcs: siblings,
      }),
      undefined,
    );
  });

  it("rejects a non-cover full-bleed that reuses a sibling src", () => {
    const section = photoPage("section", "content", coverSrc, [0, 0, 960, 540]);
    const issue = reusedFullBleedSrcIssue(section, siblings);
    assert.equal(issue?.code, "reused_cover_src");
    assert.match(issue?.message ?? "", /reused/);
    assert.match(issue?.message ?? "", /aerial-lifeline-cover/);
    assert.match(issue?.message ?? "", /cover/);
    const err = writePageSchemaError(writePageSchemaIssues(section, { siblingImageSrcs: siblings }), section, {
      siblingImageSrcs: siblings,
    });
    assert.equal(err?.error, "reused_cover_src");
    assert.match(err?.detail ?? "", /aerial-lifeline-cover/);
  });

  it("allows a non-cover full-bleed with a unique src", () => {
    const section = photoPage("section", "content", "media/section-corridor.png", [0, 0, 960, 540]);
    assert.equal(reusedFullBleedSrcIssue(section, siblings), undefined);
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(section, { siblingImageSrcs: siblings }), section, {
        siblingImageSrcs: siblings,
      }),
      undefined,
    );
  });

  it("allows a small image that reuses the cover src", () => {
    const section = photoPage("section", "content", coverSrc, [20, 20, 64, 64]);
    assert.equal(reusedFullBleedSrcIssue(section, siblings), undefined);
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(section, { siblingImageSrcs: siblings }), section, {
        siblingImageSrcs: siblings,
      }),
      undefined,
    );
  });
});
