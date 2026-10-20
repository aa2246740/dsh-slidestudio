import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSlidesRequest, type SlidesHostRuntime } from "./routes.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function invokeSlides(
  runtime: SlidesHostRuntime,
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
    req.method = "POST";
    req.url = url;
    req.headers = {
      host: "127.0.0.1:13080",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(JSON.stringify(body))),
    };
    const res = {
      statusCode: 0,
      headersSent: false,
      writeHead(status: number) {
        this.statusCode = status;
        this.headersSent = true;
      },
      end(chunk?: unknown) {
        try {
          resolve({
            status: this.statusCode,
            json: chunk == null ? {} : (JSON.parse(String(chunk)) as Record<string, unknown>),
          });
        } catch (error) {
          reject(error);
        }
      },
    };
    handleSlidesRequest(runtime, req, res as unknown as ServerResponse);
  });
}

it("accepts only one of two concurrent generation recovery turns", async () => {
  const sessionId = "concurrent-generation-resume";
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routes-resume-project-"));
  fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
  let busy = false;
  let markBusyCount = 0;
  let followupCount = 0;
  const binding = {
    version: 1 as const,
    dshSessionId: sessionId,
    projectRoot,
    design: { kind: "self-directed" as const },
    provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    createdAt: "2026-09-07T00:00:00.000Z",
  };
  const runtime = {
    workspaceRoot: repoRoot,
    dshHome: fs.mkdtempSync(path.join(os.tmpdir(), "routes-resume-home-")),
    store: {
      bindingFor: (requested: string) => (requested === sessionId ? binding : undefined),
      resolveRoot: () => projectRoot,
      inspect: () => ({
        binding,
        project: { title: "Recover me", pageCount: 10, deckSha256: "" },
        phase: { kind: "paused" as const, detail: "production-no-progress-budget" },
      }),
    },
    presentation: {},
    agentBusy: () => busy,
    markBusy: () => {
      busy = true;
      markBusyCount += 1;
    },
    cancelRateLimitWait: () => undefined,
    operatorStop: async () => undefined,
    getAgent: () => ({
      followup: () => {
        followupCount += 1;
      },
    }),
    createAgent: async () => ({ sessionId: "unused" }),
    resumeAgent: async () => undefined,
    switchModel: async () => undefined,
  } as unknown as SlidesHostRuntime;

  const body = { text: "Continue the persisted generation", resumeGeneration: true };
  const responses = await Promise.all([
    invokeSlides(runtime, `/slides/sessions/${sessionId}/turn`, body),
    invokeSlides(runtime, `/slides/sessions/${sessionId}/turn`, body),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(responses.find((response) => response.status === 409)?.json.code, "generation_resume_conflict");
  assert.equal(markBusyCount, 1);
  assert.equal(followupCount, 1);
});

it("resumes idle page-ready work using the same execution projection as the UI", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "routes-ready-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repoRoot, "fixtures/okp-yu7-ppt"), root, { recursive: true });
  const sessionId = "ready-page-session";
  const binding = {
    dshSessionId: sessionId,
    projectRoot: root,
    provider: { providerId: "local", modelId: "local" },
    design: { kind: "self-directed" },
  };
  let busy = false,
    followups = 0;
  const runtime = {
    workspaceRoot: repoRoot,
    dshHome: root,
    store: { bindingFor: () => binding, resolveRoot: () => root, inspect: () => ({ phase: { kind: "page-ready" } }) },
    agentBusy: () => busy,
    markBusy: () => {
      busy = true;
    },
    cancelRateLimitWait: () => undefined,
    getAgent: () => ({
      followup: () => {
        followups++;
      },
    }),
  } as unknown as SlidesHostRuntime;
  const body = { text: "保持两页并继续收尾", resumeGeneration: true };
  const result = await invokeSlides(runtime, `/slides/sessions/${sessionId}/turn`, body);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(followups, 1);
  const duplicate = await invokeSlides(runtime, `/slides/sessions/${sessionId}/turn`, body);
  assert.equal(duplicate.status, 409);
  assert.equal(followups, 1);
});

it("continues discussion in the same session without edit authorization, then explicitly resumes generation", async (t) => {
  const { readConversation } = await import("./assistant-conversation.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "routes-chat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = "continuous-assistant";
  const binding = { dshSessionId: sessionId, projectRoot: root, provider: { providerId: "local", modelId: "local" } };
  let busy = false;
  const messages: unknown[] = [];
  const runtime = {
    workspaceRoot: repoRoot,
    dshHome: root,
    store: { bindingFor: () => binding, resolveRoot: () => root },
    agentBusy: () => busy,
    markBusy: () => {
      busy = true;
    },
    cancelRateLimitWait: () => undefined,
    getAgent: () => ({ followup: (message: unknown) => messages.push(message) }),
  } as unknown as SlidesHostRuntime;
  const url = `/slides/sessions/${sessionId}/turn`;
  const first = await invokeSlides(runtime, url, { text: "先讨论，不修改", conversationMode: "discuss" });
  assert.equal(first.status, 200);
  assert.equal(readConversation(root).mode, "discuss");
  assert.match(JSON.stringify(messages[0]), /只讨论/);
  assert.equal(fs.existsSync(path.join(root, "_agent", "attempt.v1.json")), false);
  const raced = await invokeSlides(runtime, url, { text: "再聊一轮", conversationMode: "discuss" });
  assert.equal(raced.status, 409);
  assert.equal(readConversation(root).messages.length, 1);
  const mixed = await invokeSlides(runtime, url, { text: "讨论", conversationMode: "discuss", editorEdit: {} });
  assert.equal(mixed.status, 400);
  busy = false;
  assert.equal((await invokeSlides(runtime, url, { text: "第二个方案呢？", conversationMode: "discuss" })).status, 200);
  assert.equal(readConversation(root).messages.length, 2);
  busy = false;
  assert.equal(
    (await invokeSlides(runtime, url, { text: "按第二个方案开始生成", conversationMode: "generate" })).status,
    200,
  );
  assert.equal(readConversation(root).mode, "generate");
  assert.equal(readConversation(root).messages.length, 3);
  assert.equal(messages.length, 3);
  assert.equal(fs.existsSync(path.join(root, "_agent", "attempt.v1.json")), true);
});

it("plans a conversation turn without starting an Agent or authorizing a write", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "routes-intent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { recordConversationMessage } = await import("./assistant-conversation.js");
  recordConversationMessage(root, "请先给建议", "discuss");
  let calls = 0;
  let busy = false;
  const runtime = {
    store: {
      bindingFor: (id: string) => (id === "s" ? { projectRoot: root } : undefined),
      resolveRoot: () => root,
      inspect: () => ({ project: { pageCount: 2 } }),
    },
    agentBusy: () => busy,
    resolveAssistantIntent: async (input: import("./assistant-intent.js").AssistantIntentInput) => {
      calls++;
      assert.equal(input.pageCount, 2);
      assert.equal(input.history[0]?.text, "请先给建议");
      assert.deepEqual(input.modelSelection, { provider: "local", model: "cheap" });
      return { intent: "edit", scope: "pages", pages: [2] };
    },
    markBusy: () => {
      throw new Error("planning must not start an Agent");
    },
  } as unknown as SlidesHostRuntime;
  const body = {
    text: "第二个方案",
    sessionId: "s",
    currentPage: 1,
    selectedCount: 0,
    modelSelection: { provider: "local", model: "cheap" },
  };
  const response = await invokeSlides(runtime, "/slides/assistant-intent", body);
  assert.equal(response.status, 200);
  assert.equal(response.json.intent, "edit");
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(root, "_agent", "attempt.v1.json")), false);
  busy = true;
  assert.equal((await invokeSlides(runtime, "/slides/assistant-intent", body)).status, 409);
  assert.equal(calls, 1);
  busy = false;
  assert.equal((await invokeSlides(runtime, "/slides/assistant-intent", { ...body, currentPage: 3 })).status, 400);
  assert.equal(calls, 1);
});
