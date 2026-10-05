import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type { PresentationRun } from "@open-slidestudio/presentation-run";
import { createPresentationRun, persistPresentationRunProvider, savePageRaster, toolSchemaHasQueriesArray, initializeRunLedger, readRunLedger, recordTodo } from "@open-slidestudio/presentation-run";
import { decideWritePage } from "./write-page.js";
import { inject, runModelSwitchTransaction } from "./plugin.js";
import { SLICE_TOOL_NAMES } from "./protocol.js";
import { registerSliceTools, withProductToolArgumentContract } from "./tools.js";
import { SliceSessionStore } from "./slice-session.js";
import { AgentFaults } from "./agent-fault.js";
import { writeSliceRuntime } from "./runtime.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function stubPlaywrightRuntime(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-produce-"));
  const file = path.join(dir, "runtime.mjs");
  fs.writeFileSync(
    file,
    `export function verifyPinnedRuntime() { return true; }
export async function launchPinnedChromium() { throw new Error("stub"); }
`,
  );
  return file;
}

function fakeTools(): { defs: ToolDefinition[]; runtime: ToolRuntime } {
  const defs: ToolDefinition[] = [];
  return {
    defs,
    runtime: {
      register(def: ToolDefinition) {
        defs.push(def);
        return () => undefined;
      },
      guard() {
        return () => undefined;
      },
    } as unknown as ToolRuntime,
  };
}

function stubPresentation(): PresentationRun {
  return {
    execute: async (command) => ({
      ok: true,
      name: command.name,
      summary: `${command.name} ok`,
      detail: `${command.name} ok`,
      payload: { pageId: "1_cover", visualReview: "pass" },
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

describe("planning preflight ordering", () => {
  it("keeps the freely adopted teaching pack through the Host tool and later outline updates", async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "host-freestyle-plan-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const store = new SliceSessionStore(workspace);
    const sessionId = "host-freestyle-plan";
    const brief = "Windows 批处理教学课件，15 分钟，包含概念、例子和课堂练习。";
    const design = { kind: "self-directed" } as const;
    const provider = { providerId: "test", modelId: "test" };
    const opened = store.openProject({ dshSessionId: sessionId, title: brief, design, provider });
    const projectRoot = store.resolveRoot(opened.binding);
    const editorBaseUrl = "http://127.0.0.1:1";
    writeSliceRuntime(projectRoot, { brief, design, editorBaseUrl, strictExecution: true });
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const presentation = createPresentationRun({ repoRoot });
    await presentation.open({ projectRoot, sessionId, brief, design, provider, editorBaseUrl });
    const { defs, runtime } = fakeTools();
    registerSliceTools(runtime, { store, presentation, workspaceRoot: repoRoot, editorBaseUrl, faults: new AgentFaults(), provider });
    let sequence = 0;
    const execute = async (name: string, args: Record<string, unknown>) => {
      const tool = defs.find((def) => def.name === name)!;
      return asJsonValue(await tool.execute(args as never, {
        agent: { id: sessionId }, callId: `freestyle-${++sequence}`, signal: new AbortController().signal,
      } as unknown as ToolRunContext)) as Record<string, unknown>;
    };
    const plan = [{ pageId: "cover", title: "认识批处理", layoutFamily: "cover", exhibits: [] }];
    const args = { slidePlan: plan, adoptedSourceIds: ["openkimi:reference/design_system/academic/blue-line-courseware/design.md"] };
    let committed = await execute("commit_design", args);
    assert.equal(committed.error, "required_source_chunks_unread");
    for (let attempt = 0; attempt < 3 && committed.outcome !== "committed"; attempt++) {
      const missing = committed.missingReferenceChunks as Array<{ sourceId: string; chunkIndex: number }>;
      assert.ok(missing?.length, JSON.stringify(committed));
      for (const chunk of missing) await execute("read_reference", chunk);
      committed = await execute("commit_design", args);
    }
    assert.equal(committed.outcome, "committed", JSON.stringify(committed));
    const updated = await execute("write_todo", { items: [...plan, { pageId: "practice", title: "课堂练习", layoutFamily: "content", exhibits: [] }] });
    assert.equal(updated.outcome, "committed", JSON.stringify(updated));
    assert.deepEqual(updated.plannedPageIds, ["cover", "practice"]);
  });

  it("runs the real Host planning tool through PresentationRun before recording todo", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "planning-preflight-order-"));
    const store = new SliceSessionStore(workspace);
    const sessionId = "planning-preflight-order";
    const opened = store.openProject({
      dshSessionId: sessionId,
      title: "Planning preflight",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "test" },
    });
    const projectRoot = store.resolveRoot(opened.binding);
    writeSliceRuntime(projectRoot, {
      brief: "介绍一个普通产品",
      design: { kind: "self-directed" },
      editorBaseUrl: "http://127.0.0.1:55200",
      strictExecution: true,
    });
    initializeRunLedger(projectRoot);
    const { defs, runtime } = fakeTools();
    registerSliceTools(runtime, {
      store,
      presentation: {
        ...stubPresentation(),
        execute: async (command) => ({
          ok: false,
          name: command.name,
          summary: "required references unread",
          detail: "read openkimi:SKILL.md#0 before planning",
          payload: {
            error: "required_source_chunks_unread",
            next: "read_reference",
            missingReferenceChunks: [{ sourceId: "openkimi:SKILL.md", chunkIndex: 0 }],
          },
        }),
      },
      workspaceRoot: workspace,
      editorBaseUrl: "http://127.0.0.1:55200",
      faults: new AgentFaults(),
      provider: { providerId: "test", modelId: "test" },
    });
    const exec = {
      agent: { id: sessionId },
      callId: "planning-preflight-order-1",
      signal: new AbortController().signal,
    } as unknown as ToolRunContext;
    const commit = defs.find((definition) => definition.name === "commit_design");
    assert.ok(commit);
    const value = asJsonValue(await commit.execute({
      slidePlan: [{ pageId: "p1", title: "封面", layoutFamily: "cover", exhibits: [] }],
    }, exec)) as Record<string, unknown>;
    assert.equal(value.outcome, "rejected");
    assert.equal(value.error, "required_source_chunks_unread");
    assert.deepEqual(
      readRunLedger(projectRoot)?.facts.filter((fact) => fact.type === "todo.committed"),
      [],
      "a rejected preflight must not mutate the plan ledger",
    );
  });
});

describe("product tool arguments contract", () => {
  it("denies capability-hidden tools before their presentation executor runs", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-capability-guard-"));
    const store = new SliceSessionStore(workspace);
    const sessionId = "capability-guard-session";
    const opened = store.openProject({
      dshSessionId: sessionId,
      title: "Capability guard",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const projectRoot = store.resolveRoot(opened.binding);
    writeSliceRuntime(projectRoot, {
      brief: "Capability guard fixture",
      design: { kind: "self-directed" },
      editorBaseUrl: "http://127.0.0.1:55200",
      strictExecution: true,
    });
    initializeRunLedger(projectRoot);
    fs.writeFileSync(
      path.join(projectRoot, "_agent", "presentation-run.v1.json"),
      `${JSON.stringify({
        provider: {
          providerId: "minimax-cn",
          modelId: "MiniMax-M3",
          ready: true,
          modelInputModalities: ["text"],
        },
      })}\n`,
    );
    const called: string[] = [];
    const previousImage = process.env.SLIDESTUDIO_IMAGE;
    const previousImageSearch = process.env.SLIDESTUDIO_IMAGE_SEARCH_URL;
    const previousLlmImage = process.env.SLIDESTUDIO_LLM_IMAGE;
    process.env.SLIDESTUDIO_IMAGE = "0";
    process.env.SLIDESTUDIO_LLM_IMAGE = "0";
    delete process.env.SLIDESTUDIO_IMAGE_SEARCH_URL;
    const ctx = new Context();
    const promptFiber = await ctx.plugin(SystemPrompt, {});
    const toolsFiber = await ctx.plugin(ToolRuntime, {});
    try {
      registerSliceTools(ctx.tools, {
        store,
        presentation: {
          ...stubPresentation(),
          execute: async (command) => {
            called.push(command.name);
            return {
              ok: true,
              name: command.name,
              summary: "unexpected",
              detail: "unexpected",
              payload: {},
            };
          },
        },
        workspaceRoot: workspace,
        editorBaseUrl: "http://127.0.0.1:55200",
        faults: new AgentFaults(),
        provider: {
          providerId: "minimax-cn",
          modelId: "MiniMax-M3",
          ready: true,
          modelInputModalities: ["text"],
        },
      });
      const calls = [
        {
          name: "review_page",
          arguments: {
            pageId: "1_cover",
            revision: 1,
            deliveryToken: "delivery",
            verdict: "revise",
            issues: ["contrast"],
          },
        },

        { name: "search_image", arguments: { id: "hero", query: "skyline" } },
        { name: "generate_image", arguments: { id: "hero", prompt: "skyline" } },
      ] as const;
      for (const [index, call] of calls.entries()) {
        const result = await ctx.tools.execute({
          callId: ToolCallId(`capability-guard-${index}`),
          name: call.name,
          arguments: call.arguments,
          agent: { id: sessionId } as never,
          signal: new AbortController().signal,
        });
        assert.equal(result.isError, true, call.name);
        if (result.isError) assert.match(result.error.message, /slides preset forbids/, call.name);
      }
      assert.deepEqual(called, []);
    } finally {
      await toolsFiber.dispose();
      await promptFiber.dispose();
      if (previousImage === undefined) delete process.env.SLIDESTUDIO_IMAGE;
      else process.env.SLIDESTUDIO_IMAGE = previousImage;
      if (previousImageSearch === undefined) delete process.env.SLIDESTUDIO_IMAGE_SEARCH_URL;
      else process.env.SLIDESTUDIO_IMAGE_SEARCH_URL = previousImageSearch;
      if (previousLlmImage === undefined) delete process.env.SLIDESTUDIO_LLM_IMAGE;
      else process.env.SLIDESTUDIO_LLM_IMAGE = previousLlmImage;
    }
  });

  it("rejects a wire envelope through registerSliceTools before project history changes", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-envelope-"));
    const store = new SliceSessionStore(workspace);
    const ctx = new Context();
    const promptFiber = await ctx.plugin(SystemPrompt, {});
    const toolsFiber = await ctx.plugin(ToolRuntime, {});
    try {
      registerSliceTools(ctx.tools, {
        store,
        presentation: stubPresentation(),
        workspaceRoot: workspace,
        editorBaseUrl: "http://127.0.0.1:55200",
        faults: new AgentFaults(),
        provider: { providerId: "pi-xai", modelId: "grok-4.6" },
      });
      const rawArgs = { title: "Sibling deck", arguments: { title: "Envelope deck" } };
      const before = JSON.parse(JSON.stringify(rawArgs));
      const result = await ctx.tools.execute({
        callId: ToolCallId("slice-envelope-1"),
        name: "open_project",
        arguments: rawArgs,
        agent: { id: "slice-envelope-session" } as never,
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, true);
      if (result.isError) {
        assert.equal(result.error?.info?.code, "INVALID_ARGS");
        assert.match(JSON.stringify(result.error), /title/);
      }
      assert.deepEqual(rawArgs, before, "caller arguments must not be normalized in place");
      assert.equal(store.bindingFor("slice-envelope-session"), undefined, "no project binding/history");
    } finally {
      await toolsFiber.dispose();
      await promptFiber.dispose();
    }
  });

  it("schedules write_page as parallel so a stub batch is one INVALID_ARGS streak", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-write-mode-"));
    const store = new SliceSessionStore(workspace);
    const ctx = new Context();
    const promptFiber = await ctx.plugin(SystemPrompt, {});
    const toolsFiber = await ctx.plugin(ToolRuntime, {});
    try {
      registerSliceTools(ctx.tools, {
        store,
        presentation: stubPresentation(),
        workspaceRoot: workspace,
        editorBaseUrl: "http://127.0.0.1:55200",
        faults: new AgentFaults(),
        provider: { providerId: "pi-xai", modelId: "grok-4.6" },
      });
      const mode = ctx.tools.executionMode({
        callId: ToolCallId("slice-write-mode-1"),
        name: "write_page",
        arguments: { id: "cover" },
        agent: { id: "slice-write-mode" } as never,
        signal: new AbortController().signal,
      });
      assert.equal(mode.kind, "parallel");
    } finally {
      await toolsFiber.dispose();
      await promptFiber.dispose();
    }
  });

  it("unwraps an unambiguous arguments envelope and rejects ambiguous ones", async () => {
    const ctx = new Context();
    const promptFiber = await ctx.plugin(SystemPrompt, {});
    const toolsFiber = await ctx.plugin(ToolRuntime, {});
    try {
      const executeSpy: unknown[] = [];
      let executeCount = 0;
      let receivedArgs: unknown;
      let receivedExec: unknown;
      const original = defineTool({
        name: "argument_probe",
        description: "Strict argument probe.",
        parameters: {
          id: { type: "string", required: true },
          payload: { type: "object", additionalProperties: true },
        },
        output: { schema: { type: "json" }, render: () => [] },
        async execute(args, exec) {
          executeCount += 1;
          receivedArgs = args;
          receivedExec = exec;
          executeSpy.push(args);
          return asJsonValue(args);
        },
      });
      const contracted = withProductToolArgumentContract(original);
      assert.equal(contracted.parameters, original.parameters, "model-facing schema must stay unchanged");
      ctx.tools.register(contracted);

      const unwrapped = await ctx.tools.execute({
        callId: ToolCallId("single"),
        name: "argument_probe",
        arguments: { arguments: { id: "single" } },
        signal: new AbortController().signal,
      });
      assert.equal(unwrapped.isError, false, "sole unambiguous envelope unwraps");
      if (!unwrapped.isError) assert.deepEqual(unwrapped.value, { id: "single" });
      assert.equal(executeCount, 1, "unwrapped envelope reached execute");
      assert.deepEqual(receivedArgs, { id: "single" });

      for (const [callId, args, expected] of [
        ["double", { arguments: { arguments: { id: "double" } } }, { id: "double" }],
        ["triple", { arguments: { arguments: { arguments: { id: "triple" } } } }, { id: "triple" }],
      ] as const) {
        const nested = await ctx.tools.execute({
          callId: ToolCallId(callId),
          name: "argument_probe",
          arguments: args,
          signal: new AbortController().signal,
        });
        assert.equal(nested.isError, false, `${callId}: chain of sole envelopes unwraps`);
        if (!nested.isError) assert.deepEqual(nested.value, expected, callId);
      }
      assert.equal(executeCount, 3, "each unambiguous chain reached execute once");

      for (const [callId, args] of [
        ["siblings", { id: "sibling", arguments: { id: "nested" } }],
        ["eight", { arguments: { arguments: { arguments: { arguments: { arguments: { arguments: { arguments: { arguments: { id: "eight" } } } } } } } } }],
      ] as const) {
        const snapshot = JSON.parse(JSON.stringify(args));
        const result = await ctx.tools.execute({
          callId: ToolCallId(callId),
          name: "argument_probe",
          arguments: args,
          signal: new AbortController().signal,
        });
        assert.equal(result.isError, true, callId);
        if (result.isError) {
          assert.equal(result.error?.info?.code, "INVALID_ARGS", callId);
          assert.match(JSON.stringify(result.error), /pass the declared fields directly at the top level: id/, callId);
        }
        assert.deepEqual(args, snapshot, `${callId}: caller arguments`);
        assert.equal(executeCount, 3, `${callId}: rejected envelope must not reach execute`);
      }

      const flat = { id: "flat" };
      const exec = {
        callId: ToolCallId("flat"),
        name: "argument_probe",
        arguments: flat,
        signal: new AbortController().signal,
      };
      const valid = await ctx.tools.execute(exec);
      assert.equal(valid.isError, false);
      if (!valid.isError) assert.deepEqual(valid.value, flat);
      assert.deepEqual(receivedArgs, flat);
      assert.deepEqual(executeSpy, [{ id: "single" }, { id: "double" }, { id: "triple" }, flat]);

      const directFlat = { id: "direct-flat" };
      const directExec = {
        callId: ToolCallId("direct-flat"),
        signal: new AbortController().signal,
      } as ToolRunContext;
      const direct = await contracted.execute(directFlat, directExec);
      assert.deepEqual(direct, directFlat);
      assert.equal(receivedArgs, directFlat, "contract passes legal rawArgs to defineTool unchanged");
      assert.equal(receivedExec, directExec, "contract passes exec to defineTool unchanged");
      assert.deepEqual(executeSpy, [{ id: "single" }, { id: "double" }, { id: "triple" }, flat, directFlat]);

      const nestedBusinessArguments = {
        id: "nested-business",
        payload: { arguments: { legend: "right", encode: { x: "month" } } },
      };
      const nested = await contracted.execute(nestedBusinessArguments, directExec);
      assert.deepEqual(nested, nestedBusinessArguments);
      assert.equal(receivedArgs, nestedBusinessArguments);
      assert.deepEqual(executeSpy, [{ id: "single" }, { id: "double" }, { id: "triple" }, flat, directFlat, nestedBusinessArguments]);
    } finally {
      await toolsFiber.dispose();
      await promptFiber.dispose();
    }
  });

  it("keeps a genuinely declared arguments field under the original schema", async () => {
    const ctx = new Context();
    const promptFiber = await ctx.plugin(SystemPrompt, {});
    const toolsFiber = await ctx.plugin(ToolRuntime, {});
    try {
      const declared = defineTool({
        name: "declared_arguments_probe",
        description: "A tool that genuinely owns an arguments property.",
        parameters: {
          arguments: {
            type: "object",
            additionalProperties: true,
            required: true,
          },
        },
        output: {
          schema: { type: "json" },
          render: () => [],
        },
        async execute(args) {
          return asJsonValue(args);
        },
      });
      const declaredContract = withProductToolArgumentContract(declared);
      assert.equal(declaredContract, declared, "a declared arguments field must not be wrapped");
      ctx.tools.register(declaredContract);
      const result = await ctx.tools.execute({
        callId: ToolCallId("declared"),
        name: "declared_arguments_probe",
        arguments: { arguments: { id: "business-field" } },
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, false);
      if (!result.isError) assert.deepEqual(result.value, { arguments: { id: "business-field" } });
    } finally {
      await toolsFiber.dispose();
      await promptFiber.dispose();
    }
  });
});

describe("model switch transaction", () => {
  it("restores the previous route when activation fails", async () => {
    let route = "amd/DeepSeek-V4-Flash";
    const events: string[] = [];

    await assert.rejects(
      runModelSwitchTransaction({
        apply: () => {
          route = "amd/DeepSeek-Vision-Exp";
          events.push("apply");
        },
        activate: async () => {
          events.push("activate");
          throw new Error("cannot prepare session while it is live");
        },
        rollback: () => {
          route = "amd/DeepSeek-V4-Flash";
          events.push("rollback");
        },
      }),
      /cannot prepare session while it is live/,
    );

    assert.equal(route, "amd/DeepSeek-V4-Flash");
    assert.deepEqual(events, ["apply", "activate", "rollback"]);
  });
});

describe("produce agent web_search listing", () => {
  it("registers a first-class tool named web_search like search_image", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "produce-list-"));
    const { defs, runtime } = fakeTools();
    registerSliceTools(runtime, {
      store: new SliceSessionStore(workspace),
      presentation: stubPresentation(),
      workspaceRoot: workspace,
      editorBaseUrl: "http://127.0.0.1:55200",
      faults: new AgentFaults(),
      provider: { providerId: "pi-xai", modelId: "grok-4.6" },
    });
    const names = defs.map((def) => def.name);
    assert.equal(names.includes("web_search"), true);
    assert.equal(names.includes("search_image"), true);
    assert.equal(names.includes("generate_image"), true);
    assert.ok(SLICE_TOOL_NAMES.includes("web_search"));
    const web = defs.find((def) => def.name === "web_search");
    assert.ok(web);
    assert.match(web.description, /queries array/i);
    assert.equal(toolSchemaHasQueriesArray(web.parameters), true, JSON.stringify(web.parameters));
  });

  it("lists web_search on the produce agent even before Grok hosted caps bind", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "produce-list-mini-"));
    const { defs, runtime } = fakeTools();
    registerSliceTools(runtime, {
      store: new SliceSessionStore(workspace),
      presentation: stubPresentation(),
      workspaceRoot: workspace,
      editorBaseUrl: "http://127.0.0.1:55200",
      faults: new AgentFaults(),
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const names = defs.map((def) => def.name);
    assert.equal(names.includes("web_search"), true);
    assert.equal(names.includes("search_image"), true);
    assert.ok(SLICE_TOOL_NAMES.includes("web_search"));
  });

  it("execute of web_search is a real tool/call name, not assistant prose", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "produce-call-"));
    const { defs, runtime } = fakeTools();
    const called: string[] = [];
    const store = new SliceSessionStore(workspace);
    const sessionId = "web-search-call";
    store.openProject({
      dshSessionId: sessionId,
      title: "Search",
      design: { kind: "self-directed" },
      provider: { providerId: "pi-xai", modelId: "grok-4.6" },
    });
    registerSliceTools(runtime, {
      store,
      presentation: {
        ...stubPresentation(),
        execute: async (command) => {
          called.push(command.name);
          return {
            ok: true,
            name: command.name,
            summary: "facts",
            detail: "facts",
            payload: { source: "pi-xai-hosted", facts: ["ok"], query: "q" },
          };
        },
      },
      workspaceRoot: workspace,
      editorBaseUrl: "http://127.0.0.1:55200",
      faults: new AgentFaults(),
      provider: { providerId: "pi-xai", modelId: "grok-4.6" },
    });
    const web = defs.find((def) => def.name === "web_search");
    assert.ok(web);
    await web.execute(
      { queries: ["Starship latest flight 2026"] },
      {
        agent: { id: sessionId },
        callId: "web-1",
        signal: new AbortController().signal,
      } as unknown as ToolRunContext,
    );
    assert.deepEqual(called, ["web_search"]);
  });

  it("declares Cordis attachments inject so review_page can save the raster", () => {
    assert.equal(inject.includes("attachments"), true);
    assert.equal(inject.includes("tools"), true);
  });
});

describe("write_page plan membership surfacing", () => {
  it("surfaces a domain not_in_plan rejection as outcome rejected", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "write-page-plan-"));
    const store = new SliceSessionStore(workspace);
    const sessionId = "plan-membership-1";
    const opened = store.openProject({
      dshSessionId: sessionId,
      title: "Plan membership",
      design: { kind: "self-directed" },
      provider: { providerId: "pi-xai", modelId: "grok-4.6" },
    });
    const projectRoot = store.resolveRoot(opened.binding);
    writeSliceRuntime(projectRoot, {
      brief: "a closer test deck",
      design: { kind: "self-directed" },
      editorBaseUrl: "http://127.0.0.1:55200",
      strictExecution: true,
    });
    initializeRunLedger(projectRoot);
    recordTodo(projectRoot, { commandId: "plan-1", contextEpochId: "epoch" }, [
      { pageId: "a", title: "A", layoutFamily: "content", exhibits: [] },
      { pageId: "b", title: "B", layoutFamily: "content", exhibits: [] },
    ]);
    const { defs, runtime } = fakeTools();
    registerSliceTools(runtime, {
      store,
      presentation: {
        ...stubPresentation(),
        execute: async (command) => {
          if (command.name === "write_page") {
            return {
              ok: false,
              name: command.name,
              summary: "not in plan",
              detail:
                "page c is not in the current plan — call write_todo first to add it (title/exhibits), then write_page",
              payload: { error: "not_in_plan", painted: false },
            };
          }
          return {
            ok: true,
            name: command.name,
            summary: `${command.name} ok`,
            detail: `${command.name} ok`,
            payload: {},
          };
        },
      },
      workspaceRoot: workspace,
      editorBaseUrl: "http://127.0.0.1:55200",
      faults: new AgentFaults(),
      provider: { providerId: "pi-xai", modelId: "grok-4.6" },
    });
    const write = defs.find((def) => def.name === "write_page");
    assert.ok(write);
    const value = await write.execute(
      {
        id: "c",
        pageType: "cover",
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 200, 800, 80],
            content: { text: "光合作用", fontSize: 36 },
          },
        ],
      },
      {
        agent: { id: sessionId },
        callId: "wp-plan-1",
        signal: new AbortController().signal,
      } as unknown as ToolRunContext,
    );
    const rec = asJsonValue(value) as Record<string, unknown>;
    assert.equal(rec.outcome, "rejected");
    assert.equal(rec.error, "not_in_plan");
    assert.match(String(rec.detail ?? ""), /not in the current plan/);
  });

  it("decideWritePage stays lazy: no todo source, no plan membership verdict", () => {
    const decision = decideWritePage(
      {
        id: "c",
        pageType: "cover",
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 200, 800, 80],
            content: { text: "光合作用", fontSize: 36 },
          },
        ],
      },
      undefined,
    );
    assert.equal(decision.action, "write");
  });
});

describe("review_page image-part inject", () => {
  it("saves the on-disk PNG and renders an image part for grok-4.6", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "review-inject-"));
    const runtimeFile = stubPlaywrightRuntime();
    const prevEditor = process.env.SLIDESTUDIO_EDITOR_URL;
    const prevPw = process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
    process.env.SLIDESTUDIO_EDITOR_URL = "http://127.0.0.1:55200";
    process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = runtimeFile;
    const saved: Array<{ bytes: number; name?: string }> = [];
    try {
      const store = new SliceSessionStore(workspace);
      const sessionId = "4ffffa83-b32e-42de-b12a-891caa23b608";
      const opened = store.openProject({
        dshSessionId: sessionId,
        title: "Vision inject",
        design: { kind: "self-directed" },
        provider: { providerId: "pi-xai", modelId: "grok-4.6" },
      });
      const projectRoot = store.resolveRoot(opened.binding);
      writeSliceRuntime(projectRoot, {
        brief: "cover",
        design: { kind: "self-directed" },
        editorBaseUrl: "http://127.0.0.1:55200",
        strictExecution: true,
      });
      fs.mkdirSync(path.join(projectRoot, "_agent"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, "_agent", "presentation-run.v1.json"),
        `${JSON.stringify({
          sessionId,
          projectRoot,
          brief: "cover",
          design: { kind: "self-directed" },
          provider: { providerId: "pi-xai", modelId: "grok-4.6" },
        })}\n`,
      );
      persistPresentationRunProvider(projectRoot, {
        providerId: "pi-xai",
        modelId: "grok-4.6",
        ready: true,
        modelInputModalities: ["text", "image"],
      });
      savePageRaster(projectRoot, "1_cover", PNG);

      const { defs, runtime } = fakeTools();
      registerSliceTools(runtime, {
        store,
        presentation: stubPresentation(),
        workspaceRoot: workspace,
        editorBaseUrl: "http://127.0.0.1:55200",
        faults: new AgentFaults(),
        provider: {
          providerId: "pi-xai",
          modelId: "grok-4.6",
          ready: true,
          modelInputModalities: ["text", "image"],
        },
        attachments: {
          saveImage: async (input) => {
            saved.push({ bytes: input.data.byteLength, name: input.name });
            return {
              attachmentId: "sha256:review-raster",
              mediaType: "image/png",
              bytes: input.data.byteLength,
              width: 960,
              height: 540,
              name: input.name,
            };
          },
        },
      });
      const review = defs.find((def) => def.name === "review_page");
      assert.ok(review);
      const exec = {
        agent: { id: sessionId },
        callId: "review-1",
        signal: new AbortController().signal,
      } as unknown as ToolRunContext;
      const value = await review.execute(
        {
          pageId: "1_cover",
          revision: 1,
          deliveryToken: "tok",
          verdict: "pass",
          issues: ["none"],
        },
        exec,
      );
      const rec = asJsonValue(value);
      assert.ok(rec && typeof rec === "object" && rec !== null && !Array.isArray(rec));
      assert.ok("image" in rec);
      const blocks = review.output.render({}, rec);
      assert.equal(
        blocks.some((block) => block.type === "image"),
        true,
        JSON.stringify(blocks),
      );
      const image = blocks.find((block) => block.type === "image");
      assert.ok(image && image.type === "image" && "attachment" in image);
      assert.equal(image.attachment.attachmentId, "sha256:review-raster");
      assert.equal(saved.length, 1);
      assert.equal(saved[0]?.bytes, PNG.length);
    } finally {
      if (prevEditor === undefined) delete process.env.SLIDESTUDIO_EDITOR_URL;
      else process.env.SLIDESTUDIO_EDITOR_URL = prevEditor;
      if (prevPw === undefined) delete process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME;
      else process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = prevPw;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
