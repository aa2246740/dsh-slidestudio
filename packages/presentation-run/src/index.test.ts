import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertChartEvidence } from "./chart-gate.js";
import { CAPABILITY_LEDGER } from "./capability-ledger.js";
import { EXPECTED_SOURCE_FILES, EXPECTED_VISUAL_FILES, loadReferenceCatalog } from "./catalog.js";
import { createPresentationRun } from "./run.js";
import { listSourceReceipts } from "./receipts.js";
import {
  authorizePageEdit,
  authorizePageEdits,
  currentPageRevision,
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
import { pageRevisionSha256 } from "./domain/hashing.js";
import { pageRewriteGate } from "./domain/page-rewrite-gate.js";
import { visualReviewIsClaimable } from "./capabilities.js";
import { EMPTY_CLOSER_PRODUCE_NEXT, HOST_SEED_PRODUCE_NEXT, isPlaceholderReviewIssue } from "./domain/layout-qa.js";
import { persistWrittenPages } from "./domain/agent-tools.js";
import { loadPlaybook } from "./domain/playbook.js";
import { runDomainHand } from "./domain/domain-hands.js";
import type { SkillPageInput } from "./domain/skill-pages.js";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
} from "@open-slidestudio/pptd-v2";

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

function addTodoFact(root: string, itemCount: number): void {
  const file = path.join(root, "_agent", "run-ledger.v1.json");
  const ledger = JSON.parse(fs.readFileSync(file, "utf8")) as {
    facts: Array<Record<string, unknown>>;
  };
  ledger.facts.push({
    type: "todo.committed",
    factId: "todo-rewrite-gate",
    at: "2026-08-31T00:00:00.000Z",
    contextEpochId: "epoch-1",
    todoSha256: "d".repeat(64),
    itemCount,
    pageIds: Array.from({ length: itemCount }, (_, index) => (index === 0 ? "cover" : `p${index + 1}`)),
    pagePlan: Array.from({ length: itemCount }, (_, index) => ({
      pageId: index === 0 ? "cover" : `p${index + 1}`,
      title: `Page ${index + 1}`,
      layoutFamily: index === 0 ? "cover" : "content",
      exhibits: [],
    })),
  });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

describe("passing page rewrite gate", () => {
  it("locks a structural review pass, not a layout pass", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-rewrite-gate-"));
    const page = agentCoverPage();
    writeLedger(root, [page], "2026-08-31T00:00:00.000Z", passingRasters([page]));
    const layoutOnly = pageRewriteGate(root, page.id);
    assert.equal(layoutOnly.allowed, true);
    assert.doesNotMatch(layoutOnly.reason, /deterministic raster/);

    recordStructuralReview(root, true, []);
    const locked = pageRewriteGate(root, page.id);
    assert.equal(locked.allowed, false);
    assert.match(locked.reason, /structural review pass/);
    assert.doesNotMatch(locked.reason, /deterministic raster/);

    const file = path.join(root, "_agent", "run-ledger.v1.json");
    const ledger = JSON.parse(fs.readFileSync(file, "utf8")) as {
      facts: Array<Record<string, unknown>>;
    };
    ledger.facts.push({
      type: "deck.structural-review-recorded",
      factId: "structural-revise-cover",
      at: "2026-08-31T00:00:01.000Z",
      reviewGateVersion: "structural-review-gate-v6",
      pageRevisions: { [page.id]: stableSha256(page) },
      ok: false,
      issues: [`${page.id}: missing required evidence`],
    });
    fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
    assert.equal(pageRewriteGate(root, page.id).allowed, true);

    writeLedger(root, [page], "2026-08-31T00:00:00.000Z", [
      {
        pageId: page.id,
        pageSha256: stableSha256(page),
        layoutStatus: "fail",
        layoutIssues: [
          {
            code: "text-overflow-y",
            severity: "error",
            elementIds: ["t1"],
            detail: "title overflows",
          },
        ],
      },
    ]);
    assert.equal(pageRewriteGate(root, page.id).allowed, true);
  });

  it("allows one exact editor-Agent revision without weakening the generation gate", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-editor-edit-gate-"));
    const page = agentCoverPage();
    writeLedger(root, [page], "2026-08-31T00:00:00.000Z", passingRasters([page]));
    recordStructuralReview(root, true, []);
    const current = currentPageRevision(root, page.id);
    assert.ok(current);
    assert.equal(pageRewriteGate(root, page.id).allowed, false);

    const authorization = authorizePageEdit(root, {
      authorizationId: "editor-turn-1",
      pageId: page.id,
      revision: current.revision,
      pageSha256: current.pageSha256,
    });
    assert.equal(authorization.pageSha256, current.pageSha256);
    assert.match(pageRewriteGate(root, page.id).reason, /editor Agent edit editor-turn-1/);

    assert.throws(
      () =>
        authorizePageEdit(root, {
          authorizationId: "stale-editor-turn",
          pageId: page.id,
          revision: current.revision + 1,
          pageSha256: current.pageSha256,
        }),
      /changed before the editor Agent turn started/,
    );
  });

  it("authorizes a whole-deck editor turn atomically and rejects a partially stale request", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-editor-edit-gate-"));
    const first = agentCoverPage();
    const second = { ...agentCoverPage(), id: "page-02" };
    writeLedger(root, [first, second], "2026-08-31T00:00:00.000Z", passingRasters([first, second]));
    recordStructuralReview(root, true, []);
    const firstRevision = currentPageRevision(root, first.id);
    const secondRevision = currentPageRevision(root, second.id);
    assert.ok(firstRevision);
    assert.ok(secondRevision);
    assert.equal(pageRewriteGate(root, first.id).allowed, false);
    assert.equal(pageRewriteGate(root, second.id).allowed, false);
    const beforeFacts = readRunLedger(root)?.facts.length;

    assert.throws(
      () =>
        authorizePageEdits(root, [
          {
            authorizationId: "whole-deck-turn",
            pageId: first.id,
            revision: firstRevision.revision,
            pageSha256: firstRevision.pageSha256,
          },
          {
            authorizationId: "whole-deck-turn",
            pageId: second.id,
            revision: secondRevision.revision + 1,
            pageSha256: secondRevision.pageSha256,
          },
        ]),
      /page-02 changed before the editor Agent turn started/,
    );
    assert.equal(readRunLedger(root)?.facts.length, beforeFacts);

    const authorizations = authorizePageEdits(root, [
      {
        authorizationId: "whole-deck-turn",
        pageId: first.id,
        revision: firstRevision.revision,
        pageSha256: firstRevision.pageSha256,
      },
      {
        authorizationId: "whole-deck-turn",
        pageId: second.id,
        revision: secondRevision.revision,
        pageSha256: secondRevision.pageSha256,
      },
    ]);
    assert.equal(authorizations.length, 2);
    assert.equal(pageRewriteGate(root, first.id).allowed, true);
    assert.equal(pageRewriteGate(root, second.id).allowed, true);
  });

  it("authorizes a page by its own-body revision while inherited chrome keeps its snapshot identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-editor-inherited-"));
    const project = createEmptyProject(root, { title: "继承页面授权" });
    project.presentation.layouts = [
      {
        id: "body",
        name: "正文",
        elements: [
          {
            elementId: "chrome",
            elementType: "shape",
            shapeName: "rect",
            bounds: [0, 0, 960, 24],
            fill: { type: "solid", color: "#DDDDDD" },
          },
        ],
      },
    ];
    listComposedPage(project, "pages/p1.page", {
      layoutId: "body",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [80, 80, 800, 60],
          content: { text: "标题", fontSize: 32 },
        },
      ],
    });
    saveProject(project);
    const loaded = loadProject(root).pages[0]!;
    const pageId = "p1";
    const ownBodySha = pageRevisionSha256(loaded.page, pageId);
    const snapshotSha = stableSha256({ id: pageId, ...loaded.page });
    assert.notEqual(ownBodySha, snapshotSha, "inherited chrome must not join the revision identity");

    ensureRunLedger(root, {
      manifestSha256: "a".repeat(64),
      requirementsId: "b".repeat(64),
      requirements: [],
    });
    const recorded = recordPageRevision(
      root,
      { contextEpochId: "inherited-edit-epoch", commandId: "inherited-edit-seed" },
      pageId,
      { id: pageId, ...loaded.page },
    );
    assert.equal(recorded.pageSha256, ownBodySha);

    assert.throws(
      () =>
        authorizePageEdit(root, {
          authorizationId: "inherited-snapshot-baseline",
          pageId,
          revision: recorded.revision,
          pageSha256: snapshotSha,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "EDIT_PAGE_SHA_STALE");
        assert.match((error as Error).message, /changed before the editor Agent turn started/);
        return true;
      },
    );
    assert.throws(
      () =>
        authorizePageEdit(root, {
          authorizationId: "inherited-old-revision",
          pageId,
          revision: recorded.revision + 1,
          pageSha256: ownBodySha,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "EDIT_PAGE_REVISION_STALE");
        return true;
      },
    );
    const accepted = authorizePageEdit(root, {
      authorizationId: "inherited-own-body",
      pageId,
      revision: recorded.revision,
      pageSha256: ownBodySha,
    });
    assert.equal(accepted.pageSha256, ownBodySha);
  });

  it("names a missing ledger or page revision before starting an editor turn", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-editor-no-ledger-"));
    assert.throws(
      () =>
        authorizePageEdit(root, {
          authorizationId: "no-ledger",
          pageId: "p1",
          revision: 1,
          pageSha256: "f".repeat(64),
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "EDIT_PAGE_LEDGER_MISSING");
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(root, "_agent", "run-ledger.v1.json")), false);

    ensureRunLedger(root, {
      manifestSha256: "a".repeat(64),
      requirementsId: "b".repeat(64),
      requirements: [],
    });
    assert.throws(
      () =>
        authorizePageEdit(root, {
          authorizationId: "no-page-revision",
          pageId: "missing-page",
          revision: 1,
          pageSha256: "f".repeat(64),
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "EDIT_PAGE_LEDGER_MISSING");
        return true;
      },
    );
  });

  it("rejects element fields spilled to page level before painting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-write-spill-"));
    createEmptyProject(root, { title: "whole page write" });
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({ brief: "公开教学课件", strictExecution: true })}\n`,
    );
    writeLedger(root, [], "2026-08-31T00:00:00.000Z", []);
    addTodoFact(root, 1);
    const result = await runDomainHand(
      "write_page",
      {
        id: "cover",
        pageType: "cover",
        elements: agentCoverPage().elements,
        bold: true,
        align: ["left", "middle"],
        __openSlideStudio: { commandId: "spill-1", contextEpochId: "epoch-1" },
      },
      root,
    );
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /element fields at page level: align, bold/);
    assert.equal(loadProject(root).pages.length, 0);
  });

  it("serializes concurrent write_page calls so both revisions land", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-concurrent-"));
    createEmptyProject(root, { title: "并发写页" });
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "_agent", "runtime.json"),
      `${JSON.stringify({ brief: "并发写页", strictExecution: true })}\n`,
    );
    fs.writeFileSync(
      path.join(root, "_agent", "presentation-run.v1.json"),
      `${JSON.stringify({ provider: { providerId: "test", modelId: "m" } })}\n`,
    );
    ensureRunLedger(root, {
      manifestSha256: "d".repeat(64),
      requirementsId: "req-test",
      requirements: [],
    });
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "concurrent-write",
      brief: "并发写页",
      editorBaseUrl: "http://127.0.0.1:55200",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "m" },
    });
    const ctx = (toolCallId: string) => ({
      runId: handle.runId,
      sessionId: handle.sessionId,
      toolCallId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
    });
    const committed = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [
            { pageId: "cover", title: "封面", layoutFamily: "cover", exhibits: [] },
            { pageId: "body", title: "正文", layoutFamily: "content", exhibits: [] },
          ],
        },
      },
      ctx("commit-1"),
    );
    assert.equal(committed.ok, true, committed.detail);

    const page = (id: string, text: string) => ({
      id,
      pageType: id === "cover" ? "cover" : "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 48, 720, 72],
          content: {
            text,
            fontSize: 28,
            color: "#172856",
            bold: true,
            align: ["left", "middle"],
            wrap: true,
          },
          layoutRole: "title",
        },
        {
          elementId: "body",
          elementType: "text",
          bounds: [48, 140, 720, 200],
          content: {
            text: `${text}的说明文字与下一步行动。`,
            fontSize: 16,
            color: "#333333",
            align: ["left", "top"],
            wrap: true,
          },
          layoutRole: "body",
        },
      ],
    });
    const [a, b] = await Promise.all([
      run.execute({ name: "write_page", args: page("cover", "封面标题") }, ctx("w-1")),
      run.execute({ name: "write_page", args: page("body", "正文标题") }, ctx("w-2")),
    ]);
    assert.equal(a.ok, true, a.detail);
    assert.equal(b.ok, true, b.detail);
    const disk = loadProject(root);
    const ids = disk.pages.map((page) => path.basename(page.path, ".page")).sort();
    assert.deepEqual(ids, ["body", "cover"]);
    const ledger = readRunLedger(root);
    const revisions = ledger?.facts.filter((fact) => fact.type === "page.revision-committed") ?? [];
    assert.equal(revisions.length, 2);
    assert.equal(ledger?.facts.filter((fact) => fact.type === "todo.committed").length, 1);
  });
});

describe("presentation-run isolation", () => {
  it("does not import Pi or DSH", () => {
    const srcDir = path.join(PKG, "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(abs);
      }
    };
    walk(srcDir);
    for (const abs of files) {
      const text = fs.readFileSync(abs, "utf8");
      assert.doesNotMatch(text, /@earendil-works\/pi/);
      assert.doesNotMatch(text, /@deepseek-ai\//);
      assert.doesNotMatch(text, /from ["']@open-slidestudio\/agent-harness["']/);
      assert.doesNotMatch(text, /runPiHand/);
      if (!abs.endsWith("capability-ledger.ts")) {
        assert.doesNotMatch(text, /createPiBrain/);
      }
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.equal("@earendil-works/pi-coding-agent" in manifest.dependencies, false);
    assert.equal("@deepseek-ai/dsh" in manifest.dependencies, false);
    assert.equal("@open-slidestudio/agent-harness" in manifest.dependencies, false);
  });
});

describe("OpenKimi catalog", () => {
  it("enumerates the frozen source/visual set without cropping to a host preset", () => {
    const catalog = loadReferenceCatalog();
    assert.equal(catalog.sourceFiles, EXPECTED_SOURCE_FILES);
    assert.equal(catalog.visualFiles, EXPECTED_VISUAL_FILES);
    assert.equal(
      catalog.visuals.some((row) => row.designSystemId === "academic/paper-white-courseware"),
      true,
    );
    assert.equal(catalog.visuals.filter((row) => row.family === "academic").length >= 6, true);
  });
});

describe("chart evidence gate", () => {
  it("allows pages without charts and rejects charts without PPTD data.cols/rows", () => {
    assert.equal(
      assertChartEvidence({
        id: "cover",
        elements: [{ elementType: "text", content: { text: "勾股定理" } }],
      }).ok,
      true,
    );
    const rejected = assertChartEvidence({
      id: "p2",
      elements: [{ elementType: "chart", chartType: "bar" }],
    });
    assert.equal(rejected.ok, false);
    const accepted = assertChartEvidence({
      id: "p2",
      elements: [
        {
          elementType: "chart",
          data: {
            cols: ["年", "营收"],
            rows: [
              ["2024", 12],
              ["2028", 53],
            ],
          },
          series: [{ type: "bar", encode: { x: "年", y: "营收" } }],
        },
      ],
    });
    assert.equal(accepted.ok, true);
    const nested = assertChartEvidence({
      id: "market",
      elements: [
        {
          elementType: "chart",
          chart: {
            type: "bar",
            rows: [
              ["2024", 181],
              ["2028E", 483],
            ],
            encode: { x: "年份", y: "规模" },
            series: [{ type: "bar" }],
          },
        },
      ],
    });
    assert.equal(nested.ok, true);
  });
});

describe("PresentationRun", () => {
  it("lists exact required chunks first and rejects planning before every required chunk is read", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-required-preflight-"));
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "required-preflight",
      brief: "介绍一个普通产品",
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "test" },
    });
    ensureRunLedger(root, {
      manifestSha256: "a".repeat(64),
      requirementsId: "required-preflight-v1",
      requirements: [
        {
          sourceId: "openkimi:SKILL.md",
          fileSha256: "b".repeat(64),
          chunkIndexes: [0, 1],
          reason: "skill",
        },
        {
          sourceId: "openkimi:reference/pptd.md",
          fileSha256: "c".repeat(64),
          chunkIndexes: [0],
          reason: "pptd",
        },
      ],
    });
    const context = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
    };
    const listed = await run.execute(
      { name: "list_references", args: {} },
      { ...context, toolCallId: "list-required" },
    );
    assert.equal(listed.ok, true);
    assert.equal(listed.payload.referencesComplete, false);
    assert.deepEqual(listed.payload.missingReferenceChunks, [
      { sourceId: "openkimi:SKILL.md", chunkIndex: 0 },
      { sourceId: "openkimi:SKILL.md", chunkIndex: 1 },
      { sourceId: "openkimi:reference/pptd.md", chunkIndex: 0 },
    ]);
    assert.equal(listed.payload.next, "read_reference");

    for (const [name, args] of [
      ["commit_design", { slidePlan: [{ pageId: "p1", title: "封面", layoutFamily: "cover", exhibits: [] }] }],
      ["write_todo", { items: [{ pageId: "p1", title: "封面", layoutFamily: "cover", exhibits: [] }] }],
    ] as const) {
      const rejected = await run.execute({ name, args }, { ...context, toolCallId: `preflight-${name}` });
      assert.equal(rejected.ok, false, name);
      assert.equal(rejected.payload.error, "required_source_chunks_unread", name);
      assert.equal(rejected.payload.next, "read_reference", name);
      assert.deepEqual(rejected.payload.missingReferenceChunks, listed.payload.missingReferenceChunks, name);
    }
    const compose = await run.execute(
      { name: "compose_deck", args: { title: "Preflight" } },
      { ...context, toolCallId: "compose-required" },
    );
    assert.equal(compose.ok, false);
    assert.equal(compose.payload.error, "compose_not_ready");
    assert.equal(compose.payload.next, "read_reference");
    assert.deepEqual(compose.payload.missingReferenceChunks, listed.payload.missingReferenceChunks);
  });

  it("treats a candidate adopted design as required before recording its adoption", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-adopted-preflight-"));
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "adopted-preflight",
      brief: "介绍一个普通产品",
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "test" },
    });
    ensureRunLedger(root, {
      manifestSha256: "a".repeat(64),
      requirementsId: "candidate-adopt-v1",
      requirements: [],
    });
    const sourceId = "openkimi:reference/design_system/academic/blue-line-courseware/design.md";
    const context = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
    };
    const args = {
      slidePlan: [{ pageId: "p1", title: "封面", layoutFamily: "cover", exhibits: [] }],
      adoptedSourceIds: [sourceId],
    };
    const first = await run.execute({ name: "commit_design", args }, { ...context, toolCallId: "candidate-first" });
    assert.equal(first.ok, false);
    assert.deepEqual(first.payload.missingReferenceChunks, [
      { sourceId, chunkIndex: 0 },
      { sourceId, chunkIndex: 1 },
    ]);
    assert.equal(
      listSourceReceipts(root).some((receipt) => receipt.state === "adopted"),
      false,
    );
    for (const chunkIndex of [0, 1]) {
      const read = await run.execute(
        { name: "read_reference", args: { sourceId, chunkIndex } },
        { ...context, toolCallId: `candidate-read-${chunkIndex}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
    const committed = await run.execute(
      { name: "commit_design", args },
      { ...context, toolCallId: "candidate-committed" },
    );
    assert.equal(committed.ok, true, committed.detail);
    assert.equal(
      listSourceReceipts(root).some((receipt) => receipt.sourceId === sourceId && receipt.state === "adopted"),
      true,
    );
  });

  it("opens a self-directed run without category or design preset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-"));
    fs.mkdirSync(path.join(root, "_agent"));
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "sess-1",
      brief: "给小学生介绍勾股定理",
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const listed = await run.execute(
      { name: "list_references", args: {} },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId: "c1",
        projectRoot: root,
        abortSignal: new AbortController().signal,
      },
    );
    assert.equal(listed.ok, true);
    assert.equal(listed.payload.sourceFiles, EXPECTED_SOURCE_FILES);
    assert.equal(listed.payload.visualFiles, 44);
    const inspect = await run.inspect(handle.runId);
    assert.equal(inspect.hostDirected, false);
    assert.equal(inspect.categoryId, undefined);
    assert.equal(inspect.design.kind, "self-directed");
    assert.equal(inspect.designSystemId, undefined);
    const blocked = await run.execute(
      { name: "write_page", args: { id: "cover", elements: [] } },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId: "c2",
        projectRoot: root,
        abortSignal: new AbortController().signal,
      },
    );
    assert.equal(blocked.ok, false);
    assert.match(blocked.detail, /consulted reference receipt/);
    const cancelled = new AbortController();
    cancelled.abort();
    const aborted = await run.execute(
      { name: "list_references", args: {} },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId: "c-abort",
        projectRoot: root,
        abortSignal: cancelled.signal,
      },
    );
    assert.equal(aborted.ok, false);
    assert.match(aborted.detail, /cancelled/);
    const images = await run.execute(
      { name: "search_image", args: { query: "x" } },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        toolCallId: "c3",
        projectRoot: root,
        abortSignal: new AbortController().signal,
      },
    );
    assert.equal(images.ok, false);
    assert.match(images.detail, /not configured/);
    const revived = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const hydrated = revived.hydrate(root);
    assert.equal(hydrated?.sessionId, "sess-1");
    const inspectAgain = await revived.inspect("sess-1");
    assert.equal(inspectAgain.hostDirected, false);
    assert.equal(inspectAgain.pageCount, 0);
    assert.equal(inspectAgain.visualReviewMissing, false);
    assert.deepEqual(inspectAgain.pages, []);
    assert.equal(inspectAgain.structuralReview, "missing");
    assert.equal(inspectAgain.composeReady, false);
    assert.match(inspectAgain.composeBlockers[0] ?? "", /run ledger is not initialized/);
    assert.equal(inspectAgain.activity.phase, "awaiting-project");
    assert.equal(revived.epochFor("sess-1"), run.epochFor("sess-1"));
  });

  it("hydrates a legacy ledger into the durable strict execution policy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-hydrate-policy-"));
    fs.mkdirSync(path.join(root, "_agent"));
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    await run.open({
      projectRoot: root,
      sessionId: "sess-policy",
      brief: "继续同一个严格会话",
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    ensureRunLedger(root, {
      manifestSha256: "legacy-manifest",
      requirementsId: "legacy-requirements",
      requirements: [],
    });

    const revived = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    assert.equal(revived.hydrate(root)?.sessionId, "sess-policy");
    assert.deepEqual(readRunLedger(root)?.sourcePack.executionPolicy, {
      currentRenderedLayoutRequired: true,
      structuralReviewRequired: true,
    });
  });

  it("quarantines a zero-filled binding file instead of crashing hydration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-hydrate-corrupt-"));
    const agentDir = path.join(root, "_agent");
    fs.mkdirSync(agentDir);
    const bindingFile = path.join(agentDir, "presentation-run.v1.json");
    fs.writeFileSync(bindingFile, Buffer.alloc(256));

    const revived = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    assert.equal(revived.hydrate(root), undefined);
    assert.equal(fs.existsSync(bindingFile), false);
    assert.ok(fs.readdirSync(agentDir).some((name) => name.startsWith("presentation-run.v1.json.corrupt-")));
  });
});

describe("commit_design kind vs theme pack", () => {
  it("refuses board H1 adopting 澄光 monthly chrome and does not record the pack", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-kind-pack-"));
    fs.mkdirSync(path.join(root, "_agent"));
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const brief =
      "给公司董事会做一份「北麓制造 2026 上半年经营汇报」。办公场景，给董事会的半年经营审议，不是门店月报，不是产品立项。16 页左右。不要澄光生活，不要个人答辩。";
    const handle = await run.open({
      projectRoot: root,
      sessionId: "sess-kind-pack",
      brief,
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const ctx = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
    };
    const refused = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "H1", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: ["openkimi:reference/design_system/work/warm-jade-annual-report/design.md"],
        },
      },
      { ...ctx, toolCallId: "adopt-jade" },
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.payload.error, "kind_theme_pack");
    assert.equal(refused.payload.packId, "work/warm-jade-annual-report");
    assert.equal(refused.payload.painted, false);
    assert.equal(
      listSourceReceipts(root).some((row) => row.state === "adopted"),
      false,
    );
    const allowed = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "H1", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: ["consulting/pine-green-strategy"],
        },
      },
      { ...ctx, toolCallId: "adopt-consulting" },
    );
    assert.equal(allowed.ok, true, allowed.detail);
    assert.equal(
      listSourceReceipts(root).some(
        (row) => row.sourceId === "consulting/pine-green-strategy" && row.state === "adopted",
      ),
      true,
    );
  });

  it("refuses board H1 commit_design with no catalog pack and does not record self-directed adopt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-missing-pack-"));
    fs.mkdirSync(path.join(root, "_agent"));
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const brief =
      "给公司董事会做一份「北麓制造 2026 上半年经营汇报」。办公场景，给董事会的半年经营审议，不是门店月报，不是产品立项。16 页左右。不要澄光生活，不要个人答辩。";
    const handle = await run.open({
      projectRoot: root,
      sessionId: "sess-missing-pack",
      brief,
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const missing = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "H1", layoutFamily: "cover", exhibits: [] }],
        },
      },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        projectRoot: root,
        abortSignal: new AbortController().signal,
        toolCallId: "adopt-empty",
      },
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.payload.error, "missing_theme_pack");
    assert.equal(missing.payload.painted, false);
    assert.equal(
      listSourceReceipts(root).some((row) => row.state === "adopted"),
      false,
    );
    const selfDirected = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "H1", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: ["agent-self-directed-plan"],
        },
      },
      {
        runId: handle.runId,
        sessionId: handle.sessionId,
        projectRoot: root,
        abortSignal: new AbortController().signal,
        toolCallId: "adopt-self",
      },
    );
    assert.equal(selfDirected.ok, false);
    assert.equal(selfDirected.payload.error, "missing_theme_pack");
    assert.equal(
      listSourceReceipts(root).some((row) => row.sourceId === "agent-self-directed-plan"),
      false,
    );
  });

  it("refuses 学习分享 commit_design empty adopt / agent-self-directed-plan", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-learn-share-pack-"));
    fs.mkdirSync(path.join(root, "_agent"));
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const brief =
      "给同事做一次内部「学习分享」。办公场景，约 30 分钟的知识分享会，不是经营月报，不是产品立项。16–20 页。";
    const handle = await run.open({
      projectRoot: root,
      sessionId: "sess-learn-share-pack",
      brief,
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const ctx = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
      toolCallId: "adopt-empty-share",
    };
    const missing = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "学习分享", layoutFamily: "cover", exhibits: [] }],
        },
      },
      ctx,
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.payload.error, "missing_theme_pack");
    assert.equal(missing.payload.painted, false);
    const selfDirected = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "学习分享", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: ["agent-self-directed-plan"],
        },
      },
      { ...ctx, toolCallId: "adopt-self-share" },
    );
    assert.equal(selfDirected.ok, false);
    assert.equal(selfDirected.payload.error, "missing_theme_pack");
    const writeMissing = await run.execute(
      {
        name: "write_page",
        args: {
          id: "1_cover",
          pageType: "cover",
          elements: [
            {
              elementType: "text",
              bounds: [48, 80, 800, 80],
              content: { text: "把模糊问题变清晰" },
            },
          ],
        },
      },
      { ...ctx, toolCallId: "write-before-adopt" },
    );
    assert.equal(writeMissing.ok, false);
    assert.equal(writeMissing.payload.error, "missing_theme_pack");
    assert.equal(writeMissing.payload.painted, false);
    const allowed = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "学习分享", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: ["promotion/silk-yellow-magazine"],
        },
      },
      { ...ctx, toolCallId: "adopt-promotion" },
    );
    assert.equal(allowed.ok, true, allowed.detail);
    assert.equal(
      listSourceReceipts(root).some(
        (row) => row.sourceId === "promotion/silk-yellow-magazine" && row.state === "adopted",
      ),
      true,
    );
  });

  it("unwraps MiniMax {sourceId} / {kind,name} adopt for 个人答辩 and still refuses empty objects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-defense-object-adopt-"));
    fs.mkdirSync(path.join(root, "_agent"));
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const brief = "做一次硕士「个人答辩」。开题答辩，约 16 页。不是经营月报，不是学习分享。";
    const handle = await run.open({
      projectRoot: root,
      sessionId: "sess-defense-object-adopt",
      brief,
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const ctx = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
      toolCallId: "adopt-empty-defense",
    };
    const emptyObj = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "答辩", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: { sourceId: {} },
        },
      },
      ctx,
    );
    assert.equal(emptyObj.ok, false);
    assert.equal(emptyObj.payload.error, "missing_theme_pack");
    assert.equal(emptyObj.payload.painted, false);
    const kindOnly = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "答辩", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: { kind: "academic" },
        },
      },
      { ...ctx, toolCallId: "adopt-kind-only" },
    );
    assert.equal(kindOnly.ok, false);
    assert.equal(kindOnly.payload.error, "missing_theme_pack");
    const viaSourceId = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "答辩", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: { item: { sourceId: "academic/paper-white-courseware" } },
        },
      },
      { ...ctx, toolCallId: "adopt-sourceid" },
    );
    assert.equal(viaSourceId.ok, true, viaSourceId.detail);
    assert.equal(
      listSourceReceipts(root).some(
        (row) => row.sourceId === "academic/paper-white-courseware" && row.state === "adopted",
      ),
      true,
    );
  });

  it("unwraps MiniMax {id}/{packId} adopt and still refuses page-id / empty objects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-id-packid-adopt-"));
    fs.mkdirSync(path.join(root, "_agent"));
    const run = createPresentationRun({ repoRoot: path.resolve(PKG, "../..") });
    const brief = "做一次硕士「个人答辩」。开题答辩，约 16 页。不是经营月报，不是学习分享。";
    const handle = await run.open({
      projectRoot: root,
      sessionId: "sess-id-packid-adopt",
      brief,
      editorBaseUrl: "http://127.0.0.1:3080/app",
      design: { kind: "self-directed" },
      provider: { providerId: "minimax-cn", modelId: "MiniMax-M3" },
    });
    const ctx = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot: root,
      abortSignal: new AbortController().signal,
      toolCallId: "adopt-empty-id",
    };
    const emptyId = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "答辩", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: { id: {} },
        },
      },
      ctx,
    );
    assert.equal(emptyId.ok, false);
    assert.equal(emptyId.payload.error, "missing_theme_pack");
    assert.equal(emptyId.payload.painted, false);
    const pageId = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "答辩", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: { id: "1_cover" },
        },
      },
      { ...ctx, toolCallId: "adopt-page-id" },
    );
    assert.equal(pageId.ok, false);
    assert.equal(pageId.payload.error, "missing_theme_pack");
    const viaPackId = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: [{ pageId: "cover", title: "答辩", layoutFamily: "cover", exhibits: [] }],
          adoptedSourceIds: { item: { packId: "academic/paper-white-courseware" } },
        },
      },
      { ...ctx, toolCallId: "adopt-packid" },
    );
    assert.equal(viaPackId.ok, true, viaPackId.detail);
    assert.equal(
      listSourceReceipts(root).some(
        (row) => row.sourceId === "academic/paper-white-courseware" && row.state === "adopted",
      ),
      true,
    );
  });
});

describe("compose gate after Hub resume", () => {
  it("keeps current-revision emit/review when DSH mints a new epoch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prun-epoch-"));
    const at = "2026-08-27T08:00:00.000Z";
    const pageSha = "a".repeat(64);
    const rasterSha = "b".repeat(64);
    const fileSha = "c".repeat(64);
    const chunkSha = "d".repeat(64);
    const ledger = {
      schemaVersion: 1,
      runId: "sess-resume",
      createdAt: at,
      updatedAt: at,
      sourcePack: {
        manifestSha256: "m".repeat(64),
        requirementsId: "r".repeat(64),
        requirements: [
          {
            sourceId: "openkimi:SKILL.md",
            fileSha256: fileSha,
            reason: "skill",
            chunkIndexes: [0],
          },
        ],
      },
      facts: [
        {
          type: "reference.chunk-returned",
          factId: "ref-1",
          at,
          contextEpochId: "dsh-old-epoch",
          sourceId: "openkimi:SKILL.md",
          fileSha256: fileSha,
          chunkIndex: 0,
          chunkSha256: chunkSha,
        },
        {
          type: "todo.committed",
          factId: "todo-1",
          at,
          contextEpochId: "dsh-old-epoch",
          todoSha256: "e".repeat(64),
          itemCount: 1,
        },
        {
          type: "page.revision-committed",
          factId: "page-1",
          at,
          contextEpochId: "dsh-old-epoch",
          pageId: "cover",
          revision: 1,
          pageSha256: pageSha,
        },
        {
          type: "page.raster-committed",
          factId: "raster-1",
          at,
          pageId: "cover",
          revision: 1,
          pageSha256: pageSha,
          rasterSha256: rasterSha,
          src: "_agent/rasters/cover.png",
          width: 960,
          height: 540,
          layoutGateVersion: "rendered-layout-gate-v8",
          layoutStatus: "pass",
          layoutIssues: [],
        },
        {
          type: "page.image-content-emitted",
          factId: "emit-1",
          at,
          contextEpochId: "dsh-old-epoch",
          commandId: "cmd-1",
          pageId: "cover",
          revision: 1,
          pageSha256: pageSha,
          rasterSha256: rasterSha,
          deliveryToken: "tok-1",
        },
        {
          type: "page.visual-review-recorded",
          factId: "review-1",
          at,
          contextEpochId: "dsh-old-epoch",
          pageId: "cover",
          revision: 1,
          pageSha256: pageSha,
          rasterSha256: rasterSha,
          deliveryToken: "tok-1",
          verdict: "pass",
          issues: [],
        },
        {
          type: "deck.structural-review-recorded",
          factId: "struct-1",
          at,
          reviewGateVersion: "structural-review-gate-v6",
          pageRevisions: { cover: pageSha },
          ok: true,
          issues: [],
        },
      ],
    };
    fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
    fs.writeFileSync(path.join(root, "_agent", "run-ledger.v1.json"), `${JSON.stringify(ledger, null, 2)}\n`);
    const before = inspectRunLedger(root, "dsh-old-epoch");
    assert.equal(before.composeReady, true, before.composeBlockers.join("; "));
    // A restart resumes the persisted epoch: same contextEpochId stays sealed.
    const afterRestart = inspectRunLedger(root, "dsh-old-epoch");
    assert.equal(afterRestart.composeReady, true, afterRestart.composeBlockers.join("; "));
    assert.equal(afterRestart.pages[0]?.visualReview, "pass");
    assert.equal(afterRestart.pages[0]?.imageEmitted, true);
    // A route change mints a fresh epoch: old-epoch source reads no longer
    // satisfy the requirement, while raster/emit/review stay revision-bound.
    const switched = inspectRunLedger(root, "dsh-new-epoch-after-model-switch");
    assert.equal(switched.composeReady, false);
    assert.ok(
      switched.composeBlockers.some((blocker) => /required source chunks unread/.test(blocker)),
      switched.composeBlockers.join("; "),
    );
    assert.equal(switched.pages[0]?.visualReview, "pass");
    assert.equal(switched.pages[0]?.imageEmitted, true);
  });
});

describe("capability ledger", () => {
  it("maps Pi generate tools instead of deleting them", () => {
    const ids = new Set(CAPABILITY_LEDGER.map((row) => row.id));
    for (const required of [
      "list_references",
      "write_page",
      "compose_deck",
      "export_deck",
      "createPiBrain",
      "resolveGenerateDesign",
      "host-produce",
    ]) {
      assert.equal(ids.has(required), true, required);
    }
    assert.equal(CAPABILITY_LEDGER.find((row) => row.id === "createPiBrain")?.fate, "dev-only");
    assert.equal(CAPABILITY_LEDGER.find((row) => row.id === "host-produce")?.fate, "dev-only");
  });
});

describe("visualReviewMissing", () => {
  it("is false when vision is none, and true only for a missing image-backed pass", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vis-rev-"));
    assert.equal(currentVisualReviewsMissing(root, 0), false);
    assert.equal(currentVisualReviewsMissing(root, 2), false);
    const visionEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SLIDESTUDIO_VISION_REVIEWER: "http://127.0.0.1:9/review",
    };
    delete visionEnv.SLIDESTUDIO_LLM_IMAGE;
    assert.equal(currentVisualReviewsMissing(root, 2, visionEnv), true);
  });
});
