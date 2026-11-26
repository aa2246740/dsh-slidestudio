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
    assert.match(cfg.bin, /@earendil-works\/pi-coding-agent\/dist\/cli\.js$/);
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
