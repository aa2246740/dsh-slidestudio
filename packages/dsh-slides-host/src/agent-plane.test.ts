import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { createScope, scopeTarget } from "@deepseek-ai/dsh-scope";
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import type { PresentationRun } from "@open-slidestudio/presentation-run";
import { AssistantQuestions } from "./assistant-questions.js";
import {
  reconcileSlidesAgentPlane,
  wireSlidesAgentPlane,
  wireSlidesAgentPlaneForAgent,
  type AgentPresetProbe,
  type SlidesAgentPlaneDeps,
} from "./agent-plane.js";
import { registerSliceTools } from "./tools.js";
import { patchProduceAssembly } from "./produce-request-header.js";
import { SliceSessionStore } from "./slice-session.js";
import { AgentFaults } from "./agent-fault.js";

type FakeAgent = { id: string };

const QUESTIONS = [{ id: "q1", question: "pick?", options: [{ label: "a" }, { label: "b" }] }];
const ANSWER_A: AskUserQuestionAnswer = { answers: [{ id: "q1", selected: ["a"] }] } as never;
const NATIVE_ANSWER: AskUserQuestionAnswer = { answers: [{ id: "q1", selected: ["b"], custom: "native" }] } as never;

function stubPresentation(): PresentationRun {
  return {
    execute: async (command) => ({
      ok: true,
      name: command.name,
      summary: `${command.name} ok`,
      detail: `${command.name} ok`,
      payload: {},
    }),
    open: async () => {
      throw new Error("unused");
    },
    inspect: async () => {
      throw new Error("unused");
    },
    hydrate: () => undefined,
    epochFor: () => "epoch",
  };
}

function nativeAnsweredAt(h: { nativeAnswered: string[] }, sessionId: string): number {
  return h.nativeAnswered.filter((id) => id === sessionId).length;
}

async function harness() {
  const ctx = new Context();
  const promptFiber = await ctx.plugin(SystemPrompt, {});
  const toolsFiber = await ctx.plugin(ToolRuntime, {});
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-plane-"));
  const store = new SliceSessionStore(workspace);
  const questions = new AssistantQuestions((sessionId) => {
    const binding = store.bindingFor(sessionId);
    return binding ? store.resolveRoot(binding) : undefined;
  });
  const deps: SlidesAgentPlaneDeps = {
    store,
    presentation: stubPresentation(),
    workspaceRoot: workspace,
    editorBaseUrl: "http://127.0.0.1:55200",
    faults: new AgentFaults(),
    provider: { providerId: "pi-xai", modelId: "grok-4.6" },
    questions,
  };
  // A native answerer standing in for DSH's remote answerer: untagged, so the
  // waterfall admits it for every agent.
  const nativeAnswered: string[] = [];
  ctx.on("user-questions/request", (request: AskUserQuestionRequest) => {
    nativeAnswered.push((request.agent as unknown as FakeAgent | undefined)?.id ?? "?");
    return Promise.resolve(NATIVE_ANSWER);
  });
  // A generic tool outside the slides set — stands in for Creator/`bash`.
  ctx.tools.register(
    defineTool({
      name: "bash",
      description: "run a shell command",
      parameters: {},
      output: {
        schema: { type: "json" as const },
        render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: String(value) }],
      },
      execute: () => Promise.resolve("ok"),
    }),
  );
  // A function-calling web_search leaking into assemblies — the produce patch
  // is expected to drop it for slides agents only.
  ctx.systemPrompt.tools(() => ({
    schemas: [
      {
        name: "web_search",
        description: "search the web",
        parameters: { type: "object", properties: { queries: { type: "array" } } },
      },
    ],
  }));
  const generationKey = { id: "generation-slides" };
  const generation = createScope(ctx, generationKey as never);
  const slidesA: FakeAgent = { id: "slides-a" };
  const slidesB: FakeAgent = { id: "slides-b" };
  const creator: FakeAgent = { id: "creator-session" };
  const scopeA = createScope(ctx, slidesA as never, { parent: generationKey as never });
  const scopeB = createScope(ctx, slidesB as never, { parent: generationKey as never });
  const creatorScope = createScope(ctx, creator as never);
  const askQuestion = (agent: FakeAgent, signal?: AbortSignal) =>
    ctx.waterfall(
      scopeTarget(ctx, agent as never) as never,
      "user-questions/request",
      { questions: QUESTIONS, agent: agent as never, signal } as AskUserQuestionRequest,
      () => Promise.resolve(NATIVE_ANSWER),
    ) as Promise<AskUserQuestionAnswer>;
  const assemble = (agent: FakeAgent) =>
    ctx.systemPrompt.assemble({ agent: agent as never, scope: agent as never });
  const execute = (agent: FakeAgent, name: string, args: Record<string, unknown> = {}) =>
    ctx.tools.execute({
      callId: ToolCallId(`t-${Math.random().toString(36).slice(2)}`),
      name,
      arguments: args,
      agent: agent as never,
      signal: new AbortController().signal,
    });
  return {
    ctx,
    workspace,
    store,
    questions,
    deps,
    nativeAnswered,
    generation,
    scopeA,
    scopeB,
    creatorScope,
    slidesA,
    slidesB,
    creator,
    askQuestion,
    assemble,
    execute,
    async dispose() {
      await scopeA.dispose();
      await scopeB.dispose();
      await creatorScope.dispose();
      await generation.dispose();
      await toolsFiber.dispose();
      await promptFiber.dispose();
    },
  };
}

describe("slides agent plane — legacy global wiring reproduces the leak", () => {
  it("documents why global tools/guard/questions pollute an unrelated bound agent", async () => {
    const h = await harness();
    try {
      // Exactly what plugin.ts did before the fix: tools, guard, question
      // interception and the assemble patch all installed on the root context
      // (the question listener additionally fired for any persisted binding).
      registerSliceTools(h.ctx.tools, h.deps);
      h.ctx.on(
        "user-questions/request",
        (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => {
          const sessionId = (request.agent as unknown as FakeAgent | undefined)?.id;
          if (!sessionId || !h.store.bindingFor(sessionId)) return next();
          return h.questions.ask(sessionId, request);
        },
        { global: true, prepend: true },
      );
      h.ctx.on(
        "system-prompt/assemble",
        async (_assembly: unknown, _context: unknown, next: () => Promise<never>) =>
          patchProduceAssembly(await next()),
        { global: true, prepend: true },
      );

      // A stale store binding is enough to claim ownership under the old code.
      h.store.openProject({
        dshSessionId: h.creator.id,
        title: "stale",
        design: { kind: "self-directed" },
        provider: { providerId: "pi-xai", modelId: "grok-4.6" },
      });

      const bash = await h.execute(h.creator, "bash");
      assert.equal(bash.isError, true);
      assert.match(String(bash.error?.message ?? ""), /slides preset forbids bash/);

      const leaked = h.askQuestion(h.creator);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(nativeAnsweredAt(h, h.creator.id), 0);
      assert.equal(h.questions.list(h.creator.id).some((row) => row.status === "pending"), true);
      leaked.catch(() => undefined);

      const assembly = await h.assemble(h.creator);
      assert.equal(assembly.tools.some((tool) => tool.name === "web_search"), false);
    } finally {
      await h.dispose();
    }
  });
});

describe("slides agent plane — scoped wiring owns only slides agents", () => {
  it("leaves a Creator agent's tools, questions and assembly alone even with a stale binding", async () => {
    const h = await harness();
    try {
      wireSlidesAgentPlane(h.generation.ctx, h.deps);
      h.store.openProject({
        dshSessionId: h.creator.id,
        title: "stale",
        design: { kind: "self-directed" },
        provider: { providerId: "pi-xai", modelId: "grok-4.6" },
      });

      const bash = await h.execute(h.creator, "bash");
      assert.equal(bash.isError, false);

      const unknown = await h.execute(h.creator, "open_project");
      assert.equal(unknown.isError, true);

      const question = await h.askQuestion(h.creator);
      assert.equal(question, NATIVE_ANSWER);
      assert.equal(nativeAnsweredAt(h, h.creator.id), 1);
      assert.equal(h.questions.list(h.creator.id).length, 0);

      const schemas = h.ctx.tools.schemas(h.creator as never).map((def) => def.name);
      assert.equal(schemas.includes("open_project"), false);
      assert.equal(schemas.includes("write_page"), false);
      assert.equal(schemas.includes("bash"), true);

      const assembly = await h.assemble(h.creator);
      assert.equal(assembly.tools.some((tool) => tool.name === "web_search"), true);
      assert.equal(
        assembly.sections.every((section) => section.name !== "slides:conversation-interaction"),
        true,
      );
    } finally {
      await h.dispose();
    }
  });

  it("gives slides agents the product tools, guard and question interception", async () => {
    const h = await harness();
    try {
      wireSlidesAgentPlane(h.generation.ctx, h.deps);

      const denied = await h.execute(h.slidesA, "bash");
      assert.equal(denied.isError, true);
      assert.match(String(denied.error?.message ?? ""), /slides preset forbids bash/);

      const opened = await h.execute(h.slidesA, "open_project", { title: "Deck A" });
      assert.equal(opened.isError, false);
      assert.ok(h.store.bindingFor(h.slidesA.id));

      const schemas = h.ctx.tools.schemas(h.slidesA as never).map((def) => def.name);
      assert.equal(schemas.includes("open_project"), true);
      assert.equal(schemas.includes("write_page"), true);
      // Function web_search is never own-layer registered — hosted tools own it.
      assert.equal(schemas.includes("web_search"), false);

      const ask = h.askQuestion(h.slidesA);
      const rows = h.questions.list(h.slidesA.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "pending");
      assert.equal(nativeAnsweredAt(h, h.slidesA.id), 0);
      h.questions.settle(h.slidesA.id, rows[0]!.id, { action: "answer", answer: ANSWER_A });
      assert.deepEqual(await ask, ANSWER_A);

      const assembly = await h.assemble(h.slidesA);
      assert.equal(assembly.tools.some((tool) => tool.name === "web_search"), false);
    } finally {
      await h.dispose();
    }
  });

  it("keeps concurrent slides agents' question routing separate", async () => {
    const h = await harness();
    try {
      wireSlidesAgentPlane(h.generation.ctx, h.deps);
      const openedA = await h.execute(h.slidesA, "open_project", { title: "Deck A" });
      const openedB = await h.execute(h.slidesB, "open_project", { title: "Deck B" });
      assert.equal(openedA.isError, false, JSON.stringify(openedA));
      assert.equal(openedB.isError, false, JSON.stringify(openedB));

      const askA = h.askQuestion(h.slidesA);
      const askB = h.askQuestion(h.slidesB);
      const rowsA = h.questions.list(h.slidesA.id);
      const rowsB = h.questions.list(h.slidesB.id);
      assert.equal(rowsA.length, 1);
      assert.equal(rowsB.length, 1);
      assert.notEqual(rowsA[0]?.id, rowsB[0]?.id);
      assert.equal(nativeAnsweredAt(h, h.slidesA.id), 0);
      assert.equal(nativeAnsweredAt(h, h.slidesB.id), 0);
      h.questions.settle(h.slidesA.id, rowsA[0]!.id, { action: "answer", answer: ANSWER_A });
      assert.deepEqual(await askA, ANSWER_A);
      assert.equal(h.questions.list(h.slidesB.id)[0]?.status, "pending");
      const answerB: AskUserQuestionAnswer = { answers: [{ id: "q1", selected: ["b"] }] } as never;
      h.questions.settle(h.slidesB.id, rowsB[0]!.id, { action: "answer", answer: answerB });
      assert.deepEqual(await askB, answerB);
    } finally {
      await h.dispose();
    }
  });

  it("a cancelled question releases the pending invocation instead of hanging", async () => {
    const h = await harness();
    try {
      wireSlidesAgentPlane(h.generation.ctx, h.deps);
      await h.execute(h.slidesA, "open_project", { title: "Deck A" });
      const controller = new AbortController();
      const ask = h.askQuestion(h.slidesA, controller.signal);
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await assert.rejects(ask, (error: unknown) => {
        assert.match(String(error instanceof Error ? error.message : error), /abort/i);
        return true;
      });
      assert.equal(h.questions.list(h.slidesA.id).every((row) => row.status !== "pending"), true);
    } finally {
      await h.dispose();
    }
  });

  it("rewiring a generation replaces the old plane exactly once — the hot-reload path", async () => {
    const h = await harness();
    try {
      wireSlidesAgentPlane(h.generation.ctx, h.deps);
      await h.execute(h.slidesA, "open_project", { title: "Deck A" });

      const questions2 = new AssistantQuestions((sessionId) => {
        const binding = h.store.bindingFor(sessionId);
        return binding ? h.store.resolveRoot(binding) : undefined;
      });
      const deps2: SlidesAgentPlaneDeps = { ...h.deps, questions: questions2 };
      wireSlidesAgentPlane(h.generation.ctx, deps2);
      wireSlidesAgentPlane(h.generation.ctx, deps2);

      const ask = h.askQuestion(h.slidesA);
      assert.equal(questions2.list(h.slidesA.id).length, 1);
      questions2.settle(h.slidesA.id, questions2.list(h.slidesA.id)[0]!.id, {
        action: "answer",
        answer: ANSWER_A,
      });
      assert.deepEqual(await ask, ANSWER_A);

      const schemas = h.ctx.tools.schemas(h.slidesA as never).map((def) => def.name);
      assert.equal(schemas.filter((name) => name === "open_project").length, 1);
    } finally {
      await h.dispose();
    }
  });

  it("disposing the generation releases tools, guard and routes for every bound agent", async () => {
    const h = await harness();
    try {
      wireSlidesAgentPlane(h.generation.ctx, h.deps);
      await h.execute(h.slidesA, "open_project", { title: "Deck A" });
      await h.generation.dispose();

      const unknown = await h.execute(h.slidesA, "open_project", { title: "again" });
      assert.equal(unknown.isError, true);

      const bash = await h.execute(h.slidesA, "bash");
      assert.equal(bash.isError, false);

      const question = await h.askQuestion(h.slidesA);
      assert.equal(question, NATIVE_ANSWER);
      assert.equal(nativeAnsweredAt(h, h.slidesA.id), 1);
    } finally {
      await h.dispose();
    }
  });

  it("wires only the slides agent's own scope — a sibling on the same generation stays plain", async () => {
    const h = await harness();
    try {
      // Preset membership comes through the registry service (`composedPreset`),
      // never the registry's module state — a Host bundling a second registry
      // copy reports an empty mount set to outside importers.
      const presets: AgentPresetProbe = {
        composedPreset: (ctx) => (ctx === h.scopeA.ctx ? "slides" : "standard"),
      };
      assert.equal(
        wireSlidesAgentPlaneForAgent({ ctx: h.scopeA.ctx }, h.deps, presets),
        true,
      );
      assert.equal(
        wireSlidesAgentPlaneForAgent({ ctx: h.scopeB.ctx }, h.deps, presets),
        false,
      );
      assert.equal(
        wireSlidesAgentPlaneForAgent({ ctx: h.creatorScope.ctx }, h.deps, presets),
        false,
      );

      const schemasA = h.ctx.tools.schemas(h.slidesA as never).map((def) => def.name);
      assert.ok(schemasA.includes("open_project"));
      const schemasB = h.ctx.tools.schemas(h.slidesB as never).map((def) => def.name);
      assert.ok(!schemasB.includes("open_project"));
      const schemasC = h.ctx.tools.schemas(h.creator as never).map((def) => def.name);
      assert.ok(!schemasC.includes("open_project"));
    } finally {
      await h.dispose();
    }
  });

  it("recompose moves the plane with the preset — switching away disposes it", async () => {
    const h = await harness();
    const standing = { current: "slides" };
    const presets: AgentPresetProbe = { composedPreset: () => standing.current };
    try {
      assert.equal(
        reconcileSlidesAgentPlane({ ctx: h.scopeA.ctx }, h.deps, presets),
        true,
      );
      const opened = await h.execute(h.slidesA, "open_project", { title: "Deck A" });
      assert.equal(opened.isError, false);

      standing.current = "standard";
      assert.equal(
        reconcileSlidesAgentPlane({ ctx: h.scopeA.ctx }, h.deps, presets),
        false,
      );
      const unknown = await h.execute(h.slidesA, "open_project", { title: "again" });
      assert.equal(unknown.isError, true);
      const bash = await h.execute(h.slidesA, "bash");
      assert.equal(bash.isError, false);

      const question = await h.askQuestion(h.slidesA);
      assert.equal(question, NATIVE_ANSWER);
      assert.equal(nativeAnsweredAt(h, h.slidesA.id), 1);
    } finally {
      await h.dispose();
    }
  });
});

describe("Slides Work-entry guard", () => {
  it("rejects Work RPC prompts before the model; editor prompts and ordinary agents still run", async () => {
    const h = await harness();
    try {
      h.store.openProject({ dshSessionId: h.slidesA.id, title: "guard", design: { kind: "self-directed" }, provider: { providerId: "pi-xai", modelId: "grok-4.6" } });
      wireSlidesAgentPlane(h.scopeA.ctx, h.deps);
      let modelSteps = 0;
      const step = (agent: FakeAgent, fromWork: boolean, includeOldWorkInput = false) => {
        // The API Session Controller adds this receipt to ordinary Work input.
        const message = createUserMessage({ content: [{ type: "text", text: "edit the deck" }], source: { kind: "user", ...(fromWork ? { rpcId: "work-request" } : {}) } });
        const messages = includeOldWorkInput
          ? [createUserMessage({ content: [{ type: "text", text: "old Work input" }], source: { kind: "user", rpcId: "old-request" } }), message]
          : [message];
        return h.ctx.waterfall(scopeTarget(h.ctx, agent as never) as never,
          "agent/pre-step", { agent, messages, turn: 1, step: 1, signal: new AbortController().signal } as never,
          async () => { modelSteps++; return { kind: "enter" as const, messages: [message] }; });
      };
      await assert.rejects(step(h.slidesA, true), /请在演示文稿中继续/);
      assert.equal(modelSteps, 0);
      await step(h.slidesA, false);
      await step(h.slidesA, false, true);
      await step(h.creator, true);
      assert.equal(modelSteps, 3);
    } finally { await h.dispose(); }
  });
});
