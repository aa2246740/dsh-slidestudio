import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPresentationRun } from "./run.js";
import { inspectRunLedger, requireComposeReady, stableSha256 } from "./domain/run-ledger.js";
import { EMPTY_CLOSER_PRODUCE_NEXT, HOST_SEED_PRODUCE_NEXT } from "./domain/layout-qa.js";
import { persistWrittenPages } from "./domain/agent-tools.js";
import { loadPlaybook } from "./domain/playbook.js";
import type { SkillPageInput } from "./domain/skill-pages.js";
import { createEmptyProject, listComposedPage, saveProject, titleOnlyCoverPage } from "@open-slidestudio/pptd-v2";

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

function passingRasters(pages: SkillPageInput[]) {
  return pages.map((page) => ({
    pageId: page.id,
    pageSha256: stableSha256(page),
    layoutStatus: "pass" as const,
    layoutIssues: [],
  }));
}

describe("visual review contract", () => {
  it("compose gate returns only the produce bounce when leftover closer is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "empty-closer-inspect-"));
    const project = createEmptyProject(root, { title: "empty closer inspect" });
    project.pages = [
      {
        path: "pages/01_cover.page",
        page: { pageType: "cover", elements: [] },
      },
      {
        path: "pages/16_content.page",
        page: {
          pageType: "content",
          elements: [
            {
              elementId: "bg",
              elementType: "shape",
              shapeName: "rect",
              bounds: [0, 0, 960, 540],
              fill: { type: "solid", color: "#151515" },
            },
          ],
        },
      },
    ];
    project.presentation.pages = project.pages.map((page) => page.path);
    saveProject(project);
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    const at = "2026-08-28T02:00:00.000Z";
    fs.writeFileSync(
      path.join(root, "_agent", "run-ledger.v1.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: "sess-empty-closer",
          createdAt: at,
          updatedAt: at,
          sourcePack: {
            manifestSha256: "m".repeat(64),
            requirementsId: "r".repeat(64),
            requirements: [],
          },
          facts: [],
        },
        null,
        2,
      )}\n`,
    );
    const status = inspectRunLedger(root);
    assert.equal(status.composeReady, false);
    assert.ok(status.composeBlockers.includes(EMPTY_CLOSER_PRODUCE_NEXT));
  });

  it("host seed 1_cover.page in deck.pptd with a real agent cover → compose rejects; without the seed → compose can seal", async () => {
    const at = "2026-08-28T05:40:00.000Z";
    const pages = twoSealablePages();
    const noneEnv = noneVisionEnv();

    const withSeed = fs.mkdtempSync(path.join(os.tmpdir(), "host-seed-with-"));
    const seeded = createEmptyProject(withSeed, { title: "澄光生活 2026年7月经营月报" });
    listComposedPage(seeded, "pages/1_cover.page", titleOnlyCoverPage("澄光生活 2026年7月经营月报"));
    seeded.pages = [
      seeded.pages[0]!,
      ...pages.map((page) => ({
        path: `pages/${page.id}.page`,
        page: { pageType: page.pageType, elements: page.elements },
      })),
    ];
    seeded.presentation.pages = seeded.pages.map((page) => page.path);
    saveProject(seeded);
    writeLedger(withSeed, pages, at, passingRasters(pages));
    const blocked = inspectRunLedger(withSeed, "epoch-1", noneEnv);
    assert.equal(blocked.composeReady, false, blocked.composeBlockers.join("; "));
    assert.ok(blocked.composeBlockers.includes(HOST_SEED_PRODUCE_NEXT));
    assert.throws(() => requireComposeReady(withSeed, "epoch-1", noneEnv), /1_cover\.page/);

    const withoutSeed = fs.mkdtempSync(path.join(os.tmpdir(), "host-seed-without-"));
    persistWrittenPages({
      brief: "澄光生活 2026年7月经营月报",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: withoutSeed,
    });
    writeLedger(withoutSeed, pages, at, passingRasters(pages));
    const ready = inspectRunLedger(withoutSeed, "epoch-1", noneEnv);
    assert.equal(ready.composeReady, true, ready.composeBlockers.join("; "));
    assert.doesNotThrow(() => requireComposeReady(withoutSeed, "epoch-1", noneEnv));
  });

  it("text-overflow-y rendered hard issue → compose rejects; same page without overflow → can seal", () => {
    const at = "2026-08-28T05:41:00.000Z";
    const pages = twoSealablePages();
    const noneEnv = noneVisionEnv();
    const overflow = fs.mkdtempSync(path.join(os.tmpdir(), "layout-overflow-"));
    persistWrittenPages({
      brief: "闸门复现灯开关：结构验收，不要做成经营月报。",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: overflow,
    });
    writeLedger(overflow, pages, at, [
      {
        pageId: pages[0]!.id,
        pageSha256: stableSha256(pages[0]!),
        layoutStatus: "fail",
        layoutIssues: [
          {
            code: "text-overflow-y",
            severity: "error",
            elementIds: ["t1"],
            detail: "scrollHeight 58 exceeds clientHeight 56",
          },
        ],
      },
      {
        pageId: pages[1]!.id,
        pageSha256: stableSha256(pages[1]!),
        layoutStatus: "pass",
        layoutIssues: [],
      },
    ]);
    const blocked = inspectRunLedger(overflow, "epoch-1", noneEnv);
    assert.equal(blocked.composeReady, false, blocked.composeBlockers.join("; "));
    assert.ok(blocked.composeBlockers.some((row) => /text-overflow-y/.test(row)));
    assert.ok(!blocked.composeBlockers.some((row) => /visual review/.test(row)));
    assert.throws(() => requireComposeReady(overflow, "epoch-1", noneEnv), /text-overflow-y/);

    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "layout-clean-"));
    persistWrittenPages({
      brief: "闸门复现灯开关：结构验收，不要做成经营月报。",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: clean,
    });
    writeLedger(clean, pages, at, passingRasters(pages));
    const ready = inspectRunLedger(clean, "epoch-1", noneEnv);
    assert.equal(ready.composeReady, true, ready.composeBlockers.join("; "));
    assert.doesNotThrow(() => requireComposeReady(clean, "epoch-1", noneEnv));
  });

  it("routes a compose layout failure to write_page rather than rerendering the unchanged revision", async () => {
    const at = "2026-08-28T05:42:00.000Z";
    const pages = twoSealablePages();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-compose-next-"));
    persistWrittenPages({
      brief: "两页结构验收",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: pages,
      projectRoot: root,
    });
    writeLedger(root, pages, at, [
      {
        pageId: pages[0]!.id,
        pageSha256: stableSha256(pages[0]!),
        layoutStatus: "fail",
        layoutIssues: [
          {
            code: "text-overflow-y",
            severity: "error",
            elementIds: ["title"],
            detail: "title overflows",
          },
        ],
      },
      {
        pageId: pages[1]!.id,
        pageSha256: stableSha256(pages[1]!),
        layoutStatus: "pass",
        layoutIssues: [],
      },
    ]);
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "layout-compose-next",
      brief: "两页结构验收",
      editorBaseUrl: "",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "test" },
    });
    const result = await run.execute(
      { name: "compose_deck", args: { title: "两页结构验收" } },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId: "compose-layout-fail",
        projectRoot: root,
        abortSignal: new AbortController().signal,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.payload.error, "compose_not_ready");
    assert.equal(result.payload.next, "write_page");
    assert.equal(
      result.payload.recoveryHint,
      "Fix listed pages, refresh render/review evidence, then retry compose_deck.",
    );
    assert.deepEqual(result.payload.blockingPages, [{ pageId: pages[0]!.id, reason: "layout" }]);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
  });
});
