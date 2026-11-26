import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { createAgentBrain, loadPlaybook, runGenerateAsync } from "./index.js";
import { executeGenerateTool } from "./agent-tools.js";
import { applySkillDeck, parseSkillDeck, parseSkillPage, skillToCompose } from "./skill-pages.js";
import { call, scriptedPort, skillLesson } from "./skill-pages.fixtures.js";

describe("skill PPTD pages", () => {
  it("parses official recipe atoms Grok wrote for 种子怎么发芽", () => {
    const cover = parseSkillPage({
      id: "cover",
      elements: [
        { type: "cover-botanical" },
        {
          type: "title-band",
          title: "种子怎么发芽",
          subtitle: "从休眠到幼苗 · 结构 · 条件 · 过程",
        },
      ],
    });
    assert.ok(cover);
    assert.equal(cover?.pageType, "cover");
    assert.ok(cover?.elements.some((el) => el.elementId === "circle"));
    assert.ok(cover?.elements.some((el) => el.elementId === "title-band"));
    assert.ok(cover?.elements.some((el) => el.elementId === "chip"));
    const route = parseSkillPage({
      id: "route",
      elements: [
        { type: "coral-rule" },
        { type: "chapter", text: "01 路径" },
        { type: "page-title", text: "四站学习路径：先看结构，再抓条件，再跟过程" },
        {
          type: "route-path",
          stations: [
            { name: "结构", note: "种皮·胚·胚乳" },
            { name: "条件", note: "水·空气·温度" },
            { name: "过程", note: "吸胀到出土" },
            { name: "迁移", note: "实验与误区" },
          ],
        },
        { type: "footer-chrome", left: "« »", right: "路径｜02" },
      ],
    });
    assert.ok(route);
    assert.ok(route?.elements.some((el) => el.elementId === "path-spine"));
    assert.ok(route?.elements.some((el) => el.elementId === "step-0"));
    const method = parseSkillPage({
      id: "method",
      elements: [
        { type: "coral-rule" },
        { type: "chapter", text: "03 条件" },
        { type: "page-title", text: "萌发三要素：适量水分、充足空气、适宜温度缺一不可" },
        {
          type: "method-panels",
          panels: [
            { title: "水分", body: "吸胀软化种皮" },
            { title: "空气（氧）", body: "呼吸供能" },
            { title: "适宜温度", body: "酶活性窗口" },
          ],
        },
        { type: "footer-chrome", left: "« »", right: "条件｜04" },
      ],
    });
    assert.ok(method);
    assert.ok(method?.elements.some((el) => el.elementId === "panel-0"));
    assert.ok(method?.elements.some((el) => el.elementId === "well-0"));
    const demo = parseSkillPage({
      id: "demo",
      elements: [
        { type: "demo-band", title: "阶段证据：从吸胀到出土的可观察链条" },
        {
          type: "two-column-body",
          left: { heading: "时间顺序", bullets: ["吸胀", "胚根先出"] },
          right: { heading: "课堂可检核", bullets: ["称重法"] },
        },
        { type: "result-bar", text: "结论：先根后芽" },
        { type: "footer-chrome", left: "« »", right: "过程｜05" },
      ],
    });
    assert.ok(demo);
    assert.ok(demo?.elements.some((el) => el.elementId === "pink-band"));
    assert.ok(demo?.elements.some((el) => el.elementId === "result-bar"));
    const transfer = parseSkillPage({
      id: "transfer",
      elements: [
        { type: "result-bar", text: "带走三句话：胚是关键" },
        { type: "next-action", title: "下一步行动", items: ["用绿豆做对照"] },
        { type: "footer-chrome", left: "« »", right: "迁移｜06" },
      ],
    });
    assert.ok(transfer);
    assert.ok(transfer?.elements.some((el) => el.elementId === "result-bar"));
    assert.ok(transfer?.elements.some((el) => el.elementId === "panel-rule"));
  });

  it("parses official playbook box + position vocab and keeps copy", () => {
    const page = parseSkillPage({
      id: "page-1",
      pageType: "cover",
      notes: "Cover page for Grade 2 seed germination courseware.",
      elements: [
        { type: "slide", background: { fill: "#FDFAF5" } },
        {
          type: "text",
          text: "种子怎么发芽？",
          fontSize: 52,
          fontWeight: 700,
          color: "#44712E",
          align: "center",
          position: { x: 50, y: 80, w: 900, h: 100 },
        },
        {
          type: "box",
          position: { x: 70, y: 260, w: 860, h: 180 },
          background: { fill: "#D7EBCE" },
        },
        {
          type: "text",
          text: "今天，我们一起开启奇妙的种子发芽之旅！",
          fontSize: 20,
          fontWeight: 600,
          color: "#F5987E",
          position: { x: 100, y: 370, w: 800, h: 50 },
        },
      ],
    });
    assert.ok(page);
    assert.equal(page?.background?.type, "solid");
    assert.equal(page?.background && "color" in page.background ? page.background.color : "", "#FDFAF5");
    const box = page?.elements.find((el) => el.elementType === "shape") as
      { bounds: number[]; fill?: { color?: string }; shapeName?: string } | undefined;
    assert.deepEqual(box?.bounds, [70, 260, 860, 180]);
    assert.equal(box?.fill?.color, "#D7EBCE");
    assert.equal(box?.shapeName, "roundRect");
    const title = page?.elements.find((el) => el.elementType === "text") as
      { content?: { text?: string; bold?: boolean } } | undefined;
    assert.equal(title?.content?.text, "种子怎么发芽？");
    assert.equal(title?.content?.bold, true);
  });

  it("parses OpenKimi canvas shorthand into PPTD elements", () => {
    const parsed = parseSkillDeck({
      pages: [
        {
          elements: [
            { type: "rect", x: 0, y: 0, w: 960, h: 540, fill: "#F8F9FA" },
            {
              type: "text",
              x: 120,
              y: 140,
              w: 720,
              h: 80,
              text: "神奇的直角三角形魔术",
              fontSize: 44,
              fontWeight: "bold",
              fill: "#1E293B",
              align: "center",
            },
          ],
        },
        {
          elements: [
            {
              type: "text",
              x: 60,
              y: 45,
              w: 840,
              h: 40,
              text: "什么是直角三角形？",
              fontSize: 32,
              fontWeight: "bold",
              fill: "#1E293B",
            },
          ],
        },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.title, "神奇的直角三角形魔术");
    assert.equal(parsed.pages.length, 2);
    assert.equal(parsed.pages[0]?.background, undefined);
    const bleed = parsed.pages[0]?.elements.find((el) => el.elementType === "shape") as
      { bounds?: number[]; fill?: { color?: string } } | undefined;
    assert.deepEqual(bleed?.bounds, [0, 0, 960, 540]);
    assert.equal(bleed?.fill?.color, "#F8F9FA");
    const title = parsed.pages[0]?.elements.find((el) => el.elementType === "text") as
      { content?: { text?: string; bold?: boolean; fontSize?: number } } | undefined;
    assert.equal(title?.content?.text, "神奇的直角三角形魔术");
    assert.equal(title?.content?.bold, true);
    assert.equal(title?.content?.fontSize, 44);
  });

  it("splits a flat canvas elements[] on slide-N ids", () => {
    const parsed = parseSkillDeck({
      width: 960,
      height: 540,
      elements: [
        {
          id: "slide-1-bg",
          type: "rect",
          x: 0,
          y: 0,
          width: 960,
          height: 540,
          fill: "#F8F9FA",
        },
        {
          id: "slide-1-title",
          type: "text",
          x: 80,
          y: 160,
          width: 800,
          height: 80,
          text: "植物是怎么吃饭的",
          fontSize: 34,
          fontWeight: "bold",
          fill: "#1E293B",
        },
        {
          id: "slide-2-header",
          type: "text",
          x: 60,
          y: 40,
          width: 800,
          height: 40,
          text: "第一关",
          fontSize: 28,
          fontWeight: "bold",
          fill: "#1E293B",
        },
        {
          id: "slide-6-footer",
          type: "text",
          x: 80,
          y: 400,
          width: 800,
          height: 30,
          text: "下课啦",
          fontSize: 14,
          fill: "#64748B",
        },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.pages.length, 3);
    assert.equal(parsed.title, "植物是怎么吃饭的");
    assert.equal(
      parsed.pages[0]?.elements.some((el) => el.elementId === "slide-1-title"),
      true,
    );
    assert.equal(parsed.pages[2]?.id, "page-06");
  });

  it("applySkillDeck writes the model elements, not a card stamp", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-pages-"));
    const project = createEmptyProject(dir, { title: "t" });
    const parsed = parseSkillDeck(skillLesson);
    assert.ok(parsed);
    assert.equal(parsed.pages.length, 6);
    applySkillDeck(project, parsed, loadPlaybook().palette);
    const concept = project.pages.find((pg) => pg.page.elements.some((e) => e.elementId === "triangle"));
    assert.ok(concept);
    assert.ok(concept.page.elements.some((e) => e.elementType === "shape"));
    assert.equal(
      concept.page.elements.some((e) => /^cbg\d+$/.test(e.elementId)),
      false,
    );
    const evidence = project.pages.find((pg) => pg.page.elements.some((e) => e.elementType === "chart"));
    assert.ok(evidence);
    assert.ok(fs.existsSync(path.join(dir, "_agent", "skill-deck.json")));
    const plan = skillToCompose(parsed);
    assert.equal(plan.title, "勾股小课堂");
    assert.equal(plan.pages[2]?.title, "直角对着的边叫斜边");
  });

  it("compose_deck with elements is marked PPTD, not IR fallback", () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const exec = executeGenerateTool("compose_deck", skillLesson, {
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      todos: [],
      researchNotes: [],
    });
    assert.equal(exec.ok, true);
    assert.match(exec.summary, /PPTD/);
    assert.doesNotMatch(exec.summary, /IR fallback/);
  });

  it("agent brain persists skill elements onto disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-run-"));
    const brain = createAgentBrain({
      categoryId: "education-training",
      llm: scriptedPort([
        call("think", { summary: "小学生", detail: "课堂路径，写 PPTD。" }, "t1"),
        call("read_playbook", { section: "pptd" }, "r1"),
        call(
          "write_todo",
          {
            items: [
              { title: "封面", note: "课题" },
              { title: "路径", note: "今天要搞懂什么" },
              { title: "概念", note: "斜边" },
              { title: "公式", note: "a2+b2=c2" },
              { title: "例子", note: "3-4-5" },
              { title: "带走", note: "复述" },
            ],
          },
          "w1",
        ),
        call("compose_deck", skillLesson, "c1"),
      ]),
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "介绍一下勾股定理，面向小学生",
      brain,
    });
    assert.equal(result.status, "ready");
    assert.equal(result.composeSource, "agent");
    const project = loadProject(dir);
    assert.equal(project.presentation.title, "勾股小课堂");
    assert.ok(project.pages.some((pg) => pg.page.elements.some((e) => e.elementId === "triangle")));
    assert.ok(project.pages.some((pg) => pg.page.elements.some((e) => e.elementType === "chart")));
    assert.equal(
      project.pages.some((pg) => pg.page.elements.some((e) => /^cbg\d+$/.test(e.elementId))),
      false,
    );
  });
});
