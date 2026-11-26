import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectRunLedger,
  currentVisualReviewsMissing,
  ensureRunLedger,
  recordPageRevision,
  recordTodo,
  recordStructuralReview,
  recordVisualReview,
  requireComposeReady,
  stableSha256,
  readRunLedger,
} from "./domain/run-ledger.js";
import { visualReviewIsClaimable } from "./capabilities.js";
import { isPlaceholderReviewIssue } from "./domain/layout-qa.js";
import { persistWrittenPages } from "./domain/agent-tools.js";
import { loadPlaybook } from "./domain/playbook.js";
import { runDomainHand } from "./domain/domain-hands.js";
import type { SkillPageInput } from "./domain/skill-pages.js";
import { loadProject } from "@open-slidestudio/pptd-v2";

const navyBg = {
  elementId: "bg",
  elementType: "shape" as const,
  shapeName: "rect" as const,
  bounds: [0, 0, 960, 540] as [number, number, number, number],
  fill: { type: "solid" as const, color: "#06223F" },
};

function structText(
  id: string,
  text: string,
  bounds: [number, number, number, number],
  fontSize: number,
): SkillPageInput["elements"][number] {
  return {
    elementId: id,
    elementType: "text",
    bounds,
    content: { text, fontSize, color: "#FFFFFF" },
  };
}

function fourStructuralPages(): SkillPageInput[] {
  return [
    {
      id: "cover",
      pageType: "cover",
      elements: [navyBg, structText("t", "闸门复现灯开关", [80, 160, 800, 80], 36)],
    },
    {
      id: "p2",
      pageType: "content",
      elements: [
        navyBg,
        structText("t", "作业背景标题足够长了", [52, 48, 800, 40], 28),
        structText("b", "结构页需要可读正文，不能只铺海军蓝。", [52, 120, 856, 80], 16),
      ],
    },
    {
      id: "p3",
      pageType: "content",
      elements: [
        navyBg,
        structText("t", "方法与观测标题足够长了", [52, 48, 800, 40], 28),
        structText("b", "几何与 YAML 是结构，视觉审查是审美。", [52, 120, 856, 80], 16),
      ],
    },
    {
      id: "final",
      pageType: "final",
      elements: [
        navyBg,
        structText("title", "结束页 · 结构验收", [52, 80, 760, 60], 32),
        structText("recap", "四页均有可读正文，layout-qa 通过。", [52, 176, 856, 60], 14),
        structText("ask", "下次只补视觉审查员，不伪造 pass。", [52, 294, 856, 80], 20),
      ],
    },
  ];
}

function noneVisionEnv(): NodeJS.ProcessEnv {
  return { ...process.env, SLIDESTUDIO_VISION_REVIEWER: "", SLIDESTUDIO_LLM_IMAGE: "0" };
}

function writeLedger(
  root: string,
  pages: SkillPageInput[],
  at: string,
  rasters: Array<{
    pageId: string;
    pageSha256: string;
    layoutStatus: "pass" | "fail";
    layoutIssues: Array<{
      code: string;
      severity: "error" | "warning";
      elementIds: string[];
      detail: string;
    }>;
  }>,
  executionPolicy?: {
    currentRenderedLayoutRequired: boolean;
    structuralReviewRequired: boolean;
  },
): void {
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "run-ledger.v1.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: "sess-gate",
        createdAt: at,
        updatedAt: at,
        sourcePack: {
          manifestSha256: "m".repeat(64),
          requirementsId: "r".repeat(64),
          requirements: [],
          ...(executionPolicy ? { executionPolicy } : {}),
        },
        facts: [
          {
            type: "todo.committed",
            factId: "todo-1",
            at,
            contextEpochId: "epoch-1",
            todoSha256: "e".repeat(64),
            itemCount: pages.length,
            pageIds: pages.map((page) => page.id),
          },
          ...pages.map((page, index) => ({
            type: "page.revision-committed",
            factId: `page-${index + 1}`,
            at,
            contextEpochId: "epoch-1",
            pageId: page.id,
            revision: 1,
            pageSha256: stableSha256(page),
          })),
          ...rasters.map((row, index) => ({
            type: "page.raster-committed",
            factId: `raster-${index + 1}`,
            at,
            pageId: row.pageId,
            revision: 1,
            pageSha256: row.pageSha256,
            rasterSha256: "c".repeat(64),
            src: `_agent/rasters/${row.pageId}.png`,
            width: 960,
            height: 540,
            layoutGateVersion: "rendered-layout-gate-v8",
            layoutStatus: row.layoutStatus,
            layoutIssues: row.layoutIssues,
          })),
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function passingRasters(pages: SkillPageInput[]) {
  return pages.map((page) => ({
    pageId: page.id,
    pageSha256: stableSha256(page),
    layoutStatus: "pass" as const,
    layoutIssues: [],
  }));
}

describe("visual review contract", () => {
  it("returns render_page as the exact repair for a missing or mistyped page delivery token", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-token-repair-"));
    ensureRunLedger(root, {
      manifestSha256: "m".repeat(64),
      requirementsId: "token-repair",
      requirements: [],
    });
    recordPageRevision(root, { commandId: "write-1", contextEpochId: "epoch-1" }, "p1", {
      id: "p1",
      elements: [],
    });
    recordTodo(root, { commandId: "todo-1", contextEpochId: "epoch-1" }, [
      { pageId: "p1", title: "Synthetic page", layoutFamily: "content", exhibits: [] },
    ]);
    const previousReviewer = process.env.SLIDESTUDIO_VISION_REVIEWER;
    const previousImage = process.env.SLIDESTUDIO_LLM_IMAGE;
    process.env.SLIDESTUDIO_VISION_REVIEWER = "http://127.0.0.1:9/review";
    delete process.env.SLIDESTUDIO_LLM_IMAGE;
    try {
      const result = await runDomainHand(
        "review_page",
        {
          pageId: "p1",
          revision: 1,
          deliveryToken: "truncated-token",
          verdict: "pass",
          issues: [],
          __openSlideStudio: { commandId: "review-1", contextEpochId: "epoch-1" },
        },
        root,
      );
      assert.equal(result.ok, false);
      const payload = (result.payload ?? {}) as Record<string, unknown>;
      assert.equal(payload.error, "review_page_evidence_missing");
      assert.equal(payload.next, "render_page");
      assert.deepEqual(payload.pendingReview, ["p1"]);
      assert.match(result.detail, /copy its exact full DELIVERY_TOKEN/);
    } finally {
      if (previousReviewer === undefined) delete process.env.SLIDESTUDIO_VISION_REVIEWER;
      else process.env.SLIDESTUDIO_VISION_REVIEWER = previousReviewer;
      if (previousImage === undefined) delete process.env.SLIDESTUDIO_LLM_IMAGE;
      else process.env.SLIDESTUDIO_LLM_IMAGE = previousImage;
    }
  });

  it("does not let MiniMax text claim a visual pass when vision is none", () => {
    assert.equal(visualReviewIsClaimable(), false);
    assert.throws(
      () =>
        recordVisualReview(
          "/no-root",
          { commandId: "cmd", contextEpochId: "epoch" },
          {
            pageId: "16_final",
            revision: 1,
            deliveryToken: "tok",
            verdict: "pass",
            issues: ["none"],
          },
        ),
      /cannot claim a visual pass/,
    );
  });

  it('rejects issues:["none"] as a pass even when a vision reviewer is configured', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SLIDESTUDIO_VISION_REVIEWER: "http://127.0.0.1:9/review",
    };
    delete env.SLIDESTUDIO_LLM_IMAGE;
    assert.equal(visualReviewIsClaimable(env), true);
    assert.equal(isPlaceholderReviewIssue("none"), true);
    assert.throws(
      () =>
        recordVisualReview(
          "/no-root",
          { commandId: "cmd", contextEpochId: "epoch" },
          {
            pageId: "16_final",
            revision: 1,
            deliveryToken: "tok",
            verdict: "pass",
            issues: ["none"],
          },
          env,
        ),
      /issues:\["none"\]/,
    );
  });

  it("vision none still requires a current structural pass, then composes without a visual claim", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vis-none-four-"));
    const pages = fourStructuralPages();
    const at = "2026-08-28T04:40:00.000Z";
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({
        brief: "闸门复现灯开关：四页结构验收，不要做成经营月报。",
        strictExecution: true,
      })}\n`,
    );
    persistWrittenPages({
      brief: "闸门复现灯开关：四页结构验收，不要做成经营月报。",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: root,
    });
    fs.writeFileSync(
      path.join(root, "_agent", "hands-state.json"),
      `${JSON.stringify({ todos: [], writtenPages: pages }, null, 2)}\n`,
    );
    writeLedger(root, pages, at, passingRasters(pages));
    const noneEnv = noneVisionEnv();
    assert.equal(visualReviewIsClaimable(noneEnv), false);
    const before = inspectRunLedger(root, "epoch-1", noneEnv);
    assert.equal(before.composeReady, false);
    assert.match(before.composeBlockers.join("; "), /current structural review missing/);
    assert.equal(before.composed, false);
    assert.ok(before.pages.every((page) => page.visualReview === "missing"));
    assert.equal(currentVisualReviewsMissing(root, 4, noneEnv), false);
    assert.throws(() => requireComposeReady(root, "epoch-1", noneEnv), /structural review missing/);
    recordStructuralReview(root, true, []);
    const ready = inspectRunLedger(root, "epoch-1", noneEnv);
    assert.equal(ready.composeReady, true, ready.composeBlockers.join("; "));
    assert.doesNotThrow(() => requireComposeReady(root, "epoch-1", noneEnv));
    const beforeSha = pages.map((page) => stableSha256(page));
    const composedTitle = "无新增页面也要落盘的标题";
    const compose = await runDomainHand(
      "compose_deck",
      {
        title: composedTitle,
        __openSlideStudio: { commandId: "compose-1", contextEpochId: "epoch-1" },
      },
      root,
    );
    assert.equal(compose.ok, true, compose.detail);
    assert.match(compose.summary ?? "", /4 页 PPTD/);
    const ledger = readRunLedger(root);
    assert.equal(
      ledger?.facts.some((fact) => fact.type === "deck.composed"),
      true,
    );
    const after = inspectRunLedger(root, "epoch-1", noneEnv);
    assert.equal(after.composed, true);
    assert.deepEqual(
      pages.map((page) => stableSha256(page)),
      beforeSha,
    );
    assert.equal(
      loadProject(root).presentation.title,
      composedTitle,
      "compose-only metadata must persist even when no page mutations are returned",
    );
  });

  it("still requires an image-backed visual pass when a vision reviewer exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vis-on-four-"));
    const pages = fourStructuralPages();
    const at = "2026-08-28T04:40:00.000Z";
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    persistWrittenPages({
      brief: "闸门复现灯开关：四页结构验收，不要做成经营月报。",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: root,
    });
    fs.writeFileSync(
      path.join(root, "_agent", "run-ledger.v1.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: "sess-four-vision",
          createdAt: at,
          updatedAt: at,
          sourcePack: {
            manifestSha256: "m".repeat(64),
            requirementsId: "r".repeat(64),
            requirements: [],
          },
          facts: [
            {
              type: "todo.committed",
              factId: "todo-1",
              at,
              contextEpochId: "epoch-1",
              todoSha256: "e".repeat(64),
              itemCount: 4,
            },
            ...pages.map((page, index) => ({
              type: "page.revision-committed",
              factId: `page-${index + 1}`,
              at,
              contextEpochId: "epoch-1",
              pageId: page.id,
              revision: 1,
              pageSha256: stableSha256(page),
            })),
          ],
        },
        null,
        2,
      )}\n`,
    );
    const visionEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SLIDESTUDIO_VISION_REVIEWER: "http://127.0.0.1:9/review",
    };
    delete visionEnv.SLIDESTUDIO_LLM_IMAGE;
    assert.equal(visualReviewIsClaimable(visionEnv), true);
    const status = inspectRunLedger(root, "epoch-1", visionEnv);
    assert.equal(status.composeReady, false);
    assert.ok(status.composeBlockers.some((row) => /visual review missing|current raster missing/.test(row)));
  });
});
