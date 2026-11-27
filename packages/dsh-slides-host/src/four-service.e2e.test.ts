/**
 * Offline end-to-end proof of the DSH 4-service thin shell: the host plugin
 * activates on a context that offers ONLY `webServer`, `connection`, `llm` and
 * `attachments` (any other service access throws) and drives a slide session
 * through SlidesAgentRuntime + DshLlmPort: create → live SSE deltas →
 * question answer → follow-up → model switch → operator stop.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { readProjectLease } from "@open-slidestudio/slides-tools";
import type { DshGenerateOptionsLike, DshStreamChunk } from "./dsh-llm-port.js";
import { REPO_ROOT } from "./host-test-fixtures.js";
import { apply, inject } from "./plugin.js";

const ALLOWED = new Set(["webServer", "connection", "llm", "attachments"]);
const FORBIDDEN = [
  "tools",
  "agents",
  "agentPresets",
  "workspaceRegistry",
  "sessionQuery",
  "sessionProjections",
  "profileContext",
  "inject",
  "mcpManager",
];

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
type Step = (options: DshGenerateOptionsLike) => AsyncIterable<DshStreamChunk>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}

function strictContext(services: Record<string, unknown>) {
  const routes: { kind: string; path: string; handler: Handler }[] = [];
  const disposers: (() => void)[] = [];
  const events: string[] = [];
  const target: Record<string, unknown> = {
    ...services,
    webServer: {
      register(route: { kind: string; path: string; handler: Handler }) {
        routes.push(route);
        return () => routes.splice(routes.indexOf(route), 1);
      },
    },
    get(name: string) {
      if (!ALLOWED.has(name)) throw new Error(`thin shell violation: ctx.get(${JSON.stringify(name)})`);
      return target[name];
    },
    on(event: string) {
      if (/^(agent|session|agent-preset|user-questions|system-prompt)\b/.test(event)) {
        throw new Error(`thin shell violation: ctx.on(${JSON.stringify(event)})`);
      }
      events.push(event);
      return () => undefined;
    },
    effect(fn: () => (() => void) | void) {
      const dispose = fn();
      if (dispose) disposers.push(dispose);
    },
  };
  const ctx = new Proxy(target, {
    get(object, prop) {
      if (typeof prop === "string" && FORBIDDEN.includes(prop)) {
        throw new Error(`thin shell violation: ctx.${prop}`);
      }
      return object[prop as string];
    },
  });
  return { ctx: ctx as unknown as Context, routes, disposers, events };
}

/** Scripted DSH `ctx.llm`: roster of two models and one stream step per request. */
function scriptedLlm(steps: Step[]) {
  const requests: DshGenerateOptionsLike[] = [];
  const llm = {
    listProviders: () => [{ id: "scripted" }],
    listModels: async () => [
      { id: "scripted-1", name: "Scripted One", inputModalities: ["text"] },
      { id: "scripted-2", name: "Scripted Two", inputModalities: ["text"] },
    ],
    resolveModelInfo: async () => ({
      inputModalities: ["text"],
      context: { contextWindow: 64_000 },
      defaultMaxTokens: 4_096,
    }),
    stream(options: DshGenerateOptionsLike): AsyncIterable<DshStreamChunk> {
      const index = requests.length;
      requests.push(options);
      const step = steps[index];
      if (!step) return textReply("done")(options);
      return step(options);
    },
  };
  return { llm, requests };
}

function textReply(text: string, gate?: Promise<void>, deltaDelayMs = 0): Step {
  return async function* () {
    if (gate) await gate;
    yield { type: "block-start", index: 0, blockType: "text" };
    for (const part of text.match(/.{1,4}/gu) ?? []) {
      yield { type: "text-delta", index: 0, text: part };
      if (deltaDelayMs) await sleep(deltaDelayMs);
    }
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", reason: { kind: "stop" } };
  };
}

function askQuestion(lead: string, gate: Promise<void>): Step {
  const args = JSON.stringify({
    questions: [{ id: "tone", question: "选择语气", options: [{ label: "简洁" }, { label: "详细" }] }],
  });
  return async function* () {
    await gate;
    yield { type: "block-start", index: 0, blockType: "text" };
    for (const part of lead.match(/.{1,2}/gu) ?? []) {
      yield { type: "text-delta", index: 0, text: part };
      await sleep(60);
    }
    yield { type: "block-end", index: 0, block: { type: "text", text: lead } };
    yield { type: "block-start", index: 1, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: 1, id: "ask-1", name: "ask_user_question", argumentsDelta: args };
    yield {
      type: "block-end",
      index: 1,
      block: { type: "tool-call", id: "ask-1", name: "ask_user_question", arguments: args },
    };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  };
}

function hangUntilAborted(): Step {
  return async function* (options) {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "正在" };
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "aborted" } } };
  };
}

async function call(base: string, method: string, url: string, body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function openLive(base: string, sessionId: string) {
  const envelopes: { rows: { id: string; kind: string; status: string; detail?: string; stream?: unknown }[] }[] = [];
  let buffer = "";
  let connected = false;
  const request = http.get(`${base}/slides/sessions/${sessionId}/events`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.includes(": connected")) connected = true;
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) envelopes.push(JSON.parse(data.slice(6)));
      }
    });
  });
  request.on("error", () => undefined);
  return { envelopes, connected: () => connected, close: () => request.destroy() };
}

describe("DSH 4-service thin shell", () => {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slides-thin-shell-")));
  const dshHome = path.join(dataRoot, ".dsh-home");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { llm, requests } = scriptedLlm([
    askQuestion("我先确认一下语气。", gate),
    textReply("好的，按简洁的语气讨论。"),
    textReply("补充：光反应发生在类囊体膜上。"),
    hangUntilAborted(),
  ]);
  const saved: string[] = [];
  const attachments = {
    async saveImage(input: { data: Uint8Array; mediaType: "image/png" }) {
      saved.push(input.mediaType);
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
      };
    },
  };
  const rejections: string[] = [];
  const connection = {
    requestRejection: (req: http.IncomingMessage) => {
      rejections.push(String(req.url));
      return req.headers["x-test-deny"] ? 403 : undefined;
    },
  };
  const shell = strictContext({ llm, attachments, connection });
  const priorRuntime = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
  let server!: http.Server;
  let base = "";

  before(async () => {
    // A missing explicit runtime keeps provisioning offline (manual phase).
    process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = path.join(dataRoot, "no-runtime");
    apply(shell.ctx, {
      workspaceRoot: REPO_ROOT,
      dataRoot,
      dshHome,
      personal: true,
      operatorStopTimeoutMs: 2_000,
    });
    const slides = shell.routes.find((route) => route.path === "/slides");
    assert.ok(slides, "the /slides prefix is registered through webServer");
    server = http.createServer((req, res) => void slides.handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    for (const dispose of shell.disposers.splice(0).reverse()) dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorRuntime === undefined) delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
    else process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = priorRuntime;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("declares and touches only the thin services", () => {
    assert.deepEqual([...inject].sort(), ["attachments", "llm", "webServer"]);
    assert.deepEqual(shell.events, ["llm/adapters-updated"]);
    // Personal mode mounts only the /slides API prefix on the shared Host server.
    assert.deepEqual(
      shell.routes.map((route) => route.path),
      ["/slides"],
    );
  });

  it("runs create → live SSE deltas → question → follow-up → model switch → stop on SlidesAgentRuntime", async () => {
    const denied = await fetch(`${base}/slides/state/none`, { headers: { "x-test-deny": "1" } });
    assert.equal(denied.status, 403, "connection.requestRejection guards Personal /slides requests");

    const created = await call(base, "POST", "/slides/sessions", {
      brief: "讨论光合作用的讲解思路",
      conversationMode: "discuss",
      provider: "scripted",
      model: "scripted-1",
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const sessionId = String(created.json.sessionId);
    const live = openLive(base, sessionId);
    try {
      await waitFor(() => live.connected(), "SSE connection");
      release();

      // Live panel: real streamed deltas arrive as running snapshot rows before the durable settle.
      await waitFor(
        () =>
          live.envelopes.some((env) =>
            env.rows.some((row) => row.kind === "message" && row.status === "running" && row.stream),
          ),
        "a streaming message row",
      );
      const stateOf = async () => (await call(base, "GET", `/slides/state/${sessionId}`)).json;
      await waitFor(async () => ((await stateOf()).questions as unknown[]).length === 1, "a pending question");
      const state = await stateOf();
      assert.equal(state.agentStatus, "busy");
      const question = (state.questions as { id: string; status: string }[])[0]!;
      assert.equal(question.status, "pending");
      assert.ok(
        live.envelopes.some((env) => env.rows.some((row) => row.kind === "tool" && row.status === "running")),
        "the question tool call is published live",
      );

      const answer = { action: "answer", answer: { answers: [{ id: "tone", selected: ["简洁"] }] } };
      assert.equal((await call(base, "POST", `/slides/sessions/${sessionId}/questions/missing`, answer)).status, 409);
      assert.equal((await call(base, "POST", `/slides/sessions/nope/questions/${question.id}`, answer)).status, 404);
      assert.equal(
        (await call(base, "POST", `/slides/sessions/${sessionId}/questions/${question.id}`, answer)).status,
        200,
      );
      assert.equal(
        (await call(base, "POST", `/slides/sessions/${sessionId}/questions/${question.id}`, answer)).status,
        200,
      );
      await waitFor(async () => (await stateOf()).agentStatus === "idle", "the first turn to settle");
      assert.equal(requests.length, 2, "the answer resumed the same turn in place");
      assert.equal(((await stateOf()).questions as { status: string }[])[0]!.status, "answered");
      const lastRequest = requests[1]!;
      assert.equal(lastRequest.model, "scripted-1");
      assert.ok(
        lastRequest.messages.some((message) => message.role === "tool"),
        "the answer reached the model as the ask_user_question tool result",
      );
      const discussTools = (requests[0]!.tools ?? []).map((tool) => tool.name).sort();
      assert.deepEqual(discussTools, [
        "ask_user_question",
        "inspect_capabilities",
        "list_materials",
        "list_references",
        "query_material",
        "read_material",
        "read_page",
        "read_reference",
      ]);

      const followup = await call(base, "POST", `/slides/sessions/${sessionId}/turn`, {
        text: "再补充一点光反应",
        conversationMode: "discuss",
      });
      assert.equal(followup.status, 200, JSON.stringify(followup.json));
      await waitFor(() => requests.length === 3, "the follow-up request");
      await waitFor(async () => (await stateOf()).agentStatus === "idle", "the follow-up to settle");
      const history = requests[2]!.messages.filter((message) => message.role === "user").length;
      assert.ok(history >= 2, "the follow-up continues the same conversation history");

      const switched = await call(base, "POST", `/slides/sessions/${sessionId}/model`, {
        provider: "scripted",
        model: "scripted-2",
      });
      assert.equal(switched.status, 200, JSON.stringify(switched.json));
      const projectRoot = path.join(dataRoot, String(created.json.projectPath));
      assert.equal(readProjectLease(projectRoot).active, false, "read-only discuss turns do not hold the writer lease");
      const hung = await call(base, "POST", `/slides/sessions/${sessionId}/turn`, {
        text: "开始制作完整演示文稿",
        conversationMode: "generate",
      });
      assert.equal(hung.status, 200);
      await waitFor(() => requests.length === 4, "the post-switch request");
      assert.equal(requests[3]!.model, "scripted-2", "the rebuilt runtime streams on the switched DshLlmPort route");
      await waitFor(() => readProjectLease(projectRoot).active, "the runtime writer lease");
      assert.equal(readProjectLease(projectRoot).holder?.ownerId, `hub-run:${sessionId}`);

      const busySwitch = await call(base, "POST", `/slides/sessions/${sessionId}/model`, {
        provider: "scripted",
        model: "scripted-1",
      });
      assert.equal(busySwitch.status, 409);
      assert.equal(busySwitch.json.code, "session_busy");

      const stopped = await call(base, "POST", `/slides/sessions/${sessionId}/stop`);
      assert.equal(stopped.status, 200);
      assert.deepEqual(stopped.json, { ok: true, sessionId, stopped: true, kernel: "dsh", hostDirected: false });
      const after = await stateOf();
      assert.equal(after.agentStatus, "idle");
      assert.equal(readProjectLease(projectRoot).active, false, "operator stop releases the writer lease");
      const fault = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "dsh-agent-error.json"), "utf8"));
      assert.equal(fault.code, "operator-stop");
      assert.ok(
        fs.existsSync(path.join(projectRoot, "_agent", "runtime-session.v1.jsonl")),
        "the runtime owns the session log",
      );
      assert.ok(rejections.length > 0, "every Personal /slides request passed through connection");
    } finally {
      live.close();
    }
  });
});
