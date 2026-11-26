import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "../run.js";
import { listSourceReceipts } from "../receipts.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { packColorWriteContext } from "./theme-pack.js";

import {
  REPO_ROOT,
  SOURCE_ID,
  createMaterialProject,
  plan,
  colorPage,
  writeDesignMaterial,
  writeDesignManifest,
} from "./template-design-gates.support.js";

describe("template design source gates", () => {
  it("lets a negation or style-reference brief skip the template and still refuses its red", async (t) => {
    const briefs = ["不要使用附件模板的配色、字体或 Logo，设计请自行决定。", "这份模板只作风格参考，设计请自行决定。"];
    for (const [index, brief] of briefs.entries()) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), `template-skip-${index}-`));
      t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
      const projectRoot = createMaterialProject(temp);
      createEmptyProject(projectRoot, { title: "自行设计" });
      writeDomainRuntime(projectRoot, {
        brief,
        designDirection: "self-directed",
        strictExecution: true,
      });
      const run = createPresentationRun({ repoRoot: REPO_ROOT });
      const handle = await run.open({
        projectRoot,
        sessionId: `template-skip-${index}`,
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
      const args = {
        slidePlan: plan(),
        adoptedSourceIds: ["consulting/pine-green-strategy"],
      };
      let committed = await run.execute(
        { name: "commit_design", args },
        { ...context, toolCallId: `skip-commit-${index}-0` },
      );
      for (let attempt = 0; !committed.ok && attempt < 3; attempt += 1) {
        assert.equal(committed.payload.error, "required_source_chunks_unread", committed.detail);
        assert.equal(((committed.payload.missingMaterialChunks as unknown[]) ?? []).length, 0, committed.detail);
        const missing = (committed.payload.missingReferenceChunks ?? []) as {
          sourceId: string;
          chunkIndex: number;
        }[];
        assert.ok(missing.length > 0, committed.detail);
        for (const chunk of missing) {
          const read = await run.execute(
            {
              name: "read_reference",
              args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex },
            },
            { ...context, toolCallId: `skip-ref-${index}-${attempt}-${chunk.chunkIndex}` },
          );
          assert.equal(read.ok, true, read.detail);
        }
        committed = await run.execute(
          { name: "commit_design", args },
          { ...context, toolCallId: `skip-commit-${index}-${attempt + 1}` },
        );
      }
      assert.equal(committed.ok, true, committed.detail);
      assert.match(String(committed.payload.hint), new RegExp(SOURCE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(String(committed.payload.hint), /尚未采用/);
      const todo = await run.execute(
        { name: "write_todo", args: { items: plan() } },
        { ...context, toolCallId: `skip-todo-${index}` },
      );
      assert.equal(todo.ok, true, todo.detail);
      const written = await run.execute(
        { name: "write_page", args: colorPage("#03522C") },
        { ...context, toolCallId: `skip-page-${index}` },
      );
      assert.equal(written.ok, true, written.detail);
      const foreign = await run.execute(
        { name: "write_page", args: colorPage("#C8102E") },
        { ...context, toolCallId: `skip-foreign-${index}` },
      );
      assert.equal(foreign.ok, false);
      assert.match(foreign.detail, /#C8102E/);
      assert.notEqual(loadProject(projectRoot).presentation.theme?.colors?.accent1, "#C8102E");
      const runtime = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "runtime.json"), "utf8")) as {
        designDirection?: string;
      };
      assert.notEqual(runtime.designDirection, "user-design");
    }
  });

  it("adopts only the first of two templates for theme keys and ignores an unadopted palette", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-two-brands-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = path.join(temp, "project");
    const brandA = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-brand-a.pptx",
      name: "品牌A.pptx",
      palette: { accent1: "#C8102E", dk1: "#1A1A1A", lt1: "#FFFFFF" },
      major: { latin: "Arial", ea: "微软雅黑" },
      minor: { latin: "Georgia", ea: "宋体" },
    };
    const brandB = {
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-brand-b.pptx",
      name: "品牌B.pptx",
      palette: { accent1: "#112233", dk1: "#445566", lt1: "#778899" },
      major: { latin: "Times New Roman", ea: "黑体" },
      minor: { latin: "Verdana", ea: "楷体" },
    };
    createEmptyProject(projectRoot, { title: "两个品牌" });
    writeDesignMaterial(projectRoot, brandA);
    writeDesignMaterial(projectRoot, brandB);
    writeDesignManifest(projectRoot, [brandA, brandB]);
    const brief = "A 的配色、字体和 Logo 用于视觉，B 只提供文字内容。";
    writeDomainRuntime(projectRoot, {
      brief,
      designDirection: "self-directed",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "template-two-brands",
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
    const readDesign = async (materialId: string) => {
      const count = materialChunkCount(verifyMaterial(projectRoot, materialId), "design");
      for (let offset = 0; offset < count; offset += 1) {
        const read = await run.execute(
          { name: "read_material", args: { materialId, part: "design", offset } },
          { ...context, toolCallId: `brand-read-${materialId}-${offset}` },
        );
        assert.equal(read.ok, true, read.detail);
      }
    };
    await readDesign(brandA.id);
    const references = await run.execute(
      { name: "list_references", args: {} },
      { ...context, toolCallId: "brand-list-references" },
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
        { ...context, toolCallId: `brand-ref-${chunk.sourceId}-${chunk.chunkIndex}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
    const onlyA = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [`material:${brandA.id}`] },
      },
      { ...context, toolCallId: "brand-only-a" },
    );
    assert.equal(onlyA.ok, true, onlyA.detail);
    assert.equal(onlyA.payload.hint, undefined);
    const paletteA = packColorWriteContext([`material:${brandA.id}`], projectRoot);
    assert.equal(paletteA.adoptedPackHexes?.has("#C8102E"), true);
    assert.equal(paletteA.adoptedPackHexes?.has("#112233"), false);
    assert.equal(paletteA.adoptedPackHexes?.has("#445566"), false);
    let theme = loadProject(projectRoot).presentation.theme;
    assert.equal(theme?.colors?.accent1, "#C8102E");
    assert.deepEqual(theme?.textStyles?.schemeMajor?.fontFamily, {
      latin: "Arial",
      ea: "微软雅黑",
    });

    await readDesign(brandB.id);
    const both = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          adoptedSourceIds: [`material:${brandA.id}`, `material:${brandB.id}`],
        },
      },
      { ...context, toolCallId: "brand-a-then-b" },
    );
    assert.equal(both.ok, true, both.detail);
    theme = loadProject(projectRoot).presentation.theme;
    assert.equal(theme?.colors?.accent1, "#C8102E");
    assert.deepEqual(theme?.textStyles?.schemeMajor?.fontFamily, {
      latin: "Arial",
      ea: "微软雅黑",
    });
    assert.deepEqual(theme?.textStyles?.schemeMinor?.fontFamily, { latin: "Georgia", ea: "宋体" });
    assert.notEqual(theme?.colors?.accent1, "#112233");
  });

  it("returns a Chinese hint when templates are attached and none is adopted", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-hint-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    createEmptyProject(projectRoot, { title: "提示" });
    const brief = "做一份说明。";
    writeDomainRuntime(projectRoot, {
      brief,
      designDirection: "self-directed",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "template-hint",
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
    let committed = await run.execute(
      { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: [] } },
      { ...context, toolCallId: "hint-commit-0" },
    );
    for (let attempt = 0; !committed.ok && attempt < 3; attempt += 1) {
      assert.equal(committed.payload.error, "required_source_chunks_unread", committed.detail);
      const missing = (committed.payload.missingReferenceChunks ?? []) as {
        sourceId: string;
        chunkIndex: number;
      }[];
      assert.equal(((committed.payload.missingMaterialChunks as unknown[]) ?? []).length, 0);
      for (const chunk of missing) {
        const read = await run.execute(
          {
            name: "read_reference",
            args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex },
          },
          { ...context, toolCallId: `hint-ref-${attempt}-${chunk.sourceId}-${chunk.chunkIndex}` },
        );
        assert.equal(read.ok, true, read.detail);
      }
      committed = await run.execute(
        { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: [] } },
        { ...context, toolCallId: `hint-commit-${attempt + 1}` },
      );
    }
    assert.equal(committed.ok, true, committed.detail);
    assert.match(String(committed.payload.hint), /品牌模板|brand\.pptx/);
    assert.match(String(committed.payload.hint), new RegExp(SOURCE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("reuses the latest adopted source order when a later plan omits adoptedSourceIds", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-adoption-order-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = path.join(temp, "project");
    const brandA = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-brand-a.pptx",
      name: "品牌A.pptx",
      palette: { accent1: "#C8102E", dk1: "#1A1A1A", lt1: "#FFFFFF" },
      major: { latin: "Arial", ea: "微软雅黑" },
      minor: { latin: "Georgia", ea: "宋体" },
    };
    const brandB = {
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-brand-b.pptx",
      name: "品牌B.pptx",
      palette: { accent1: "#112233", dk1: "#445566", lt1: "#778899" },
      major: { latin: "Times New Roman", ea: "黑体" },
      minor: { latin: "Verdana", ea: "楷体" },
    };
    const sourceA = `material:${brandA.id}`;
    const sourceB = `material:${brandB.id}`;
    createEmptyProject(projectRoot, { title: "采纳顺序" });
    writeDesignMaterial(projectRoot, brandA);
    writeDesignMaterial(projectRoot, brandB);
    writeDesignManifest(projectRoot, [brandA, brandB]);
    const brief = "两份附件设计源都采用，主品牌放在 adoptedSourceIds 的第一位。";
    writeDomainRuntime(projectRoot, {
      brief,
      designDirection: "self-directed",
      editorBaseUrl: "http://127.0.0.1:55200",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "template-adoption-order",
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
    const readDesign = async (materialId: string) => {
      const count = materialChunkCount(verifyMaterial(projectRoot, materialId), "design");
      for (let offset = 0; offset < count; offset += 1) {
        const read = await run.execute(
          { name: "read_material", args: { materialId, part: "design", offset } },
          { ...context, toolCallId: `order-read-${materialId}-${offset}` },
        );
        assert.equal(read.ok, true, read.detail);
      }
    };
    await readDesign(brandA.id);
    await readDesign(brandB.id);
    const references = await run.execute(
      { name: "list_references", args: {} },
      { ...context, toolCallId: "order-list-references" },
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
        { ...context, toolCallId: `order-ref-${chunk.sourceId}-${chunk.chunkIndex}` },
      );
      assert.equal(read.ok, true, read.detail);
    }

    const first = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [sourceA, sourceB] },
      },
      { ...context, toolCallId: "order-commit-ab" },
    );
    assert.equal(first.ok, true, first.detail);
    assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, "#C8102E");

    const second = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [sourceB, sourceA] },
      },
      { ...context, toolCallId: "order-commit-ba" },
    );
    assert.equal(second.ok, true, second.detail);
    assert.deepEqual(second.payload.adoptedSourceIds, [sourceB, sourceA]);
    let theme = loadProject(projectRoot).presentation.theme;
    assert.equal(theme?.colors?.accent1, "#112233");
    assert.deepEqual(theme?.textStyles?.schemeMajor?.fontFamily, brandB.major);
    // Receipts stay an insertion-order audit trail. They must not become the selection.
    assert.deepEqual(
      listSourceReceipts(projectRoot)
        .filter((row) => row.sourceId.startsWith("material:"))
        .map((row) => row.sourceId),
      [sourceA, sourceB],
    );

    const todo = await run.execute(
      { name: "write_todo", args: { items: plan() } },
      { ...context, toolCallId: "order-todo" },
    );
    assert.equal(todo.ok, true, todo.detail);
    assert.deepEqual(todo.payload.adoptedSourceIds, [sourceB, sourceA]);
    theme = loadProject(projectRoot).presentation.theme;
    assert.equal(theme?.colors?.accent1, "#112233");
    assert.deepEqual(theme?.textStyles?.schemeMajor?.fontFamily, brandB.major);
    assert.deepEqual(theme?.textStyles?.schemeMinor?.fontFamily, brandB.minor);
    const palette = packColorWriteContext(todo.payload.adoptedSourceIds as string[], projectRoot);
    for (const hex of ["#112233", "#445566", "#778899", "#C8102E", "#1A1A1A", "#FFFFFF"]) {
      assert.equal(palette.adoptedPackHexes?.has(hex), true, hex);
    }
    assert.deepEqual(palette.adoptedDesignSourceIds, [sourceB, sourceA]);
    const runtime = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "runtime.json"), "utf8")) as {
      adoptedSourceIds?: string[];
    };
    assert.deepEqual(runtime.adoptedSourceIds, [sourceB, sourceA]);
    assert.deepEqual(
      listSourceReceipts(projectRoot)
        .filter((row) => row.sourceId.startsWith("material:"))
        .map((row) => row.sourceId),
      [sourceA, sourceB],
    );

    const restarted = createPresentationRun({ repoRoot: REPO_ROOT });
    const again = restarted.hydrate(projectRoot);
    assert.ok(again);
    const todoAgain = await restarted.execute(
      { name: "write_todo", args: { items: plan() } },
      {
        runId: again.runId,
        sessionId: again.sessionId,
        projectRoot,
        abortSignal: new AbortController().signal,
        toolCallId: "order-restart-todo",
      },
    );
    assert.equal(todoAgain.ok, true, todoAgain.detail);
    assert.deepEqual(todoAgain.payload.adoptedSourceIds, [sourceB, sourceA]);
    theme = loadProject(projectRoot).presentation.theme;
    assert.equal(theme?.colors?.accent1, "#112233");
    assert.deepEqual(theme?.textStyles?.schemeMajor?.fontFamily, brandB.major);
    const restartedRuntime = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "runtime.json"), "utf8")) as {
      adoptedSourceIds?: string[];
    };
    assert.deepEqual(restartedRuntime.adoptedSourceIds, [sourceB, sourceA]);
  });
});
