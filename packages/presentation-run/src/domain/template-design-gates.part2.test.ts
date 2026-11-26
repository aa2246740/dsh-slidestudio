import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject, saveProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "../run.js";
import { listSourceReceipts, recordSourceReceipt } from "../receipts.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { ensureRunLedger, inspectRunLedger, readRunLedger, recordMaterialChunk } from "./run-ledger.js";
import { readMaterialChunk, materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { executeGenerateTool, type AgentToolState } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import { PACK_COLOR_ERROR } from "./theme-pack.js";

import {
  REPO_ROOT,
  TEMPLATE_ID,
  SOURCE_ID,
  createMaterialProject,
  plan,
  agentColorPage,
} from "./template-design-gates.support.js";

describe("template design source gates", () => {
  it("agent-tools write_page uses the shared material-aware palette context", (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-agent-tools-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    createEmptyProject(projectRoot, { title: "公司介绍" });
    recordSourceReceipt(projectRoot, { sourceId: SOURCE_ID, state: "adopted" });
    const state: AgentToolState = {
      brief: "做一份公司介绍",
      playbook: loadPlaybook({
        designSystemId: "consulting/pine-green-strategy",
        hostDefaults: false,
      }),
      todos: [],
      researchNotes: [],
      writtenPages: [],
      projectRoot,
    };
    const accepted = executeGenerateTool("write_page", agentColorPage("#C8102E"), state);
    assert.equal(accepted.ok, true, accepted.detail);
    const refused = executeGenerateTool("write_page", agentColorPage("#3366FF"), state);
    assert.equal(refused.ok, false);
    assert.equal((refused.payload as Record<string, unknown>).error, PACK_COLOR_ERROR);
    assert.match(refused.detail, /已采用的设计源/);
  });

  it("run-ledger YAML blocker uses the same receipt-verified material palette", (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-run-ledger-color-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    const project = createEmptyProject(projectRoot, { title: "公司介绍" });
    const page = agentColorPage("#C8102E");
    project.pages = [
      {
        path: "pages/cover.page",
        page: { pageType: "cover", elements: page.elements },
      },
    ];
    project.presentation.pages = project.pages.map((loaded) => loaded.path);
    saveProject(project);

    const setBackground = (color: string) => {
      const background = project.pages[0]!.page.elements[0]!;
      assert.equal(background.elementType, "shape");
      if (background.elementType === "shape") {
        background.fill = { type: "solid", color };
      }
    };
    recordSourceReceipt(projectRoot, { sourceId: SOURCE_ID, state: "adopted" });
    ensureRunLedger(projectRoot, {
      manifestSha256: "c".repeat(64),
      requirementsId: "template-color-context",
      requirements: [],
    });
    const accepted = inspectRunLedger(projectRoot);
    assert.equal(
      accepted.composeBlockers.some((blocker) => blocker.includes("cover: pack_color")),
      false,
      accepted.composeBlockers.join("; "),
    );

    setBackground("#3366FF");
    saveProject(project);
    const refused = inspectRunLedger(projectRoot);
    assert.equal(
      refused.composeBlockers.some((blocker) => blocker.includes("cover: pack_color")),
      true,
      refused.composeBlockers.join("; "),
    );

    const sourceJson = path.join(projectRoot, "_agent", "materials", TEMPLATE_ID, "design-source.json");
    fs.appendFileSync(sourceJson, " ");
    setBackground("#C8102E");
    saveProject(project);
    const tampered = inspectRunLedger(projectRoot);
    assert.equal(
      tampered.composeBlockers.some((blocker) => blocker.includes("cover: pack_color")),
      true,
      tampered.composeBlockers.join("; "),
    );
  });

  it("requires every current-epoch design-source chunk before commit_design and write_todo", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-preflight-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp, TEMPLATE_ID, true);
    writeDomainRuntime(projectRoot, {
      brief: "给董事会做一份上半年经营汇报。",
      designDirection: "self-directed",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "template-preflight",
      brief: "给董事会做一份上半年经营汇报。",
      editorBaseUrl: "http://127.0.0.1:55200",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "offline" },
    });
    const context = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot,
      abortSignal: new AbortController().signal,
    };
    const verified = verifyMaterial(projectRoot, TEMPLATE_ID);
    const chunkCount = materialChunkCount(verified, "design");
    assert.ok(chunkCount >= 2);

    const commitArgs = { slidePlan: plan(), adoptedSourceIds: [SOURCE_ID] };
    fs.rmSync(path.join(projectRoot, "_agent", "run-ledger.v1.json"));
    const refusedWithoutLedger = await run.execute(
      { name: "commit_design", args: commitArgs },
      { ...context, toolCallId: "template-commit-without-ledger" },
    );
    assert.equal(refusedWithoutLedger.ok, false);
    assert.equal(refusedWithoutLedger.payload.error, "required_source_chunks_unread");
    assert.equal(
      (refusedWithoutLedger.payload.missingMaterialChunks as unknown[]).length,
      chunkCount,
      "the material preflight cannot be skipped when the ledger is missing",
    );
    writeDomainRuntime(projectRoot, {
      brief: "给董事会做一份上半年经营汇报。",
      designDirection: "self-directed",
      strictExecution: true,
    });
    const refusedCommit = await run.execute(
      { name: "commit_design", args: commitArgs },
      { ...context, toolCallId: "template-commit-before-read" },
    );
    assert.equal(refusedCommit.ok, false);
    assert.equal(refusedCommit.payload.error, "required_source_chunks_unread");
    assert.equal(refusedCommit.payload.next, "read_material");
    assert.equal((refusedCommit.payload.missingMaterialChunks as unknown[]).length, chunkCount);
    assert.match(refusedCommit.detail, /read_material/);
    assert.match(refusedCommit.detail, new RegExp(`${SOURCE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#0`));
    assert.equal(listSourceReceipts(projectRoot).length, 0);

    recordSourceReceipt(projectRoot, {
      sourceId: SOURCE_ID,
      state: "adopted",
      toolCallId: "prior-adoption",
    });
    const refusedTodo = await run.execute(
      { name: "write_todo", args: { items: plan() } },
      { ...context, toolCallId: "template-todo-before-read" },
    );
    assert.equal(refusedTodo.ok, false);
    assert.equal(refusedTodo.payload.next, "read_material");
    assert.equal((refusedTodo.payload.missingMaterialChunks as unknown[]).length, chunkCount);

    for (let offset = 0; offset < chunkCount; offset += 1) {
      const read = await run.execute(
        {
          name: "read_material",
          args: { materialId: TEMPLATE_ID, part: "design", offset },
        },
        { ...context, toolCallId: `template-read-${offset}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
    const references = await run.execute(
      { name: "list_references", args: {} },
      { ...context, toolCallId: "template-list-references" },
    );
    const missingReferenceChunks = references.payload.missingReferenceChunks as {
      sourceId: string;
      chunkIndex: number;
    }[];
    for (const chunk of missingReferenceChunks) {
      const read = await run.execute(
        {
          name: "read_reference",
          args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex },
        },
        {
          ...context,
          toolCallId: `template-read-reference-${chunk.sourceId}-${chunk.chunkIndex}`,
        },
      );
      assert.equal(read.ok, true, read.detail);
    }
    const committed = await run.execute(
      { name: "commit_design", args: commitArgs },
      { ...context, toolCallId: "template-commit-after-read" },
    );
    assert.equal(committed.ok, true, committed.detail);
    assert.equal(
      readRunLedger(projectRoot)?.facts.filter(
        (fact) => fact.type === "material.chunk-returned" && fact.materialId === TEMPLATE_ID,
      ).length,
      chunkCount,
    );
    const runtime = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "runtime.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(runtime.designDirection, "user-design");
    assert.deepEqual(runtime.designMaterialIds, [TEMPLATE_ID]);

    const mixedArgs = {
      slidePlan: plan(),
      adoptedSourceIds: [SOURCE_ID, "consulting/pine-green-strategy"],
    };
    const mixedFirst = await run.execute(
      { name: "commit_design", args: mixedArgs },
      { ...context, toolCallId: "template-mixed-commit-before-catalog-read" },
    );
    assert.equal(mixedFirst.ok, false);
    const missingCatalogChunks = mixedFirst.payload.missingReferenceChunks as {
      sourceId: string;
      chunkIndex: number;
    }[];
    assert.ok(missingCatalogChunks.length > 0);
    for (const chunk of missingCatalogChunks) {
      const read = await run.execute(
        {
          name: "read_reference",
          args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex },
        },
        {
          ...context,
          toolCallId: `template-mixed-read-${chunk.sourceId}-${chunk.chunkIndex}`,
        },
      );
      assert.equal(read.ok, true, read.detail);
    }
    const mixedCommitted = await run.execute(
      { name: "commit_design", args: mixedArgs },
      { ...context, toolCallId: "template-mixed-commit-after-catalog-read" },
    );
    assert.equal(mixedCommitted.ok, true, mixedCommitted.detail);
    assert.deepEqual(mixedCommitted.payload.adoptedSourceIds, mixedArgs.adoptedSourceIds);
  });

  it("does not accept matching chunk hashes from another context epoch", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-epoch-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    writeDomainRuntime(projectRoot, {
      brief: "公司介绍",
      designDirection: "self-directed",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "template-epoch",
      brief: "公司介绍",
      editorBaseUrl: "http://127.0.0.1:55200",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "offline" },
    });
    const material = verifyMaterial(projectRoot, TEMPLATE_ID);
    const chunk = readMaterialChunk({ material, part: "design", offset: 0 });
    recordMaterialChunk(
      projectRoot,
      { commandId: "old-read", contextEpochId: "prior-epoch" },
      {
        materialId: TEMPLATE_ID,
        materialSha256: material.sha256,
        part: "design",
        chunkIndex: chunk.chunkIndex,
        chunkSha256: chunk.chunkSha256,
      },
    );
    const refused = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [SOURCE_ID] },
      },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        projectRoot,
        abortSignal: new AbortController().signal,
        toolCallId: "commit-old-read",
      },
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.payload.next, "read_material");
    assert.equal((refused.payload.missingMaterialChunks as unknown[]).length, 1);
  });

  it("VAL-TPL-009: refuses a wrong chunkSha256 read in the current context epoch", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-wrong-hash-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp, TEMPLATE_ID, true);
    const brief = "给董事会做一份上半年经营汇报。";
    writeDomainRuntime(projectRoot, {
      brief,
      designDirection: "self-directed",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "template-wrong-hash",
      brief,
      editorBaseUrl: "http://127.0.0.1:55200",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "offline" },
    });
    const context = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot,
      abortSignal: new AbortController().signal,
    };
    const epoch = run.epochFor(handle.sessionId);
    assert.match(epoch, /^dsh-/);
    const material = verifyMaterial(projectRoot, TEMPLATE_ID);
    const chunkCount = materialChunkCount(material, "design");
    assert.ok(chunkCount >= 2);
    const badIndex = chunkCount - 1;
    const expected = readMaterialChunk({ material, part: "design", offset: badIndex });
    const wrongSha = "0".repeat(64);
    assert.notEqual(wrongSha, expected.chunkSha256);
    assert.equal(expected.part, "design");

    for (let offset = 0; offset < chunkCount; offset += 1) {
      if (offset === badIndex) continue;
      const read = await run.execute(
        { name: "read_material", args: { materialId: TEMPLATE_ID, part: "design", offset } },
        { ...context, toolCallId: `wrong-hash-good-${offset}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
    recordMaterialChunk(
      projectRoot,
      { commandId: "wrong-hash-read", contextEpochId: epoch },
      {
        materialId: TEMPLATE_ID,
        materialSha256: material.sha256,
        part: expected.part,
        chunkIndex: badIndex,
        chunkSha256: wrongSha,
      },
    );
    const currentFacts =
      readRunLedger(projectRoot)?.facts.filter(
        (fact) =>
          fact.type === "material.chunk-returned" && fact.contextEpochId === epoch && fact.materialId === TEMPLATE_ID,
      ) ?? [];
    assert.equal(currentFacts.length, chunkCount);
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.type === "material.chunk-returned" && fact.chunkIndex === badIndex && fact.chunkSha256 === wrongSha,
      ),
      true,
    );

    const label = `${SOURCE_ID}#${badIndex}`;
    const labelPattern = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const refusedCommit = await run.execute(
      { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: [SOURCE_ID] } },
      { ...context, toolCallId: "wrong-hash-commit" },
    );
    assert.equal(refusedCommit.ok, false, refusedCommit.detail);
    assert.equal(refusedCommit.payload.error, "required_source_chunks_unread");
    assert.deepEqual(
      (refusedCommit.payload.missingMaterialChunks as { sourceId: string; chunkIndex: number }[]).map(
        (chunk) => `${chunk.sourceId}#${chunk.chunkIndex}`,
      ),
      [label],
      refusedCommit.detail,
    );
    assert.match(refusedCommit.detail, labelPattern);
    const refusedTodo = await run.execute(
      { name: "write_todo", args: { items: plan(), adoptedSourceIds: [SOURCE_ID] } },
      { ...context, toolCallId: "wrong-hash-todo" },
    );
    assert.equal(refusedTodo.ok, false, refusedTodo.detail);
    assert.equal(refusedTodo.payload.error, "required_source_chunks_unread");
    assert.deepEqual(
      (refusedTodo.payload.missingMaterialChunks as { sourceId: string; chunkIndex: number }[]).map(
        (chunk) => `${chunk.sourceId}#${chunk.chunkIndex}`,
      ),
      [label],
      refusedTodo.detail,
    );
    assert.match(refusedTodo.detail, labelPattern);

    const corrected = await run.execute(
      {
        name: "read_material",
        args: { materialId: TEMPLATE_ID, part: "design", offset: badIndex },
      },
      { ...context, toolCallId: "wrong-hash-reread" },
    );
    assert.equal(corrected.ok, true, corrected.detail);
    assert.equal(corrected.payload.chunkSha256, expected.chunkSha256);
    const references = await run.execute(
      { name: "list_references", args: {} },
      { ...context, toolCallId: "wrong-hash-list-references" },
    );
    for (const chunk of (references.payload.missingReferenceChunks ?? []) as {
      sourceId: string;
      chunkIndex: number;
    }[]) {
      const read = await run.execute(
        {
          name: "read_reference",
          args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex },
        },
        { ...context, toolCallId: `wrong-hash-ref-${chunk.sourceId}-${chunk.chunkIndex}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
    const committed = await run.execute(
      { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: [SOURCE_ID] } },
      { ...context, toolCallId: "wrong-hash-commit-after" },
    );
    assert.equal(committed.ok, true, committed.detail);
    const todo = await run.execute(
      { name: "write_todo", args: { items: plan(), adoptedSourceIds: [SOURCE_ID] } },
      { ...context, toolCallId: "wrong-hash-todo-after" },
    );
    assert.equal(todo.ok, true, todo.detail);
  });
});
