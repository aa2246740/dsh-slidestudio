import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPresentationRun } from "./run.js";
import { inspectRunLedger, recordStructuralReview, requireComposeReady, stableSha256 } from "./domain/run-ledger.js";
import { visualReviewIsClaimable } from "./capabilities.js";
import { persistWrittenPages } from "./domain/agent-tools.js";
import { loadPlaybook } from "./domain/playbook.js";
import type { SkillPageInput } from "./domain/skill-pages.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function noneVisionEnv(): NodeJS.ProcessEnv {
  return { ...process.env, SLIDESTUDIO_VISION_REVIEWER: "", SLIDESTUDIO_LLM_IMAGE: "0" };
}

function agentCoverPage(): SkillPageInput {
  return {
    id: "p01_cover",
    pageType: "cover",
    elements: [
      navyBg,
      structText("t1", "差 140 万不是客单下跌", [50, 170, 700, 80], 40),
      structText("t2", "2026年7月经营月报已核实数字", [50, 270, 800, 40], 16),
    ],
  };
}

function twoSealablePages(): SkillPageInput[] {
  return [
    agentCoverPage(),
    {
      id: "final",
      pageType: "final",
      elements: [
        navyBg,
        structText("title", "结束页 · 结构验收", [52, 80, 760, 60], 32),
        structText("recap", "两页均有可读正文，layout-qa 通过。", [52, 176, 856, 60], 14),
        structText("ask", "下次只补视觉审查员，不伪造 pass。", [52, 294, 856, 80], 20),
      ],
    },
  ];
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

describe("visual review contract", () => {
  it("keeps compose_not_ready under 4 KiB while naming every blocked page", async () => {
    const at = "2026-08-28T05:43:00.000Z";
    const template = agentCoverPage();
    const pages = Array.from({ length: 24 }, (_, index) => ({
      ...template,
      id: `page-${String(index + 1).padStart(2, "0")}`,
    }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compact-compose-refusal-"));
    persistWrittenPages({
      brief: "Redacted compact refusal fixture",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: root,
    });
    writeLedger(
      root,
      pages,
      at,
      pages.map((page) => ({
        pageId: page.id,
        pageSha256: stableSha256(page),
        layoutStatus: "fail" as const,
        layoutIssues: [
          {
            code: "text-overflow-y",
            severity: "error" as const,
            elementIds: ["t1"],
            detail: "title overflows",
          },
        ],
      })),
    );
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "compact-compose-refusal",
      brief: "Redacted compact refusal fixture",
      editorBaseUrl: "",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "test" },
    });
    const result = await run.execute(
      { name: "compose_deck", args: { title: "Redacted" } },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId: "compose-compact",
        projectRoot: root,
        abortSignal: new AbortController().signal,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.payload.error, "compose_not_ready");
    const blockingPages = result.payload.blockingPages as Array<{
      pageId: string;
      reason: string;
    }>;
    assert.equal(blockingPages.length, pages.length);
    assert.deepEqual(
      blockingPages.map((page) => page.pageId),
      pages.map((page) => page.id),
    );
    assert.ok(blockingPages.every((page) => page.reason.includes("layout")));
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
  });

  it("vision=none + leftover-clean + YAML-ok + layout missing → compose can seal", () => {
    const at = "2026-08-28T05:55:00.000Z";
    const pages = twoSealablePages();
    const noneEnv = noneVisionEnv();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-missing-"));
    persistWrittenPages({
      brief: "闸门复现灯开关：结构验收，不要做成经营月报。",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: root,
    });
    writeLedger(root, pages, at, []);
    const ready = inspectRunLedger(root, "epoch-1", noneEnv);
    assert.equal(visualReviewIsClaimable(noneEnv), false);
    assert.ok(ready.pages.every((page) => page.layout === "missing"));
    assert.ok(!ready.composeBlockers.some((row) => /rendered layout/.test(row)), ready.composeBlockers.join("; "));
    assert.equal(ready.composeReady, true, ready.composeBlockers.join("; "));
    assert.doesNotThrow(() => requireComposeReady(root, "epoch-1", noneEnv));
  });

  it("strict ledger + deleted runtime + layout missing → compose remains blocked", () => {
    const at = "2026-08-28T05:56:00.000Z";
    const pages = twoSealablePages();
    const noneEnv = noneVisionEnv();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-required-"));
    persistWrittenPages({
      brief: "严格本地渲染闸门",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: root,
    });
    writeLedger(root, pages, at, [], {
      currentRenderedLayoutRequired: true,
      structuralReviewRequired: true,
    });
    recordStructuralReview(root, true, []);
    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify(
        {
          brief: "严格本地渲染闸门",
          editorBaseUrl: "http://127.0.0.1:55200",
          strictExecution: true,
        },
        null,
        2,
      )}\n`,
    );
    fs.unlinkSync(path.join(root, "_agent", "runtime.json"));
    const blocked = inspectRunLedger(root, "epoch-1", noneEnv);
    assert.equal(visualReviewIsClaimable(noneEnv), false);
    assert.equal(blocked.composeReady, false);
    assert.ok(
      blocked.composeBlockers.every((row) => !/visual review/.test(row)),
      blocked.composeBlockers.join("; "),
    );
    assert.ok(
      blocked.composeBlockers.some((row) => /rendered layout missing.*current deterministic/.test(row)),
      blocked.composeBlockers.join("; "),
    );
    assert.throws(() => requireComposeReady(root, "epoch-1", noneEnv), /rendered layout missing/);
  });
});
