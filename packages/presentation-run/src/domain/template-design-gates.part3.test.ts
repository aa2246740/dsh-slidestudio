import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "@open-slidestudio/exporter-native";
import { createPresentationRun } from "../run.js";
import { listSourceReceipts, recordSourceReceipt } from "../receipts.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { ensureRunLedger, inspectRunLedger, recordMaterialChunk } from "./run-ledger.js";
import { readMaterialChunk, materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { executeGenerateTool, type AgentToolState } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import { PACK_COLOR_ERROR, packColorWriteContext } from "./theme-pack.js";
import { writePageSchemaError, writePageSchemaIssues } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";

import {
  REPO_ROOT,
  TEMPLATE_ID,
  SOURCE_ID,
  createMaterialProject,
  plan,
  chartSeriesPage,
} from "./template-design-gates.support.js";

describe("template design source gates", () => {
  it("refuses unknown and tampered material source ids instead of skipping non-catalog ids", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-invalid-"));
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
      sessionId: "template-invalid",
      brief: "公司介绍",
      editorBaseUrl: "http://127.0.0.1:55200",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "offline" },
    });
    const context = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot,
      abortSignal: new AbortController().signal,
      toolCallId: "unknown-material",
    };
    const unknown = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: ["material:not-present"] },
      },
      context,
    );
    assert.equal(unknown.ok, false);
    assert.match(unknown.detail, /material:not-present/);
    assert.match(unknown.detail, /资料|设计源|校验/);

    fs.appendFileSync(path.join(projectRoot, "_agent", "materials", TEMPLATE_ID, "design-source.json"), " ");
    const tampered = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [SOURCE_ID] },
      },
      { ...context, toolCallId: "tampered-material" },
    );
    assert.equal(tampered.ok, false);
    assert.match(tampered.detail, /已变化|回执|校验|重新上传/);
  });

  it("adopts a template, accepts a chart in accent1 plus documented tints, and exports those colors with the workbook", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-chart-tints-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    recordSourceReceipt(projectRoot, { sourceId: SOURCE_ID, state: "adopted" });
    const context = packColorWriteContext([SOURCE_ID], projectRoot);
    const accent1 = "#C8102E";
    const tint20 = "#D34058";
    const tint40 = "#DE7082";
    const chart = {
      elementId: "revenue-chart",
      elementType: "chart" as const,
      bounds: [40, 80, 880, 400] as [number, number, number, number],
      title: "营收",
      data: {
        cols: ["年", "产品", "服务", "其他"],
        rows: [
          ["2023", 1200, 800, 400],
          ["2024", 1580, 900, 500],
          ["2025", 2100, 1100, 600],
        ],
      },
      series: [
        { type: "bar", name: "产品", encode: { x: "年", y: "产品" }, fill: accent1 },
        { type: "bar", name: "服务", encode: { x: "年", y: "服务" }, fill: tint20 },
        { type: "bar", name: "其他", encode: { x: "年", y: "其他" }, fill: tint40 },
        { type: "bar", name: "补充", encode: { x: "年", y: "其他" }, fill: "#E99FAB" },
      ],
    };
    const skillPage: SkillPageInput = {
      id: "revenue",
      pageType: "content",
      elements: [
        chart,
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 24, 600, 40],
          content: { text: "营收", fontSize: 24, color: accent1 },
        },
      ],
    };
    assert.equal(
      writePageSchemaIssues(skillPage, context).some((issue) => issue.code === "pack_color"),
      false,
    );

    const project = createEmptyProject(projectRoot, { title: "模板图表" });
    const page = titleOnlyCoverPage("营收");
    page.elements = [chart];
    listComposedPage(project, "pages/revenue.page", page);
    saveProject(project);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true);
    assert.ok(result.report.editDataCharts.ok.includes("revenue-chart"));
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.data);
    const chartName = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    assert.ok(chartName);
    const xml = await zip.file(chartName)!.async("string");
    for (const hex of ["C8102E", "D34058", "DE7082", "E99FAB"]) {
      assert.match(xml, new RegExp(`<a:srgbClr val="${hex}"\\/>`));
    }
    assert.doesNotMatch(xml, /F59E0B|10B981/i);
    for (const value of ["1200", "1580", "2100"]) {
      assert.match(xml, new RegExp(`<c:v>${value}</c:v>`));
    }
    const workbookName = Object.keys(zip.files).find((name) => /^ppt\/embeddings\/.+\.xlsx$/.test(name));
    assert.ok(workbookName, "embedded chart workbook present");
    const workbook = await JSZip.loadAsync(await zip.file(workbookName)!.async("uint8array"));
    const sheet = await workbook.file("xl/worksheets/sheet1.xml")?.async("string");
    assert.ok(sheet);
    for (const value of ["1200", "1580", "2100"]) assert.match(sheet, new RegExp(value));
  });

  it("refuses a foreign string series fill through the shared palette and both in-package callers", (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-series-fill-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    const context = packColorWriteContext([SOURCE_ID], projectRoot);
    for (const fill of ["#C8102E", "#D34058", "#DE7082", "#E99FAB", "#A00D25", "#780A1C", "#500612"]) {
      assert.equal(
        writePageSchemaIssues(chartSeriesPage(fill), context).some((issue) => issue.code === "pack_color"),
        false,
        fill,
      );
    }
    const foreign = chartSeriesPage("#3366FF");
    const foreignError = writePageSchemaError(writePageSchemaIssues(foreign, context), foreign, context);
    assert.equal(foreignError?.error, "pack_color");
    assert.match(foreignError?.detail ?? "", /已采用的设计源/);
    assert.match(foreignError?.detail ?? "", /#3366FF/);

    createEmptyProject(projectRoot, { title: "营收" });
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
    const accepted = executeGenerateTool("write_page", chartSeriesPage("#C8102E"), state);
    assert.equal(accepted.ok, true, accepted.detail);
    const refused = executeGenerateTool("write_page", chartSeriesPage("#3366FF", "revenue-b"), state);
    assert.equal(refused.ok, false);
    assert.equal((refused.payload as Record<string, unknown>).error, PACK_COLOR_ERROR);
    assert.match(refused.detail, /已采用的设计源/);

    const project = loadProject(projectRoot);
    const bad = chartSeriesPage("#3366FF", "ledger");
    listComposedPage(project, "pages/ledger.page", {
      pageType: "content",
      elements: bad.elements,
    });
    saveProject(project);
    ensureRunLedger(projectRoot, {
      manifestSha256: "d".repeat(64),
      requirementsId: "series-fill",
      requirements: [],
    });
    const blocked = inspectRunLedger(projectRoot);
    assert.equal(
      blocked.composeBlockers.some((blocker) => blocker.includes("ledger: pack_color")),
      true,
      blocked.composeBlockers.join("; "),
    );
  });

  it("canonicalizes both material aliases and refuses unknown or malformed ids in Chinese", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-alias-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp, TEMPLATE_ID, true);
    createEmptyProject(projectRoot, { title: "公司介绍" });
    const brief = "请采用附件模板的配色、字体和 Logo。";
    writeDomainRuntime(projectRoot, {
      brief,
      designDirection: "self-directed",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "template-alias",
      brief,
      editorBaseUrl: "http://127.0.0.1:55200",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "offline" },
    });
    const base = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot,
      abortSignal: new AbortController().signal,
    };
    const aliases = [`openkimi:${SOURCE_ID}`, `openkimi-preview:${SOURCE_ID}`];
    for (const [index, alias] of aliases.entries()) {
      const commit = await run.execute(
        { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: [alias] } },
        { ...base, toolCallId: `alias-commit-${index}` },
      );
      assert.equal(commit.ok, false, commit.detail);
      assert.equal(commit.payload.error, "required_source_chunks_unread");
      const missing = commit.payload.missingMaterialChunks as {
        sourceId: string;
        chunkIndex: number;
      }[];
      assert.ok(missing.some((chunk) => chunk.sourceId === SOURCE_ID && chunk.chunkIndex === 0));
      const todo = await run.execute(
        { name: "write_todo", args: { items: plan(), adoptedSourceIds: [alias] } },
        { ...base, toolCallId: `alias-todo-${index}` },
      );
      assert.equal(todo.ok, false);
      assert.equal(todo.payload.error, "required_source_chunks_unread");
      const todoMissing = todo.payload.missingMaterialChunks as { sourceId: string }[];
      assert.ok(todoMissing.some((chunk) => chunk.sourceId === SOURCE_ID));
    }

    for (const bad of [
      "material:../secret",
      "openkimi:material:foo/bar",
      `openkimi:openkimi:${SOURCE_ID}`,
      "openkimi:material:missing-template",
    ]) {
      const refused = await run.execute(
        { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: [bad] } },
        { ...base, toolCallId: `bad-${bad}` },
      );
      assert.equal(refused.ok, false, bad);
      assert.match(refused.detail, /无法采用|资料不存在|校验/);
      assert.match(refused.detail, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    fs.appendFileSync(path.join(projectRoot, "_agent", "materials", TEMPLATE_ID, "design-source.json"), " ");
    const tampered = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [`openkimi:${SOURCE_ID}`] },
      },
      { ...base, toolCallId: "alias-tampered" },
    );
    assert.equal(tampered.ok, false);
    assert.match(tampered.detail, /已变化|回执|校验|重新上传/);
    assert.match(tampered.detail, new RegExp(SOURCE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("stores the canonical id after an alias commit and ignores an older epoch", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-alias-ok-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = createMaterialProject(temp);
    createEmptyProject(projectRoot, { title: "公司介绍" });
    const brief = "请采用附件模板的配色、字体和 Logo。";
    writeDomainRuntime(projectRoot, {
      brief,
      designDirection: "self-directed",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "template-alias-ok",
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
    const material = verifyMaterial(projectRoot, TEMPLATE_ID);
    const oldChunk = readMaterialChunk({ material, part: "design", offset: 0 });
    recordMaterialChunk(
      projectRoot,
      { commandId: "old-alias-read", contextEpochId: "prior-epoch" },
      {
        materialId: TEMPLATE_ID,
        materialSha256: material.sha256,
        part: "design",
        chunkIndex: oldChunk.chunkIndex,
        chunkSha256: oldChunk.chunkSha256,
      },
    );
    const stale = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [`openkimi-preview:${SOURCE_ID}`] },
      },
      { ...context, toolCallId: "alias-stale-epoch" },
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.payload.error, "required_source_chunks_unread");
    const staleMissing = stale.payload.missingMaterialChunks as { sourceId: string }[];
    assert.ok(staleMissing.some((chunk) => chunk.sourceId === SOURCE_ID));

    const chunkCount = materialChunkCount(material, "design");
    for (let offset = 0; offset < chunkCount; offset += 1) {
      const read = await run.execute(
        { name: "read_material", args: { materialId: TEMPLATE_ID, part: "design", offset } },
        { ...context, toolCallId: `alias-read-${offset}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
    const references = await run.execute(
      { name: "list_references", args: {} },
      { ...context, toolCallId: "alias-list-references" },
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
        { ...context, toolCallId: `alias-ref-${chunk.sourceId}-${chunk.chunkIndex}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
    const committed = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [`openkimi:${SOURCE_ID}`] },
      },
      { ...context, toolCallId: "alias-commit" },
    );
    assert.equal(committed.ok, true, committed.detail);
    assert.deepEqual(committed.payload.adoptedSourceIds, [SOURCE_ID]);
    assert.equal(
      listSourceReceipts(projectRoot).some((row) => row.sourceId === SOURCE_ID && row.state === "adopted"),
      true,
    );
    assert.equal(
      listSourceReceipts(projectRoot).some(
        (row) => row.sourceId === `openkimi:${SOURCE_ID}` || row.sourceId === `openkimi-preview:${SOURCE_ID}`,
      ),
      false,
    );
    const runtime = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "runtime.json"), "utf8")) as {
      designDirection?: string;
    };
    assert.equal(runtime.designDirection, "user-design");
    assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, "#C8102E");
  });
});
