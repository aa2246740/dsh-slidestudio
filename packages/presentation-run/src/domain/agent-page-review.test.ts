import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { reviewRasterNote } from "./agent-page-review.js";
import type { AgentToolState } from "./agent-tools.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { persistPageKey } from "./page-identity.js";
import { ensureRunLedger, recordPageRevision } from "./run-ledger.js";
import { recordRaster } from "./run-ledger-raster.js";

const context = { commandId: "review-raster-test", contextEpochId: "epoch-1" };

async function writeTwoPages(root: string): Promise<void> {
  createEmptyProject(root, { title: "光栅连续性测试" });
  writeDomainRuntime(root, { brief: "两页演示文稿" });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  for (const id of ["p01", "p02"]) {
    const res = await runDomainHand(
      "write_page",
      {
        id,
        pageType: "content",
        notes: `${id} 演讲备注`,
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 80, 800, 70],
            content: { text: `页面 ${id} 标题`, fontSize: 32 },
          },
          {
            elementId: "body",
            elementType: "text",
            bounds: [80, 200, 800, 160],
            content: { text: "正文内容清晰完整。", fontSize: 22 },
          },
        ],
      },
      root,
    );
    assert.equal(res.ok, true, res.detail);
  }
}

describe("reviewRasterNote", () => {
  it("recognizes current-revision disk rasters across cold restarts without claiming no render_page yet", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-raster-note-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await writeTwoPages(root);
    ensureRunLedger(root, {
      manifestSha256: "fixture",
      requirementsId: "fixture",
      requirements: [],
      executionPolicy: { currentRenderedLayoutRequired: true, structuralReviewRequired: true },
    });
    const entries = loadProject(root).pages;
    const revisions = entries.map((entry) => {
      const id = persistPageKey(entry.path);
      return recordPageRevision(root, context, id, { ...entry.page, id });
    });

    const state = { projectRoot: root } as AgentToolState;
    const none = reviewRasterNote(state);
    assert.match(none.note, /no render_page yet/);
    assert.equal(none.allCurrentOnDisk, false);

    // One of two pages rendered on disk -> reports partial status + exact missing page id.
    recordRaster(root, revisions[0]!, {
      bytes: Buffer.from("raster-p01"),
      src: "_agent/rasters/p01.png",
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    const partial = reviewRasterNote(state);
    assert.match(partial.note, /1\/2 pages current/);
    assert.match(partial.note, /missing render_page: p02/);
    assert.equal(partial.allCurrentOnDisk, false);

    // Both pages rendered and layout pass -> cold-started review_pages knows no re-render is needed.
    recordRaster(root, revisions[1]!, {
      bytes: Buffer.from("raster-p02"),
      src: "_agent/rasters/p02.png",
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    const full = reviewRasterNote(state);
    assert.match(full.note, /disk rasters current: 2\/2 pages rendered \(2 layout pass\)/);
    assert.equal(full.allCurrentOnDisk, true);

    // End-to-end review_pages tool on a fresh state uses the disk raster summary.
    const reviewResult = await runDomainHand("review_pages", { __openSlideStudio: context }, root);
    assert.equal(reviewResult.ok, true, reviewResult.detail);
    assert.match(reviewResult.detail, /disk rasters current: 2\/2 pages rendered/);
    assert.doesNotMatch(reviewResult.detail, /no render_page yet/);
  });
});
