import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contrastRatio, createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import {
  parseComposeDeck,
  assertComposeHasBody,
  fillComposeFromTodos,
  deterministicDeck,
  inferDeckIntent,
  resolvePlaybookCategory,
  resolveGenerateDesign,
  intentComposeGuidance,
  DEFAULT_ACADEMIC_DESIGN,
  DEFAULT_PROMO_DESIGN,
  DEFAULT_REPORT_DESIGN,
  DEFAULT_TEACH_DESIGN,
  DEFAULT_TRAVEL_DESIGN,
  HUB_DEFAULT_DESIGN,
  extractPalette,
  extractReferenceLines,
  loadPlaybook,
  listDesignSystems,
  createPlaybookBrain,
  runGenerate,
  runGenerateAsync,
  mockBrain,
  chartHasNumericY,
  stripIndexPrefix,
  briefToOutline,
  materializeDeck,
  titleFontSize,
  composeBodyRules,
} from "./index.js";

describe("open-kimi playbook", () => {
  it("does not force a four-page teaching brief to six pages", () => {
    assert.equal(composeBodyRules("请制作 4 页教学课件：定义、例子、练习、总结").minPages, 4);
    assert.equal(composeBodyRules("教学课件：定义、例子、练习、总结").minPages, 6);
  });

  it("uses a Markdown heading as the deck title without splitting 16:9", () => {
    const outline = briefToOutline(
      "# 客户运营中心 2026 年 7 月经营月报\n\n请制作 7 页 16:9 中文办公 PPT，受众是经营层。",
    );
    assert.equal(outline.title, "客户运营中心 2026 年 7 月经营月报");
    assert.match(outline.claims.join(" "), /16∶9/);
  });

  it("lists consulting design systems and extracts a dark primary", () => {
    const bundle = loadPlaybook({
      designSystemId: "consulting/pine-green-strategy",
      categoryId: "analysis-decision",
    });
    assert.match(bundle.designSystemId, /pine-green-strategy/);
    assert.ok(bundle.designMarkdown.includes("PART B"));
    assert.equal(bundle.skillExcerpt, fs.readFileSync(path.join(bundle.skillRoot, "SKILL.md"), "utf8"));
    assert.doesNotMatch(bundle.skillExcerpt, /\[truncated\]/);
    assert.match(bundle.skillExcerpt, /Image priority/);
    assert.match(bundle.pptdExcerpt, /bounds/);
    assert.equal(bundle.pptdExcerpt, fs.readFileSync(path.join(bundle.skillRoot, "reference", "pptd.md"), "utf8"));
    assert.doesNotMatch(bundle.pptdExcerpt, /\[truncated\]/);
    const ids = listDesignSystems(bundle.skillRoot).map((s) => s.id);
    assert.ok(ids.includes("consulting/pine-green-strategy"));
    assert.ok(ids.includes("finance/lake-blue-memo"));
    const indigo = loadPlaybook({ designSystemId: "finance/indigo" });
    assert.match(indigo.designMarkdown, /indigo|尽调|due diligence/i);
    const pal = extractPalette(bundle.designMarkdown);
    assert.match(pal.primary, /^#[0-9A-F]{6}$/);
    assert.ok(["#03522C", "#04512C"].includes(pal.primary));
    assert.notEqual(pal.primary, "#E71C56");
  });

  it("does not invent pine-green or analysis-decision when hostDefaults is false", () => {
    const bundle = loadPlaybook({ hostDefaults: false });
    assert.equal(bundle.designSystemId, "");
    assert.equal(bundle.categoryId, "");
    assert.doesNotMatch(bundle.designMarkdown, /pine-green-strategy was selected/);
    assert.match(bundle.designMarkdown, /Host did not select a design system/);
  });

  it("extractPalette honors black-gold and red-black signatures", () => {
    const root = loadPlaybook().skillRoot;
    const blackGold = extractPalette(
      fs.readFileSync(path.join(root, "reference/design_system/finance/black-gold-ledger/design.md"), "utf8"),
    );
    assert.equal(blackGold.primary, "#151515");
    assert.equal(blackGold.accent, "#D6A000");
    const cream = extractPalette(
      fs.readFileSync(path.join(root, "reference/design_system/promotion/cream-collage/design.md"), "utf8"),
    );
    assert.equal(cream.background, "#F3E8D4");
    assert.ok(["#F05A39", "#2657D7"].includes(cream.primary));
    const redBlack = extractPalette(
      fs.readFileSync(path.join(root, "reference/design_system/consulting/red-black-growth/design.md"), "utf8"),
    );
    assert.ok(["#1C0B0B", "#0F0605"].includes(redBlack.primary));
    assert.equal(redBlack.accent, "#FF4D4D");
  });

  it("uses an accessible title color instead of a light accent on paper-white courseware", () => {
    const root = loadPlaybook().skillRoot;
    const paperWhite = extractPalette(
      fs.readFileSync(path.join(root, "reference/design_system/academic/paper-white-courseware/design.md"), "utf8"),
    );
    assert.equal(paperWhite.background, "#FDFAF5");
    assert.equal(paperWhite.primary, "#44712E");
    assert.ok(contrastRatio(paperWhite.primary, paperWhite.background) >= 4.5);
  });

  it("rejects thin compose IR and accepts a 2-page object", () => {
    assert.throws(() => parseComposeDeck({ title: "x", pages: [] }));
    const deck = parseComposeDeck({
      title: "核聚变商业化路径",
      pages: [
        { role: "cover", title: "核聚变商业化路径" },
        {
          role: "content",
          title: "资本开支窗口仍在 2028 之前",
          bullets: ["示范堆并网时点未定"],
        },
      ],
    });
    assert.equal(deck.pages.length, 2);
  });

  it("does not truncate an explicitly scripted 20-page deck", () => {
    const deck = parseComposeDeck({
      title: "20页经营月报",
      pages: Array.from({ length: 20 }, (_, index) => ({
        role: index === 0 ? "cover" : "content",
        title: `第${index + 1}页`,
        bullets: index === 0 ? undefined : [`第${index + 1}页结论`],
      })),
    });

    assert.equal(deck.pages.length, 20);
    assert.equal(deck.pages.at(-1)?.title, "第20页");
  });

  it("reads body copy from points/body aliases, not only bullets", () => {
    const deck = parseComposeDeck({
      title: "勾股小课堂",
      pages: [
        { role: "cover", title: "勾股小课堂" },
        {
          role: "toc",
          title: "今天要搞懂什么",
          points: ["直角边", "斜边", "3-4-5"],
        },
        {
          role: "content",
          title: "先认三条边",
          body: "直角对面是斜边。\n另外两边叫直角边。\n先指边，再写公式。",
        },
      ],
    });
    assert.deepEqual(deck.pages[1]?.items, ["直角边", "斜边", "3-4-5"]);
    assert.equal((deck.pages[2]?.bullets ?? []).length, 3);
  });

  it("rejects title-only teaching pages", () => {
    const thin = parseComposeDeck({
      title: "勾股小课堂",
      pages: [
        { role: "cover", title: "勾股小课堂" },
        { role: "toc", title: "今天要搞懂什么" },
        { role: "content", title: "直角边和斜边" },
        { role: "content", title: "公式" },
        { role: "close", title: "带走什么" },
      ],
    });
    assert.throws(() => assertComposeHasBody(thin), /too thin|bullets/i);
  });

  it("fills empty compose pages from write_todo notes", () => {
    const thin = parseComposeDeck({
      title: "勾股小课堂",
      pages: [
        { role: "cover", title: "勾股小课堂" },
        { role: "toc", title: "今天要搞懂什么" },
        { role: "content", title: "直角边和斜边" },
        { role: "content", title: "记住公式" },
        { role: "close", title: "带走什么" },
      ],
    });
    const filled = fillComposeFromTodos(thin, [
      { title: "封面" },
      { title: "今天要搞懂什么", note: "先认三条边。再记公式。最后用 3-4-5 检查。" },
      { title: "直角边和斜边", note: "直角对面是斜边。另外两边叫直角边。先指边再写字。" },
      { title: "记住公式", note: "写成 a²+b²=c²。c 一定是斜边。3-4-5 是课堂练习。" },
      { title: "带走什么", note: "能指认三边。能写出公式。回去画一个直角三角形。" },
    ]);
    assertComposeHasBody(filled);
    assert.ok((filled.pages[2]?.bullets ?? []).length >= 3);
  });

  it("supplements a one-bullet page from write_todo notes", () => {
    const thin = parseComposeDeck({
      title: "勾股小课堂",
      pages: [
        { role: "cover", title: "勾股小课堂" },
        { role: "toc", title: "今天要搞懂什么", items: ["边"] },
        { role: "content", title: "直角边和斜边", bullets: ["先找到直角。"] },
        { role: "content", title: "记住公式", bullets: ["写成 a²+b²=c²。"] },
        { role: "close", title: "带走什么", bullets: ["能指认三边。"] },
      ],
    });
    const filled = fillComposeFromTodos(thin, [
      { title: "封面" },
      { title: "今天要搞懂什么", note: "先认三条边。再记公式。最后用 3-4-5 检查。" },
      { title: "直角边和斜边", note: "直角对面是斜边。另外两边叫直角边。先指边再写字。" },
      { title: "记住公式", note: "c 一定是斜边。3-4-5 是课堂练习。先指边再写字。" },
      { title: "带走什么", note: "能写出公式。回去画一个直角三角形。" },
    ]);
    assertComposeHasBody(filled);
    assert.ok((filled.pages[2]?.bullets ?? []).length >= 3);
    assert.equal(filled.pages[2]?.bullets?.[0], "先找到直角。");
  });

  it("playbook brain writes a classroom lesson for a kids explainer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-teach-"));
    const result = runGenerate({
      projectRoot: dir,
      brief: "介绍一下勾股定理，面向小学生",
    });
    assert.equal(result.status, "ready");
    const project = loadProject(dir);
    assert.equal(project.pages.length, 6);
    const blob = JSON.stringify(project);
    assert.doesNotMatch(blob, /四个支撑面/);
    assert.doesNotMatch(blob, /先读标题判断，再看证据缺口，最后落到下周动作/);
    assert.match(blob, /勾股|直角/);
    assert.match(blob, /今天带走什么|课堂练习/);
    assert.ok(project.pages.some((pg) => pg.page.elements.some((el) => el.elementType === "chart")));
  });

  it("playbook brain writes consulting structure onto disk PPTD", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-"));
    const result = runGenerate({
      projectRoot: dir,
      brief: "华北区域 Q3 增长复盘：试点成效与下周动作",
    });
    assert.equal(result.status, "ready");
    const project = loadProject(dir);
    assert.ok(project.pages.length >= 5);
    assert.match(project.presentation.title ?? "", /华北|增长|复盘/);
    const primary = project.presentation.theme?.colors?.primary ?? "";
    assert.match(primary, /^#[0-9A-F]{6}$/);
    assert.notEqual(primary, "#2563EB");
    assert.ok(loadPlaybook().designMarkdown.toUpperCase().includes(primary.slice(1)));
    const roles = project.presentation.pages.join(" ");
    assert.match(roles, /cover/);
    assert.match(roles, /evidence/);
    assert.match(roles, /close/);
    const hasRound = project.pages.some((pg) =>
      pg.page.elements.some((el) => "shapeName" in el && (el as { shapeName?: string }).shapeName === "roundRect"),
    );
    assert.equal(hasRound, false);
  });

  it("mock brain remains available as an explicit fallback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-"));
    const result = runGenerate({
      projectRoot: dir,
      brief: "华北增长复盘",
      brain: mockBrain,
    });
    assert.equal(result.status, "ready");
    assert.equal(loadProject(dir).pages.length, 2);
  });

  it("async export still works with playbook default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-exp-"));
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "导出链路测试",
      exportPptx: true,
    });
    assert.equal(result.status, "ready");
    assert.ok(result.pptxPath && fs.existsSync(result.pptxPath));
  });

  it("optional LlmPort path materializes schema-valid IR", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-llm-"));
    const brain = createPlaybookBrain({
      llm: {
        async completeJson() {
          return {
            title: "示范堆并网窗口",
            pages: [
              { role: "cover", title: "示范堆并网窗口" },
              { role: "toc", title: "结构", items: ["判断", "证据", "动作"] },
              {
                role: "content",
                title: "资本开支必须赶在 2028 年前锁定",
                bullets: ["长周期设备交期不可压缩", "窗口一旦错过，示范堆并网只能后移", "先锁资本开支，再谈扩容叙事"],
              },
              {
                role: "evidence",
                title: "占位序列",
                note: "示意",
                chart: {
                  title: "示意",
                  cols: ["年", "值"],
                  rows: [
                    ["2026", 1],
                    ["2027", 2],
                  ],
                },
              },
              {
                role: "close",
                title: "动作",
                bullets: ["把占位图换成带单位的真实序列", "缺口径的位置保持待补", "下一步只写能核对的动作"],
              },
            ],
          };
        },
      },
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "核聚变商业化",
      brain,
    });
    assert.equal(result.status, "ready");
    assert.equal(loadProject(dir).presentation.title, "示范堆并网窗口");
  });

  it("does not plot a bar chart when evidence cells are labels", () => {
    assert.equal(
      chartHasNumericY({
        title: "t",
        cols: ["项", "状态"],
        rows: [["增长口径", "未统一"]],
      }),
      false,
    );
    assert.equal(
      chartHasNumericY({
        title: "t",
        cols: ["项", "值"],
        rows: [["A", 3]],
      }),
      true,
    );
    assert.equal(stripIndexPrefix("1. 试点成功信号"), "试点成功信号");
  });

  it("materialized body pages keep title boxes tall and toc numbers unwrapped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-"));
    const result = runGenerate({
      projectRoot: dir,
      brief: "华北区域 Q3 增长复盘：试点成效与下周动作",
    });
    assert.equal(result.status, "ready");
    const project = loadProject(dir);
    for (const pg of project.pages) {
      const title = pg.page.elements.find((e) => e.elementId === "title");
      assert.ok(title);
      assert.ok(title.bounds[3] >= 64);
    }
    const toc = project.pages.find((pg) => pg.path.includes("toc"));
    assert.ok(toc);
    const num = toc.page.elements.find((e) => e.elementId === "n0");
    assert.ok(num);
    assert.ok(num.bounds[2] >= 56);
    const ev = project.pages.find((pg) => pg.path.includes("evidence"));
    assert.ok(ev);
    assert.ok(ev.page.elements.some((e) => e.elementType === "chart"));
  });

  it("categorical evidence becomes a full-width table, not an empty bar chart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-ev-"));
    const project = createEmptyProject(dir, { title: "t" });
    materializeDeck(
      project,
      parseComposeDeck({
        title: "分类证据",
        pages: [
          { role: "cover", title: "分类证据" },
          {
            role: "evidence",
            title: "缺口都是状态而不是数值",
            chart: {
              title: "状态",
              cols: ["核查项", "试点口径", "统一目标", "差距状态"],
              rows: [
                ["增长口径定义", "占位", "占位", "未统一"],
                ["负责人归属", "占位", "占位", "未闭环"],
              ],
              note: "占位",
            },
          },
        ],
      }),
      loadPlaybook().palette,
    );
    const ev = project.pages.find((pg) => pg.path.includes("evidence"));
    assert.ok(ev);
    assert.equal(
      ev.page.elements.some((e) => e.elementType === "chart"),
      false,
    );
    const tbl = ev.page.elements.find((e) => e.elementType === "table");
    assert.ok(tbl);
    assert.ok(tbl.bounds[2] >= 800);
  });

  it("cover kicker defaults to Chinese draft label and title scales with length", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kicker-"));
    const project = createEmptyProject(dir, { title: "t" });
    materializeDeck(
      project,
      parseComposeDeck({
        title: "短封面",
        pages: [
          { role: "cover", title: "短封面" },
          { role: "content", title: "判断句", bullets: ["一条"] },
        ],
      }),
      loadPlaybook().palette,
    );
    const cover = project.pages.find((pg) => pg.path.includes("cover"));
    assert.ok(cover);
    const kicker = cover.page.elements.find((e) => e.elementId === "kicker");
    assert.ok(kicker);
    assert.equal((kicker as { content?: { text?: string } }).content?.text, "内部讨论 · 草稿");
    const title = cover.page.elements.find((e) => e.elementId === "title");
    assert.ok(title);
    assert.ok(((title as { content?: { fontSize?: number } }).content?.fontSize ?? 0) >= 32);
    assert.equal(titleFontSize("短封面", "cover"), 34);
    assert.ok(titleFontSize("这是一句更长的封面主标题用来压字号", "cover") < 34);
  });

  it("IR fallback stacks exhibit + support and does not stamp cards", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-"));
    const project = createEmptyProject(dir, { title: "t" });
    materializeDeck(
      project,
      parseComposeDeck({
        title: "三卡",
        pages: [
          { role: "cover", title: "三卡" },
          {
            role: "content",
            title: "三个并列判断",
            bullets: ["第一判断要写完整", "第二判断要写完整", "第三判断要写完整"],
            soWhat: "主展品只放判断，不堆证据。",
          },
        ],
      }),
      loadPlaybook().palette,
    );
    const page = project.pages.find((pg) => pg.path.includes("content"));
    assert.ok(page);
    assert.ok(page.page.elements.some((e) => e.elementId === "exhibit"));
    assert.ok(page.page.elements.some((e) => e.elementId === "b0"));
    assert.equal(
      page.page.elements.some((e) => /^cbg\d+$/.test(e.elementId)),
      false,
    );
    for (const el of page.page.elements) {
      if (!/^b\d+$/.test(el.elementId) && el.elementId !== "exhibit") continue;
      assert.ok(el.bounds[1] + el.bounds[3] <= 432, `${el.elementId} collides with so-what`);
    }
  });

  it("classroom briefs do not inherit the Hub consulting default design", () => {
    assert.equal(
      resolveGenerateDesign("介绍一下勾股定理，面向小学生", "consulting/pine-green-strategy"),
      DEFAULT_TEACH_DESIGN,
    );
    assert.equal(
      resolveGenerateDesign("介绍一下勾股定理，面向小学生", "consulting/moss-green"),
      "consulting/moss-green",
    );
    assert.equal(inferDeckIntent("给二年级讲一讲种子怎么发芽"), "teach");
    assert.equal(inferDeckIntent("种子怎么发芽"), "teach");
    assert.equal(inferDeckIntent("新员工培训课件：如何处理客户升级"), "teach");
    assert.equal(
      inferDeckIntent(
        "内部知识分享：如何把复盘写成可执行结论。避免经营月报样式，不要使用财务账本式密集表格。",
        "education-training",
      ),
      "teach",
    );
    assert.equal(inferDeckIntent("这不是科普。管理层决策是否批准试点，预算含培训与变更费用"), "decide");
    assert.equal(resolvePlaybookCategory("给二年级讲一讲种子怎么发芽", "analysis-decision"), "education-training");
    assert.equal(
      resolveGenerateDesign("给二年级讲一讲种子怎么发芽", "consulting/pine-green-strategy"),
      DEFAULT_TEACH_DESIGN,
    );
  });

  it("document-type markers beat audience words and remap Hub Freestyle", () => {
    const proposal = "开题报告：城市热岛对小学课间活动时长的影响。只有方法边界，没有实验数据。";
    const launch = "为一家社区咖啡馆做秋季新品发布会开场页，记忆点是桂花拿铁";
    const recap = "华北区域 Q3 增长复盘：试点成效与下周动作";
    const lesson = "面向幼儿园小朋友讲清楚为什么饭前要洗手";
    assert.equal(inferDeckIntent(proposal), "academic");
    assert.equal(inferDeckIntent(launch), "promo");
    assert.equal(inferDeckIntent(recap), "decide");
    assert.equal(inferDeckIntent(lesson), "teach");
    assert.equal(resolvePlaybookCategory(proposal, "analysis-decision"), "academic-research");
    assert.equal(resolvePlaybookCategory(launch, "analysis-decision"), "brand-creative");
    assert.equal(resolveGenerateDesign(proposal, HUB_DEFAULT_DESIGN), DEFAULT_ACADEMIC_DESIGN);
    assert.equal(resolveGenerateDesign(launch, HUB_DEFAULT_DESIGN), DEFAULT_PROMO_DESIGN);
    assert.equal(resolveGenerateDesign(recap, HUB_DEFAULT_DESIGN), HUB_DEFAULT_DESIGN);
    assert.equal(resolveGenerateDesign(lesson, HUB_DEFAULT_DESIGN), DEFAULT_TEACH_DESIGN);
    assert.equal(resolveGenerateDesign("本周进度周报：缺数据标占位", HUB_DEFAULT_DESIGN), DEFAULT_REPORT_DESIGN);
    const monthly = "根据附件写华北零售 7 月经营月报，只引用虚构演示数字";
    assert.equal(inferDeckIntent(monthly), "report");
    assert.equal(inferDeckIntent("澄光生活是新消费品牌，请生成 2026 年 7 月经营月报"), "report");
    assert.equal(resolvePlaybookCategory(monthly, "analysis-decision"), "management-report");
    assert.equal(resolveGenerateDesign(monthly, HUB_DEFAULT_DESIGN), DEFAULT_REPORT_DESIGN);
    const reportHint = intentComposeGuidance("report", monthly).join("\n");
    assert.match(reportHint, /do not collapse|6-page|attachment/i);
    assert.match(reportHint, /omitted headings/);
    assert.doesNotMatch(reportHint, /cover → path → concept → remember/);
    const tokyo = "东京三日旅游攻略，不要编造人均消费";
    assert.equal(inferDeckIntent(tokyo), "travel");
    assert.equal(resolvePlaybookCategory(tokyo, "analysis-decision"), "brand-creative");
    assert.equal(resolveGenerateDesign(tokyo, HUB_DEFAULT_DESIGN), DEFAULT_TRAVEL_DESIGN);
    const travelHint = intentComposeGuidance("travel", tokyo).join("\n");
    assert.match(travelHint, /not required|optional|handbook/i);
    const academicHint = intentComposeGuidance("academic", proposal).join("\n");
    assert.match(academicHint, /defense|开题|方法/);
    assert.doesNotMatch(academicHint, /rtTriangle|勾股/);
    const teachHint = intentComposeGuidance("teach", "介绍一下勾股定理，面向小学生").join("\n");
    assert.match(teachHint, /rtTriangle|勾股/);
    const washHint = intentComposeGuidance("teach", lesson).join("\n");
    assert.doesNotMatch(washHint, /rtTriangle/);
  });

  it("timeline labels alternate and do not overlap at 5–7 items", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-"));
    const project = createEmptyProject(dir, { title: "t" });
    const items = ["启动", "试点核对", "口径统一", "扩量观察", "复盘冻结", "动作闭环", "下周复盘"];
    materializeDeck(
      project,
      parseComposeDeck({
        title: "节奏",
        pages: [
          { role: "cover", title: "节奏" },
          { role: "timeline", title: "七段节奏", items },
        ],
      }),
      loadPlaybook().palette,
    );
    const page = project.pages.find((pg) => pg.path.includes("timeline"));
    assert.ok(page);
    const labels = page.page.elements.filter((e) => /^tb\d+$/.test(e.elementId));
    const track = page.page.elements.find((e) => e.elementId === "track");
    assert.ok(track);
    assert.equal(labels.length, 7);
    const box = (el: { bounds: [number, number, number, number] }) => el.bounds;
    const overlap = (a: [number, number, number, number], b: [number, number, number, number]) =>
      a[0] < b[0] + b[2] - 2 && a[0] + a[2] > b[0] + 2 && a[1] < b[1] + b[3] - 2 && a[1] + a[3] > b[1] + 2;
    for (let i = 0; i < labels.length; i++) {
      const a = box(labels[i]!);
      assert.ok(a[0] >= 0);
      assert.ok(a[0] + a[2] <= 960);
      const trackTop = track.bounds[1];
      const trackBottom = track.bounds[1] + track.bounds[3];
      assert.ok(
        a[1] + a[3] <= trackTop - 14 || a[1] >= trackBottom + 14,
        `tb${i} must keep 14px clear of the timeline track`,
      );
      for (let j = i + 1; j < labels.length; j++) {
        assert.equal(overlap(a, box(labels[j]!)), false, `tb${i} overlaps tb${j}`);
      }
    }
  });

  it("deterministic deck never fabricates a source citation", () => {
    const deck = deterministicDeck("仅有一句话主题", "consulting/pine-green-strategy");
    const blob = JSON.stringify(deck);
    assert.doesNotMatch(blob, /Gartner|McKinsey|Bloomberg/i);
    assert.match(blob, /待补|示意|占位/);
    assert.ok(deck.pages.length >= 4);
    assert.ok(deck.pages.length < 7);
    assert.equal(
      deck.pages.some((p) => p.role === "matrix"),
      false,
    );
  });

  it("classroom briefs use a lesson outline instead of the consulting skeleton", () => {
    const deck = deterministicDeck("介绍一下勾股定理，面向小学生", "consulting/pine-green-strategy");
    const roles = deck.pages.map((p) => p.role);
    assert.deepEqual(roles, ["cover", "toc", "content", "content", "evidence", "close"]);
    assert.equal(deck.pages.length, 6);
    const blob = JSON.stringify(deck);
    assert.doesNotMatch(blob, /下周动作|四个支撑面|本篇结构/);
    assert.match(blob, /今天带走什么/);
    const chart = deck.pages.find((p) => p.chart);
    assert.deepEqual(chart?.chart?.rows, [
      ["短直角边", 3],
      ["长直角边", 4],
      ["斜边", 5],
    ]);
    assert.match(String(chart?.note), /课堂练习/);
  });

  it("resolves Hub All + a kids explainer onto the education skill", () => {
    assert.equal(inferDeckIntent("介绍一下勾股定理，面向小学生"), "teach");
    assert.equal(resolvePlaybookCategory("介绍一下勾股定理，面向小学生", "analysis-decision"), "education-training");
    assert.equal(inferDeckIntent("华北区域 Q3 增长复盘：试点成效与下周动作"), "decide");
    const recap = deterministicDeck("华北区域 Q3 增长复盘：试点成效与下周动作", "consulting/pine-green-strategy");
    const thin = deterministicDeck("仅有一句话主题", "consulting/pine-green-strategy");
    assert.notEqual(recap.pages.length, thin.pages.length);
    assert.ok(recap.pages.some((p) => p.role === "evidence"));
    assert.ok(recap.pages.some((p) => p.role === "timeline"));
    assert.equal(
      thin.pages.some((p) => p.role === "evidence"),
      false,
    );
  });

  it("referenceText reaches the LLM user prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-ref-llm-"));
    let capturedUser = "";
    const referenceText = "## 参考: brand-voice.md\n松绿主色贯穿封面与证据页\n禁止编造客户案例";
    const brain = createPlaybookBrain({
      referenceText,
      llm: {
        async completeJson(_system, user) {
          capturedUser = String(user);
          return {
            title: "参考资料引用核验",
            pages: [
              { role: "cover", title: "参考资料引用核验" },
              { role: "toc", title: "结构", items: ["判断", "证据", "动作"] },
              {
                role: "content",
                title: "只引用附件原文",
                bullets: ["松绿主色贯穿封面与证据页", "禁止编造客户案例", "缺材料的位置保持占位"],
              },
              {
                role: "evidence",
                title: "占位序列",
                note: "来源：brand-voice.md，数值为占位",
                chart: {
                  title: "示意",
                  cols: ["项", "值"],
                  rows: [
                    ["A", 1],
                    ["B", 2],
                  ],
                },
              },
              {
                role: "close",
                title: "动作",
                bullets: ["核对来源", "缺材料的位置保持占位", "不编造客户评价"],
              },
            ],
          };
        },
      },
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "品牌语气核验",
      brain,
    });
    assert.equal(result.status, "ready");
    assert.match(capturedUser, /参考资料（只可引用，不可编造超出内容）/);
    assert.match(capturedUser, /brand-voice\.md/);
    assert.match(capturedUser, /松绿主色贯穿封面与证据页/);
  });

  it("offline deck cites reference source names and quotes lines", async () => {
    const referenceText = [
      "## 参考: brand-voice.md",
      "松绿主色贯穿封面与证据页",
      "标题必须是完整断言句",
      "",
      "## 参考: brand-palette.md",
      "背景留白只用松绿与石墨灰",
    ].join("\n");
    const parsed = extractReferenceLines(referenceText);
    assert.deepEqual(parsed.names, ["brand-voice.md", "brand-palette.md"]);
    assert.ok(parsed.lines[0]?.includes("松绿主色贯穿封面"));

    const deck = deterministicDeck("季度复盘主题说明文字", "consulting/pine-green-strategy", referenceText);
    const content = deck.pages.find((p) => p.role === "content");
    assert.ok(content?.bullets?.some((b) => b.includes("松绿主色贯穿封面")));
    const ev = deck.pages.find((p) => p.role === "evidence");
    assert.equal(ev?.note, "来源：brand-voice.md、brand-palette.md，数值为占位");
    assert.doesNotMatch(JSON.stringify(deck.pages), /Gartner|McKinsey|Bloomberg/i);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-ref-off-"));
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "季度复盘主题说明文字",
      referenceText,
    });
    assert.equal(result.status, "ready");
    const blob = JSON.stringify(loadProject(dir));
    assert.match(blob, /brand-voice\.md|松绿主色贯穿封面/);
    assert.match(blob, /来源：/);
    assert.match(blob, /数值为占位/);
  });
});
