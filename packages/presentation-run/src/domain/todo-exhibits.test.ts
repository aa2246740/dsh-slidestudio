import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { executeGenerateTool, type AgentToolState } from "./agent-tools.js";
import { pageExhibitContracts } from "./agent-page-review.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { resolveTodoExhibits, requestedExhibitIssues, type LayoutReview } from "./layout-qa.js";
import { loadPlaybook } from "./playbook.js";
import { reviewPageExecution } from "./review-page-hand.js";
import { currentPageRevision, ensureRunLedger, readRunLedger, recordPageRevision } from "./run-ledger.js";
import { recordImageEmitted, recordImagePrepared, recordRaster } from "./run-ledger-raster.js";
import type { SkillPageInput } from "./skill-pages.js";

const page = (id: string): SkillPageInput => ({
  id,
  elements: [
    {
      elementId: `${id}-title`,
      elementType: "text",
      bounds: [80, 40, 800, 60],
      content: { text: "合成范围回归测试", fontSize: 28, color: "#111111" },
    },
    {
      elementId: `${id}-body`,
      elementType: "text",
      bounds: [80, 460, 800, 40],
      content: { text: "本页只验证展品声明，不使用任何真实资料。", fontSize: 20, color: "#111111" },
    },
  ],
});
type ExhibitPlanItem = AgentToolState["todos"][number] & {
  pageId: string;
  exhibits: NonNullable<AgentToolState["todos"][number]["exhibits"]>;
};
const plan: ExhibitPlanItem[] = Array.from({ length: 6 }, (_, index): ExhibitPlanItem => ({
  pageId: `p${String(index + 1).padStart(2, "0")}`,
  title: "合成页面",
  layoutFamily: "content",
  exhibits: index === 4 ? ["chart:line"] : ["none"],
  note: index === 4 ? "KPI 的趋势说明" : index === 5 ? "卡片仅作文字说明" : "",
}));
const state = (): AgentToolState => ({
  brief: "合成展品检查，不使用外部资料",
  playbook: loadPlaybook({ hostDefaults: false }),
  todos: [],
  researchNotes: [],
  writtenPages: plan.map(({ pageId }) => page(pageId)),
});
const issues = (value: { payload?: unknown }) =>
  (value.payload as LayoutReview).issues.filter((issue) => issue.code === "missing_requested_exhibit");

test("VAL-FAULT-011: out-of-order disk writes bind table and none by normalized pageId through compose", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exhibit-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "合成展品检查" });
  writeDomainRuntime(root, { brief: "制作两页协作流程说明。" });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    runDomainHand(name, { ...args, __openSlideStudio: { commandId: name, contextEpochId: "order-fixture" } }, root);
  assert.equal(
    (
      await call("write_todo", {
        items: [
          {
            pageId: "pages/P01.page",
            title: "合成数据表",
            layoutFamily: "content",
            exhibits: ["table"],
          },
          { pageId: "p02", title: "合成说明", layoutFamily: "content", exhibits: ["none"] },
        ],
      })
    ).ok,
    true,
  );
  const tablePage = page("p01");
  tablePage.elements.push({
    elementId: "data",
    elementType: "table",
    bounds: [80, 160, 800, 180],
    columnWidths: [400, 400],
    rows: [
      [{ text: "项目" }, { text: "负责人" }],
      [{ text: "核对" }, { text: "协作组" }],
    ],
  });
  for (const content of [page("p02"), tablePage]) {
    const written = await call("write_page", content);
    assert.equal(written.ok, true, written.detail);
  }
  assert.deepEqual(
    loadProject(root).pages.map((entry) => entry.path),
    ["pages/p02.page", "pages/p01.page"],
  );
  assert.equal(loadProject(root).pages[1]?.page.elements[2]?.elementType, "table");
  const reviewed = await call("review_pages");
  assert.deepEqual(issues(reviewed), []);
  assert.equal(reviewed.ok, true, reviewed.detail);
  const composed = await call("compose_deck", { title: "协作流程说明" });
  assert.equal(composed.ok, true, composed.detail);
  assert.ok(readRunLedger(root)?.facts.some((fact) => fact.type === "deck.composed"));
});

test("VAL-FAULT-011: positional compatibility is only for entirely id-less legacy plans", () => {
  const run = state();
  run.writtenPages = [page("p02"), page("p01")];
  run.todos = [
    { pageId: "pages/P01.page", title: "合成页面", exhibits: ["table"] },
    { pageId: "p02", title: "合成页面", exhibits: ["none"] },
  ];
  assert.deepEqual(
    issues(executeGenerateTool("review_pages", {}, run)).map((issue) => issue.pageId),
    ["p01"],
  );
  run.todos = [
    { title: "合成页面", exhibits: ["table"] },
    { title: "合成页面", exhibits: ["none"] },
  ];
  assert.deepEqual(
    issues(executeGenerateTool("review_pages", {}, run)).map((issue) => issue.pageId),
    ["p02"],
  );
  run.todos = [
    { pageId: "p01", title: "合成页面", exhibits: ["table"] },
    { title: "数据表", exhibits: ["table"] },
  ];
  assert.deepEqual(
    issues(executeGenerateTool("review_pages", {}, run)).map((issue) => issue.pageId),
    ["p01"],
  );
});

test("VAL-FAULT-011: persisted write_todo receipt and review_pages agree after offline replanning", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exhibit-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "合成展品检查" });
  writeDomainRuntime(root, { brief: "合成展品检查，不使用外部资料" });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    runDomainHand(name, { ...args, __openSlideStudio: { commandId: "synthetic", contextEpochId: "fixture" } }, root);
  assert.equal(
    (
      await call("write_todo", {
        items: plan.map((item) => ({ ...item, exhibits: ["kpi-cards"] })),
      })
    ).ok,
    true,
  );
  for (const item of plan) {
    const content = page(item.pageId);
    if (item.pageId === "p05")
      content.elements.push({
        elementId: "trend",
        elementType: "chart",
        bounds: [80, 140, 800, 300],
        data: {
          cols: ["period", "value"],
          rows: [
            ["A", 1],
            ["B", 2],
          ],
        },
        series: [{ type: "line", encode: { x: "period", y: "value" }, fill: "#123456" }],
      });
    const write = await call("write_page", content);
    assert.equal(write.ok, true, write.detail);
  }
  assert.equal(issues(await call("review_pages")).length, 6);
  const receipt = await call("write_todo", { items: plan });
  assert.equal(receipt.ok, true, receipt.detail);
  const committed = (receipt.payload as { items: typeof plan }).items;
  assert.deepEqual(committed[4]?.exhibits, ["chart:line"]);
  assert.deepEqual(committed[5]?.exhibits, ["none"]);
  const review = await call("review_pages");
  assert.deepEqual(issues(review), []);
  assert.equal(review.ok, true, review.detail);
});

test("VAL-FAULT-011: explicit exhibits, empty arrays and none override all keyword inference", () => {
  for (const exhibits of [[], ["none"], ["chart:line"]] as const) {
    const actual = resolveTodoExhibits(
      { title: "KPI 卡片", note: "数据表", exhibits: [...exhibits] },
      4,
      "【第5页】KPI 卡片、数据表",
    );
    assert.deepEqual(actual, exhibits.length ? exhibits : ["none"]);
    assert.deepEqual(requestedExhibitIssues(page("p05"), { title: "KPI 卡片", exhibits: [] }), []);
  }
});

test("VAL-FAULT-011: review_page rejects missing declared chart and honors none", async (t) => {
  const run = state();
  run.todos = plan;
  const pages = [page("p05"), page("p06")];
  const contracts = pageExhibitContracts(run, pages);
  const p05Issues = requestedExhibitIssues(pages[0]!, contracts[0]);
  assert.equal(p05Issues.length, 1);
  assert.equal(p05Issues[0]?.code, "missing_requested_exhibit");
  assert.match(p05Issues[0]?.message ?? "", /chart:line.*plan declaration/i);
  assert.deepEqual(requestedExhibitIssues(pages[1]!, contracts[1]), []);

  run.todos = [{ pageId: "p05", title: "KPI 卡片", layoutFamily: "content" }];
  const undeclared = page("p05");
  const inferred = pageExhibitContracts(run, [undeclared]);
  assert.deepEqual(inferred[0]?.exhibits, ["kpi-cards"]);
  assert.match(requestedExhibitIssues(undeclared, inferred[0])[0]?.message ?? "", /kpi-cards/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-page-exhibit-unit-"));
  const previousVision = process.env.SLIDESTUDIO_VISION_REVIEWER;
  const previousImage = process.env.SLIDESTUDIO_LLM_IMAGE;
  t.after(() => {
    if (previousVision === undefined) delete process.env.SLIDESTUDIO_VISION_REVIEWER;
    else process.env.SLIDESTUDIO_VISION_REVIEWER = previousVision;
    if (previousImage === undefined) delete process.env.SLIDESTUDIO_LLM_IMAGE;
    else process.env.SLIDESTUDIO_LLM_IMAGE = previousImage;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.SLIDESTUDIO_VISION_REVIEWER = "offline-unit";
  delete process.env.SLIDESTUDIO_LLM_IMAGE;
  const project = createEmptyProject(root, { title: "展品声明单页复核" });
  project.pages = ["p05", "p06"].map((pageId) => ({
    path: `pages/${pageId}.page`,
    page: {
      pageType: "content",
      notes: pageId === "p05" ? "KPI 趋势说明" : "卡片仅作文字说明",
      elements: page(pageId).elements,
    },
  }));
  project.presentation.pages = project.pages.map((entry) => entry.path);
  saveProject(project);
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "review-page-exhibits",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: true, structuralReviewRequired: true },
  });
  run.projectRoot = root;
  run.todos = [plan[4]!, plan[5]!];
  const context = { commandId: "review-page-exhibits", contextEpochId: "unit-epoch" };
  const reviewArgs = new Map<string, Record<string, unknown>>();
  for (const pageId of ["p05", "p06"]) {
    const revision = recordPageRevision(root, context, pageId, page(pageId));
    const raster = recordRaster(root, revision, {
      bytes: Buffer.from(`offline raster ${pageId}`),
      src: `_agent/rasters/${pageId}.png`,
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
    recordImageEmitted(root, context, raster.deliveryToken);
    reviewArgs.set(pageId, {
      pageId,
      revision: revision.revision,
      deliveryToken: raster.deliveryToken,
      verdict: "pass",
      issues: [],
    });
  }
  const p05Result = reviewPageExecution(root, context, reviewArgs.get("p05")!, run);
  assert.equal(p05Result.ok, false);
  const missing = p05Result.payload as { error?: string; issues: LayoutReview["issues"] };
  assert.equal(missing.error, "missing_requested_exhibit");
  assert.equal(missing.issues[0]?.code, "missing_requested_exhibit");
  assert.match(missing.issues[0]?.message ?? "", /chart:line.*plan declaration/i);
  assert.equal(
    readRunLedger(root)?.facts.some(
      (fact) => fact.type === "page.visual-review-recorded" && fact.pageId === "p05" && fact.verdict === "pass",
    ),
    false,
  );
  const rejection = readRunLedger(root)
    ?.facts.filter((fact) => fact.type === "page.visual-review-recorded" && fact.pageId === "p05")
    .at(-1);
  assert.ok(rejection?.type === "page.visual-review-recorded");
  assert.equal(rejection?.verdict, "revise");
  assert.match(rejection?.issues[0] ?? "", /missing_requested_exhibit/);

  const p06 = reviewPageExecution(root, context, reviewArgs.get("p06")!, run);
  assert.equal(p06.ok, true);
  assert.deepEqual((p06.payload as { issues: string[] }).issues, []);
});

test("VAL-FAULT-011: offline steps 45–47 review p05 line and p06 none with review_page", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exhibit-run2-review-"));
  const envKeys = ["SLIDESTUDIO_VISION_REVIEWER", "SLIDESTUDIO_LLM_IMAGE"] as const;
  const previous = envKeys.map((key) => process.env[key]);
  t.after(() => {
    for (const [index, key] of envKeys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.SLIDESTUDIO_VISION_REVIEWER = "offline-transcript";
  delete process.env.SLIDESTUDIO_LLM_IMAGE;
  createEmptyProject(root, { title: "合成展项检查" });
  writeDomainRuntime(root, { brief: "合成展项检查，不使用外部资料" });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: true, structuralReviewRequired: true },
  });
  const context = { commandId: "offline-run2-45-47", contextEpochId: "fixture-epoch" };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    runDomainHand(name, { ...args, __openSlideStudio: context }, root);
  const oldPlan = plan.map((item) => ({ ...item, exhibits: ["kpi-cards"] }));
  const firstPlan = await call("write_todo", { items: oldPlan });
  assert.equal(firstPlan.ok, true, firstPlan.detail);
  for (const item of plan) {
    const written = await call("write_page", page(item.pageId));
    assert.equal(written.ok, true, written.detail);
  }
  assert.equal(issues(await call("review_pages")).length, 6);

  const receipt = await call("write_todo", { items: plan });
  assert.equal(receipt.ok, true, receipt.detail);
  const committed = (receipt.payload as { items: Array<{ pageId: string; exhibits: string[] }> }).items;
  assert.deepEqual(committed.find((item) => item.pageId === "p05")?.exhibits, ["chart:line"]);
  assert.deepEqual(committed.find((item) => item.pageId === "p06")?.exhibits, ["none"]);
  const structural = await call("review_pages");
  assert.equal(structural.ok, false, structural.detail);
  assert.deepEqual(
    issues(structural).map((issue) => issue.pageId),
    ["p05"],
  );

  const progressIds = plan.map((item) => item.pageId);
  for (const pageId of ["p05", "p06"]) {
    const revision = currentPageRevision(root, pageId);
    assert.ok(revision);
    const raster = recordRaster(root, revision, {
      bytes: Buffer.from(`offline raster ${pageId}`),
      src: `_agent/rasters/${pageId}.png`,
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
    const emitted = await call("_mark_image_emitted", { deliveryToken: raster.deliveryToken });
    assert.equal(emitted.ok, true, emitted.detail);
    const reviewed = await call("review_page", {
      pageId,
      revision: revision.revision,
      deliveryToken: raster.deliveryToken,
      verdict: "pass",
      issues: [],
    });
    const payload = reviewed.payload as { issues?: unknown[]; pendingReview?: string[] } | undefined;
    if (pageId === "p05") {
      assert.equal(reviewed.ok, false);
      const pageIssues = (payload?.issues ?? []) as LayoutReview["issues"];
      assert.equal(pageIssues.length, 1);
      assert.equal(pageIssues[0]?.code, "missing_requested_exhibit");
      assert.match(pageIssues[0]?.message ?? "", /chart:line.*plan declaration/i);
      assert.ok(payload?.pendingReview?.includes("p05"));
      assert.equal(
        readRunLedger(root)?.facts.some(
          (fact) => fact.type === "page.visual-review-recorded" && fact.pageId === "p05" && fact.verdict === "pass",
        ),
        false,
      );
      const rejection = readRunLedger(root)
        ?.facts.filter((fact) => fact.type === "page.visual-review-recorded" && fact.pageId === "p05")
        .at(-1);
      assert.ok(rejection?.type === "page.visual-review-recorded");
      assert.equal(rejection?.verdict, "revise");
      assert.match(rejection?.issues[0] ?? "", /missing_requested_exhibit/);
    } else {
      assert.equal(reviewed.ok, true, reviewed.detail);
      assert.deepEqual(payload?.issues, []);
      assert.ok(payload?.pendingReview?.includes("p05"));
      assert.ok(!payload?.pendingReview?.includes("p06"));
    }
  }
  const finalStructural = await call("review_pages");
  assert.equal(finalStructural.ok, false);
  assert.deepEqual(
    issues(finalStructural).map((issue) => issue.message),
    [
      "page p05 requires chart:line from plan declaration in write_todo but did not implement it as editable PPTD elements",
    ],
  );
});

test("VAL-FAULT-011: missing requested exhibits name the actual plan or brief origin", (t) => {
  const declared = state();
  assert.equal(executeGenerateTool("write_todo", { items: plan }, declared).ok, true);
  const fromPlan = issues(executeGenerateTool("review_pages", {}, declared));
  assert.equal(fromPlan.length, 1);
  assert.match(fromPlan[0]!.message, /chart:line.*plan declaration/i);
  t.diagnostic(fromPlan[0]!.message);

  const legacy = state();
  legacy.brief = "【第5页】KPI 卡片";
  legacy.todos = plan.map(({ exhibits: _exhibits, ...item }) => ({ ...item, note: "" }));
  const fromBrief = issues(executeGenerateTool("review_pages", {}, legacy));
  assert.equal(fromBrief.length, 1);
  assert.match(fromBrief[0]!.message, /kpi-cards.*brief/i);
  t.diagnostic(fromBrief[0]!.message);
  assert.deepEqual(resolveTodoExhibits({ title: "KPI 卡片" }, 0, ""), ["kpi-cards"]);
  assert.deepEqual(resolveTodoExhibits({ title: "合成页面", note: "数据表" }, 0, ""), ["table"]);
});

test("Chinese keyword fallback covers all 5 diagram exhibits without hijacking risk scatter", () => {
  const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["获客漏斗", "销售转化漏斗分析", ["diagram:funnel"]],
    ["目标达成", "核心指标进度环与达成率环", ["diagram:gauge"]],
    ["组织层级", "三层层级塔与金字塔结构", ["diagram:pyramid"]],
    ["优先级划分", "四象限与九宫格评估矩阵", ["diagram:matrix"]],
    ["产品演进", "产品发展历程、时间轴与演进路线", ["diagram:timeline"]],
    ["风险评估", "可能性与影响的风险矩阵散点", ["chart:scatter"]],
  ];
  for (const [title, note, expected] of cases) {
    assert.deepEqual(resolveTodoExhibits({ title, note }, 0, ""), expected, `${title}: ${note}`);
  }
});
