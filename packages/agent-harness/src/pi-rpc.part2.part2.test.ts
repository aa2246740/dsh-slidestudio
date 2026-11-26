import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { runGenerateAsync } from "./index.js";
import { createPiBrain, type PiSessionLike } from "./pi-brain.js";
import { runPiHand } from "./pi-hands.js";

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
  it("fails closed by default when Pi fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-default-closed-"));
    const brain = createPiBrain({
      createSession: () => {
        throw new Error("pi missing");
      },
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "华北区域 Q3 增长复盘：试点成效",
      brain,
      exportPptx: false,
    });
    assert.equal(result.status, "failed");
    assert.equal(brain.usedPi, false);
    assert.match(result.fallbackReason ?? "", /pi missing/);
    const project = loadProject(dir);
    assert.equal(project.pages.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "pages", "1_cover.page")), false);
    assert.equal(fs.existsSync(path.join(dir, "_agent", "compose-deck.json")), false);
  });

  it("nudges Pi to write after a read-only first turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nudge-"));
    let turns = 0;
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "nudge" };
      },
      async promptAndWait() {
        turns += 1;
        if (turns === 1) return [{ type: "agent_end" }];
        await persistSkillStack(dir, "催写后落地");
        return stackRpcEvents();
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({ createSession: () => session, fallback: false });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "催写测试",
      brain,
    });
    assert.equal(result.status, "ready");
    assert.equal(brain.usedPi, true);
    assert.equal(turns, 2);
  });

  it("rejects a chat JSON dump as not the skill stack", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-salvage-"));
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "salvage" };
      },
      async promptAndWait() {
        return [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: '```json\n{"title":"聊天里的稿","pages":[{"role":"cover","title":"聊天里的稿"},{"role":"content","title":"证据","bullets":["1840"]},{"role":"close","title":"收束","bullets":["下周"]}]}\n```',
                },
              ],
            },
          },
          { type: "agent_end" },
        ];
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({ createSession: () => session, fallback: false });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "捞聊天 JSON",
      brain,
    });
    assert.equal(result.status, "failed");
    assert.equal(brain.usedPi, false);
    assert.match(brain.fallbackReason ?? result.fallbackReason ?? "", /did not run as Pi tools/);
  });

  it("rejects a one-shot skill-deck.json write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-oneshot-"));
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "oneshot" };
      },
      async promptAndWait() {
        const file = path.join(dir, "_agent", "skill-deck.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ title: "一锤子", pages: [] }), "utf8");
        return [
          { type: "agent_start" },
          {
            type: "tool_execution_start",
            toolName: "write",
            args: { path: "_agent/skill-deck.json" },
          },
          { type: "agent_end" },
        ];
      },
      async stop() {},
      getStderr() {
        return "";
      },
    };
    const brain = createPiBrain({ createSession: () => session, fallback: false });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "一锤子稿",
      brain,
    });
    assert.equal(result.status, "failed");
    assert.equal(brain.usedPi, false);
    assert.match(brain.fallbackReason ?? result.fallbackReason ?? "", /did not run as Pi tools/);
  });

  it("writes attachments.md so Pi can read Hub files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-"));
    let sawAttach = "";
    const session: PiSessionLike = {
      async start() {},
      async getState() {
        return { sessionId: "att" };
      },
      async promptAndWait() {
        const attach = path.join(dir, "_agent", "attachments.md");
        sawAttach = fs.existsSync(attach) ? fs.readFileSync(attach, "utf8") : "";
        await persistSkillStack(dir, "附件月报");
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
      referenceText: "## 参考: 2026-07-经营月报-虚构演示.md\nGMV 1,840 万（虚构演示）",
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "根据附件写月报",
      brain,
    });
    assert.equal(result.status, "ready");
    assert.equal(brain.usedPi, true);
    assert.match(sawAttach, /1,840 万/);
  });

  it("switches Google model after a daily-quota 429", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-quota-"));
    const seen: string[] = [];
    const brain = createPiBrain({
      fallback: false,
      provider: "google",
      model: "gemini-3.5-flash",
      sleep: async () => undefined,
      createSession: (opts) => {
        seen.push(opts.model || "");
        return {
          async start() {},
          async getState() {
            return { sessionId: "q" };
          },
          async promptAndWait() {
            if (opts.model === "gemini-3.5-flash") {
              return [
                {
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [],
                    stopReason: "error",
                    errorMessage:
                      "GenerateRequestsPerDayPerProjectPerModel-FreeTier model: gemini-3.5-flash RESOURCE_EXHAUSTED 429",
                  },
                },
                { type: "agent_end" },
              ];
            }
            await persistSkillStack(dir, "换模型后落地");
            return stackRpcEvents();
          },
          async stop() {},
          getStderr() {
            return "";
          },
        };
      },
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "配额测试",
      brain,
    });
    assert.equal(result.status, "ready");
    assert.equal(brain.usedPi, true);
    assert.equal(brain.model, "gemini-3.5-flash-lite");
    assert.ok(seen.includes("gemini-3.5-flash"));
    assert.ok(seen.includes("gemini-3.5-flash-lite"));
  });

  it("pauses when every Google produce model is out of daily quota", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-quota-all-"));
    const brain = createPiBrain({
      fallback: false,
      provider: "google",
      model: "gemini-3.5-flash",
      sleep: async () => undefined,
      createSession: (opts) => ({
        async start() {},
        async getState() {
          return { sessionId: "all" };
        },
        async promptAndWait() {
          return [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: `GenerateRequestsPerDayPerProjectPerModel-FreeTier model: ${opts.model} 429`,
              },
            },
            { type: "agent_end" },
          ];
        },
        async stop() {},
        getStderr() {
          return "";
        },
      }),
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "全配额测试",
      brain,
    });
    assert.equal(result.status, "paused");
    assert.equal(result.composeSource, "paused");
    assert.equal(brain.pause?.kind, "rate_limit");
    assert.match(brain.fallbackReason ?? "", /免费次数|限流/);
  });

  it("re-reads the durable ledger before a fresh failover model context", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-failover-recovery-"));
    const prompts: string[] = [];
    const brain = createPiBrain({
      fallback: false,
      provider: "google",
      model: "gemini-3.5-flash",
      strictExecution: true,
      sleep: async () => undefined,
      createSession: (opts) => ({
        async start() {},
        async getState() {
          return { sessionId: `failover-${opts.model}` };
        },
        async promptAndWait(message) {
          prompts.push(message);
          return [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: `GenerateRequestsPerDayPerProjectPerModel-FreeTier model: ${opts.model} 429`,
              },
            },
            { type: "agent_end" },
          ];
        },
        async stop() {},
        getStderr() {
          return "";
        },
      }),
    });
    const result = await runGenerateAsync({
      projectRoot: dir,
      brief: "模型切换恢复测试",
      brain,
    });
    assert.equal(result.status, "paused");
    assert.ok(prompts.length >= 2);
    assert.doesNotMatch(prompts[0]!, /RECOVERY RUN/);
    assert.match(prompts[1]!, /RECOVERY RUN/);
    assert.match(prompts[1]!, /continue the durable project on disk/);
  });
});
