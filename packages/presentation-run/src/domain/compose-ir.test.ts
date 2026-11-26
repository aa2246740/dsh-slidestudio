import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBriefKind,
  inferDeckIntent,
  briefToOutline,
  briefWithoutNegatedDocTypes,
  composeBodyRules,
  requestedPageCountFromBrief,
  parseComposeDeck,
} from "./compose-ir.js";

export const BEILU_H1 =
  "给公司董事会做一份「北麓制造 2026 上半年经营汇报」。办公场景，给董事会的半年经营审议，不是门店月报，不是产品立项。内容要有：H1 收入/毛利/现金一句话结论，三条业务线达成，产能与交期，客户与回款，资本开支，下半年要拍的板。 16 页左右。虚构演示数据。不要澄光生活，不要青岚费控，不要学习分享，不要个人答辩。\n视觉不要素白公文：深色封面、杂志感排版、数字很大、对比强、克制留白、琥珀或铜点缀。仍是董事会半年经营汇报，不是花哨营销页，不是月报换皮。";

export const QINGLAN_INTRO =
  "给管理层做一份「青岚费控」产品介绍，办公立项用。讲清楚：这是什么、给谁用（财务/部门经理/员工）、解决什么报销和对账痛点、核心流程、和现有 Excel/OA 的差别、上线节奏、这次要拍的板。16 页左右。虚构演示数据即可。不要做成经营月报，不要澄光生活，不要学习分享，不要个人答辩。";

export const CHENGGUANG_MONTHLY = "澄光生活 2026年7月经营月报，约 20 页。";

export const HARNESS_NOT_MONTHLY =
  "闸门复现灯开关\n两页即可：封面 + 结束页。不要做成经营月报，不要做成课件。虚构车间灯开关验收。";

export const LEARN_SHARE =
  "给同事做一次内部「学习分享」。办公场景，约 30 分钟的知识分享会，听众是同组同事，不是经营月报，不是产品立项，不是董事会半年报，不是个人答辩。内容结构：封面与分享目的、今天带走什么、问题从哪来、核心概念、方法拆成步骤、一个可复述的例子、对照常见误区、检查清单、怎么用回工作、结束页。16–20 页。不要编造收入、毛利、回款等经营 KPI。不要澄光生活，不要青岚费控，不要北麓制造，不要个人答辩。\n视觉不要素白公文：深色封面、杂志感排版、标题和步骤数字要大、对比强、克制留白。仍是学习分享，不是花哨营销页。导出 hybrid PPTX。";

/** Mentions 封面 + 一张章节页; must not collapse to cover-only. */
export const LEARN_SHARE_CHAPTERS =
  "给AI产品同学做一场内部学习分享：Agent 怎么把需求拆成可执行计划。封面之后分三部分：问题、方法、例子。每部分先一张章节页再展开。收尾一页把步骤收成清单。";

export const COVER_ONLY = "只要一张封面：光合作用。";

export const TSMC_H1_REVIEW =
  "做一份给经营层与董事看的 2026 半年度检讨简报。页数 12；封面与末页深蓝，内页暖灰白，点缀砖红与松绿。";

describe("brief kind routing", () => {
  it("accepts a one-page compose IR", () => {
    const deck = parseComposeDeck({
      title: "光合作用",
      pages: [{ role: "cover", title: "光合作用" }],
    });
    assert.equal(deck.pages.length, 1);
    assert.equal(deck.pages[0]?.title, "光合作用");
  });

  it("honors an explicit page count and invents no total when the brief omits one", () => {
    assert.equal(requestedPageCountFromBrief("请制作 4 页教学课件"), 4);
    assert.equal(requestedPageCountFromBrief("页数 12；封面深蓝"), 12);
    assert.equal(composeBodyRules("请制作 4 页教学课件：概念、例题、练习、总结").minPages, 4);
    const unspecifiedTeaching = composeBodyRules("教学课件：概念、例题、练习、总结");
    assert.deepEqual(unspecifiedTeaching.pageCount, { kind: "unspecified" });
    assert.equal(unspecifiedTeaching.minPages, 1);
  });

  it("keeps Markdown heading titles intact when the body says 16:9", () => {
    const outline = briefToOutline("# 新员工信息安全培训课件\n\n请制作 7 页 16:9 办公培训 PPT。");
    assert.equal(outline.title, "新员工信息安全培训课件");
    assert.match(outline.claims.join(" "), /16∶9/);
  });

  it("classifies 董事会半年经营汇报 as board H1, not 立项, academic, or 澄光月报", () => {
    assert.equal(classifyBriefKind(BEILU_H1), "board-h1");
    assert.equal(inferDeckIntent(BEILU_H1), "report");
    assert.notEqual(inferDeckIntent(BEILU_H1), "academic");
    assert.doesNotMatch(briefWithoutNegatedDocTypes(BEILU_H1), /个人答辩/);
    assert.doesNotMatch(briefWithoutNegatedDocTypes(BEILU_H1), /门店月报/);
    assert.doesNotMatch(briefWithoutNegatedDocTypes(BEILU_H1), /产品立项/);
  });

  it("classifies the real 经营层与董事半年度检讨 brief as board H1", () => {
    assert.equal(classifyBriefKind(TSMC_H1_REVIEW), "board-h1");
    assert.equal(inferDeckIntent(TSMC_H1_REVIEW), "report");
  });

  it("classifies 青岚费控 产品介绍 as product-intro, not a monthly", () => {
    assert.equal(classifyBriefKind(QINGLAN_INTRO), "product-intro");
    assert.equal(inferDeckIntent(QINGLAN_INTRO), "decide");
    assert.notEqual(inferDeckIntent(QINGLAN_INTRO), "report");
  });

  it("does not reintroduce a negated half-year board report", () => {
    const brief = "给经营层做青岚费控产品介绍，不要做半年度检讨简报。";
    assert.equal(classifyBriefKind(brief), "product-intro");
    assert.equal(inferDeckIntent(brief), "decide");
    assert.doesNotMatch(briefWithoutNegatedDocTypes(brief), /半年度检讨简报/);
  });

  it("keeps 不要做成经营月报 off monthly and keeps a real 经营月报 on monthly", () => {
    assert.equal(classifyBriefKind(HARNESS_NOT_MONTHLY), "other");
    assert.notEqual(inferDeckIntent(HARNESS_NOT_MONTHLY), "report");
    assert.equal(classifyBriefKind(CHENGGUANG_MONTHLY), "retail-monthly");
    assert.equal(inferDeckIntent(CHENGGUANG_MONTHLY), "report");
  });

  it("still treats 开题答辩 as academic and 勾股 as teach", () => {
    assert.equal(classifyBriefKind("开题报告：城市热岛。只有方法边界，没有实验数据。"), "academic");
    assert.equal(inferDeckIntent("开题报告：城市热岛。只有方法边界，没有实验数据。"), "academic");
    assert.equal(inferDeckIntent("硕士答辩：城市热岛对课间活动时长的影响。只有方法边界。"), "academic");
    assert.equal(
      classifyBriefKind("做一次硕士「个人答辩」。开题答辩，约 16 页。不是经营月报，不是学习分享。"),
      "academic",
    );
    assert.equal(classifyBriefKind("介绍一下勾股定理，面向小学生"), "teach-pythagoras");
    assert.equal(inferDeckIntent("介绍一下勾股定理，面向小学生"), "teach");
  });

  it("classifies 学习分享 / 分享会 / 内部分享 as learn-share, not other, 月报, or 立项", () => {
    assert.equal(classifyBriefKind(LEARN_SHARE), "learn-share");
    assert.equal(inferDeckIntent(LEARN_SHARE), "teach");
    assert.notEqual(inferDeckIntent(LEARN_SHARE), "report");
    assert.equal(classifyBriefKind("给同事做一场分享会，约 16 页。"), "learn-share");
    assert.equal(classifyBriefKind("做一次内部分享：把模糊问题变清晰。16 页。"), "learn-share");
    assert.equal(classifyBriefKind(LEARN_SHARE_CHAPTERS), "learn-share");
    assert.notEqual(classifyBriefKind(LEARN_SHARE_CHAPTERS), "cover-only");
    assert.doesNotMatch(briefWithoutNegatedDocTypes(LEARN_SHARE), /经营月报/);
    assert.doesNotMatch(briefWithoutNegatedDocTypes(LEARN_SHARE), /产品立项/);
    assert.equal(classifyBriefKind(BEILU_H1), "board-h1");
    assert.equal(classifyBriefKind(QINGLAN_INTRO), "product-intro");
    assert.equal(classifyBriefKind(COVER_ONLY), "cover-only");
    assert.equal(classifyBriefKind("一张封面：光合作用"), "cover-only");
  });

  it("does not route a knowledge share to monthly when it says to avoid monthly styling", () => {
    const brief = "内部知识分享：如何把复盘写成可执行结论。避免经营月报样式，不要使用财务账本式密集表格。";
    assert.equal(classifyBriefKind(brief), "learn-share");
    assert.equal(inferDeckIntent(brief, "education-training"), "teach");
    assert.doesNotMatch(briefWithoutNegatedDocTypes(brief), /经营月报/);
  });

  it("routes common office teaching, performance, work, training, and proposal briefs intentionally", () => {
    const performance = "做一份产品经理个人年中述职报告：目标达成、代表项目、能力复盘和下半年计划。";
    const promotionDefense = "做一份晋升述职答辩：年度贡献、关键项目、能力证明和下一阶段目标。";
    const workReport = "做一份研发团队项目阶段工作汇报：进度、交付、风险、资源和下周计划。";
    const training = "做一份面向一线主管的新员工培训课件：流程、案例、练习和检查清单。";
    const teaching = "做一份高中物理教学课件：概念导入、推导、例题、课堂练习与小结。";
    const teachingShare = "给教研组做一次教学分享：如何设计一堂可参与、可检查的复习课。";
    const proposal = "做一份仓储自动化项目立项方案：现状、目标、方案、投入、里程碑、风险和决策事项。";

    assert.equal(classifyBriefKind(performance), "performance-review");
    assert.equal(classifyBriefKind(promotionDefense), "performance-review");
    assert.equal(inferDeckIntent(performance), "report");
    assert.equal(classifyBriefKind(workReport), "work-report");
    assert.equal(inferDeckIntent(workReport), "report");
    assert.equal(classifyBriefKind(training), "training");
    assert.equal(inferDeckIntent(training), "teach");
    assert.equal(classifyBriefKind(teaching), "teaching");
    assert.equal(inferDeckIntent(teaching), "teach");
    assert.equal(classifyBriefKind(teachingShare), "learn-share");
    assert.equal(inferDeckIntent(teachingShare), "teach");
    assert.equal(classifyBriefKind(proposal), "project-proposal");
    assert.equal(inferDeckIntent(proposal), "decide");
    assert.equal(classifyBriefKind("硕士毕业答辩：城市热岛研究。"), "academic");
  });

  it("keeps a stated 述职报告 ahead of a rejected company monthly style", () => {
    const brief = "产品经理 2026 年中述职报告。区分个人贡献与团队成果。不要做成学术答辩或公司经营月报。";
    assert.equal(classifyBriefKind(brief), "performance-review");
    assert.equal(inferDeckIntent(brief), "report");
  });
});
