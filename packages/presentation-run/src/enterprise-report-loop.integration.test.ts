import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "./capabilities.js";
import { createPresentationRun } from "./run.js";
import { readVerifiedDelivery } from "./export-deck.js";
import { renderFixturePage } from "./domain/composed-deck.testkit.js";
import { materialChunkCount, readMaterialChunk } from "./domain/material-content.js";
import { verifyMaterial } from "./domain/material-pack.js";
import { persistPageKey } from "./domain/page-identity.js";
import { readDesignAuthority } from "./domain/design-authority.js";
import { readRecordedReportRequirements } from "./domain/report-authority.js";
import {
  authorizePageEdits,
  currentPageRevision,
  ensureRunLedger,
  readRunLedger,
  recordMaterialChunk,
  type TodoFact,
} from "./domain/run-ledger.js";
import type { PresentationCommand } from "./types.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(PKG, "../..");
const HUB_PACK = "finance/honey-orange-memo";
const BRAND_RED = "#C8102E";
const INK = "#500612";

/** A fixed six-page management report whose page order and roles come from the user. */
const BRIEF =
  "向管理层汇报 2026 年第三季度运营情况，固定 6 页。页序：1 结论、2 关键指标、3 问题与原因、" +
  "4 风险、5 行动计划、6 资源需求。背景保持白色，金额统一写万元。";

const ROLES = [
  "第 1 页给出本季度结论",
  "第 2 页列出关键指标",
  "第 3 页说明问题与原因",
  "第 4 页列出风险",
  "第 5 页给出行动计划",
  "第 6 页提出资源需求",
] as const;

const PAGE_IDS = ["p01", "p02", "p03", "p04", "p05", "p06"] as const;

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function addBrandTemplate(projectRoot: string): void {
  const id = "brand";
  const dir = path.join(projectRoot, "_agent", "materials", id);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from("synthetic-enterprise-template");
  fs.writeFileSync(path.join(dir, "original.pptx"), original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: id,
      status: "ok",
      source: { sha256: sha256(original) },
      parser: { id: "pptx-ooxml-v1" },
      "deck-template": {
        slides: [
          { index: 1, title: "结论", text: "本章结论" },
          { index: 2, title: "指标", text: "关键指标" },
        ],
        masters: [],
        templateDetail: {},
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  const markdown = Buffer.from(`【Color Palette】\n- accent1: ${BRAND_RED}\n`);
  const sourceJson = Buffer.from(
    `${JSON.stringify({ version: 1, layouts: [], themeColors: { accent1: BRAND_RED } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, "design-source.md"), markdown);
  fs.writeFileSync(path.join(dir, "design-source.json"), sourceJson);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    `${JSON.stringify({
      version: 1,
      id,
      name: "brand.pptx",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalSha256: sha256(original),
      derivativeSha256: sha256(derivative),
      designSourceMdSha256: sha256(markdown),
      designSourceJsonSha256: sha256(sourceJson),
    })}\n`,
  );
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      materials: [
        {
          id,
          name: "brand.pptx",
          kind: "deck-template",
          summaryZh: "合成企业模板",
          parser: "pptx-ooxml-v1",
          sha256: sha256(original),
          parts: [],
        },
      ],
    })}\n`,
  );
}

function readWholePart(projectRoot: string, part: string, epoch: string): void {
  const material = verifyMaterial(projectRoot, "brand");
  const count = materialChunkCount(material, part, {});
  for (let index = 0; index < count; index += 1) {
    const chunk = readMaterialChunk({ material, part, offset: index });
    recordMaterialChunk(
      projectRoot,
      { commandId: `read-${part}-${index}`, contextEpochId: epoch },
      {
        materialId: "brand",
        materialSha256: material.sha256,
        part: chunk.part,
        chunkIndex: index,
        chunkSha256: chunk.chunkSha256,
      },
    );
  }
}

function writeStyleQuestion(projectRoot: string, status: "cancelled" | "answered", epoch: string): void {
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "assistant-questions.v1.json"),
    `${JSON.stringify([
      {
        id: "q-style",
        at: "2026-11-14T00:00:00Z",
        contextEpochId: epoch,
        questions: [
          {
            id: "style",
            question: "配色以企业模板还是首页所选风格为准？",
            options: [{ label: "以企业模板为准" }, { label: "保留首页风格" }],
          },
        ],
        status,
        ...(status === "answered"
          ? {
              answer: { answers: [{ id: "style", selected: ["以企业模板为准"] }] },
              answeredAt: "2026-11-14T00:00:01Z",
            }
          : {}),
      },
    ])}\n`,
  );
}

function fixture(t: TestContext): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-report-loop-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  createEmptyProject(root, { title: "合成企业汇报" });
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "runtime.json"),
    `${JSON.stringify({ brief: BRIEF, strictExecution: true, designSystemId: HUB_PACK })}\n`,
  );
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "e".repeat(64),
    requirementsId: "enterprise-report-loop",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: true, structuralReviewRequired: true },
  });
  addBrandTemplate(root);
  return root;
}

async function openRun(root: string) {
  const run = createPresentationRun({ repoRoot: REPO });
  const handle = await run.open({
    projectRoot: root,
    sessionId: "enterprise-report",
    brief: BRIEF,
    editorBaseUrl: "http://127.0.0.1:55200",
    design: { kind: "explicit-style", designSystemId: HUB_PACK },
    provider: { providerId: "offline", modelId: "fixture" },
  });
  const ctx = (toolCallId: string) => ({
    runId: handle.runId,
    sessionId: handle.sessionId,
    toolCallId,
    projectRoot: root,
    abortSignal: new AbortController().signal,
  });
  return { run, ctx, epoch: run.epochFor(handle.sessionId) };
}

type Run = Awaited<ReturnType<typeof openRun>>["run"];
type Ctx = Awaited<ReturnType<typeof openRun>>["ctx"];

async function readMissingReferences(run: Run, ctx: Ctx): Promise<void> {
  const listed = await run.execute({ name: "list_references", args: {} }, ctx("refs"));
  for (const chunk of (listed.payload.missingReferenceChunks ?? []) as {
    sourceId: string;
    chunkIndex: number;
  }[]) {
    const read = await run.execute(
      { name: "read_reference", args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex } },
      ctx(`ref-${chunk.sourceId}-${chunk.chunkIndex}`),
    );
    assert.equal(read.ok, true, read.detail);
  }
}

function slidePlan(count: number = PAGE_IDS.length) {
  return PAGE_IDS.slice(0, count).map((pageId, index) => ({
    pageId,
    title: `合成页面 ${pageId}`,
    layoutFamily: "content",
    exhibits: [],
    purpose: ROLES[index],
  }));
}

const REQUIREMENTS = [
  {
    id: "white-ground",
    role: "explicit-requirement",
    statement: "背景保持白色",
    origin: { kind: "user-request" },
  },
  {
    id: "unit-wan",
    role: "explicit-requirement",
    statement: "金额统一写万元",
    origin: { kind: "user-request" },
  },
  {
    id: "brand-structure",
    role: "explicit-requirement",
    statement: "结论与指标页沿用企业模板前两页的职责",
    origin: { kind: "user-request" },
    material: { materialId: "brand", sourcePages: [1, 2] },
  },
  {
    id: "brand-style",
    role: "design-reference",
    statement: "配色参考企业模板",
    origin: { kind: "user-request" },
    material: { materialId: "brand", parts: ["design"] },
  },
];

function planCommand(extra: Record<string, unknown> = {}, count: number = PAGE_IDS.length): PresentationCommand {
  return {
    name: "commit_design",
    args: {
      slidePlan: slidePlan(count),
      adoptedSourceIds: ["material:brand"],
      designAspects: [{ source: "material:brand", aspects: ["palette"] }],
      reportRequirements: REQUIREMENTS,
      ...extra,
    },
  };
}

function pageInput(pageId: string, title: string, body: string) {
  return {
    id: pageId,
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 40, 800, 60],
        content: { text: title, fontSize: 28, color: INK },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [80, 160, 800, 120],
        content: { text: body, fontSize: 20, color: INK },
      },
      {
        elementId: "accent",
        elementType: "shape",
        shapeName: "rect",
        bounds: [80, 120, 120, 6],
        fill: { type: "solid", color: BRAND_RED },
      },
    ],
  };
}

function bodyOf(pageId: string): string {
  return `${pageId}：成本 120 万元，同比下降。`;
}

function diskOrder(root: string): string[] {
  return loadProject(root).pages.map((entry) => persistPageKey(entry.path));
}

function pageFileHashes(root: string): Record<string, string> {
  return Object.fromEntries(
    loadProject(root).pages.map((entry) => [
      persistPageKey(entry.path),
      sha256(fs.readFileSync(path.join(root, entry.path))),
    ]),
  );
}

function runtime(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8")) as Record<string, unknown>;
}

function committedPlan(root: string): TodoFact {
  const fact = [...(readRunLedger(root)?.facts ?? [])]
    .reverse()
    .find((item): item is TodoFact => item.type === "todo.committed");
  assert.ok(fact, "a committed plan is required");
  return fact;
}

async function deliverReport(root: string, run: Run, ctx: Ctx, epoch: string): Promise<void> {
  readWholePart(root, "design", epoch);
  await readMissingReferences(run, ctx);

  // A page-role requirement that rests on the template's slides is not met by the design read.
  const early = await run.execute(
    planCommand({ adoptedSourceIds: [], designAspects: [] }),
    ctx("plan-before-slides-read"),
  );
  assert.equal(early.ok, false);
  assert.equal(early.payload.error, "required_source_chunks_unread");
  assert.equal(readRecordedReportRequirements(root), undefined);

  readWholePart(root, "slides", epoch);
  writeStyleQuestion(root, "cancelled", epoch);
  const decision = {
    designAuthority: {
      source: "material:brand",
      origin: { kind: "clarification-answer", questionId: "style", text: "以企业模板为准" },
    },
  };
  const cancelled = await run.execute(planCommand(decision), ctx("plan-cancelled"));
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.payload.error, "clarification_not_answered");
  assert.equal(readDesignAuthority(root).kind, "absent");

  writeStyleQuestion(root, "answered", epoch);
  const fiveRefused = await run.execute(planCommand(decision, 5), ctx("plan-five"));
  assert.equal(fiveRefused.ok, false);
  assert.equal(fiveRefused.payload.error, "page_count_mismatch");

  const planned = await run.execute(planCommand(decision), ctx("plan-six"));
  assert.equal(planned.ok, true, planned.detail);

  for (const pageId of ["p03", "p01", "p06", "p02", "p05", "p04"]) {
    const written = await run.execute(
      { name: "write_page", args: pageInput(pageId, `合成页面 ${pageId}`, bodyOf(pageId)) },
      ctx(`write-${pageId}`),
    );
    assert.equal(written.ok, true, written.detail);
    // No browser runs here: the raster is the synthetic one the shared testkit records.
    renderFixturePage(root, pageId);
  }
  const reviewed = await run.execute({ name: "review_pages", args: {} }, ctx("review"));
  assert.equal(reviewed.ok, true, reviewed.detail);
  const composed = await run.execute({ name: "compose_deck", args: { title: "合成企业汇报" } }, ctx("compose"));
  assert.equal(composed.ok, true, composed.detail);
}

describe("synthetic enterprise report through the production seams", () => {
  it("keeps requirements, exact count, page roles and order from plan to editable export", async (t) => {
    const root = fixture(t);
    const { run, ctx, epoch } = await openRun(root);
    await deliverReport(root, run, ctx, epoch);

    assert.deepEqual(diskOrder(root), [...PAGE_IDS], "compose restores the planned order");
    assert.deepEqual(
      committedPlan(root).pagePlan?.map((entry) => entry.purpose),
      [...ROLES],
      "the committed plan keeps every page role in order",
    );
    assert.deepEqual(
      readRecordedReportRequirements(root)?.map((item) => `${item.id}:${item.role}`),
      [
        "white-ground:explicit-requirement",
        "unit-wan:explicit-requirement",
        "brand-structure:explicit-requirement",
        "brand-style:design-reference",
      ],
      "mandatory rules and the style reference stay separate roles",
    );
    const authority = runtime(root).designAuthority as { source?: string };
    assert.equal(authority.source, "material:brand");
    assert.equal(runtime(root).designSystemId, HUB_PACK, "the Hub choice stays as history");
    assert.equal(
      readRunLedger(root)!.facts.some((fact) => fact.type === "page.edit-authorized"),
      false,
      "planning and a style answer grant no page edit authority",
    );

    const exported = await run.execute({ name: "export_deck", args: {} }, ctx("export"));
    assert.equal(exported.ok, true, exported.detail);
    assert.equal(exported.payload.slideCount, 6);
    const delivery = readVerifiedDelivery(root);
    assert.ok(delivery, "the export is backed by a verified receipt");
    assert.equal(fs.existsSync(path.join(root, delivery.artifactPath)), true);
  });

  it("limits a same-page comment batch to its authorized pages and refuses stale baselines", async (t) => {
    const root = fixture(t);
    const { run, ctx, epoch } = await openRun(root);
    await deliverReport(root, run, ctx, epoch);
    const before = pageFileHashes(root);

    const second = currentPageRevision(root, "p02");
    const fifth = currentPageRevision(root, "p05");
    assert.ok(second && fifth);
    authorizePageEdits(root, [
      {
        authorizationId: "comment-batch:enterprise",
        pageId: "p02",
        revision: second.revision,
        pageSha256: second.pageSha256,
      },
      {
        authorizationId: "comment-batch:enterprise",
        pageId: "p05",
        revision: fifth.revision,
        pageSha256: fifth.pageSha256,
      },
    ]);

    const unauthorized = await run.execute(
      { name: "write_page", args: pageInput("p04", "越权改动", "不应写入") },
      ctx("edit-unauthorized"),
    );
    assert.equal(unauthorized.ok, false, "a page outside the batch stays locked");
    assert.deepEqual(pageFileHashes(root)["p04"], before["p04"]);

    const edited = await run.execute(
      { name: "write_page", args: pageInput("p02", "合成页面 p02（已改）", bodyOf("p02")) },
      ctx("edit-authorized"),
    );
    assert.equal(edited.ok, true, edited.detail);
    const after = pageFileHashes(root);
    assert.notEqual(after["p02"], before["p02"], "the authorized target changed");
    for (const id of PAGE_IDS.filter((entry) => entry !== "p02")) {
      assert.equal(after[id], before[id], `${id} is outside the edited target`);
    }
    assert.deepEqual(diskOrder(root), [...PAGE_IDS]);

    assert.throws(
      () =>
        authorizePageEdits(root, [
          {
            authorizationId: "comment-batch:stale",
            pageId: "p02",
            revision: second.revision,
            pageSha256: second.pageSha256,
          },
        ]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "EDIT_PAGE_REVISION_STALE");
        return true;
      },
    );
  });
});
