import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { runGenerateAsync } from "./index.js";
import { createPiBrain, type PiSessionLike } from "./pi-brain.js";
import { runPiHand, skillStackEvidence } from "./pi-hands.js";

function textPage(id: string, title: string, body: string) {
  return {
    id,
    pageType: id === "page-01" ? "cover" : "content",
    background: { type: "solid", color: "#FDFAF5" },
    elements: [
      {
        elementId: "panel",
        elementType: "shape",
        shapeName: "rect",
        bounds: [48, 120, 400, 220],
        fill: { type: "solid", color: "#D7EBCE" },
      },
      {
        elementId: "rule",
        elementType: "shape",
        shapeName: "rect",
        bounds: [48, 80, 72, 8],
        fill: { type: "solid", color: "#F5987E" },
      },
      {
        elementId: "seed",
        elementType: "shape",
        shapeName: "ellipse",
        bounds: [120, 180, 72, 52],
        fill: { type: "solid", color: "#C4A35A" },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [48, 36, 860, 40],
        content: { text: title, bold: true, fontSize: 22, color: "#44712E" },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [480, 140, 420, 200],
        content: { text: body, fontSize: 16, color: "#56687A" },
      },
    ],
  };
}

async function persistSkillStack(dir: string, title: string): Promise<void> {
  const titles = ["封面", "路径", "概念", "记住", "展板", "收束"];
  const todo = await runPiHand(
    "write_todo",
    { items: titles.map((t) => ({ title: t, note: `${title} · ${t}` })) },
    dir,
  );
  if (!todo.ok) throw new Error(todo.detail);
  for (const [i, pageTitle] of titles.entries()) {
    const page = await runPiHand(
      "write_page",
      textPage(`page-0${i + 1}`, pageTitle, `${title}：${pageTitle}写在这一页。`),
      dir,
    );
    if (!page.ok) throw new Error(page.detail);
  }
  const review = await runPiHand("review_pages", {}, dir);
  if (!review.ok) throw new Error(review.detail);
  const compose = await runPiHand("compose_deck", { title }, dir);
  if (!compose.ok) throw new Error(compose.detail);
}

function stackRpcEvents(at = "2026-08-18T16:00:00.000Z", renders = 0): Record<string, unknown>[] {
  const names = [
    "write_todo",
    "write_page",
    "write_page",
    "write_page",
    "write_page",
    "write_page",
    "write_page",
    ...Array.from({ length: renders }, () => "render_page"),
    "review_pages",
    "compose_deck",
  ];
  return [
    { type: "agent_start", _receivedAt: at },
    ...names.flatMap((toolName) => [
      { type: "tool_execution_start", toolName, _receivedAt: at },
      { type: "tool_execution_end", toolName, _receivedAt: at },
    ]),
    { type: "agent_end", _receivedAt: at },
  ];
}

describe("pi brain", () => {
  it("materializes compose IR from an injected Pi session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-brain-"));
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "inj" };
      },
      async promptAndWait() {
        await persistSkillStack(dir, "注入生成");
        return stackRpcEvents();
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({
      createSession: () => session,
      fallback: false,
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "注入生成：只验证 Pi 脑",
      brain,
      exportPptx: false,
    });
    assert.equal(result.status, "ready");
    assert.equal(brain.usedPi, true);
    assert.ok(brain.skills.some((p) => p.includes("open-slidestudio")));
    assert.ok(!result.steps.some((s) => s.tool === "think"));
    assert.ok(result.steps.some((s) => s.tool === "compose_deck" && /Pi · Skill/.test(s.label)));
    const project = loadProject(dir);
    assert.equal(project.presentation.title, "注入生成");
    assert.ok(project.pages.length >= 5);
    assert.ok(fs.existsSync(path.join(dir, "_agent", "skill-paths.md")));
  });

  it("writes agent_start / skill-tool / agent_end clocks into pi-trace.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-clock-"));
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "clock" };
      },
      async promptAndWait() {
        await persistSkillStack(dir, "时钟稿");
        return [
          { type: "agent_start", _receivedAt: "2026-08-18T15:00:00.000Z" },
          {
            type: "tool_execution_start",
            toolName: "write_todo",
            _receivedAt: "2026-08-18T15:00:02.000Z",
          },
          {
            type: "tool_execution_start",
            toolName: "write_page",
            _receivedAt: "2026-08-18T15:00:04.000Z",
          },
          {
            type: "tool_execution_start",
            toolName: "write_page",
            _receivedAt: "2026-08-18T15:00:05.000Z",
          },
          {
            type: "tool_execution_start",
            toolName: "review_pages",
            _receivedAt: "2026-08-18T15:00:09.000Z",
          },
          {
            type: "tool_execution_start",
            toolName: "compose_deck",
            _receivedAt: "2026-08-18T15:00:10.000Z",
          },
          { type: "agent_end", _receivedAt: "2026-08-18T15:00:11.500Z" },
        ];
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({
      createSession: () => session,
      fallback: false,
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "时钟核验",
      brain,
      exportPptx: false,
    });
    assert.equal(result.status, "ready");
    const trace = JSON.parse(fs.readFileSync(path.join(dir, "_agent", "pi-trace.json"), "utf8")) as {
      agentStart: string;
      agentEnd: string;
      wallMs: number;
      toolWrites: Array<{ at: string; event: string }>;
      timedEvents: Array<{ at: string; event: string }>;
      fileMtimes: { composeDeck: string | null };
    };
    assert.equal(trace.agentStart, "2026-08-18T15:00:00.000Z");
    assert.equal(trace.agentEnd, "2026-08-18T15:00:11.500Z");
    assert.equal(trace.wallMs, 11_500);
    assert.ok(trace.timedEvents.some((e) => e.event === "tool:write_todo"));
    assert.ok(trace.timedEvents.filter((e) => e.event === "tool:write_page").length >= 2);
    assert.ok(trace.timedEvents.some((e) => e.event === "tool:review_pages"));
    assert.ok(trace.timedEvents.some((e) => e.event === "tool:compose_deck"));
    assert.ok(skillStackEvidence(trace.timedEvents).ok);
    assert.ok(trace.timedEvents.some((e) => e.event === "agent_start" && e.at === trace.agentStart));
    const visual = JSON.parse(fs.readFileSync(path.join(dir, "_agent", "visual-review.json"), "utf8")) as {
      note: string;
      kind: string;
    };
    assert.equal(visual.kind, "pi-tools");
    assert.match(visual.note, /Host did not raster after agent_end/);
    assert.doesNotMatch(visual.note, /Host raster after Pi/);
  });

  it("remaps a 讲一讲 classroom brief off Hub consulting pine-green", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-taste-"));
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "taste" };
      },
      async promptAndWait() {
        await persistSkillStack(dir, "种子怎么发芽");
        return stackRpcEvents("2026-08-18T16:00:00.000Z", 6);
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({
      createSession: () => session,
      fallback: false,
      designSystemId: "consulting/pine-green-strategy",
      categoryId: "analysis-decision",
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "给二年级讲一讲种子怎么发芽",
      brain,
      exportPptx: false,
    });
    assert.equal(result.status, "ready");
    const runtime = JSON.parse(fs.readFileSync(path.join(dir, "_agent", "runtime.json"), "utf8")) as {
      categoryId: string;
      designSystemId: string;
    };
    assert.equal(runtime.categoryId, "education-training");
    assert.equal(runtime.designSystemId, "academic/paper-white-courseware");
    const playbook = fs.readFileSync(path.join(dir, "_agent", "playbook.md"), "utf8");
    assert.match(playbook, /paper-white-courseware/);
    assert.match(playbook, /K-12 classroom courseware/);
    assert.doesNotMatch(playbook, /consulting\/pine-green-strategy/);
  });

  it("fails closed when Pi dies after write_page — host does not salvage-compose", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-salvage-"));
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "salvage" };
      },
      async promptAndWait() {
        await runPiHand(
          "write_todo",
          {
            items: ["封面", "路径", "概念", "记住", "展板", "收束"].map((title) => ({
              title,
              note: title,
            })),
          },
          dir,
        );
        for (let i = 1; i <= 4; i++) {
          await runPiHand("write_page", textPage(`page-0${i}`, `第${i}页`, `种子怎么发芽 ${i}`), dir);
        }
        return [
          { type: "agent_start", _receivedAt: "2026-08-18T16:20:00.000Z" },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "The service is currently unavailable. 503 UNAVAILABLE",
            },
            _receivedAt: "2026-08-18T16:20:08.000Z",
          },
          { type: "agent_end", _receivedAt: "2026-08-18T16:20:08.000Z" },
        ];
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({
      createSession: () => session,
      fallback: false,
      sleep: async () => undefined,
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "给二年级讲一讲种子怎么发芽",
      brain,
      exportPptx: false,
    });
    assert.equal(result.status, "failed");
    assert.equal(brain.usedPi, false);
    const trace = JSON.parse(fs.readFileSync(path.join(dir, "_agent", "pi-trace.json"), "utf8")) as {
      skillStack?: { ok?: boolean };
      produce?: string;
      error?: string;
    };
    assert.notEqual(trace.produce, "pi-tools-salvage");
    assert.equal(trace.skillStack?.ok ?? false, false);
  });

  it("fails closed when Codex blows the context window — no salvage-compose", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-travel-salvage-"));
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "travel-salvage" };
      },
      async promptAndWait() {
        await runPiHand(
          "write_todo",
          {
            items: ["封面", "浅草", "涩谷", "收束"].map((title) => ({
              title,
              note: title,
            })),
          },
          dir,
        );
        await runPiHand("write_page", textPage("page-01", "封面", "东京七日"), dir);
        await runPiHand("write_page", textPage("page-02", "浅草", "浅草寺"), dir);
        return [
          { type: "agent_start", _receivedAt: "2026-08-19T03:23:00.000Z" },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Codex error: Your input exceeds the context window of this model.",
            },
            _receivedAt: "2026-08-19T03:23:14.000Z",
          },
          { type: "agent_end", _receivedAt: "2026-08-19T03:23:14.000Z" },
        ];
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({
      createSession: () => session,
      fallback: false,
      sleep: async () => undefined,
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "生成一份日本东京7日旅游攻略，列出10月必去的地方",
      brain,
      exportPptx: false,
    });
    assert.equal(result.status, "failed");
    assert.equal(brain.usedPi, false);
    const playbook = fs.readFileSync(path.join(dir, "_agent", "playbook.md"), "utf8");
    assert.match(playbook, /# Runtime routing promotion\/travel-green-handbook/);
    assert.match(playbook, /not an OpenKimi source/);
    assert.doesNotMatch(playbook, /paper-white-courseware \+ education-training/);
    const trace = JSON.parse(fs.readFileSync(path.join(dir, "_agent", "pi-trace.json"), "utf8")) as {
      produce?: string;
    };
    assert.notEqual(trace.produce, "pi-tools-salvage");
  });

  it("refuses a 经营月报 with no company and no numbers before write_page", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nodata-"));
    let started = 0;
    const session: PiSessionLike = {
      async start() {
        started += 1;
      },
      async getState() {
        return { sessionId: "nodata" };
      },
      async promptAndWait() {
        throw new Error("Pi must not start on an empty 经营月报 brief");
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({
      createSession: () => session,
      fallback: false,
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "做一份公司经营月报",
      brain,
      exportPptx: false,
    });
    assert.equal(result.status, "failed");
    assert.equal(started, 0);
    assert.match(result.fallbackReason ?? "", /公司名和至少一组/);
  });

  it("falls back to playbook when Pi fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fallback-"));
    const brain = createPiBrain({
      fallback: true,
      createSession: () => {
        throw new Error("pi missing");
      },
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "华北区域 Q3 增长复盘：试点成效",
      brain,
    });
    assert.equal(result.status, "ready");
    assert.equal(brain.usedPi, false);
    assert.match(brain.fallbackReason ?? "", /pi missing/);
    const project = loadProject(dir);
    assert.ok(project.pages.length >= 5);
  });
});
