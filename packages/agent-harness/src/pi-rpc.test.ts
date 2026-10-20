import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { runGenerateAsync } from "./index.js";
import { createPiBrain, type PiSessionLike } from "./pi-brain.js";
import {
  assistantTextsFromEvents,
  buildPiRpcArgs,
  inferPiProvider,
  isIdleEvent,
  piAuthEnv,
  piConfigFromEnv,
  PiRpcSession,
  publicPiRuntimeEvent,
  summarizeEvents,
  summarizeTimedEvents,
} from "./pi-rpc.js";
import { clocksFromTimed } from "./pi-brain.js";
import { runPiHand, skillStackEvidence } from "./pi-hands.js";
import { resolvePiSkillDirs } from "./pi-skill.js";

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

const MOCK_PI = `#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id;
  if (msg.type === "get_state") {
    send({ id, type: "response", command: "get_state", success: true, data: { sessionId: "t", thinkingLevel: "off", isStreaming: false } });
    return;
  }
  if (msg.type === "prompt") {
    send({ id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    send({ type: "tool_execution_start", toolName: "write" });
    const out = path.join(process.cwd(), "_agent", "compose-deck.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      title: "华北区域 Q3 增长复盘",
      pages: [
        { role: "cover", title: "华北区域 Q3 增长复盘", subtitle: "试点成效" },
        { role: "toc", title: "本篇结构", items: ["判断", "证据", "动作"] },
        { role: "content", title: "试点有效但尚未铺开", bullets: ["先核对口径"] },
        { role: "evidence", title: "证据位：待补真实序列", note: "占位", chart: { title: "示意", cols: ["项", "值"], rows: [["A", 1], ["B", 2]], note: "placeholder" } },
        { role: "close", title: "结论与下周动作", bullets: ["补数据", "定负责人"] }
      ]
    }));
    send({ type: "tool_execution_end", toolName: "write" });
    send({ type: "agent_end" });
    send({ type: "agent_settled" });
    return;
  }
  send({ id, type: "response", command: String(msg.type), success: false, error: "unknown" });
});
`;

describe("pi env mapping", () => {
  it("prefers the repository-pinned Pi binary", () => {
    const cfg = piConfigFromEnv({});
    assert.ok(cfg.bin.endsWith(path.join("@earendil-works", "pi-coding-agent", "dist", "cli.js")));
  });

  it("does not map SLIDESTUDIO_LLM_API_KEY onto Gemini", () => {
    const out = piAuthEnv({ SLIDESTUDIO_LLM_API_KEY: "secret-test" });
    assert.equal(out.GEMINI_API_KEY, undefined);
    assert.equal(out.GOOGLE_API_KEY, undefined);
  });

  it("strips GEMINI_API_KEY unless a developer opts in", () => {
    const hidden = piAuthEnv({
      SLIDESTUDIO_LLM_API_KEY: "host-key",
      GEMINI_API_KEY: "pi-key",
    });
    assert.equal(hidden.GEMINI_API_KEY, undefined);
    assert.equal(hidden.SLIDESTUDIO_LLM_API_KEY, undefined);
    const allowed = piAuthEnv({
      GEMINI_API_KEY: "pi-key",
      SLIDESTUDIO_PI_ALLOW_ENV: "1",
    });
    assert.equal(allowed.GEMINI_API_KEY, "pi-key");
  });

  it("does not infer google from a Gemini chat URL", () => {
    const empty = path.join(os.tmpdir(), `pi-empty-${Date.now()}.json`);
    const env = {
      SLIDESTUDIO_PI_AUTH_PATH: empty,
      SLIDESTUDIO_LLM_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
      SLIDESTUDIO_LLM_MODEL: "gemini-3.5-flash",
    };
    assert.equal(inferPiProvider(env), undefined);
    const cfg = piConfigFromEnv(env);
    assert.equal(cfg.provider, undefined);
    assert.equal(cfg.model, undefined);
  });

  it("infers google from a native GEMINI_API_KEY", () => {
    const empty = path.join(os.tmpdir(), `pi-empty-${Date.now()}.json`);
    assert.equal(inferPiProvider({ SLIDESTUDIO_PI_AUTH_PATH: empty, GEMINI_API_KEY: "dev-key" }), "google");
  });

  it("does not invent a provider for a local OpenAI-compat URL", () => {
    const empty = path.join(os.tmpdir(), `pi-empty-${Date.now()}.json`);
    assert.equal(
      inferPiProvider({
        SLIDESTUDIO_PI_AUTH_PATH: empty,
        SLIDESTUDIO_LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      }),
      undefined,
    );
  });
});

describe("pi rpc skills", () => {
  it("keeps --no-skills and still passes --skill for host + vendor", () => {
    const dirs = resolvePiSkillDirs();
    const args = buildPiRpcArgs({ cwd: process.cwd() });
    assert.ok(args.includes("--no-skills"));
    const skills = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--skill") skills.push(args[i + 1]);
    }
    assert.ok(skills.includes(dirs.host));
    assert.ok(skills.includes(dirs.vendor));
    assert.ok(fs.existsSync(path.join(dirs.host, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(dirs.vendor, "SKILL.md")));
  });
});

describe("pi rpc protocol", () => {
  it("keeps waiting while a long turn continues to emit progress", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-active-turn-"));
    const bin = path.join(dir, "mock-active-turn.mjs");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "get_state") {
    send({ id: msg.id, type: "response", success: true, data: { sessionId: "active" } });
    return;
  }
  if (msg.type !== "prompt") return;
  send({ id: msg.id, type: "response", success: true });
  send({ type: "agent_start" });
  let page = 0;
  const timer = setInterval(() => {
    page += 1;
    send({ type: "tool_execution_end", toolName: "write_page", result: { page } });
    if (page < 6) return;
    clearInterval(timer);
    send({ type: "agent_end" });
    send({ type: "agent_settled" });
  }, 100);
});
`,
      "utf8",
    );
    fs.chmodSync(bin, 0o755);
    const session = new PiRpcSession({
      bin: process.execPath,
      prefixArgs: [bin],
      cwd: dir,
      skills: [],
      commandTimeoutMs: 5_000,
    });
    await session.start();
    await session.getState();
    try {
      const events = await session.promptAndWait("write six pages", 500);
      assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 6);
      assert.ok(events.some((event) => event.type === "agent_end"));
    } finally {
      await session.stop();
    }
  });

  it("publishes tool progress without assistant reasoning or full page content", () => {
    const start = publicPiRuntimeEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "write_page",
      args: { id: "page-03", elements: [{ content: "must stay private" }] },
    });
    assert.equal(start?.status, "running");
    assert.equal(start?.summary, "page-03");
    assert.doesNotMatch(JSON.stringify(start), /must stay private/);
    const end = publicPiRuntimeEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "write_page",
      isError: false,
    });
    assert.equal(end?.status, "completed");
    assert.equal(end?.id, start?.id);
  });

  it("records a 429 stop instead of a blank assistant message", () => {
    const lines = summarizeEvents([
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "RESOURCE_EXHAUSTED code 429",
        },
      },
      { type: "agent_end" },
    ]);
    assert.deepEqual(lines, ["agent_start", "stop:429", "agent_end"]);
  });

  it("extracts assistant chat text from message_end events", () => {
    const texts = assistantTextsFromEvents([
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: '{"title":"x"}' }] },
      },
      { type: "message_end", message: { role: "user", content: "ignore" } },
    ]);
    assert.deepEqual(texts, ['{"title":"x"}']);
  });

  it("does not treat a leftover agent_settled as the next turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-idle-"));
    const bin = path.join(dir, "mock-pi.mjs");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let prompts = 0;
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "get_state") {
    send({ id: msg.id, type: "response", command: "get_state", success: true, data: { sessionId: "t" } });
    return;
  }
  if (msg.type === "prompt") {
    prompts += 1;
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    if (prompts === 1) {
      send({ type: "agent_start" });
      send({ type: "agent_end" });
      setTimeout(() => send({ type: "agent_settled" }), 30);
      return;
    }
    send({ type: "agent_start" });
    send({ type: "tool_execution_start", toolName: "write" });
    send({ type: "agent_end" });
    send({ type: "agent_settled" });
  }
});
`,
      "utf8",
    );
    fs.chmodSync(bin, 0o755);
    const session = new PiRpcSession({
      bin: process.execPath,
      prefixArgs: [bin],
      cwd: dir,
      skills: [],
      commandTimeoutMs: 5_000,
    });
    await session.start();
    await session.getState();
    await session.promptAndWait("first", 5_000);
    const second = await session.promptAndWait("second", 5_000);
    await session.stop();
    assert.ok(second.some((e) => e.type === "tool_execution_start" && e.toolName === "write"));
  });

  it("waits for agent_settled before sending a follow-up prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-settled-"));
    const bin = path.join(dir, "mock-pi.mjs");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let processing = false;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "get_state") {
    send({ id: msg.id, type: "response", success: true, data: { sessionId: "settled" } });
    return;
  }
  if (msg.type !== "prompt") return;
  if (processing) {
    send({
      id: msg.id,
      type: "response",
      success: false,
      error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    });
    return;
  }
  processing = true;
  send({ id: msg.id, type: "response", success: true });
  send({ type: "agent_start" });
  send({ type: "agent_end" });
  setTimeout(() => {
    processing = false;
    send({ type: "agent_settled" });
  }, 25);
});
`,
      "utf8",
    );
    fs.chmodSync(bin, 0o755);
    const session = new PiRpcSession({
      bin: process.execPath,
      prefixArgs: [bin],
      cwd: dir,
      skills: [],
      commandTimeoutMs: 5_000,
    });
    await session.start();
    await session.getState();
    try {
      await session.promptAndWait("first", 500);
      const second = await session.promptAndWait("continue", 500);
      assert.ok(second.some((event) => event.type === "agent_settled"));
    } finally {
      await session.stop();
    }
  });

  it("waits for agent_settled instead of the earlier agent_end", () => {
    assert.equal(isIdleEvent({ type: "agent_end" }), false);
    assert.equal(isIdleEvent({ type: "agent_settled" }), true);
    assert.equal(isIdleEvent({ type: "turn_end" }), false);
    assert.deepEqual(summarizeEvents([{ type: "tool_execution_start", toolName: "write" }]), ["tool:write"]);
  });

  it("keeps the receive clock on each summarized event", () => {
    const timed = summarizeTimedEvents([
      { type: "agent_start", _receivedAt: "2026-08-18T14:20:00.000Z" },
      {
        type: "tool_execution_start",
        toolName: "write",
        args: { path: "_agent/skill-deck.json" },
        _receivedAt: "2026-08-18T14:20:07.400Z",
      },
      { type: "agent_end", _receivedAt: "2026-08-18T14:20:12.000Z" },
    ]);
    assert.deepEqual(timed, [
      { at: "2026-08-18T14:20:00.000Z", event: "agent_start" },
      { at: "2026-08-18T14:20:07.400Z", event: "tool:write:skill-deck.json" },
      { at: "2026-08-18T14:20:12.000Z", event: "agent_end" },
    ]);
    const clocks = clocksFromTimed(timed);
    assert.equal(clocks.agentStart, "2026-08-18T14:20:00.000Z");
    assert.equal(clocks.agentEnd, "2026-08-18T14:20:12.000Z");
    assert.equal(clocks.wallMs, 12_000);
    assert.deepEqual(clocks.toolWrites, [{ at: "2026-08-18T14:20:07.400Z", event: "tool:write:skill-deck.json" }]);
  });

  it("clocks the last agent_start, not a prior 429 session", () => {
    const clocks = clocksFromTimed([
      { at: "2026-08-18T14:45:21.814Z", event: "agent_start" },
      { at: "2026-08-18T14:45:22.064Z", event: "agent_end" },
      { at: "2026-08-18T14:45:22.065Z", event: "quota:gemini-3.5-flash" },
      { at: "2026-08-18T14:45:22.787Z", event: "agent_start" },
      { at: "2026-08-18T14:45:26.306Z", event: "tool:write_todo" },
      { at: "2026-08-18T14:45:40.007Z", event: "tool:write_page" },
      { at: "2026-08-18T14:45:51.000Z", event: "agent_end" },
    ]);
    assert.equal(clocks.agentStart, "2026-08-18T14:45:22.787Z");
    assert.equal(clocks.agentEnd, "2026-08-18T14:45:51.000Z");
    assert.equal(clocks.wallMs, 28_213);
  });

  it("stamps _receivedAt when each RPC line arrives", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-clock-"));
    const bin = path.join(dir, "mock-pi.mjs");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "get_state") {
    send({ id: msg.id, type: "response", command: "get_state", success: true, data: { sessionId: "t" } });
    return;
  }
  if (msg.type === "prompt") {
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    setTimeout(() => {
      send({ type: "tool_execution_start", toolName: "write", args: { path: "_agent/skill-deck.json" } });
    }, 40);
    setTimeout(() => send({ type: "agent_end" }), 80);
    setTimeout(() => send({ type: "agent_settled" }), 90);
  }
});
`,
      "utf8",
    );
    fs.chmodSync(bin, 0o755);
    const session = new PiRpcSession({
      bin: process.execPath,
      prefixArgs: [bin],
      cwd: dir,
      skills: [],
      commandTimeoutMs: 5_000,
    });
    await session.start();
    await session.getState();
    const events = await session.promptAndWait("write", 5_000);
    await session.stop();
    const start = events.find((e) => e.type === "agent_start");
    const write = events.find((e) => e.type === "tool_execution_start");
    const end = events.find((e) => e.type === "agent_end");
    assert.equal(typeof start?._receivedAt, "string");
    assert.equal(typeof write?._receivedAt, "string");
    assert.equal(typeof end?._receivedAt, "string");
    const startMs = Date.parse(String(start?._receivedAt));
    const writeMs = Date.parse(String(write?._receivedAt));
    const endMs = Date.parse(String(end?._receivedAt));
    assert.ok(writeMs - startMs >= 20, `write-start gap ${writeMs - startMs}`);
    assert.ok(endMs - writeMs >= 20, `end-write gap ${endMs - writeMs}`);
  });

  it("drives a mock pi binary through promptAndWait", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-"));
    const bin = path.join(dir, "mock-pi.mjs");
    fs.writeFileSync(bin, MOCK_PI, "utf8");
    fs.chmodSync(bin, 0o755);
    const session = new PiRpcSession({
      bin: process.execPath,
      prefixArgs: [bin],
      cwd: dir,
      commandTimeoutMs: 5_000,
    });
    await session.start();
    const state = await session.getState();
    assert.equal(state.sessionId, "t");
    const events = await session.promptAndWait("write the deck", 5_000);
    await session.stop();
    assert.ok(events.some((e) => e.type === "agent_settled" || e.type === "agent_end"));
    assert.ok(fs.existsSync(path.join(dir, "_agent", "compose-deck.json")));
  });
});

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
          { type: "tool_execution_start", toolName: "write_todo", _receivedAt: "2026-08-18T15:00:02.000Z" },
          { type: "tool_execution_start", toolName: "write_page", _receivedAt: "2026-08-18T15:00:04.000Z" },
          { type: "tool_execution_start", toolName: "write_page", _receivedAt: "2026-08-18T15:00:05.000Z" },
          { type: "tool_execution_start", toolName: "review_pages", _receivedAt: "2026-08-18T15:00:09.000Z" },
          { type: "tool_execution_start", toolName: "compose_deck", _receivedAt: "2026-08-18T15:00:10.000Z" },
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
