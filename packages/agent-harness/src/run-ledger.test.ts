import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DECK_TASTE_AXES,
  RENDERED_LAYOUT_GATE_VERSION,
  RUN_LEDGER_REL,
  STRUCTURAL_REVIEW_GATE_VERSION,
  TASTE_EXECUTION_GATE_VERSION,
  currentDeckSnapshot,
  ensureRunLedger,
  inspectRunLedger,
  recordDeckOverviewPrepared,
  recordDeckTasteReview,
  recordDesignContractCommitted,
  recordDesignReferencePrepared,
  recordCompose,
  recordImageEmitted,
  recordImagePrepared,
  recordPageRevision,
  recordPreparedImageEmitted,
  recordRaster,
  recordReferenceChunk,
  recordStructuralReview,
  recordTodo,
  recordVisualReview,
  stableSha256,
} from "./run-ledger.js";
import { commitDesignContract, type DesignContractDraft } from "./design-contract.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-run-ledger-"));
  const context = { commandId: "cmd-1", contextEpochId: "epoch-1" };
  ensureRunLedger(root, {
    manifestSha256: "manifest",
    requirementsId: "req-1",
    requirements: [
      {
        sourceId: "openkimi:SKILL.md",
        fileSha256: "skill",
        chunkIndexes: [0, 1],
        reason: "skill",
      },
    ],
  });
  return { root, context };
}

describe("RunLedger", () => {
  it("blocks compose until exact current evidence exists", () => {
    const { root, context } = fixture();
    assert.equal(inspectRunLedger(root, context.contextEpochId).referencesComplete, false);
    for (const chunkIndex of [0, 1]) {
      recordReferenceChunk(root, context, {
        sourceId: "openkimi:SKILL.md",
        fileSha256: "skill",
        chunkIndex,
        chunkSha256: `chunk-${chunkIndex}`,
      });
    }
    recordTodo(root, context, [{ title: "one" }, { title: "two" }]);
    for (const id of ["page-01", "page-02"]) {
      const page = recordPageRevision(root, context, id, { id, text: id });
      const raster = recordRaster(root, page, {
        bytes: Buffer.from(`${id}-png`),
        src: `_agent/rasters/${id}.png`,
        width: 960,
        height: 540,
        layoutStatus: "pass",
        layoutIssues: [],
      });
      recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
      recordImageEmitted(root, context, raster.deliveryToken);
      recordVisualReview(root, context, {
        pageId: id,
        revision: page.revision,
        deliveryToken: raster.deliveryToken,
        verdict: "pass",
        issues: [],
      });
    }
    recordStructuralReview(root, true, []);
    assert.equal(inspectRunLedger(root, context.contextEpochId).composeReady, true);
    recordCompose(root, context, "deck");
    assert.equal(inspectRunLedger(root, context.contextEpochId).composed, true);
  });

  it("invalidates raster and review when a page changes", () => {
    const { root, context } = fixture();
    const first = recordPageRevision(root, context, "page-01", { text: "a" });
    const raster = recordRaster(root, first, {
      bytes: Buffer.from("png"),
      src: "_agent/rasters/page-01.png",
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
    recordImageEmitted(root, context, raster.deliveryToken);
    recordVisualReview(root, context, {
      pageId: "page-01",
      revision: 1,
      deliveryToken: raster.deliveryToken,
      verdict: "pass",
      issues: [],
    });
    const second = recordPageRevision(root, context, "page-01", { text: "b" });
    assert.equal(second.revision, 2);
    const status = inspectRunLedger(root, context.contextEpochId).pages[0];
    assert.equal(status?.raster, false);
    assert.equal(status?.imageEmitted, false);
    assert.equal(status?.visualReview, "missing");
  });

  it("requires a changed page after a revise decision", () => {
    const { root, context } = fixture();
    const page = recordPageRevision(root, context, "page-01", { text: "a" });
    const raster = recordRaster(root, page, {
      bytes: Buffer.from("png"),
      src: "_agent/rasters/page-01.png",
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
    recordImageEmitted(root, context, raster.deliveryToken);
    recordVisualReview(root, context, {
      pageId: "page-01",
      revision: 1,
      deliveryToken: raster.deliveryToken,
      verdict: "revise",
      issues: ["footer collision"],
    });
    assert.throws(() => recordPageRevision(root, context, "page-01", { text: "a" }), /must change/);
  });

  it("does not let a visual pass hide a rendered layout failure", () => {
    const { root, context } = fixture();
    const page = recordPageRevision(root, context, "page-01", { text: "a" });
    const raster = recordRaster(root, page, {
      bytes: Buffer.from("png"),
      src: "_agent/rasters/page-01.png",
      width: 960,
      height: 540,
      layoutStatus: "fail",
      layoutIssues: [
        {
          code: "text-overflow-y",
          severity: "error",
          elementIds: ["body"],
          detail: "scrollHeight 40 exceeds clientHeight 20",
        },
      ],
    });
    recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
    recordImageEmitted(root, context, raster.deliveryToken);
    assert.throws(
      () =>
        recordVisualReview(root, context, {
          pageId: "page-01",
          revision: 1,
          deliveryToken: raster.deliveryToken,
          verdict: "pass",
          issues: [],
        }),
      /cannot pass.*text-overflow-y/,
    );
    assert.equal(
      recordVisualReview(root, context, {
        pageId: "page-01",
        revision: 1,
        deliveryToken: raster.deliveryToken,
        verdict: "revise",
        issues: ["text-overflow-y: body text is clipped"],
      }).verdict,
      "revise",
    );
  });

  it("invalidates raster evidence from an older layout gate", () => {
    const { root, context } = fixture();
    const page = recordPageRevision(root, context, "page-01", { text: "a" });
    const raster = recordRaster(root, page, {
      bytes: Buffer.from("png"),
      src: "_agent/rasters/page-01.png",
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    assert.equal(raster.fact.layoutGateVersion, RENDERED_LAYOUT_GATE_VERSION);
    const ledgerFile = path.join(root, RUN_LEDGER_REL);
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as {
      facts: Array<Record<string, unknown>>;
    };
    const rasterFact = ledger.facts.find((fact) => fact.type === "page.raster-committed");
    assert.ok(rasterFact);
    delete rasterFact.layoutGateVersion;
    fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    assert.equal(inspectRunLedger(root, context.contextEpochId).pages[0]?.raster, false);
  });

  it("invalidates structural evidence from an older review gate", () => {
    const { root, context } = fixture();
    recordStructuralReview(root, true, []);
    const ledgerFile = path.join(root, RUN_LEDGER_REL);
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as {
      facts: Array<Record<string, unknown>>;
    };
    const reviewFact = ledger.facts.find((fact) => fact.type === "deck.structural-review-recorded");
    assert.equal(reviewFact?.reviewGateVersion, STRUCTURAL_REVIEW_GATE_VERSION);
    delete reviewFact!.reviewGateVersion;
    fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    assert.equal(inspectRunLedger(root, context.contextEpochId).structuralReview, "missing");
  });

  it("hashes object keys deterministically", () => {
    assert.equal(stableSha256({ b: 2, a: 1 }), stableSha256({ a: 1, b: 2 }));
    assert.equal(stableSha256(undefined), stableSha256(null));
  });

  it("requires selected preview, current contract, full-deck overview, and grounded taste review", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oss-taste-ledger-"));
    const context = { commandId: "cmd", contextEpochId: "taste-epoch" };
    const designSha = "a".repeat(64);
    const previewSha = "b".repeat(64);
    ensureRunLedger(root, {
      manifestSha256: "manifest",
      requirementsId: "taste-req",
      requirements: [
        {
          sourceId: "openkimi:design.md",
          fileSha256: designSha,
          chunkIndexes: [0],
          reason: "preset-design",
        },
      ],
      tasteGate: {
        version: TASTE_EXECUTION_GATE_VERSION,
        visualManifestSha256: "c".repeat(64),
        designSystemId: "consulting/marine-blue-research",
        selectedDesignSourceId: "openkimi:design.md",
        selectedDesignSha256: designSha,
        selectedPreviewSourceId: "openkimi-preview:consulting/marine-blue-research",
        selectedPreviewSha256: previewSha,
      },
    });
    recordReferenceChunk(root, context, {
      sourceId: "openkimi:design.md",
      fileSha256: designSha,
      chunkIndex: 0,
      chunkSha256: "chunk",
    });
    recordDesignReferencePrepared(root, context, {
      sourceId: "openkimi-preview:consulting/marine-blue-research",
      imageSha256: previewSha,
      src: "_agent/references/selected-design.jpg",
      deliveryToken: "preview-token",
    });
    recordPreparedImageEmitted(root, context, "preview-token");
    const contract = commitDesignContract(root, {
      brief: "董事会月报，深蓝",
      categoryId: "management-report",
      designSystemId: "consulting/marine-blue-research",
      references: [
        { sourceId: "openkimi:design.md", sha256: designSha, role: "selected-design" },
        {
          sourceId: "openkimi-preview:consulting/marine-blue-research",
          sha256: previewSha,
          role: "selected-preview",
        },
      ],
      draft: tasteDraft(),
    });
    recordDesignContractCommitted(root, context, contract.contractSha256);
    const todo = contract.draft.slidePlan.map((slide) => ({
      pageId: slide.pageId,
      title: slide.title,
      layoutFamily: slide.layoutFamily,
    }));
    recordTodo(root, context, todo);
    for (const planned of contract.draft.slidePlan) {
      const page = recordPageRevision(root, context, planned.pageId, {
        id: planned.pageId,
        pageType: planned.layoutFamily,
      });
      const raster = recordRaster(root, page, {
        bytes: Buffer.from(`${planned.pageId}-png`),
        src: `_agent/rasters/${planned.pageId}.png`,
        width: 960,
        height: 540,
        layoutStatus: "pass",
        layoutIssues: [],
      });
      recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
      recordPreparedImageEmitted(root, context, raster.deliveryToken);
      recordVisualReview(root, context, {
        pageId: planned.pageId,
        revision: page.revision,
        deliveryToken: raster.deliveryToken,
        verdict: "pass",
        issues: [],
      });
    }
    recordStructuralReview(root, true, []);
    assert.equal(inspectRunLedger(root, context.contextEpochId).composeReady, false);
    assert.match(inspectRunLedger(root, context.contextEpochId).composeBlockers.join(";"), /overview/);

    const snapshot = currentDeckSnapshot(root, context.contextEpochId);
    const overview = recordDeckOverviewPrepared(root, context, snapshot, {
      bytes: Buffer.from("overview-png"),
      src: `_agent/overviews/${snapshot.deckSnapshotSha256}.png`,
      width: 1480,
      height: 1000,
      rendererVersion: "deck-overview-v1",
    });
    recordPreparedImageEmitted(root, context, overview.deliveryToken);
    assert.throws(
      () =>
        recordDeckTasteReview(root, context, {
          deliveryToken: overview.deliveryToken,
          verdict: "revise",
          axes: DECK_TASTE_AXES.map((axis) => ({
            axis,
            verdict: "revise" as const,
            observations: [`${axis} still looks generic`],
            pageIds: ["page-01"],
            contractRules: [`${axis} contract rule`],
          })),
          strongestPageId: "page-02",
          weakestPageId: "page-01",
          visualMemoryObserved: "the feature is inconsistent",
          summary: "revision is required",
          remainingAiDefaults: ["uniform card rhythm"],
          revisionActions: [],
        }),
      /requires at least one page repair action/,
    );
    recordDeckTasteReview(root, context, {
      deliveryToken: overview.deliveryToken,
      verdict: "pass",
      axes: DECK_TASTE_AXES.map((axis) => ({
        axis,
        verdict: "pass" as const,
        observations: [`${axis} is visibly resolved in the current overview`],
        pageIds: ["page-01", "page-02"],
        contractRules: [`${axis} follows the committed contract`],
      })),
      strongestPageId: "page-02",
      weakestPageId: "page-05",
      visualMemoryObserved: "the conclusion rule recurs at section transitions",
      summary: "the deck has a deliberate visual sequence and no unresolved generic defaults",
      remainingAiDefaults: [],
      revisionActions: [],
    });
    const ready = inspectRunLedger(root, context.contextEpochId);
    assert.equal(ready.deckOverview, "emitted");
    assert.equal(ready.deckTasteReview, "pass");
    assert.equal(ready.composeReady, true, ready.composeBlockers.join("; "));
    recordCompose(root, context, "taste deck");
    assert.equal(inspectRunLedger(root, context.contextEpochId).composed, true);

    recordPageRevision(root, context, "page-02", {
      id: "page-02",
      pageType: "chart-led",
      changed: true,
    });
    const stale = inspectRunLedger(root, context.contextEpochId);
    assert.equal(stale.deckOverview, "missing");
    assert.equal(stale.deckTasteReview, "missing");
    assert.equal(stale.composeReady, false);
  });
});

describe("plan to pages identity gate", () => {
  it("matching todo pageIds and pages report no identity blocker", () => {
    const { root, context } = fixture();
    recordTodo(root, context, [
      { pageId: "a", title: "A" },
      { pageId: "b", title: "B" },
    ]);
    recordPageRevision(root, context, "a", { id: "a" });
    recordPageRevision(root, context, "b", { id: "b" });
    const blockers = inspectRunLedger(root, context.contextEpochId).composeBlockers;
    assert.ok(!blockers.some((blocker) => /missing pages|not in todo/.test(blocker)), blockers.join("; "));
  });

  it("same count with different identity still blocks", () => {
    const { root, context } = fixture();
    recordTodo(root, context, [
      { pageId: "a", title: "A" },
      { pageId: "b", title: "B" },
    ]);
    recordPageRevision(root, context, "a", { id: "a" });
    recordPageRevision(root, context, "c", { id: "c" });
    const blockers = inspectRunLedger(root, context.contextEpochId).composeBlockers;
    assert.ok(
      blockers.some((blocker) => blocker.includes("missing pages") && blocker.includes("b")),
      blockers.join("; "),
    );
    assert.ok(
      blockers.some((blocker) => blocker.includes("pages not in todo") && blocker.includes("c")),
      blockers.join("; "),
    );
  });

  it("legacy todo facts without pageIds keep the cardinality blocker", () => {
    const { root, context } = fixture();
    recordTodo(root, context, [{ title: "one" }, { title: "two" }]);
    recordPageRevision(root, context, "a", { id: "a" });
    recordPageRevision(root, context, "b", { id: "b" });
    recordPageRevision(root, context, "c", { id: "c" });
    const blockers = inspectRunLedger(root, context.contextEpochId).composeBlockers;
    assert.ok(
      blockers.some((blocker) => /todo has 2 pages but 3 current page revisions exist/.test(blocker)),
      blockers.join("; "),
    );
  });
});

function tasteDraft(): DesignContractDraft {
  const layouts = ["cover", "chart-led", "table-led", "editorial-asymmetric", "decision", "conclusion"] as const;
  return {
    audience: "董事会",
    scene: "月度经营会",
    purpose: "解释经营结果并推动决策",
    designRead: "深蓝建立结构，强调色只用于关键结论",
    necessaryJudgment: {
      removeOrDemote: ["装饰卡片"],
      mustRemain: ["结论和证据"],
      inevitableRelationships: ["结果、原因、动作顺序"],
    },
    tasteDials: {
      visualVariance: 4,
      informationDensity: 4,
      brandDistinction: 4,
      typeExpressiveness: 3,
      experimentRisk: 2,
    },
    typeSystem: {
      personality: "克制权威",
      title: "结论式大标题",
      body: "紧凑中文正文",
      data: "清晰数字层级",
      mixedScript: "中文为主",
    },
    palette: {
      background: "#F7F8FA",
      text: "#172033",
      primary: "#153B63",
      accent: "#C8942F",
      neutral: "#8290A3",
      areaRules: ["主色不过量"],
    },
    grid: "12 栏和固定安全边距",
    densityRules: ["一页一个判断"],
    chartGrammar: ["直接标注关键值"],
    visualMemory: { feature: "结论标尺", recurrence: "章节页复现", avoid: "不满页复制" },
    referenceUse: { adopt: ["层级"], adapt: ["密度"], doNotCopy: ["不复制文字数据"] },
    antiDefaultLocks: ["禁止平均卡片墙"],
    slidePlan: layouts.map((layoutFamily, index) => ({
      pageId: `page-${String(index + 1).padStart(2, "0")}`,
      title: `第 ${index + 1} 页`,
      narrativeJob: `任务 ${index + 1}`,
      layoutFamily,
      focalPoint: `焦点 ${index + 1}`,
    })),
    userOverrides: [{ quote: "深蓝", effect: "作为主色" }],
  };
}
