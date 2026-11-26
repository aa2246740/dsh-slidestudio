import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parameterSchemaSpecToJsonSchema, type ToolDefinition, type ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { PresentationRun } from "@open-slidestudio/presentation-run";
import {
  acquireProjectLease,
  compileParameterSpec,
  listCanonicalSlideTools,
  PLAN_DESIGN_PARAMETERS,
  readProjectLease,
  releaseProjectLease,
  WRITER_LEASE_FILE,
} from "@open-slidestudio/slides-tools";
import { SLIDE_PLAN_ITEMS_PARAMETER } from "@open-slidestudio/slides-tools/internal/tools-plan";
import {
  WRITE_TODO_DATA_PARAMETERS,
  writeTodoItemsParameter,
} from "@open-slidestudio/slides-tools/internal/plan-material-params";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { AgentFaults } from "./agent-fault.js";
import { apply as applySlidesHostPlugin } from "./plugin.js";
import { SLICE_TOOL_NAMES } from "./protocol.js";
import { SliceSessionStore } from "./slice-session.js";
import { registerSliceTools } from "./tools.js";

function bridged(presentation: PresentationRun, extra: Record<string, unknown> = {}) {
  const definitions: ToolDefinition[] = [];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-bridge-"));
  const store = new SliceSessionStore(workspace);
  const runtime = {
    register(definition: ToolDefinition) {
      definitions.push(definition);
      return () => undefined;
    },
    guard() {
      return () => undefined;
    },
  } as unknown as ToolRuntime;
  registerSliceTools(runtime, {
    store,
    presentation,
    workspaceRoot: workspace,
    editorBaseUrl: "http://127.0.0.1:55200",
    faults: new AgentFaults(),
    provider: { providerId: "test", modelId: "test" },
    ...extra,
  });
  return { definitions, store };
}

const unusedPresentation = {
  execute: async () => {
    throw new Error("unused");
  },
  hydrate: () => undefined,
  epochFor: () => "epoch",
} as unknown as PresentationRun;

test("the neutral parameter DSL compiles exactly like the DSH value-schema compiler", () => {
  const specs: Record<string, unknown>[] = [
    PLAN_DESIGN_PARAMETERS as unknown as Record<string, unknown>,
    { slidePlan: { ...SLIDE_PLAN_ITEMS_PARAMETER, required: true }, ...PLAN_DESIGN_PARAMETERS },
    {
      items: { ...writeTodoItemsParameter(SLIDE_PLAN_ITEMS_PARAMETER), required: true },
      ...WRITE_TODO_DATA_PARAMETERS,
    },
    { pageId: { type: "string", required: true }, theme: { type: "json" }, n: { type: "integer" } },
  ];
  for (const spec of specs) {
    assert.deepEqual(compileParameterSpec(spec), parameterSchemaSpecToJsonSchema(spec as never));
  }
});

test("DSH publishes every canonical tool except the Hub-embedded editor link, with the canonical schema", () => {
  const { definitions } = bridged(unusedPresentation);
  assert.equal(definitions.length, SLICE_TOOL_NAMES.length);
  assert.deepEqual(new Set(definitions.map((definition) => definition.name)), new Set(SLICE_TOOL_NAMES));
  const canonical = new Map(listCanonicalSlideTools().map((tool) => [tool.name, tool]));
  assert.equal(canonical.has("open_in_editor"), true);
  assert.equal(
    definitions.some((definition) => definition.name === "open_in_editor"),
    false,
  );
  for (const definition of definitions) {
    const tool = canonical.get(definition.name);
    assert.ok(tool, definition.name);
    assert.deepEqual(definition.parameters, tool.inputSchema, `${definition.name} parameters`);
    assert.equal(definition.description, tool.description, `${definition.name} description`);
  }
});

test("a Hub run write fails closed with lease-conflict while an MCP client holds the project", async () => {
  const calls: string[] = [];
  const presentation = {
    ...unusedPresentation,
    execute: async (command: { name: string }) => {
      calls.push(command.name);
      return { ok: true, name: command.name, summary: "ok", detail: "ok", payload: {} };
    },
  } as unknown as PresentationRun;
  const { definitions, store } = bridged(presentation);
  const tool = (name: string) => definitions.find((definition) => definition.name === name)!;
  const sessionId = "bridge-session";
  const exec = (callId: string) => ({ agent: { id: sessionId }, callId, signal: new AbortController().signal });
  await tool("open_project").execute({ title: "Bridge" }, exec("open") as never);
  const binding = store.bindingFor(sessionId)!;
  const projectRoot = store.resolveRoot(binding);
  assert.equal(releaseProjectLease(projectRoot, `hub-run:${sessionId}`), true);
  assert.equal(
    acquireProjectLease(projectRoot, { kind: "mcp", ownerId: "mcp:desktop", label: "Desktop client" }).ok,
    true,
  );
  calls.length = 0;

  const kernelLockPath = path.join(projectRoot, "_agent", "kernel.lock");
  fs.rmSync(kernelLockPath, { force: true });
  const reopenBefore = fs.readFileSync(path.join(projectRoot, "_agent", "dsh-runtime.json"), "utf8");
  const reopenRefused = (await tool("open_project").execute(
    { title: "Overwrite" },
    exec("reopen-1") as never,
  )) as Record<string, unknown>;
  assert.equal(reopenRefused.outcome, "lease-conflict");
  assert.equal(fs.existsSync(kernelLockPath), false, "open_project must not rewrite kernel.lock on lease-conflict");
  assert.equal(
    fs.readFileSync(path.join(projectRoot, "_agent", "dsh-runtime.json"), "utf8"),
    reopenBefore,
    "open_project must not rewrite runtime metadata when another owner holds the lease",
  );

  const refused = (await tool("compose_deck").execute({ title: "Bridge" }, exec("compose-1") as never)) as Record<
    string,
    unknown
  >;
  assert.equal(refused.outcome, "lease-conflict");
  assert.equal((refused.holder as Record<string, unknown>).kind, "mcp");
  assert.deepEqual(calls, [], "presentation-run never ran");

  const read = (await tool("read_reference").execute(
    { sourceId: "s", chunkIndex: 0 },
    exec("read-1") as never,
  )) as Record<string, unknown>;
  assert.equal(read.ok, true, "read-only tools work while another owner writes");
  assert.deepEqual(calls, ["read_reference"]);
  const lease = JSON.parse(fs.readFileSync(path.join(projectRoot, WRITER_LEASE_FILE), "utf8"));
  assert.equal(lease.holder.ownerId, "mcp:desktop");
});

test("neutral image blocks are delivered through the DSH attachments service", async () => {
  const saved: { mediaType: string; name?: string; bytes: number }[] = [];
  const presentation = {
    ...unusedPresentation,
    execute: async (command: { name: string }) => ({
      ok: true,
      name: command.name,
      summary: "ok",
      detail: "ok",
      payload:
        command.name === "view_material"
          ? { materialId: "img-1", kind: "image", imageBytesBase64: Buffer.from("jpeg-bytes").toString("base64") }
          : {},
    }),
  } as unknown as PresentationRun;
  const { definitions, store } = bridged(presentation, {
    attachments: {
      async saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
        saved.push({ mediaType: input.mediaType, name: input.name, bytes: input.data.byteLength });
        return { attachmentId: "att-1", mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 };
      },
    },
  });
  const tool = (name: string) => definitions.find((definition) => definition.name === name)!;
  const exec = (callId: string) => ({ agent: { id: "image-session" }, callId, signal: new AbortController().signal });
  await tool("open_project").execute({ title: "Images" }, exec("open") as never);
  const projectRoot = store.resolveRoot(store.bindingFor("image-session")!);
  const bindingFile = path.join(projectRoot, "_agent", "presentation-run.v1.json");
  if (!fs.existsSync(bindingFile)) fs.writeFileSync(bindingFile, JSON.stringify({ version: 1 }));
  const rec = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
  rec.provider = { providerId: "test", modelId: "test", ready: true, modelInputModalities: ["text", "image"] };
  fs.writeFileSync(bindingFile, JSON.stringify(rec));
  const value = (await tool("view_material").execute({ materialId: "img-1" }, exec("view-1") as never)) as Record<
    string,
    unknown
  >;
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(saved, [{ mediaType: "image/jpeg", name: "img-1.jpg", bytes: Buffer.byteLength("jpeg-bytes") }]);
  assert.equal((value.image as Record<string, unknown>).attachmentId, "att-1");
  const rendered = tool("view_material").output.render({}, value as never);
  assert.ok(
    rendered.some((block) => block.type !== "text"),
    "the attachment reaches the model as an image part",
  );
});

function mountPluginLifecycleHarness(
  dataRoot: string,
  opts: {
    liveAgents?: Array<{ id: string; status: string; cancel?: () => void; whenIdle?: () => Promise<void> }>;
    operatorStopTimeoutMs?: number;
    writerLeaseHeartbeatMs?: number;
  } = {},
) {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const disposers: Array<() => void> = [];
  const agentsById = new Map((opts.liveAgents ?? []).map((agent) => [agent.id, agent]));
  let slidesHandler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const ctx = {
    on(event: string, fn: (...args: unknown[]) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => undefined;
    },
    effect(fn: () => (() => void) | void) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return () => undefined;
    },
    inject() {
      return undefined;
    },
    get() {
      return undefined;
    },
    webServer: {
      register(entry: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) {
        if (entry.path === "/slides") slidesHandler = entry.handler;
        return () => undefined;
      },
    },
    agents: {
      get: (id: string) => agentsById.get(id),
      list: () => [...agentsById.values()],
    },
    tools: { register: () => () => undefined, guard: () => () => undefined },
  } as unknown as Context;
  const dshHome = path.join(dataRoot, ".dsh", "home");
  fs.mkdirSync(dshHome, { recursive: true });
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    applySlidesHostPlugin(ctx, {
      workspaceRoot: dataRoot,
      dataRoot,
      personal: true,
      ...(opts.operatorStopTimeoutMs !== undefined ? { operatorStopTimeoutMs: opts.operatorStopTimeoutMs } : {}),
      ...(opts.writerLeaseHeartbeatMs !== undefined ? { writerLeaseHeartbeatMs: opts.writerLeaseHeartbeatMs } : {}),
    });
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
  return {
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    async postStop(sessionId: string) {
      assert.ok(slidesHandler, "/slides handler registered");
      return new Promise<number>((resolve) => {
        const req = Readable.from([Buffer.alloc(0)]) as IncomingMessage;
        req.method = "POST";
        req.url = `/slides/sessions/${encodeURIComponent(sessionId)}/stop`;
        req.headers = { host: "127.0.0.1:55200" };
        let status = 0;
        const res = {
          headersSent: false,
          writeHead(code: number) {
            status = code;
            res.headersSent = true;
          },
          end() {
            resolve(status);
          },
        };
        slidesHandler!(req, res as unknown as ServerResponse);
      });
    },
    dispose() {
      for (const fn of disposers) fn();
    },
  };
}

test("plugin releases Hub writer leases on idle, dispose, operatorStop, and activation recovery", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lease-lifecycle-"));
  const store = new SliceSessionStore(dataRoot);
  const { binding } = store.openProject({
    dshSessionId: "sess-a",
    title: "Lifecycle",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const projectRoot = store.resolveRoot(binding);
  const takeHub = () =>
    assert.equal(
      acquireProjectLease(projectRoot, { kind: "hub-run", ownerId: "hub-run:sess-a", label: "Hub" }).ok,
      true,
    );
  const assertUnlockedFor = (kind: "hub-run" | "editor-human" | "mcp", ownerId: string) => {
    assert.equal(readProjectLease(projectRoot).active, false);
    assert.equal(acquireProjectLease(projectRoot, { kind, ownerId, label: ownerId }).ok, true);
    assert.equal(releaseProjectLease(projectRoot, ownerId), true);
  };

  // 1. Activation recovery clears stale Hub lease left over from before Host restart.
  takeHub();
  const h = mountPluginLifecycleHarness(dataRoot);
  try {
    assertUnlockedFor("hub-run", "hub-run:sess-b");

    // 2. agent/status -> idle releases Hub lease immediately for editor-human.
    takeHub();
    h.emit("agent/status", { agent: { id: "sess-a" }, status: "idle" });
    assertUnlockedFor("editor-human", "editor-human:tab-1");

    // 3. agent/disposed releases Hub lease immediately for MCP.
    takeHub();
    h.emit("agent/disposed", { agent: { session: { id: "sess-a" } } });
    assertUnlockedFor("mcp", "mcp:codex");

    // 4. operatorStop via POST /slides/sessions/:id/stop releases Hub lease immediately.
    takeHub();
    const stopStatus = await h.postStop("sess-a");
    assert.equal(stopStatus, 200);
    assertUnlockedFor("hub-run", "hub-run:sess-c");
  } finally {
    h.dispose();
  }
});

test("hot reload keeps a running Hub agent's writer lease, and timed-out operatorStop defers release until idle", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lease-running-"));
  const store = new SliceSessionStore(dataRoot);
  const { binding } = store.openProject({
    dshSessionId: "sess-live",
    title: "Hot Reload",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const projectRoot = store.resolveRoot(binding);
  assert.equal(
    acquireProjectLease(projectRoot, { kind: "hub-run", ownerId: "hub-run:sess-live", label: "Hub" }).ok,
    true,
  );

  let cancelCount = 0;
  let resolveIdle!: () => void;
  const idlePromise = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  const h = mountPluginLifecycleHarness(dataRoot, {
    liveAgents: [
      {
        id: "sess-live",
        status: "running",
        cancel: () => {
          cancelCount += 1;
        },
        whenIdle: () => idlePromise,
      },
    ],
    operatorStopTimeoutMs: 25,
  });
  try {
    // 1. Hot reload must NOT steal or drop the running agent's writer lease.
    assert.equal(readProjectLease(projectRoot).holder?.ownerId, "hub-run:sess-live");
    assert.equal(acquireProjectLease(projectRoot, { kind: "mcp", ownerId: "mcp:racer" }).outcome, "lease-conflict");

    // 2. Timed-out operatorStop still responds HTTP 200 promptly, but keeps the lease until whenIdle resolves.
    const status = await h.postStop("sess-live");
    assert.equal(status, 200);
    assert.equal(cancelCount, 1);
    assert.equal(readProjectLease(projectRoot).holder?.ownerId, "hub-run:sess-live");
    assert.equal(acquireProjectLease(projectRoot, { kind: "mcp", ownerId: "mcp:racer" }).outcome, "lease-conflict");

    // 3. Once the old tool/agent actually settles to idle, the deferred cleanup releases the lease.
    resolveIdle();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(readProjectLease(projectRoot).active, false);
    assert.equal(acquireProjectLease(projectRoot, { kind: "mcp", ownerId: "mcp:racer" }).ok, true);
  } finally {
    h.dispose();
  }
});

test("open_project rolls back a newly created project when post-open setup fails", async () => {
  const { definitions, store } = bridged(unusedPresentation);
  const openTool = definitions.find((definition) => definition.name === "open_project")!;
  const sessionId = "rollback-session";
  const exec = (callId: string) => ({ agent: { id: sessionId }, callId, signal: new AbortController().signal });
  const originalOpen = store.openProject.bind(store);
  let failOnce = true;
  store.openProject = ((input) => {
    const opened = originalOpen(input);
    if (failOnce) {
      failOnce = false;
      // Inject a lease-write EIO failure by placing a directory at the writer-lease path.
      fs.mkdirSync(path.join(store.resolveRoot(opened.binding), WRITER_LEASE_FILE), { recursive: true });
    }
    return opened;
  }) as typeof store.openProject;

  await assert.rejects(() => openTool.execute({ title: "Atomic Create" }, exec("open-fail") as never));
  assert.equal(store.bindingFor(sessionId), undefined, "in-memory binding rolled back");
  assert.deepEqual(fs.readdirSync(store.slicesRoot()), [], "no partial deck directory left behind");

  const retried = (await openTool.execute({ title: "Atomic Create" }, exec("open-ok") as never)) as Record<
    string,
    unknown
  >;
  assert.equal(retried.outcome, "created", "retry starts cleanly as created instead of reopened");
});
