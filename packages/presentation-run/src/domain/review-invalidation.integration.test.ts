import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { currentReviewProgress, withReviewProgress } from "./review-progress.js";
import { currentPageRevision, ensureRunLedger, inspectRunLedger, readRunLedger } from "./run-ledger.js";
import { recordImagePrepared, recordRaster } from "./run-ledger-raster.js";
import type { SkillPageInput } from "./skill-pages.js";

test("M1-SCR-015: changed exhibits invalidate prior pass across durable review and compose projections", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-invalidation-"));
  const envKeys = ["SLIDESTUDIO_VISION_REVIEWER", "SLIDESTUDIO_LLM_IMAGE"] as const;
  const previous = envKeys.map((key) => process.env[key]);
  t.after(() => {
    for (const [index, key] of envKeys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Synthetic renderer/capability evidence only; never invokes a model provider.
  process.env.SLIDESTUDIO_VISION_REVIEWER = "offline-invalidation";
  delete process.env.SLIDESTUDIO_LLM_IMAGE;
  createEmptyProject(root, { title: "合成审阅失效检查" });
  writeDomainRuntime(root, { brief: "制作一页协作说明。" });
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
  const context = { commandId: "offline-invalidation", contextEpochId: "review-epoch" };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    runDomainHand(name, { ...args, __openSlideStudio: context }, root);
  const plan = (exhibits: string[], title = "协作说明") => ({
    items: [{ pageId: "p01", title, layoutFamily: "content", exhibits }],
  });
  const page: SkillPageInput = {
    id: "p01",
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 40, 800, 60],
        content: { text: "明确协作职责", fontSize: 28 },
      },
      {
        elementId: "body",
        elementType: "text",
        bounds: [80, 460, 800, 40],
        content: { text: "记录交付结果并核对负责人。", fontSize: 20 },
      },
    ],
  };
  const prepareReview = async () => {
    const revision = currentPageRevision(root, "p01");
    assert.ok(revision);
    const raster = recordRaster(root, revision, {
      bytes: Buffer.from(`synthetic raster revision ${revision.revision}`),
      src: "_agent/rasters/p01.png",
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
    const emitted = await call("_mark_image_emitted", { deliveryToken: raster.deliveryToken });
    assert.equal(emitted.ok, true, emitted.detail);
    return { pageId: "p01", revision: revision.revision, deliveryToken: raster.deliveryToken };
  };
  const assertProgress = (payload: unknown, pendingReview: string[]) => {
    const value = payload as Record<string, unknown>;
    assert.deepEqual(value.pendingReview, pendingReview);
    assert.equal(value.next, pendingReview.length ? "review_page p01" : "compose_deck");
  };
  const assertDurableProgress = (pendingReview: string[]) => {
    assertProgress(currentReviewProgress(root), pendingReview);
    assert.equal(inspectRunLedger(root).pages[0]?.visualReview === "pass", pendingReview.length === 0);
    for (const name of ["render_page", "review_page", "review_pages", "write_todo"]) {
      assertProgress(
        withReviewProgress(root, name, { name, ok: true, summary: "", detail: "", payload: {} }).payload,
        pendingReview,
      );
    }
  };
  assert.equal((await call("write_todo", plan(["none"]))).ok, true);
  assert.equal((await call("write_page", page)).ok, true);
  let reviewArgs = await prepareReview();
  const firstPass = await call("review_page", { ...reviewArgs, verdict: "pass", issues: [] });
  assert.equal(firstPass.ok, true, firstPass.detail);
  assertProgress(firstPass.payload, []);
  assert.equal((await call("review_pages")).ok, true);
  const history = readRunLedger(root)!.facts;

  // Replanning alone must invalidate a pass, even before a rejecting review is attempted.
  const changedPlan = await call("write_todo", plan(["chart:line"]));
  assert.equal(changedPlan.ok, true, changedPlan.detail);
  assertDurableProgress(["p01"]);
  assertProgress(changedPlan.payload, ["p01"]);
  const failedRender = await call("render_page", { pageIndex: 99 });
  assert.equal(failedRender.ok, false);
  assertProgress(failedRender.payload, ["p01"]);
  const composeBeforeReview = await call("compose_deck", { title: "合成说明" });
  assert.equal(composeBeforeReview.ok, false, "compose must refuse the obsolete none pass");
  assert.match(composeBeforeReview.detail, /visual review/);
  t.diagnostic(`compose after replan: refused=${!composeBeforeReview.ok}`);

  const rejected = await call("review_page", { ...reviewArgs, verdict: "pass", issues: [] });
  assert.equal(rejected.ok, false);
  assert.equal((rejected.payload as { error: string }).error, "missing_requested_exhibit");
  assertProgress(rejected.payload, ["p01"]);
  assertDurableProgress(["p01"]);
  const composeAfterReject = await call("compose_deck", { title: "合成说明" });
  assert.equal(composeAfterReject.ok, false, "compose must refuse the latest rejection");
  t.diagnostic(`compose after rejection: refused=${!composeAfterReject.ok}`);
  assert.equal(
    readRunLedger(root)
      ?.facts.filter((fact) => fact.type === "page.visual-review-recorded")
      .at(-1)?.verdict,
    "revise",
  );
  const structuralReject = await call("review_pages");
  assert.equal(structuralReject.ok, false);
  assertProgress(structuralReject.payload, ["p01"]);

  page.elements.push({
    elementId: "trend",
    elementType: "chart",
    bounds: [80, 140, 800, 280],
    data: {
      cols: ["period", "value"],
      rows: [
        ["A", 1],
        ["B", 2],
      ],
    },
    series: [{ type: "line", encode: { x: "period", y: "value" }, fill: "#123456" }],
  });
  const updated = await call("write_page", page);
  assert.equal(updated.ok, true, updated.detail);
  reviewArgs = await prepareReview();
  const repaired = await call("review_page", { ...reviewArgs, verdict: "pass", issues: [] });
  assert.equal(repaired.ok, true, repaired.detail);
  assertProgress(repaired.payload, []);
  assertDurableProgress([]);
  assert.equal((await call("review_pages")).ok, true);
  assert.equal((await call("compose_deck", { title: "合成说明" })).ok, true);

  const samePlan = await call("write_todo", plan(["chart:line"], "同一展品的新标题"));
  assert.equal(samePlan.ok, true, samePlan.detail);
  assertProgress(samePlan.payload, []);
  assertProgress((await call("write_todo", plan(["chart:line"], "同一展品的新标题"))).payload, []);
  assertDurableProgress([]);
  assert.deepEqual(readRunLedger(root)!.facts.slice(0, history.length), history);

  // A newer explicit revise must beat a pass; a later pass may settle that same revision.
  const revised = await call("review_page", {
    ...reviewArgs,
    verdict: "revise",
    issues: ["合成检查：图表标签需要复核"],
  });
  assert.equal(revised.ok, true, revised.detail);
  assertProgress(revised.payload, ["p01"]);
  assertDurableProgress(["p01"]);
  const repassed = await call("review_page", { ...reviewArgs, verdict: "pass", issues: [] });
  assert.equal(repassed.ok, true, repassed.detail);
  assertProgress(repassed.payload, []);
  assertDurableProgress([]);

  // Restoring an old declaration must not resurrect its retired pass or lose the new plan.
  assertProgress((await call("write_todo", plan(["none"]))).payload, ["p01"]);
  assertProgress((await call("write_todo", plan(["chart:line"]))).payload, ["p01"]);
  assertDurableProgress(["p01"]);
  const finalPass = await call("review_page", { ...reviewArgs, verdict: "pass", issues: [] });
  assert.equal(finalPass.ok, true, finalPass.detail);
  assertProgress(finalPass.payload, []);
  assertDurableProgress([]);
  assert.deepEqual(readRunLedger(root)!.facts.slice(0, history.length), history);
});
