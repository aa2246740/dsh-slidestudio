import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { DISCUSSION_TOOLS, recordConversationMessage } from "./assistant-conversation.js";
import { attachSlidesAgentPlane, type SlidesAgentPlaneDeps } from "./agent-plane.js";
import { AgentFaults } from "./agent-fault.js";
import { SliceSessionStore } from "./slice-session.js";
import { restrictGlobalToolsCompat } from "./tool-visibility.js";
import { isSliceToolStepVisible, registerSliceTools } from "./tools.js";

it("hides capability-filtered tools and web_search, and keeps an allowed write", () => {
  const allowed = new Set(["read_page", "write_page", "web_search", "inspect_capabilities"]);
  assert.equal(isSliceToolStepVisible("write_page", allowed), true);
  assert.equal(isSliceToolStepVisible("read_page", allowed), true);
  assert.equal(isSliceToolStepVisible("web_search", allowed), false);
  for (const name of [
    "edit_elements",
    "edit_page_background",
    "delete_pages",
    "reorder_pages",
    "update_deck",
    "review_page",
    "search_image",
    "generate_image",
  ]) {
    assert.equal(isSliceToolStepVisible(name, allowed), false, name);
  }
  const withCaps = new Set([...allowed, "edit_elements", "review_page", "search_image", "generate_image"]);
  assert.equal(isSliceToolStepVisible("edit_elements", withCaps), true);
  assert.equal(isSliceToolStepVisible("review_page", withCaps), true);
  assert.equal(isSliceToolStepVisible("search_image", withCaps), true);
  assert.equal(isSliceToolStepVisible("generate_image", withCaps), true);
  assert.equal(isSliceToolStepVisible("web_search", withCaps), false);
});

it("passes when to tools.register and answers discussion versus capability gaps", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slice-when-"));
  try {
    const store = new SliceSessionStore(workspace);
    const provider = { providerId: "test", modelId: "test", ready: true };
    const opened = store.openProject({
      dshSessionId: "when-session",
      title: "When",
      design: { kind: "self-directed" },
      provider,
    });
    const registered: Array<{ name: string; when?: (context: { agent?: { id?: string } }) => boolean }> = [];
    const runtime = {
      register(definition: ToolDefinition, options?: { when?: (context: { agent?: { id?: string } }) => boolean }) {
        registered.push({ name: definition.name, when: options?.when });
        return () => undefined;
      },
      guard() {
        return () => undefined;
      },
    } as unknown as ToolRuntime;
    registerSliceTools(runtime, {
      store,
      presentation: {
        execute: async () => {
          throw new Error("unused");
        },
      } as never,
      workspaceRoot: workspace,
      editorBaseUrl: "http://127.0.0.1:55200",
      faults: new AgentFaults(),
      provider,
    });
    const whenOf = (name: string) => {
      const row = registered.find((item) => item.name === name);
      assert.equal(typeof row?.when, "function", name);
      return row!.when!;
    };
    const agent = { agent: { id: "when-session" } };
    assert.equal(whenOf("write_page")(agent), true);
    assert.equal(whenOf("read_page")(agent), true);
    assert.equal(whenOf("web_search")(agent), false);
    assert.equal(whenOf("edit_elements")(agent), false);
    assert.equal(whenOf("delete_pages")(agent), false);
    assert.equal(whenOf("reorder_pages")(agent), false);
    assert.equal(whenOf("update_deck")(agent), false);

    recordConversationMessage(store.resolveRoot(opened.binding), "只讨论", "discuss");
    assert.equal(whenOf("write_page")(agent), false);
    assert.equal(whenOf("edit_elements")(agent), false);
    assert.equal(whenOf("read_page")(agent), true);
    assert.equal(whenOf("inspect_capabilities")(agent), DISCUSSION_TOOLS.has("inspect_capabilities"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function planeDeps(): { deps: SlidesAgentPlaneDeps; workspace: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "plane-restrict-"));
  return {
    workspace,
    deps: {
      store: { bindingFor: () => undefined } as unknown as SliceSessionStore,
      presentation: {
        execute: async () => {
          throw new Error("unused");
        },
      } as never,
      workspaceRoot: workspace,
      editorBaseUrl: "http://127.0.0.1:55200",
      faults: new AgentFaults(),
      provider: { providerId: "test", modelId: "test", ready: true },
    },
  };
}

function probeTools(present: boolean) {
  const state = { calls: [] as Array<{ deny: readonly string[] }>, disposed: 0 };
  class ProbeTools extends Service {
    constructor(ctx: Context) {
      super(ctx, "tools");
    }

    get(name: string) {
      return present && name === "web_search" ? { name } : undefined;
    }

    restrict(filter: { deny: readonly string[] }) {
      state.calls.push({ deny: [...filter.deny] });
      return () => {
        state.disposed += 1;
      };
    }

    register() {
      return () => undefined;
    }

    guard() {
      return () => undefined;
    }
  }
  return { ProbeTools, state };
}

it("denies a global web_search through tools.restrict and lifts it on dispose", async () => {
  const { ProbeTools, state } = probeTools(true);
  const ctx = new Context();
  const fiber = await ctx.plugin(ProbeTools);
  const scope = createScope(ctx, { id: "slides-agent" } as never);
  const { deps, workspace } = planeDeps();
  try {
    const dispose = attachSlidesAgentPlane(scope.ctx, deps);
    assert.deepEqual(state.calls, [{ deny: ["web_search"] }]);
    dispose();
    assert.equal(state.disposed, 1);
  } finally {
    await scope.dispose();
    await fiber.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

it("does not throw when the global registry has no web_search", async () => {
  const { ProbeTools, state } = probeTools(false);
  const ctx = new Context();
  const fiber = await ctx.plugin(ProbeTools);
  const scope = createScope(ctx, { id: "slides-agent" } as never);
  const { deps, workspace } = planeDeps();
  try {
    const dispose = attachSlidesAgentPlane(scope.ctx, deps);
    assert.deepEqual(state.calls, []);
    dispose();
    assert.equal(state.disposed, 0);
  } finally {
    await scope.dispose();
    await fiber.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

it("still restricts global web_search on a non-root context when local scopeOf returns undefined", async () => {
  const { ProbeTools, state } = probeTools(true);
  const ctx = new Context();
  const fiber = await ctx.plugin(ProbeTools);
  // 模拟宿主使用独立副本的 @deepseek-ai/dsh-scope：childCtx !== ctx.root，但本包 scopeOf(childCtx) 为 undefined。
  const childCtx = ctx.extend();
  assert.notEqual(childCtx, childCtx.root);
  assert.equal(scopeOf(childCtx), undefined);
  const { deps, workspace } = planeDeps();
  try {
    const dispose = attachSlidesAgentPlane(childCtx, deps);
    assert.deepEqual(state.calls, [{ deny: ["web_search"] }]);
    dispose();
    assert.equal(state.disposed, 1);
  } finally {
    await fiber.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

it("skips tools.restrict on the root context and ignores scoped-context rejection", async () => {
  const { ProbeTools, state } = probeTools(true);
  const ctx = new Context();
  const fiber = await ctx.plugin(ProbeTools);
  const { deps, workspace } = planeDeps();
  try {
    const dispose = attachSlidesAgentPlane(ctx, deps);
    assert.deepEqual(state.calls, []);
    dispose();
    assert.equal(state.disposed, 0);

    const noop = restrictGlobalToolsCompat(
      {
        get: (name) => (name === "web_search" ? { name } : undefined),
        restrict() {
          throw new Error("tools.restrict() requires a scoped context (agent.ctx)");
        },
      },
      ["web_search"],
    );
    assert.equal(noop(), undefined);
  } finally {
    await fiber.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
