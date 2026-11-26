import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  createPresentationRun,
  initializeRunLedger,
  recordSourceReceipt,
  recordTodo,
  type PresentationRun,
} from "@open-slidestudio/presentation-run";
import { createEmptyProject, saveProject, loadProject, type TextElement } from "@open-slidestudio/pptd-v2";
import { AgentFaults } from "./agent-fault.js";
import { SliceSessionStore } from "./slice-session.js";
import { registerSliceTools } from "./tools.js";
import { writeSliceRuntime } from "./runtime.js";
import { directorBrief } from "./director-brief.js";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("edit_elements publishes the canonical seven-branch subset schema", () => {
  const definitions: ToolDefinition[] = [];
  const runtime = {
    register(definition: ToolDefinition) {
      definitions.push(definition);
      return () => undefined;
    },
    guard() {
      return () => undefined;
    },
  } as unknown as ToolRuntime;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "edit-elements-schema-"));
  registerSliceTools(runtime, {
    store: new SliceSessionStore(workspace),
    presentation: {
      execute: async () => {
        throw new Error("unused");
      },
    } as unknown as PresentationRun,
    workspaceRoot: workspace,
    editorBaseUrl: "",
    faults: new AgentFaults(),
    provider: { providerId: "test", modelId: "test" },
  });
  const definition = definitions.find((candidate) => candidate.name === "edit_elements");
  assert.ok(definition);
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(definition.parameters.required, ["pageId", "expectedPageSha256", "elements"]);
  const properties = definition.parameters.properties as Record<string, unknown> | undefined;
  const elements = properties?.elements as {
    items?: { oneOf?: unknown[] };
  };
  assert.equal(elements.items?.oneOf?.length, 7);
});

test("the director routes element scopes to edit_elements and whole-page edits to write_page", () => {
  const prompt = directorBrief("Revise the selected title");
  assert.match(prompt, /review scope is elements, use edit_elements/);
  assert.match(prompt, /do not call write_page/);
  assert.match(prompt, /whole-page and deck edits still use write_page/);
});

function textElement(elementId: string, text: string, y: number) {
  return {
    elementId,
    elementType: "text" as const,
    bounds: [80, y, 800, 60] as [number, number, number, number],
    content: { text, fontSize: 28, color: "#223344" },
  };
}

test("edit_elements merges a target through canonical write_page and preserves the page", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "edit-elements-runtime-"));
  const store = new SliceSessionStore(workspace);
  const sessionId = "edit-elements-runtime";
  const opened = store.openProject({
    dshSessionId: sessionId,
    title: "Scoped edit",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const projectRoot = store.resolveRoot(opened.binding);
  writeSliceRuntime(projectRoot, {
    brief: "Element edit regression",
    design: { kind: "self-directed" },
    editorBaseUrl: "",
    strictExecution: true,
  });
  initializeRunLedger(projectRoot);
  recordSourceReceipt(projectRoot, { sourceId: "fixture", state: "adopted", toolCallId: "source" });
  recordTodo(projectRoot, { commandId: "plan", contextEpochId: "epoch" }, [
    { pageId: "page-1", title: "Scoped", layoutFamily: "content", exhibits: [] },
  ]);
  const actual = createPresentationRun({ repoRoot: REPO_ROOT });
  await actual.open({
    projectRoot,
    sessionId,
    brief: "Element edit regression",
    editorBaseUrl: "",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  const writeArgs: Array<Record<string, unknown>> = [];
  const presentation: PresentationRun = {
    ...actual,
    async execute(command, context) {
      if (command.name === "render_page") {
        return {
          ok: false,
          name: "render_page",
          summary: "render omitted",
          detail: "render omitted",
          payload: { layoutStatus: "unavailable" },
        };
      }
      if (command.name === "write_page") writeArgs.push(structuredClone(command.args));
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
      editorBaseUrl: "",
      faults: new AgentFaults(),
      provider: { providerId: "test", modelId: "test" },
    });
    const initial = await ctx.tools.execute({
      callId: ToolCallId("edit-elements-seed"),
      name: "write_page",
      arguments: {
        id: "page-1",
        pageType: "content",
        background: { type: "solid", color: "#F7F3EA" },
        notes: "Preserve this page note.",
        elements: [
          textElement("title", "Before", 70),
          textElement("body", "Untouched", 180),
          textElement("footer", "Keep order", 410),
        ],
        animations: [{ elementId: "title", effect: "fade-in" }],
      },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (initial.isError) assert.fail(initial.error.message);
    assert.equal((initial.value as Record<string, unknown>).outcome, "written", JSON.stringify(initial.value));
    const read = await ctx.tools.execute({
      callId: ToolCallId("edit-elements-read"),
      name: "read_page",
      arguments: { pageId: "page-1" },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (read.isError) assert.fail(read.error.message);
    const baseline = structuredClone(read.value) as Record<string, unknown>;
    const pageSha256 = String(baseline.pageSha256);
    assert.match(pageSha256, /^[a-f0-9]{64}$/, JSON.stringify(read.value));
    delete baseline.pageSha256;
    delete baseline.id;
    fs.writeFileSync(
      path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        token: "edit-elements-token",
        pagePath: "pages/page-1.page",
        scope: { kind: "elements", pageId: "page-1", elementIds: ["title"] },
        pageSha256,
        pageBody: baseline,
        expiresAt: Date.now() + 60_000,
      }),
    );

    const beforeDirectWholePage = fs.readFileSync(path.join(projectRoot, "pages", "page-1.page"), "utf8");
    const directWholePage = await ctx.tools.execute({
      callId: ToolCallId("edit-elements-direct-write-page"),
      name: "write_page",
      arguments: { ...baseline, id: "page-1", expectedPageSha256: pageSha256 },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    assert.equal(directWholePage.isError, true);
    if (directWholePage.isError) assert.match(directWholePage.error.message, /slides preset forbids write_page/);
    assert.equal(fs.readFileSync(path.join(projectRoot, "pages", "page-1.page"), "utf8"), beforeDirectWholePage);

    const replacement = textElement("title", "After", 70);
    const call = {
      callId: ToolCallId("edit-elements-1"),
      name: "edit_elements",
      arguments: { pageId: "page-1", expectedPageSha256: pageSha256, elements: [replacement] },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    };
    const changed = await ctx.tools.execute(call);
    if (changed.isError) assert.fail(changed.error.message);
    assert.equal((changed.value as Record<string, unknown>).outcome, "written", JSON.stringify(changed.value));
    const currentPageSha256 = String((changed.value as Record<string, unknown>).pageSha256);
    assert.match(currentPageSha256, /^[a-f0-9]{64}$/);
    const changedProject = loadProject(projectRoot);
    const changedPage = changedProject.pages[0]!.page;
    assert.deepEqual(
      changedPage.elements.map((element) => element.elementId),
      ["title", "body", "footer"],
    );
    assert.equal((changedPage.elements[0] as TextElement).content.text, "After");
    assert.equal((changedPage.elements[1] as TextElement).content.text, "Untouched");
    assert.deepEqual(changedPage.background, { type: "solid", color: "#F7F3EA" });
    assert.equal(changedPage.notes, "Preserve this page note.");
    assert.deepEqual(changedPage.animations, [{ elementId: "title", effect: "fade-in" }]);
    assert.equal(writeArgs.length, 2);
    assert.deepEqual(
      (writeArgs[1]!.elements as Array<{ elementId: string }>).map((element) => element.elementId),
      ["title", "body", "footer"],
    );

    const replayed = await ctx.tools.execute(call);
    assert.equal(replayed.isError, false);
    assert.deepEqual(replayed.value, changed.value);
    assert.equal(writeArgs.length, 2, "same callId must replay before the old SHA can conflict");

    const pageFile = path.join(projectRoot, "pages", "page-1.page");
    const beforeInvalid = fs.readFileSync(pageFile, "utf8");
    const invalidCalls = [
      {
        id: "duplicate",
        expectedPageSha256: pageSha256,
        elements: [replacement, replacement],
        error: /elementId must be unique/,
      },
      {
        id: "missing-scope-target",
        expectedPageSha256: currentPageSha256,
        elements: [textElement("body", "Wrong target", 180)],
        error: /must replace exactly the authorized elementIds/,
      },
      {
        id: "stale",
        expectedPageSha256: pageSha256,
        elements: [textElement("title", "Stale", 70)],
        error: /stale-page/,
      },
    ];
    for (const invalid of invalidCalls) {
      const result = await ctx.tools.execute({
        callId: ToolCallId(`edit-elements-${invalid.id}`),
        name: "edit_elements",
        arguments: {
          pageId: "page-1",
          expectedPageSha256: invalid.expectedPageSha256,
          elements: invalid.elements,
        },
        agent: { id: sessionId } as never,
        signal: new AbortController().signal,
      });
      if (result.isError) assert.match(result.error.message, invalid.error);
      else assert.match(JSON.stringify(result.value), invalid.error);
      assert.equal(fs.readFileSync(pageFile, "utf8"), beforeInvalid);
      assert.equal(writeArgs.length, 2);
    }

    fs.writeFileSync(
      path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/page-1.page",
        scope: { kind: "elements", pageId: "page-1", elementIds: ["deleted"] },
        expiresAt: Date.now() + 60_000,
      }),
    );
    const deleted = await ctx.tools.execute({
      callId: ToolCallId("edit-elements-deleted"),
      name: "edit_elements",
      arguments: {
        pageId: "page-1",
        expectedPageSha256: currentPageSha256,
        elements: [textElement("deleted", "No longer present", 70)],
      },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    if (deleted.isError) assert.match(deleted.error.message, /TARGET_MISSING|no longer exist/);
    else assert.match(JSON.stringify(deleted.value), /ELEMENT_EDIT_TARGET_MISSING/);
    assert.equal(fs.readFileSync(pageFile, "utf8"), beforeInvalid);

    fs.writeFileSync(
      path.join(projectRoot, "_agent", "ai-review-lock.v1.json"),
      JSON.stringify({
        pagePath: "pages/page-1.page",
        scope: { kind: "elements", pageId: "page-1", elementIds: ["title"] },
        expiresAt: Date.now() - 1,
      }),
    );
    const expired = await ctx.tools.execute({
      callId: ToolCallId("edit-elements-expired"),
      name: "edit_elements",
      arguments: {
        pageId: "page-1",
        expectedPageSha256: currentPageSha256,
        elements: [textElement("title", "Expired", 70)],
      },
      agent: { id: sessionId } as never,
      signal: new AbortController().signal,
    });
    assert.equal(expired.isError, true);
    if (expired.isError) assert.match(expired.error.message, /slides preset forbids/);
    assert.equal(fs.readFileSync(pageFile, "utf8"), beforeInvalid);

    const definitionRuntime: ToolDefinition[] = [];
    const definitionOnly = {
      register(definition: ToolDefinition) {
        definitionRuntime.push(definition);
        return () => undefined;
      },
      guard() {
        return () => undefined;
      },
    } as unknown as ToolRuntime;
    registerSliceTools(definitionOnly, {
      store,
      presentation,
      workspaceRoot: workspace,
      editorBaseUrl: "",
      faults: new AgentFaults(),
      provider: { providerId: "test", modelId: "test" },
    });
    const definition = definitionRuntime.find((candidate) => candidate.name === "edit_elements");
    assert.ok(definition);
    await assert.rejects(
      definition.execute({ arguments: { ...call.arguments, undeclaredEnvelopeKey: true } }, {
        signal: call.signal,
      } as never),
      /provider wire envelope/,
    );
  } finally {
    await toolsFiber.dispose();
    await promptFiber.dispose();
  }
});

test("batch element tool accepts both same-page targets and a second page without broadening scope", async () => {
  const { prepareElementEdit } = await import("./edit-elements.js");
  const { stableSha256 } = await import("@open-slidestudio/presentation-run");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch-elements-"));
  const project = createEmptyProject(root, { title: "Batch" });
  project.pages = ["p1", "p2"].map((id) => ({
    path: `pages/${id}.page`,
    page: {
      pageType: "content",
      elements: [
        textElement("title", "Title", 70),
        textElement("body", "Body", 170),
        textElement("footer", "Untouched", 410),
      ],
    },
  }));
  project.presentation.pages = project.pages.map((page) => page.path);
  saveProject(project);
  const items = [
    {
      pagePath: "pages/p1.page",
      scope: { kind: "elements", pageId: "p1", elementIds: ["title"] },
      pageBody: project.pages[0]!.page,
    },
    {
      pagePath: "pages/p1.page",
      scope: { kind: "elements", pageId: "p1", elementIds: ["body"] },
      pageBody: project.pages[0]!.page,
    },
    {
      pagePath: "pages/p2.page",
      scope: { kind: "elements", pageId: "p2", elementIds: ["title"] },
      pageBody: project.pages[1]!.page,
    },
  ];
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "ai-review-lock.v1.json"),
    JSON.stringify({ ...items[0], items, expiresAt: Date.now() + 60_000 }),
  );
  const expectedPageSha256 = stableSha256({ ...project.pages[0]!.page, id: "p1" });
  const accepted = prepareElementEdit(root, {
    pageId: "p1",
    expectedPageSha256,
    elements: [textElement("title", "New title", 70), textElement("body", "New body", 170)],
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  if (accepted.ok) assert.deepEqual(accepted.page.elements[2], project.pages[0]!.page.elements[2]);
  assert.equal(
    prepareElementEdit(root, { pageId: "p1", expectedPageSha256, elements: [textElement("title", "Only first", 70)] })
      .ok,
    false,
  );
  assert.equal(
    prepareElementEdit(root, {
      pageId: "p1",
      expectedPageSha256,
      elements: [textElement("title", "New", 70), textElement("footer", "Wrong", 410)],
    }).ok,
    false,
  );
  assert.equal(
    prepareElementEdit(root, {
      pageId: "p2",
      expectedPageSha256: stableSha256({ ...project.pages[1]!.page, id: "p2" }),
      elements: [textElement("title", "Page two", 70)],
    }).ok,
    true,
  );
});
