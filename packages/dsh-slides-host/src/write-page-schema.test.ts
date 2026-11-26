import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type JsonSchemaNode, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  createPresentationRun,
  initializeRunLedger,
  recordSourceReceipt,
  recordTodo,
  type PresentationRun,
} from "@open-slidestudio/presentation-run";
import { loadProject, type LineElement, type ShapeElement, type TextElement } from "@open-slidestudio/pptd-v2";
import { AgentFaults } from "./agent-fault.js";
import { SliceSessionStore } from "./slice-session.js";
import { registerSliceTools } from "./tools.js";
import { writeSliceRuntime } from "./runtime.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function sliceDefinitions(): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  const runtime = {
    register(definition: ToolDefinition) {
      definitions.push(definition);
      return () => undefined;
    },
    guard() {
      return () => undefined;
    },
  } as unknown as import("@deepseek-ai/dsh-tools").default;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "write-schema-"));
  registerSliceTools(runtime, {
    store: new SliceSessionStore(workspace),
    presentation: {
      execute: async () => {
        throw new Error("invalid arguments must not reach presentation-run");
      },
    } as unknown as PresentationRun,
    workspaceRoot: workspace,
    editorBaseUrl: "http://127.0.0.1:55200",
    faults: new AgentFaults(),
    provider: { providerId: "test", modelId: "test" },
  });
  return definitions;
}

function toolDefinition(name: string): ToolDefinition {
  const definition = sliceDefinitions().find((candidate) => candidate.name === name);
  assert.ok(definition);
  return definition;
}

function isComponentBranch(branch: { properties?: Record<string, unknown> }): boolean {
  return (branch.properties?.elementType as { const?: string } | undefined)?.const === "component";
}

test("write_page publishes the seven canonical element branches and the component branch to the model", () => {
  const definition = toolDefinition("write_page");
  const root = definition.parameters as {
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.deepEqual(root.required, ["id", "elements"]);
  assert.equal(root.additionalProperties, false);
  const background = root.properties?.background as { oneOf?: unknown[] };
  assert.equal(background.oneOf?.length, 3);
  assert.deepEqual(root.properties?.notes, { type: "string" });
  const animations = root.properties?.animations as {
    items?: { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> };
  };
  assert.equal(animations.items?.additionalProperties, false);
  assert.deepEqual(animations.items?.required, ["elementId", "effect"]);
  const elements = root.properties?.elements as {
    items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> };
  };
  const allBranches = elements.items!.oneOf!;
  assert.equal(allBranches.filter(isComponentBranch).length, 1, "one template-component branch, expanded by the Host");
  assert.equal(allBranches.length, 8);
  const branches = allBranches.filter((branch) => !isComponentBranch(branch));
  assert.equal(branches.length, 7);
  for (const branch of branches) {
    const bounds = branch.properties?.bounds as { minItems?: number; maxItems?: number };
    assert.equal(bounds.minItems, 4);
    assert.equal(bounds.maxItems, 4);
  }
  const line = branches.find((branch) => (branch.properties?.elementType as { const?: string }).const === "line");
  const viewBox = line?.properties?.viewBox as { minItems?: number; maxItems?: number };
  assert.equal(viewBox.minItems, 2);
  assert.equal(viewBox.maxItems, 2);
  const text = elements.items?.oneOf?.find((branch) => {
    const elementType = branch.properties?.elementType as { const?: string } | undefined;
    return elementType?.const === "text";
  });
  assert.ok(text);
  const content = text.properties?.content as {
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.equal(content.additionalProperties, false);
  assert.deepEqual(content.properties?.style, {
    type: "string",
    description: "Theme text-style reference such as $title. Never pass a style object here.",
  });
  assert.deepEqual(content.properties?.fontSize, {
    type: "number",
    description: "Font size belongs directly on content.",
  });
});

test("write_page rejects b7 nested styles and non-four-value bounds before project access", async () => {
  const definition = toolDefinition("write_page");
  const exec = { signal: new AbortController().signal } as never;
  await assert.rejects(
    definition.execute(
      {
        id: "cover",
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 80, 800, 100],
            content: { text: "勾股定理", style: { fontSize: 50 } },
          },
        ],
      },
      exec,
    ),
    (error: unknown) => {
      const candidate = error as { code?: string; message?: string };
      assert.equal(candidate.code, "INVALID_ARGS");
      assert.match(candidate.message ?? "", /\$\.elements\[0\]\.content\.style must be a string/);
      return true;
    },
  );
  await assert.rejects(
    definition.execute(
      {
        id: "cover",
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 80, 800],
            content: { text: "勾股定理", fontSize: 50 },
          },
        ],
      },
      exec,
    ),
    (error: unknown) => {
      const candidate = error as { code?: string; message?: string };
      assert.equal(candidate.code, "INVALID_ARGS");
      assert.match(candidate.message ?? "", /bounds must contain exactly 4 numbers/);
      return true;
    },
  );
});

test("planning and page review publish canonical item schemas", () => {
  for (const [name, field] of [
    ["commit_design", "slidePlan"],
    ["write_todo", "items"],
  ] as const) {
    const definition = toolDefinition(name);
    assert.equal(definition.parameters.additionalProperties, false);
    const properties = (definition.parameters.properties ?? {}) as Record<string, JsonSchemaNode>;
    const property = properties[field] as {
      type?: string;
      items?: { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> };
    };
    assert.equal(property.type, "array");
    assert.equal(property.items?.additionalProperties, false);
    assert.deepEqual(property.items?.required, ["pageId", "title", "layoutFamily", "exhibits"]);
  }
  const commit = toolDefinition("commit_design");
  const commitProperties = (commit.parameters.properties ?? {}) as Record<string, JsonSchemaNode>;
  const adopted = commitProperties.adoptedSourceIds as {
    type?: string;
    items?: { type?: string };
  };
  assert.equal(adopted.type, "array");
  assert.equal(adopted.items?.type, "string");

  const review = toolDefinition("review_page");
  const reviewProperties = (review.parameters.properties ?? {}) as Record<string, JsonSchemaNode>;
  assert.equal(review.parameters.additionalProperties, false);
  assert.deepEqual(reviewProperties.verdict?.enum, ["pass", "revise"]);
  assert.equal(reviewProperties.issues?.items?.type, "string");
  assert.ok(((review.parameters.required ?? []) as string[]).includes("issues"));
  assert.match(review.description, /verdict=pass requires issues=\[\]/);

  const compose = toolDefinition("compose_deck");
  assert.deepEqual(compose.parameters.required, ["title"]);
  assert.deepEqual(Object.keys(compose.parameters.properties ?? {}), ["title"]);
});

test("canonical write_page persists text and native element metadata through ToolRuntime", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-write-persist-"));
  const store = new SliceSessionStore(workspace);
  const sessionId = "canonical-persist-session";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Canonical persistence",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  writeSliceRuntime(projectRoot, {
    brief: "公开的规范页面持久化回归",
    design: { kind: "self-directed" },
    editorBaseUrl: "",
    strictExecution: true,
  });
  initializeRunLedger(projectRoot);
  recordSourceReceipt(projectRoot, { sourceId: "fixture", state: "adopted", toolCallId: "source-1" });
  recordTodo(projectRoot, { commandId: "plan-1", contextEpochId: "epoch-1" }, [
    { pageId: "page-1", title: "Canonical", layoutFamily: "content", exhibits: [] },
  ]);
  const actual = createPresentationRun({ repoRoot: REPO_ROOT });
  await actual.open({
    projectRoot,
    sessionId,
    brief: "公开的规范页面持久化回归",
    editorBaseUrl: "",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const presentation: PresentationRun = {
    ...actual,
    async execute(command, context) {
      if (command.name === "render_page") {
        return {
          ok: false,
          name: "render_page",
          summary: "render skipped in persistence test",
          detail: "render skipped in persistence test",
          payload: { layoutStatus: "unavailable" },
        };
      }
      return actual.execute(command, context);
    },
  };
  const ctx = new Context();
  const promptFiber = await ctx.plugin(SystemPrompt, {});
  const toolsFiber = await ctx.plugin(ToolRuntime, {});
  try {
    registerSliceTools(ctx.tools, {
      store,
      presentation,
      workspaceRoot: workspace,
      editorBaseUrl: "http://127.0.0.1:55200",
      faults: new AgentFaults(),
      provider: { providerId: "test", modelId: "test" },
    });
    const result = await ctx.tools.execute({
      callId: ToolCallId("canonical-write-1"),
      name: "write_page",
      arguments: {
        id: "page-1",
        pageType: "content",
        background: { type: "solid", color: "#F7F3EA" },
        notes: "Keep this note through read and whole-page replacement.",
        elements: [
          {
            elementId: "bg",
            elementType: "shape",
            bounds: [0, 0, 960, 540],
            shapeName: "rect",
            fill: { type: "solid", color: "#FFFFFF" },
            border: { style: "solid", width: 2, color: "#223344" },
          },
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 90, 800, 100],
            layoutRole: "content",
            content: {
              text: "02",
              fontSize: 50,
              fontFamily: { latin: "Inter", ea: "MiSans" },
              color: "#5C4630",
              align: ["center", "middle"],
            },
          },
          {
            elementId: "connector",
            elementType: "line",
            bounds: [120, 240, 720, 40],
            viewBox: [720, 40],
            points: "M0 20 L720 20",
            border: { style: "solid", width: 2, color: "#223344" },
            arrow: [null, "stealth"],
            connects: ["bg", "title"],
          },
        ],
        animations: [
          {
            elementId: "title",
            effect: "fade-in",
            trigger: "afterPrevious",
            direction: "up",
            durationMs: 500,
            delayMs: 100,
          },
        ],
      },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    const firstRead = await ctx.tools.execute({
      callId: ToolCallId("canonical-read-1"),
      name: "read_page",
      arguments: { pageId: "page-1" },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (firstRead.isError) assert.fail(firstRead.error.message);
    const baseline = structuredClone(firstRead.value) as Record<string, unknown>;
    const pageSha256 = String(baseline.pageSha256 ?? "");
    assert.match(pageSha256, /^[a-f0-9]{64}$/);
    delete baseline.pageSha256;
    fs.writeFileSync(
      path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        token: "roundtrip",
        pagePath: "pages/page-1.page",
        elementId: "title",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const numericBaseline = structuredClone(baseline);
    ((numericBaseline.elements as Array<Record<string, unknown>>)[1]!.content as Record<string, unknown>).text = 2;
    const roundtrip = await ctx.tools.execute({
      callId: ToolCallId("canonical-write-2"),
      name: "write_page",
      arguments: { ...numericBaseline, expectedPageSha256: pageSha256 },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    assert.equal(roundtrip.isError, false);
    const secondRead = await ctx.tools.execute({
      callId: ToolCallId("canonical-read-2"),
      name: "read_page",
      arguments: { pageId: "page-1" },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (secondRead.isError) assert.fail(secondRead.error.message);
    assert.equal((secondRead.value as Record<string, unknown>).pageSha256, pageSha256);

    const page = loadProject(projectRoot).pages[0]?.page;
    assert.ok(page);
    assert.deepEqual(page.background, { type: "solid", color: "#F7F3EA" });
    assert.equal(page.notes, "Keep this note through read and whole-page replacement.");
    assert.deepEqual(page.animations, [
      {
        elementId: "title",
        effect: "fade-in",
        trigger: "afterPrevious",
        direction: "up",
        durationMs: 500,
        delayMs: 100,
      },
    ]);
    const title = page.elements.find((element) => element.elementId === "title") as TextElement;
    assert.equal(title.content.text, "02");
    assert.equal(title.content.fontSize, 50);
    // write_page normalizes off-list faces to the Office/WPS pair; the value
    // persisted through read+rewrite is the rewritten common face.
    assert.deepEqual(title.content.fontFamily, { latin: "Arial", ea: "微软雅黑" });
    assert.equal(title.layoutRole, "content");
    const shape = page.elements.find((element) => element.elementId === "bg") as ShapeElement;
    assert.deepEqual(shape.border, { style: "solid", width: 2, color: "#223344" });
    const line = page.elements.find((element) => element.elementId === "connector") as LineElement;
    assert.deepEqual(line.arrow, [null, "stealth"]);
    assert.deepEqual(line.connects, ["bg", "title"]);
    fs.writeFileSync(
      path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        token: "background-edit",
        pagePath: "pages/page-1.page",
        expiresAt: Date.now() + 60_000,
        scope: { kind: "page", pageId: "page-1", backgroundColorOverride: true },
      }),
    );
    const backgroundArgs = {
      pageId: "page-1",
      expectedPageSha256: pageSha256,
      background: { type: "solid", color: "#172E49" },
    };
    const backgroundEdit = await ctx.tools.execute({
      name: "edit_page_background",
      callId: ToolCallId("background-edit-1"),
      arguments: backgroundArgs,
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (backgroundEdit.isError) assert.fail(backgroundEdit.error.message);
    assert.equal((backgroundEdit.value as Record<string, unknown>).outcome, "written");
    assert.deepEqual(
      loadProject(projectRoot).pages[0]!.page,
      { ...page, background: backgroundArgs.background },
      "only background changes, including numeric text and all metadata",
    );
    const afterBackground = fs.readFileSync(path.join(projectRoot, "pages/page-1.page"), "utf8");
    const stale = await ctx.tools.execute({
      name: "edit_page_background",
      callId: ToolCallId("background-stale"),
      arguments: backgroundArgs,
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (stale.isError) assert.fail(stale.error.message);
    assert.equal((stale.value as Record<string, unknown>).error, "PAGE_EDIT_STALE_PAGE");
    assert.equal(fs.readFileSync(path.join(projectRoot, "pages/page-1.page"), "utf8"), afterBackground);
    const outside = await ctx.tools.execute({
      name: "edit_page_background",
      callId: ToolCallId("background-outside"),
      arguments: { ...backgroundArgs, pageId: "other" },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (outside.isError) assert.fail(outside.error.message);
    assert.equal((outside.value as Record<string, unknown>).error, "PAGE_EDIT_SCOPE_REQUIRED");
    const extra = await ctx.tools.execute({
      name: "edit_page_background",
      callId: ToolCallId("background-extra"),
      arguments: { ...backgroundArgs, elements: [] },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    assert.equal(extra.isError, true);

    fs.writeFileSync(
      path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        token: "background-cased",
        pagePath: "pages/page-1.page",
        expiresAt: Date.now() + 60_000,
        scope: { kind: "page", pageId: "Page-1", backgroundColorOverride: true },
      }),
    );
    const cased = await ctx.tools.execute({
      name: "edit_page_background",
      callId: ToolCallId("background-cased"),
      arguments: backgroundArgs,
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (cased.isError) assert.fail(cased.error.message);
    // A differently-cased lock pageId authorizes; only the stale hash rejects.
    assert.equal((cased.value as Record<string, unknown>).error, "PAGE_EDIT_STALE_PAGE");

    fs.writeFileSync(
      path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        token: "background-elements",
        pagePath: "pages/page-1.page",
        expiresAt: Date.now() + 60_000,
        scope: { kind: "elements", pageId: "Page-1", elementIds: ["title"] },
      }),
    );
    const elementsOnly = await ctx.tools.execute({
      name: "edit_page_background",
      callId: ToolCallId("background-elements"),
      arguments: backgroundArgs,
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    assert.equal(elementsOnly.isError, true);
    assert.match(elementsOnly.error.message, /forbids edit_page_background/);
  } finally {
    await toolsFiber.dispose();
    await promptFiber.dispose();
  }
});

test("planning rejects wrapper objects and incomplete items before project access", async () => {
  const definition = toolDefinition("commit_design");
  const exec = { signal: new AbortController().signal } as never;
  for (const slidePlan of [
    { items: [{ pageId: "cover", title: "Cover", layoutFamily: "cover" }] },
    [{ pageId: "cover", title: "Cover" }],
  ]) {
    await assert.rejects(definition.execute({ slidePlan }, exec), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_ARGS");
      return true;
    });
  }
});
