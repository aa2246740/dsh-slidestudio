import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { currentPageRevision, ensureRunLedger, inspectRunLedger, readRunLedger } from "./run-ledger.js";
import { recordImagePrepared, recordRaster } from "./run-ledger-raster.js";

test("VAL-FAULT-012: three-page offline tool transcript re-reads reviews and drains pendingReview before compose", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-progress-transcript-"));
  const envKeys = ["SLIDESTUDIO_VISION_REVIEWER", "SLIDESTUDIO_LLM_IMAGE"] as const;
  const previous = envKeys.map((key) => process.env[key]);
  t.after(() => {
    for (const [index, key] of envKeys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Capability fixture only: no browser or real model/reviewer is invoked.
  process.env.SLIDESTUDIO_VISION_REVIEWER = "offline-transcript";
  delete process.env.SLIDESTUDIO_LLM_IMAGE;
  createEmptyProject(root, { title: "离线审阅链路" });
  writeDomainRuntime(root, { brief: "制作三页协作流程说明。" });
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
  const context = { commandId: "offline-transcript", contextEpochId: "review-epoch" };
  const transcript: { name: string; pendingReview: unknown; next: unknown }[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await runDomainHand(name, { ...args, __openSlideStudio: context }, root);
    assert.equal(result.ok, true, result.detail);
    return result;
  };
  const ids = ["p01", "p02", "p03"];
  await call("write_todo", {
    items: ids.map((pageId) => ({
      pageId,
      title: `协作流程 ${pageId}`,
      layoutFamily: "content",
      exhibits: ["none"],
    })),
  });
  const tokens = new Map<string, { revision: number; deliveryToken: string }>();
  for (const id of ids) {
    await call("write_page", {
      id,
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [80, 80, 800, 70],
          content: { text: `明确协作职责 ${id}`, fontSize: 32 },
        },
        {
          elementId: "body",
          elementType: "text",
          bounds: [80, 200, 800, 160],
          content: { text: "核对输入信息，明确负责人，并记录交付结果。", fontSize: 24 },
        },
      ],
    });
    const revision = currentPageRevision(root, id);
    assert.ok(revision);
    // Seed synthetic already-passed layout evidence at the renderer seam.
    // Visual verdicts below must still travel through real review_page dispatch.
    const raster = recordRaster(root, revision, {
      bytes: Buffer.from(`offline raster ${id}`),
      src: `_agent/rasters/${id}.png`,
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
    await call("_mark_image_emitted", { deliveryToken: raster.deliveryToken });
    tokens.set(id, { revision: revision.revision, deliveryToken: raster.deliveryToken });
  }
  const assertProgress = (name: string, payload: unknown, pendingReview: string[]) => {
    const value = payload as Record<string, unknown>;
    const next = pendingReview.length ? `review_page ${pendingReview[0]}` : "compose_deck";
    assert.deepEqual(value.pendingReview, pendingReview);
    assert.equal(value.next, next);
    transcript.push({ name, pendingReview: value.pendingReview, next: value.next });
  };
  assertProgress("review_pages", (await call("review_pages")).payload, ids);
  for (const [index, pageId] of ids.entries()) {
    const token = tokens.get(pageId);
    assert.ok(token);
    const result = await call("review_page", { pageId, ...token, verdict: "pass", issues: [] });
    const pending = ids.slice(index + 1);
    assertProgress(`review_page ${pageId}`, result.payload, pending);
    // Re-open durable ledger, not the review payload or an in-memory mock.
    const reviews = readRunLedger(root)?.facts.filter((fact) => fact.type === "page.visual-review-recorded");
    assert.deepEqual(
      reviews?.map((fact) => fact.pageId),
      ids.slice(0, index + 1),
    );
    assert.ok(reviews?.every((fact) => fact.verdict === "pass"));
    const inspection = inspectRunLedger(root);
    assert.deepEqual(
      inspection.pages.filter((page) => page.visualReview !== "pass").map((page) => page.pageId),
      pending,
    );
    assertProgress("review_pages re-read", (await call("review_pages")).payload, pending);
  }
  await call("compose_deck", { title: "协作流程说明" });
  assert.equal(inspectRunLedger(root).composed, true);
  t.diagnostic(JSON.stringify(transcript));
});
