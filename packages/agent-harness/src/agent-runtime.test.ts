import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import {
  createAgentBrain,
  createHttpResearchPort,
  GENERATE_TOOLS,
  parseResearchHit,
  readGenerateCheckpoint,
  runAgentLoop,
  runGenerateAsync,
  runResearch,
  loadPlaybook,
  resolvePlaybookCategory,
} from "./index.js";
import { executeGenerateTool, persistWrittenPages } from "./agent-tools.js";
import type { SkillPageInput } from "./skill-pages.js";
import type { LlmChatMessage, LlmPort, LlmToolSpec, LlmTurnResult } from "./llm-port.js";

function call(name: string, args: unknown, id = name): LlmTurnResult {
  return {
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function scriptedPort(turns: LlmTurnResult[]): LlmPort {
  let i = 0;
  return {
    async completeJson() {
      throw new Error("completeJson should not run when completeTurn exists");
    },
    async completeTurn(_messages: LlmChatMessage[]) {
      if (i >= turns.length) {
        return { content: "done", toolCalls: [] };
      }
      return turns[i++]!;
    },
  };
}

function scriptedPortThenFail(turns: LlmTurnResult[], err: Error): LlmPort {
  let i = 0;
  return {
    async completeJson() {
      throw new Error("completeJson must not run after a retryable failure");
    },
    async completeTurn() {
      if (i < turns.length) return turns[i++]!;
      throw err;
    },
  };
}

const lessonDeck = {
  title: "勾股小课堂",
  pages: [
    { role: "cover", title: "勾股小课堂" },
    { role: "toc", title: "今天要搞懂什么", items: ["概念", "记住", "例子"] },
    {
      role: "content",
      title: "直角边和斜边",
      bullets: ["先找到直角。", "直角对面是斜边。", "另外两边叫直角边。"],
    },
    {
      role: "content",
      title: "记住 a²+b²=c²",
      bullets: ["公式写成 a²+b²=c²。", "c 一定是斜边。", "先指边，再写字。"],
    },
    {
      role: "evidence",
      title: "课堂例子 3-4-5",
      note: "课堂练习数字，不是统计",
      chart: {
        title: "三边",
        cols: ["边", "长度"],
        rows: [
          ["短直角边", 3],
          ["长直角边", 4],
          ["斜边", 5],
        ],
      },
    },
    {
      role: "close",
      title: "今天带走什么",
      bullets: ["能指认直角边和斜边。", "能写出 a²+b²=c²。", "用 3、4、5 检查一次。"],
    },
  ],
};

describe("agent runtime", () => {
  it("research reports a gap when there are no attachments on a recap", () => {
    const gap = runResearch("Q3 增长口径", "华北区域 Q3 增长复盘");
    assert.equal(gap.source, "none");
    assert.match(gap.gap ?? "", /占位|来源/);
    assert.doesNotMatch(JSON.stringify(gap), /Gartner|McKinsey/i);
  });

  it("research labels classroom facts as common knowledge, not a citation", () => {
    const hit = runResearch("勾股定理", "介绍一下勾股定理，面向小学生");
    assert.equal(hit.source, "classroom_common");
    assert.equal(hit.citations.length, 0);
    assert.match(hit.note, /不是出处/);
  });

  it("research does not stamp 勾股 facts onto every classroom or 开题 brief", () => {
    const wash = runResearch("洗手步骤", "面向幼儿园小朋友讲清楚为什么饭前要洗手");
    assert.equal(wash.source, "none");
    assert.match(wash.gap ?? "", /占位|来源/);
    const proposal = runResearch(
      "classroom_common",
      "开题报告：城市热岛对小学课间活动时长的影响。只有方法边界，没有实验数据。",
    );
    assert.equal(proposal.source, "none");
    assert.doesNotMatch(JSON.stringify(proposal), /斜边|勾股/);
  });

  it("tool loop reads the playbook, writes a todo, researches, then composes", async () => {
    const playbook = loadPlaybook({
      categoryId: resolvePlaybookCategory("介绍一下勾股定理，面向小学生"),
    });
    const traces: string[] = [];
    const result = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      llm: scriptedPort([
        call("think", { summary: "小学生", detail: "先定听众，不编造课外统计。" }, "t1"),
        call("read_playbook", { section: "category" }, "r1"),
        call(
          "write_todo",
          {
            items: [
              { title: "封面" },
              { title: "今天要搞懂什么" },
              { title: "概念" },
              { title: "记住" },
              { title: "3-4-5 例子" },
              { title: "带走什么" },
            ],
          },
          "w1",
        ),
        call("research", { query: "勾股定理" }, "s1"),
        call("compose_deck", lessonDeck, "c1"),
      ]),
      onTrace: (t) => {
        traces.push(t.label);
      },
    });
    assert.equal(result.source, "agent");
    assert.equal(result.deck.title, "勾股小课堂");
    assert.deepEqual(traces, ["Think", "Read", "Write Todo", "Research", "Compose Deck"]);
    assert.doesNotMatch(JSON.stringify(result.deck), /下周动作|Gartner/);
  });

  it("falls back to the playbook when the model never composes", async () => {
    const playbook = loadPlaybook({ categoryId: "analysis-decision" });
    const result = await runAgentLoop({
      brief: "仅有一句话主题",
      playbook,
      maxTurns: 3,
      llm: scriptedPort([
        call("think", { summary: "主题", detail: "没有材料，不编造。" }, "t1"),
        { content: "I refuse to use tools now.", toolCalls: [] },
        { content: "still no", toolCalls: [] },
      ]),
    });
    assert.equal(result.source, "playbook");
    assert.match(result.fallbackReason ?? "", /compose_deck|tools|text/);
    assert.ok(result.deck.pages.length >= 4);
  });

  it("blocks a tool that is not on the allowlist", async () => {
    const playbook = loadPlaybook();
    const result = await runAgentLoop({
      brief: "仅有一句话主题",
      playbook,
      maxTurns: 2,
      llm: scriptedPort([
        call("bash", { command: "curl https://example.com" }, "bad"),
        call("compose_deck", lessonDeck, "c1"),
      ]),
    });
    assert.equal(result.traces[0]?.ok, false);
    assert.match(result.traces[0]?.detail ?? "", /not allowed|blocked/i);
    assert.equal(result.source, "agent");
  });

  it("runGenerateAsync with an agent brain emits Read / Write Todo / Research rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-"));
    const brain = createAgentBrain({
      categoryId: "education-training",
      llm: scriptedPort([
        call("think", { summary: "小学生", detail: "课堂路径，不套复盘。" }, "t1"),
        call("read_playbook", { section: "catalog" }, "r1"),
        call(
          "write_todo",
          {
            items: [{ title: "封面" }, { title: "概念" }, { title: "例子" }, { title: "收束" }],
          },
          "w1",
        ),
        call("research", { query: "勾股" }, "s1"),
        call("compose_deck", lessonDeck, "c1"),
      ]),
    });
    const labels: string[] = [];
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "介绍一下勾股定理，面向小学生",
      brain,
      onStep: (step) => {
        if (step.status === "completed") labels.push(step.label);
      },
    });
    assert.equal(result.status, "ready");
    assert.equal(result.composeSource, "agent");
    assert.ok(labels.includes("Think"));
    assert.ok(labels.includes("Read"));
    assert.ok(labels.includes("Write Todo"));
    assert.ok(labels.includes("Research"));
    assert.ok(labels.includes("Compose Deck"));
    const project = loadProject(dir);
    assert.equal(project.presentation.title, "勾股小课堂");
    const reason = JSON.parse(fs.readFileSync(path.join(dir, "generate-reason.json"), "utf8"));
    assert.ok(reason.tools.some((t: { label: string }) => t.label === "Read"));
    assert.ok(reason.plan?.detail);
  });

  it("research quotes attachments instead of inventing a source", () => {
    const hit = runResearch("华北增长", "华北区域 Q3 增长复盘", "来源：q3.md\n华北增长 12%，口径与去年一致。");
    assert.equal(hit.source, "attachment");
    assert.match(hit.facts.join("\n"), /12%/);
    assert.doesNotMatch(JSON.stringify(hit), /Gartner|McKinsey/i);
  });

  it("rejects a title-only compose_deck so the loop can retry", () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const exec = executeGenerateTool(
      "compose_deck",
      {
        title: "勾股小课堂",
        pages: [
          { role: "cover", title: "勾股小课堂" },
          { role: "toc", title: "今天要搞懂什么" },
          { role: "content", title: "直角边和斜边" },
          { role: "content", title: "公式" },
          { role: "close", title: "带走什么" },
        ],
      },
      {
        brief: "介绍一下勾股定理，面向小学生",
        playbook,
        todos: [],
        researchNotes: [],
      },
    );
    assert.equal(exec.ok, false);
    assert.match(exec.detail, /too thin|bullets/i);
  });

  it("compose_deck fills title-only pages from write_todo notes", () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const exec = executeGenerateTool(
      "compose_deck",
      {
        title: "勾股小课堂",
        pages: [
          { role: "cover", title: "勾股小课堂" },
          { role: "toc", title: "今天要搞懂什么" },
          { role: "content", title: "直角边和斜边" },
          { role: "content", title: "记住公式" },
          { role: "content", title: "3-4-5 例子" },
          { role: "close", title: "带走什么" },
        ],
      },
      {
        brief: "介绍一下勾股定理，面向小学生",
        playbook,
        todos: [
          { title: "封面" },
          { title: "今天要搞懂什么", note: "先认三条边。再记公式。最后用 3-4-5 检查。" },
          { title: "直角边和斜边", note: "直角对面是斜边。另外两边叫直角边。先指边再写字。" },
          { title: "记住公式", note: "写成 a²+b²=c²。c 一定是斜边。3-4-5 是课堂练习。" },
          { title: "3-4-5 例子", note: "3²+4²=9+16=25。25 正好是 5²。这是课堂练习不是统计。" },
          { title: "带走什么", note: "能指认三边。能写出公式。回去画一个直角三角形。" },
        ],
        researchNotes: [],
      },
    );
    assert.equal(exec.ok, true);
    assert.ok((exec.payload as { pages: { bullets?: string[] }[] }).pages[2]?.bullets?.length ?? 0 >= 3);
  });

  it("rejects invalid compose IR then accepts a later valid deck", async () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const result = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      llm: scriptedPort([
        call("compose_deck", { title: "坏", pages: [] }, "bad"),
        call("compose_deck", lessonDeck, "ok"),
      ]),
    });
    assert.equal(result.traces[0]?.ok, false);
    assert.match(result.traces[0]?.detail ?? "", /pages|IR/i);
    assert.equal(result.source, "agent");
    assert.equal(result.deck.title, "勾股小课堂");
  });

  it("uses completeJson when the port has no tool loop", async () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const result = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      llm: {
        async completeJson() {
          return lessonDeck;
        },
      },
    });
    assert.equal(result.source, "agent");
    assert.equal(result.deck.title, "勾股小课堂");
  });

  it("falls back to completeJson when tool calling is rejected", async () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const result = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      llm: {
        async completeJson() {
          return lessonDeck;
        },
        async completeTurn() {
          throw new Error("LLM HTTP 400: tools not supported");
        },
      },
    });
    assert.equal(result.source, "agent");
    assert.equal(result.deck.title, "勾股小课堂");
    assert.match(result.fallbackReason ?? "", /400|tools/);
  });

  it("rejects a title-only JSON dump so it does not become the deck", async () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const thin = {
      title: "空课堂",
      pages: [
        { role: "cover", title: "空课堂" },
        { role: "toc", title: "目录" },
        { role: "content", title: "概念" },
        { role: "content", title: "公式" },
        { role: "close", title: "带走" },
      ],
    };
    const result = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      maxTurns: 1,
      llm: scriptedPort([{ content: JSON.stringify(thin), toolCalls: [] }]),
    });
    assert.equal(result.source, "playbook");
    assert.ok((result.deck.pages[2]?.bullets ?? []).length >= 3);
    assert.notEqual(result.deck.title, "空课堂");
  });

  it("accepts a last-resort JSON deck in assistant text", async () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const result = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      maxTurns: 2,
      llm: scriptedPort([{ content: JSON.stringify(lessonDeck), toolCalls: [] }]),
    });
    assert.equal(result.source, "agent");
    assert.equal(result.deck.pages.length, 6);
  });

  it("passes the allowlisted tools into completeTurn", async () => {
    const playbook = loadPlaybook();
    let seen: LlmToolSpec[] | undefined;
    await runAgentLoop({
      brief: "仅有一句话主题",
      playbook,
      maxTurns: 2,
      llm: {
        async completeJson() {
          throw new Error("unused");
        },
        async completeTurn(_messages, tools) {
          seen = tools;
          return call("compose_deck", lessonDeck, "c1");
        },
      },
    });
    assert.deepEqual(
      (seen ?? []).map((t) => t.function.name),
      GENERATE_TOOLS.map((t) => t.function.name),
    );
    assert.ok(GENERATE_TOOLS.some((t) => t.function.name === "render_page"));
    assert.ok(GENERATE_TOOLS.some((t) => t.function.name === "search_image"));
  });

  it("puts the capability card in the system prompt before design", async () => {
    const playbook = loadPlaybook();
    let system = "";
    await runAgentLoop({
      brief: "东京三日，不必配图",
      playbook,
      maxTurns: 1,
      llm: {
        async completeJson() {
          throw new Error("unused");
        },
        async completeTurn(messages) {
          const first = messages[0];
          system = first && first.role === "system" ? first.content : "";
          return call("compose_deck", lessonDeck, "c1");
        },
      },
    });
    assert.match(system, /CAPABILITY CARD/);
    assert.match(system, /imageSearch:/);
    assert.match(system, /pageRaster:/);
    assert.match(system, /no-image mode|imageGenerate:/);
  });

  it("does not tell a 月报 to pad to a 6-page lesson", async () => {
    const playbook = loadPlaybook({ categoryId: "management-report" });
    let system = "";
    await runAgentLoop({
      brief: "根据附件写华北零售 7 月经营月报",
      playbook,
      maxTurns: 1,
      llm: {
        async completeJson() {
          throw new Error("unused");
        },
        async completeTurn(messages) {
          const first = messages[0];
          system = first && first.role === "system" ? first.content : "";
          return call("compose_deck", lessonDeck, "c1");
        },
      },
    });
    assert.match(system, /Inferred intent: report/);
    assert.match(system, /do not pad|follows the brief/i);
    assert.match(system, /silent clipping is a lie/);
    assert.doesNotMatch(system, /write_todo with 5–8 pages/);
    const todo = GENERATE_TOOLS.find((t) => t.function.name === "write_todo");
    assert.match(todo?.function.description ?? "", /Do not default to 6/);
    assert.doesNotMatch(todo?.function.description ?? "", /5–8 pages for a lesson/);
  });

  it("adds page-specific brief exhibits even when write_todo omits them", () => {
    const state: Parameters<typeof executeGenerateTool>[2] = {
      brief: [
        "澄光生活 2026年7月经营月报，营收 12,860 万。",
        "【第1页 封面】无图表。",
        "【第2页 收入】右侧贡献瀑布，底部数据表。",
      ].join("\n"),
      playbook: loadPlaybook({ categoryId: "management-report" }),
      todos: [],
      researchNotes: [],
    };
    const result = executeGenerateTool(
      "write_todo",
      {
        items: [
          { title: "封面", note: "标题", exhibits: ["none"] },
          { title: "收入", note: "结论", exhibits: ["none"] },
        ],
      },
      state,
    );
    assert.equal(result.ok, true, result.detail);
    assert.deepEqual(state.todos[0]?.exhibits, ["none"]);
    assert.deepEqual(state.todos[1]?.exhibits, ["chart:waterfall", "table"]);
  });

  it("blocks compose when a structured page drops a locked number", () => {
    const brief = [
      "澄光生活 2026年7月经营月报。",
      "【第1页 封面】营收 1.286 亿。",
      "【第2页 KPI】净利率 7.9%，预算达成 105.4%。",
      "【第3页 库存】周转 19.0 天。",
      "【第4页 附录】投放 428 万。",
    ].join("\n");
    const page = (id: string, text: string) => ({
      id,
      elements: [
        {
          elementId: `${id}-text`,
          elementType: "text" as const,
          bounds: [40, 80, 880, 360] as [number, number, number, number],
          content: { text },
        },
      ],
    });
    const writtenPages = [
      page("page-01", "营收 1.286 亿"),
      page("page-02", "净利率七点九，预算达成 105%"),
      page("page-03", "周转 19 天"),
      page("page-04", "投放 428 万"),
    ];
    const state: Parameters<typeof executeGenerateTool>[2] = {
      brief,
      playbook: loadPlaybook({ categoryId: "management-report" }),
      todos: writtenPages.map((_, index) => ({
        title: `第${index + 1}页`,
        exhibits: ["none"],
      })),
      researchNotes: [],
      writtenPages,
    };

    const result = executeGenerateTool("compose_deck", { title: "澄光生活", pages: writtenPages }, state);

    assert.equal(result.ok, false);
    assert.match(result.detail, /7\.9%/);
    assert.match(result.detail, /105\.4%/);
  });

  it("auto-renders native #slide after write_page when raster is available", async () => {
    const playbook = loadPlaybook();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-render-"));
    const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(80, 4)]);
    const { createPageRasterPort } = await import("./page-raster.js");
    const raster = createPageRasterPort({
      editorBaseUrl: "http://127.0.0.1:55200",
      screenshot: async () => ({ bytes, width: 960, height: 540 }),
    });
    const el = (id: string, text: string) => ({
      id,
      pageType: id === "page-01" ? "cover" : id === "page-04" ? "close" : "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 80, 880, 80],
          content: { text, bold: true, fontSize: 22 },
        },
        {
          elementId: "body",
          elementType: "text",
          bounds: [40, 180, 880, 280],
          content: { text: "形状和文字即可，不必配图。", fontSize: 16 },
        },
      ],
    });
    const pages = [el("page-01", "自动看页"), el("page-02", "第二页"), el("page-03", "第三页"), el("page-04", "收束")];
    const result = await runAgentLoop({
      brief: "自动看页测试",
      playbook,
      projectRoot: dir,
      raster,
      capability: {
        research: { mode: "attachments-gap", configured: false },
        imageSearch: { configured: false, via: "none" },
        imageGenerate: { configured: false, via: "none" },
        vision: { mode: "none", note: "test" },
        pageRaster: { mode: "native-slide", note: "injected" },
        runtime: { kind: "agent-loop", piAvailable: false, piNote: "test" },
        mediaPolicy: "optional",
      },
      llm: scriptedPort([call("write_page", pages[0], "w1"), call("compose_deck", { title: "自动看页", pages }, "c1")]),
    });
    assert.equal(result.source, "agent");
    assert.ok(result.traces.some((t) => t.tool === "write_page" && t.ok));
    assert.ok(
      result.traces.some((t) => t.tool === "render_page" && t.ok),
      result.traces.map((t) => `${t.tool}:${t.summary}`).join(", "),
    );
    assert.ok(fs.existsSync(path.join(dir, "_agent", "rasters", "page-01.png")));
  });

  it("auto-renders the rewritten page, not the last page", async () => {
    const playbook = loadPlaybook();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-render-id-"));
    const seen: number[] = [];
    const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(80, 6)]);
    const { createPageRasterPort } = await import("./page-raster.js");
    const raster = createPageRasterPort({
      editorBaseUrl: "http://127.0.0.1:55200",
      screenshot: async ({ pageIndex }) => {
        seen.push(pageIndex);
        return { bytes, width: 960, height: 540 };
      },
    });
    const el = (id: string, text: string) => ({
      id,
      pageType: id === "page-01" ? "cover" : id === "page-04" ? "close" : "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 80, 880, 80],
          content: { text, bold: true, fontSize: 22 },
        },
        {
          elementId: "body",
          elementType: "text",
          bounds: [40, 180, 880, 280],
          content: { text: "形状和文字即可。", fontSize: 16 },
        },
      ],
    });
    const pages = [el("page-01", "封面"), el("page-02", "第二页"), el("page-03", "第三页"), el("page-04", "收束")];
    const result = await runAgentLoop({
      brief: "自动看页测试",
      playbook,
      projectRoot: dir,
      raster,
      capability: {
        research: { mode: "attachments-gap", configured: false },
        imageSearch: { configured: false, via: "none" },
        imageGenerate: { configured: false, via: "none" },
        vision: { mode: "none", note: "test" },
        pageRaster: { mode: "native-slide", note: "injected" },
        runtime: { kind: "agent-loop", piAvailable: false, piNote: "test" },
        mediaPolicy: "optional",
      },
      llm: scriptedPort([
        call("write_page", pages[0], "w1"),
        call("write_page", pages[1], "w2"),
        call("write_page", { ...pages[0]!, elements: pages[0]!.elements }, "w1b"),
        call("compose_deck", { title: "自动看页", pages }, "c1"),
      ]),
    });
    assert.equal(result.source, "agent");
    const renders = result.traces.filter((t) => t.tool === "render_page");
    assert.equal(renders.length, 3, renders.map((t) => t.summary).join(", "));
    assert.match(renders[0]!.summary, /page-01/);
    assert.match(renders[1]!.summary, /page-02/);
    assert.match(renders[2]!.summary, /page-01/);
    assert.deepEqual(seen, [0, 1, 0]);
  });

  it("does not auto-render when raster is unavailable", async () => {
    const playbook = loadPlaybook();
    const { createPageRasterPort } = await import("./page-raster.js");
    const result = await runAgentLoop({
      brief: "自动看页测试",
      playbook,
      raster: createPageRasterPort(),
      llm: scriptedPort([
        call(
          "write_page",
          {
            id: "page-01",
            pageType: "cover",
            elements: [
              {
                elementId: "title",
                elementType: "text",
                bounds: [40, 80, 880, 80],
                content: { text: "无真页", bold: true, fontSize: 22 },
              },
              {
                elementId: "body",
                elementType: "text",
                bounds: [40, 180, 880, 280],
                content: { text: "没有 editor URL，不能假装看见。", fontSize: 16 },
              },
            ],
          },
          "w1",
        ),
        call(
          "compose_deck",
          {
            title: "无真页",
            pages: [
              {
                id: "page-01",
                pageType: "cover",
                elements: [
                  {
                    elementId: "title",
                    elementType: "text",
                    bounds: [40, 80, 880, 80],
                    content: { text: "无真页", bold: true, fontSize: 22 },
                  },
                  {
                    elementId: "body",
                    elementType: "text",
                    bounds: [40, 180, 880, 280],
                    content: { text: "没有 editor URL，不能假装看见。", fontSize: 16 },
                  },
                ],
              },
              {
                id: "page-02",
                pageType: "content",
                elements: [
                  {
                    elementId: "title",
                    elementType: "text",
                    bounds: [40, 80, 880, 80],
                    content: { text: "二", bold: true, fontSize: 22 },
                  },
                  {
                    elementId: "body",
                    elementType: "text",
                    bounds: [40, 180, 880, 280],
                    content: { text: "形状和文字即可。", fontSize: 16 },
                  },
                ],
              },
              {
                id: "page-03",
                pageType: "content",
                elements: [
                  {
                    elementId: "title",
                    elementType: "text",
                    bounds: [40, 80, 880, 80],
                    content: { text: "三", bold: true, fontSize: 22 },
                  },
                  {
                    elementId: "body",
                    elementType: "text",
                    bounds: [40, 180, 880, 280],
                    content: { text: "形状和文字即可。", fontSize: 16 },
                  },
                ],
              },
              {
                id: "page-04",
                pageType: "close",
                elements: [
                  {
                    elementId: "title",
                    elementType: "text",
                    bounds: [40, 80, 880, 80],
                    content: { text: "收束", bold: true, fontSize: 22 },
                  },
                  {
                    elementId: "body",
                    elementType: "text",
                    bounds: [40, 180, 880, 280],
                    content: { text: "没有看见幻灯片。", fontSize: 16 },
                  },
                ],
              },
            ],
          },
          "c1",
        ),
      ]),
    });
    assert.equal(result.source, "agent");
    assert.ok(result.traces.some((t) => t.tool === "write_page" && t.ok));
    assert.equal(
      result.traces.some((t) => t.tool === "render_page"),
      false,
    );
  });

  it("intranet research port is used when configured", async () => {
    const playbook = loadPlaybook({ categoryId: "analysis-decision" });
    const result = await runAgentLoop({
      brief: "华北区域 Q3 增长复盘",
      playbook,
      research: {
        async search({ query }) {
          return {
            source: "intranet",
            citations: ["wiki/q3"],
            facts: [`${query}：内网纪要写华北同比持平`],
            note: "内网检索，不是公网。",
          };
        },
      },
      llm: scriptedPort([call("research", { query: "华北增长口径" }, "s1"), call("compose_deck", lessonDeck, "c1")]),
    });
    assert.equal(result.traces[0]?.summary, "intranet");
    assert.match(result.traces[0]?.detail ?? "", /内网纪要/);
    assert.doesNotMatch(result.traces[0]?.detail ?? "", /Gartner/);
  });

  it("HTTP research degrades to a gap when the intranet endpoint fails", async () => {
    const port = createHttpResearchPort(
      { url: "http://127.0.0.1:9/research" },
      {
        async search() {
          return runResearch("Q3 增长口径", "华北区域 Q3 增长复盘");
        },
      },
    );
    const hit = await port.search({
      query: "Q3 增长口径",
      brief: "华北区域 Q3 增长复盘",
    });
    assert.equal(hit.source, "none");
    assert.match(hit.gap ?? "", /占位|来源/);
  });

  it("pauses on 429 instead of swapping in a playbook deck", async () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const result = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      llm: {
        async completeJson() {
          throw new Error("completeJson must not run after a 429");
        },
        async completeTurn() {
          throw new Error("LLM HTTP 429: RESOURCE_EXHAUSTED");
        },
      },
    });
    assert.equal(result.source, "paused");
    assert.equal(result.pause?.kind, "rate_limit");
    assert.match(result.fallbackReason, /429/);
    assert.equal(result.pause?.checkpoint.brief, "介绍一下勾股定理，面向小学生");
    assert.ok(result.pause?.checkpoint.messages.length >= 2);
  });

  it("resumes a paused loop and composes instead of starting over", async () => {
    const playbook = loadPlaybook({ categoryId: "education-training" });
    const first = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      llm: scriptedPortThenFail(
        [call("think", { summary: "小学生", detail: "先定听众。" }, "t1")],
        new Error("LLM HTTP 429: quota"),
      ),
    });
    assert.equal(first.source, "paused");
    assert.equal(first.traces[0]?.label, "Think");

    const second = await runAgentLoop({
      brief: "介绍一下勾股定理，面向小学生",
      playbook,
      resume: first.pause?.checkpoint,
      llm: scriptedPort([call("compose_deck", lessonDeck, "c1")]),
    });
    assert.equal(second.source, "agent");
    assert.equal(second.deck.title, "勾股小课堂");
    assert.equal(second.traces[0]?.label, "Think");
    assert.ok(second.traces.some((t) => t.tool === "compose_deck"));
  });

  it("runGenerateAsync writes a checkpoint and does not mark a 429 as ready", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pause-"));
    const brain = createAgentBrain({
      categoryId: "education-training",
      llm: {
        async completeJson() {
          throw new Error("completeJson must not run after a 429");
        },
        async completeTurn() {
          throw new Error("LLM HTTP 503: UNAVAILABLE");
        },
      },
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "介绍一下勾股定理，面向小学生",
      brain,
    });
    assert.equal(result.status, "paused");
    assert.equal(result.composeSource, "paused");
    assert.equal(result.canResume, true);
    assert.ok(result.steps.some((s) => s.tool === "wait" && s.status === "failed"));
    assert.ok(!result.steps.some((s) => s.tool === "validate" && s.status === "completed"));
    const cp = readGenerateCheckpoint(dir);
    assert.ok(cp);
    assert.equal(cp?.kind, "busy");
    assert.doesNotMatch(JSON.stringify(cp), /apiKey|authorization|AIza/i);
  });

  it("parseResearchHit ignores empty intranet payloads", () => {
    assert.equal(parseResearchHit({}), undefined);
    const hit = parseResearchHit({
      facts: ["纪要：预算冻结"],
      citations: ["wiki/budget"],
    });
    assert.equal(hit?.source, "intranet");
    assert.equal(hit?.citations[0], "wiki/budget");
  });
});
