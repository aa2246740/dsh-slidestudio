import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { classifyBriefKind } from "./compose-ir.js";
import { executeGenerateTool, type AgentToolState } from "./agent-tools.js";
import { persistPageKey } from "./layout-qa.js";
import { loadPlaybook } from "./playbook.js";
import { stableSha256 } from "./run-ledger.js";
import {
  KIND_THEME_PACK_ERROR,
  MISSING_THEME_PACK_ERROR,
  PACK_COLOR_ERROR,
  chosenThemePacksFrom,
  extractColorPaletteHexes,
  kindThemePackIssue,
  packColorWriteContextFrom,
  parseThemePackId,
  sourceIdList,
} from "./theme-pack.js";
import {
  BEILU_H1,
  QINGLAN_INTRO,
  CHENGGUANG_MONTHLY,
  HARNESS_NOT_MONTHLY,
  LEARN_SHARE,
  LEARN_SHARE_CHAPTERS,
  COVER_ONLY,
} from "./compose-ir.test.js";
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

describe("theme pack parse from catalog ids", () => {
  it("parses group/slug, preview, design.md, numbered 澄光, and lead-grey alias", () => {
    assert.equal(parseThemePackId("work/warm-jade-annual-report"), "work/warm-jade-annual-report");
    assert.equal(parseThemePackId("openkimi-preview:work/warm-jade-annual-report"), "work/warm-jade-annual-report");
    assert.equal(
      parseThemePackId("openkimi:reference/design_system/work/warm-jade-annual-report/design.md"),
      "work/warm-jade-annual-report",
    );
    assert.equal(
      parseThemePackId("reference/design_system/03_work/03/en/warm-jade-annual-report.md"),
      "work/warm-jade-annual-report",
    );
    assert.equal(parseThemePackId("work/lead-grey"), "work/warm-jade-annual-report");
    assert.equal(
      parseThemePackId("openkimi:reference/design_system/02_business/04/en/lead-gray-quarterly.md"),
      "work/warm-jade-annual-report",
    );
    assert.equal(
      parseThemePackId("openkimi:reference/design_system/consulting/pine-green-strategy/design.md"),
      "consulting/pine-green-strategy",
    );
    assert.equal(parseThemePackId("agent-self-directed-plan"), undefined);
    assert.equal(parseThemePackId("openkimi:SKILL.md"), undefined);
    assert.equal(parseThemePackId("openkimi:reference/slides_categories/management-report.md"), undefined);
  });
});

describe("kind vs chosen theme pack disagreement", () => {
  it("requires scene-fit packs for the added office genres", () => {
    const performance = "个人年中述职报告：目标达成、代表项目、能力复盘和下半年计划。";
    const workReport = "项目阶段工作汇报：进度、交付、风险、资源和下周计划。";
    const teaching = "高中物理教学课件：概念、例题、课堂练习与小结。";
    const training = "新员工培训课件：流程、案例、练习和检查清单。";
    const proposal = "仓储自动化项目立项方案：现状、方案、投入、风险和决策事项。";

    for (const brief of [performance, workReport]) {
      assert.equal(kindThemePackIssue({ brief })?.code, MISSING_THEME_PACK_ERROR);
      assert.equal(kindThemePackIssue({ brief, adoptedSourceIds: ["work/sky-blue-wayfinding"] }), undefined);
      assert.equal(kindThemePackIssue({ brief, adoptedSourceIds: ["consulting/apricot-white-brief"] }), undefined);
      assert.equal(
        kindThemePackIssue({ brief, adoptedSourceIds: ["academic/paper-white-courseware"] })?.code,
        KIND_THEME_PACK_ERROR,
      );
    }

    for (const brief of [teaching, training]) {
      assert.equal(kindThemePackIssue({ brief })?.code, MISSING_THEME_PACK_ERROR);
      assert.equal(kindThemePackIssue({ brief, adoptedSourceIds: ["academic/blue-line-courseware"] }), undefined);
      assert.equal(kindThemePackIssue({ brief, adoptedSourceIds: ["consulting/apricot-white-brief"] }), undefined);
      assert.equal(
        kindThemePackIssue({ brief, adoptedSourceIds: ["work/warm-jade-annual-report"] })?.code,
        KIND_THEME_PACK_ERROR,
      );
    }

    assert.equal(kindThemePackIssue({ brief: proposal })?.code, MISSING_THEME_PACK_ERROR);
    for (const pack of ["consulting/pine-green-strategy", "finance/lake-blue-memo", "work/red-white-business"]) {
      assert.equal(kindThemePackIssue({ brief: proposal, adoptedSourceIds: [pack] }), undefined);
    }
    assert.equal(
      kindThemePackIssue({ brief: proposal, adoptedSourceIds: ["academic/paper-white-courseware"] })?.code,
      KIND_THEME_PACK_ERROR,
    );
  });

  it("refuses board H1 + 澄光 monthly chrome, allows consulting, refuses empty adopt", () => {
    assert.equal(classifyBriefKind(BEILU_H1), "board-h1");
    const jade = kindThemePackIssue({
      brief: BEILU_H1,
      adoptedSourceIds: ["work/warm-jade-annual-report"],
    });
    assert.equal(jade?.code, KIND_THEME_PACK_ERROR);
    assert.equal(jade?.packId, "work/warm-jade-annual-report");
    const numbered = kindThemePackIssue({
      brief: BEILU_H1,
      adoptedSourceIds: ["openkimi:reference/design_system/03_work/03/en/warm-jade-annual-report.md"],
    });
    assert.equal(numbered?.packId, "work/warm-jade-annual-report");
    const academic = kindThemePackIssue({
      brief: BEILU_H1,
      designSystemId: "academic/paper-white-courseware",
    });
    assert.equal(academic?.family, "academic");
    assert.equal(
      kindThemePackIssue({
        brief: BEILU_H1,
        adoptedSourceIds: ["consulting/pine-green-strategy"],
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: BEILU_H1,
        adoptedSourceIds: ["agent-self-directed-plan"],
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    assert.equal(kindThemePackIssue({ brief: BEILU_H1 })?.code, MISSING_THEME_PACK_ERROR);
  });

  it("refuses product-intro + work 经营月报 layouts, allows consulting", () => {
    assert.equal(classifyBriefKind(QINGLAN_INTRO), "product-intro");
    const work = kindThemePackIssue({
      brief: QINGLAN_INTRO,
      adoptedSourceIds: ["work/blue-flame-brand"],
    });
    assert.equal(work?.code, KIND_THEME_PACK_ERROR);
    assert.equal(work?.family, "work");
    assert.equal(
      kindThemePackIssue({
        brief: QINGLAN_INTRO,
        adoptedSourceIds: ["consulting/pine-green-strategy"],
      }),
      undefined,
    );
    assert.equal(kindThemePackIssue({ brief: QINGLAN_INTRO })?.code, MISSING_THEME_PACK_ERROR);
  });

  it("keeps 澄光 monthly on work/warm-jade and does not lock other/cover briefs", () => {
    assert.equal(
      kindThemePackIssue({
        brief: CHENGGUANG_MONTHLY,
        adoptedSourceIds: ["work/warm-jade-annual-report"],
      }),
      undefined,
    );
    assert.equal(kindThemePackIssue({ brief: CHENGGUANG_MONTHLY }), undefined);
    assert.equal(
      kindThemePackIssue({
        brief: HARNESS_NOT_MONTHLY,
        adoptedSourceIds: ["work/warm-jade-annual-report"],
      }),
      undefined,
    );
    assert.equal(kindThemePackIssue({ brief: HARNESS_NOT_MONTHLY }), undefined);
  });

  it("requires an academic pack for 开题答辩 and refuses empty or 澄光 adopt", () => {
    const defense = "开题报告：城市热岛。只有方法边界，没有实验数据。";
    assert.equal(classifyBriefKind(defense), "academic");
    assert.equal(kindThemePackIssue({ brief: defense })?.code, MISSING_THEME_PACK_ERROR);
    assert.equal(
      kindThemePackIssue({
        brief: defense,
        adoptedSourceIds: ["work/warm-jade-annual-report"],
      })?.code,
      KIND_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: defense,
        adoptedSourceIds: ["academic/paper-white-courseware"],
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: defense,
        adoptedSourceIds: sourceIdList({ sourceId: "academic/paper-white-courseware" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: defense,
        adoptedSourceIds: sourceIdList({
          item: { kind: "academic", name: "paper-white-courseware" },
        }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: defense,
        adoptedSourceIds: sourceIdList({ kind: "academic", name: "meridian" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: defense,
        adoptedSourceIds: sourceIdList({ kind: "promotion", name: "silk-yellow-magazine" }),
      })?.code,
      KIND_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: defense,
        adoptedSourceIds: sourceIdList({ sourceId: "agent-self-directed-plan" }),
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: defense,
        adoptedSourceIds: sourceIdList({ kind: "academic" }),
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    const personalDefense = "做一次硕士「个人答辩」。开题答辩，约 16 页。不是经营月报，不是学习分享。";
    assert.equal(classifyBriefKind(personalDefense), "academic");
    assert.equal(kindThemePackIssue({ brief: personalDefense })?.code, MISSING_THEME_PACK_ERROR);
    assert.equal(
      kindThemePackIssue({
        brief: personalDefense,
        adoptedSourceIds: sourceIdList({ sourceId: "academic/paper-white-courseware" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: personalDefense,
        adoptedSourceIds: sourceIdList({ packId: "academic/paper-white-courseware" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: personalDefense,
        adoptedSourceIds: sourceIdList({ id: "academic/paper-white-courseware" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: personalDefense,
        adoptedSourceIds: sourceIdList({ id: "1_cover" }),
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
  });

  it("requires consulting or promotion for 学习分享 and refuses empty / 澄光 / academic / finance adopt", () => {
    assert.equal(classifyBriefKind(LEARN_SHARE), "learn-share");
    assert.equal(kindThemePackIssue({ brief: LEARN_SHARE })?.code, MISSING_THEME_PACK_ERROR);
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: ["agent-self-directed-plan"],
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: ["work/warm-jade-annual-report"],
      })?.code,
      KIND_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: ["academic/paper-white-courseware"],
      })?.family,
      "academic",
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: ["finance/black-gold-ledger"],
      })?.family,
      "finance",
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: ["consulting/pine-green-strategy"],
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: ["promotion/silk-yellow-magazine"],
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: ["openkimi:reference/design_system/01_strategy/04/en/red-black-business.md"],
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: ["openkimi:reference/design_system/04_promotion/02/en/silk-yellow-magazine.md"],
      }),
      undefined,
    );
    assert.deepEqual(sourceIdList({ item: "consulting/pine-green-strategy" }), ["consulting/pine-green-strategy"]);
    assert.deepEqual(
      sourceIdList({
        item: "openkimi:reference/design_system/01_strategy/04/en/red-black-business.md",
      }),
      ["openkimi:reference/design_system/01_strategy/04/en/red-black-business.md"],
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({
          item: "openkimi:reference/design_system/01_strategy/04/en/red-black-business.md",
        }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ item: "openkimi-preview:promotion/silk-yellow-magazine" }),
      }),
      undefined,
    );
    assert.deepEqual(sourceIdList({ sourceId: "consulting/pine-green-strategy" }), ["consulting/pine-green-strategy"]);
    assert.deepEqual(sourceIdList({ item: { sourceId: "promotion/silk-yellow-magazine" } }), [
      "promotion/silk-yellow-magazine",
    ]);
    assert.deepEqual(sourceIdList({ kind: "promotion", name: "silk-yellow-magazine" }), [
      "promotion/silk-yellow-magazine",
    ]);
    assert.deepEqual(sourceIdList({ item: { kind: "academic", name: "paper-white-courseware" } }), [
      "academic/paper-white-courseware",
    ]);
    assert.deepEqual(sourceIdList({ kind: "academic", name: "meridian" }), ["academic/meridian"]);
    assert.deepEqual(sourceIdList({ kind: "finance", name: "black-gold-ledger" }), ["finance/black-gold-ledger"]);
    assert.deepEqual(sourceIdList({ kind: "01_strategy", name: "red-black-business" }), [
      "consulting/red-black-business",
    ]);
    assert.deepEqual(sourceIdList({ sourceId: {} }), []);
    assert.deepEqual(sourceIdList({ kind: "academic" }), []);
    assert.deepEqual(sourceIdList({ name: "paper-white-courseware" }), []);
    assert.deepEqual(sourceIdList({ id: "consulting/pine-green-strategy" }), ["consulting/pine-green-strategy"]);
    assert.deepEqual(sourceIdList({ packId: "academic/paper-white-courseware" }), ["academic/paper-white-courseware"]);
    assert.deepEqual(sourceIdList({ item: { packId: "promotion/silk-yellow-magazine" } }), [
      "promotion/silk-yellow-magazine",
    ]);
    assert.deepEqual(sourceIdList({ id: {} }), []);
    assert.deepEqual(sourceIdList({ packId: {} }), []);
    assert.deepEqual(sourceIdList({ id: "1_cover" }), ["1_cover"]);
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ sourceId: "consulting/pine-green-strategy" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({
          item: { sourceId: "openkimi-preview:promotion/silk-yellow-magazine" },
        }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ kind: "promotion", name: "silk-yellow-magazine" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ kind: "finance", name: "black-gold-ledger" }),
      })?.family,
      "finance",
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ sourceId: {} }),
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ kind: "promotion" }),
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ id: "consulting/pine-green-strategy" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ packId: "promotion/silk-yellow-magazine" }),
      }),
      undefined,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ id: {} }),
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ packId: {} }),
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE,
        adoptedSourceIds: sourceIdList({ id: "1_cover" }),
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
    assert.equal(classifyBriefKind(LEARN_SHARE_CHAPTERS), "learn-share");
    assert.equal(kindThemePackIssue({ brief: LEARN_SHARE_CHAPTERS })?.code, MISSING_THEME_PACK_ERROR);
    assert.equal(
      kindThemePackIssue({
        brief: LEARN_SHARE_CHAPTERS,
        adoptedSourceIds: ["agent-self-directed-plan"],
      })?.code,
      MISSING_THEME_PACK_ERROR,
    );
  });

  it("does not close retail-monthly or cover-only empty adopt", () => {
    assert.equal(kindThemePackIssue({ brief: CHENGGUANG_MONTHLY }), undefined);
    assert.equal(kindThemePackIssue({ brief: COVER_ONLY }), undefined);
    assert.equal(kindThemePackIssue({ brief: HARNESS_NOT_MONTHLY }), undefined);
  });

  it("does not refuse a user-explicit 澄光 pack, but still refuses an extra work adopt", () => {
    assert.equal(
      kindThemePackIssue({
        brief: BEILU_H1,
        designSystemId: "work/warm-jade-annual-report",
        userExplicitPack: true,
      }),
      undefined,
    );
    const extra = kindThemePackIssue({
      brief: BEILU_H1,
      designSystemId: "consulting/pine-green-strategy",
      userExplicitPack: true,
      adoptedSourceIds: ["work/warm-jade-annual-report"],
    });
    assert.equal(extra?.packId, "work/warm-jade-annual-report");
  });

  it("treats mixed adopt lists as a disagreement when any pack is wrong", () => {
    const packs = chosenThemePacksFrom({
      adoptedSourceIds: [
        "openkimi:SKILL.md",
        "consulting/pine-green-strategy",
        "openkimi-preview:work/warm-jade-annual-report",
      ],
    });
    assert.equal(
      packs.some((row) => row.id === "work/warm-jade-annual-report"),
      true,
    );
    const issue = kindThemePackIssue({
      brief: BEILU_H1,
      adoptedSourceIds: [
        "openkimi:SKILL.md",
        "consulting/pine-green-strategy",
        "openkimi-preview:work/warm-jade-annual-report",
      ],
    });
    assert.equal(issue?.packId, "work/warm-jade-annual-report");
  });
});

describe("write-time and compose-time kind/theme pack fail-closed", () => {
  it("write_page refuses board H1 with 澄光 pack and still writes consulting", () => {
    const bad = executeGenerateTool(
      "write_page",
      coverPage("cover", "北麓制造 2026 上半年经营汇报"),
      stateFor(BEILU_H1, "work/warm-jade-annual-report"),
    );
    assert.equal(bad.ok, false);
    assert.equal((bad.payload as { error?: string }).error, KIND_THEME_PACK_ERROR);
    assert.equal((bad.payload as { painted?: boolean }).painted, false);
    const ok = executeGenerateTool(
      "write_page",
      coverPage("cover", "北麓制造 2026 上半年经营汇报", "#03522C"),
      stateFor(BEILU_H1, "consulting/pine-green-strategy"),
    );
    assert.equal(ok.ok, true, ok.detail);
  });

  it("write_todo and compose_deck refuse product-intro with work pack", () => {
    const todo = executeGenerateTool(
      "write_todo",
      {
        items: [
          { pageId: "cover", title: "青岚费控产品介绍", layoutFamily: "cover" },
          { pageId: "final", title: "结束页", layoutFamily: "final" },
        ],
        adoptedSourceIds: ["work/warm-jade-annual-report"],
      },
      stateFor(QINGLAN_INTRO),
    );
    assert.equal(todo.ok, false);
    assert.equal((todo.payload as { error?: string }).error, KIND_THEME_PACK_ERROR);

    const composeState = stateFor(QINGLAN_INTRO, "work/electric-violet-business");
    composeState.writtenPages = [coverPage("cover", "青岚费控 · 产品介绍"), closerPage("final")];
    const compose = executeGenerateTool("compose_deck", { title: "青岚费控" }, composeState);
    assert.equal(compose.ok, false);
    assert.equal((compose.payload as { error?: string }).error, KIND_THEME_PACK_ERROR);
    assert.equal((compose.payload as { painted?: boolean }).painted, false);
  });

  it("chengguang monthly can still write the 澄光 work pack", () => {
    const monthly = "澄光生活 2026年7月经营月报。营收 1,860 万，预算达成 93%。约 20 页。";
    const write = executeGenerateTool(
      "write_page",
      coverPage("cover", "澄光生活 2026年7月经营月报", "#FDC356"),
      stateFor(monthly, "work/warm-jade-annual-report"),
    );
    assert.notEqual((write.payload as { error?: string }).error, KIND_THEME_PACK_ERROR);
    assert.notEqual((write.payload as { error?: string }).error, MISSING_THEME_PACK_ERROR);
    assert.equal(write.ok, true, write.detail);
  });

  it("write_page and compose_deck refuse board H1 / product-intro when commit_design adopted no pack", () => {
    const write = executeGenerateTool(
      "write_page",
      coverPage("cover", "北麓制造 2026 上半年经营汇报"),
      stateFor(BEILU_H1),
    );
    assert.equal(write.ok, false);
    assert.equal((write.payload as { error?: string }).error, MISSING_THEME_PACK_ERROR);
    assert.equal((write.payload as { painted?: boolean }).painted, false);

    const composeState = stateFor(QINGLAN_INTRO);
    composeState.writtenPages = [coverPage("cover", "青岚费控 · 产品介绍"), closerPage("final")];
    const compose = executeGenerateTool("compose_deck", { title: "青岚费控" }, composeState);
    assert.equal(compose.ok, false);
    assert.equal((compose.payload as { error?: string }).error, MISSING_THEME_PACK_ERROR);
    assert.equal((compose.payload as { painted?: boolean }).painted, false);
  });

  it("write_page and compose_deck refuse 学习分享 empty adopt and still write consulting/promotion", () => {
    const empty = executeGenerateTool("write_page", coverPage("cover", "把模糊问题变清晰"), stateFor(LEARN_SHARE));
    assert.equal(empty.ok, false);
    assert.equal((empty.payload as { error?: string }).error, MISSING_THEME_PACK_ERROR);
    assert.equal((empty.payload as { painted?: boolean }).painted, false);

    const consulting = executeGenerateTool(
      "write_page",
      coverPage("cover", "把模糊问题变清晰", "#03522C"),
      stateFor(LEARN_SHARE, "consulting/pine-green-strategy"),
    );
    assert.equal(consulting.ok, true, consulting.detail);

    const promotion = executeGenerateTool(
      "write_page",
      coverPage("cover", "把模糊问题变清晰", "#000000"),
      stateFor(LEARN_SHARE, "promotion/silk-yellow-magazine"),
    );
    assert.equal(promotion.ok, true, promotion.detail);

    const composeState = stateFor(LEARN_SHARE);
    composeState.writtenPages = [coverPage("cover", "把模糊问题变清晰"), closerPage("final")];
    const compose = executeGenerateTool("compose_deck", { title: "学习分享" }, composeState);
    assert.equal(compose.ok, false);
    assert.equal((compose.payload as { error?: string }).error, MISSING_THEME_PACK_ERROR);
    assert.equal((compose.payload as { painted?: boolean }).painted, false);
  });
});
