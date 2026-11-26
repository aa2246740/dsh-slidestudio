import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authenticGenerationStatus } from "./generation-provenance.js";
import {
  DECK_TASTE_AXES,
  TASTE_EXECUTION_GATE_VERSION,
  currentDeckSnapshot,
  ensureRunLedger,
  recordDeckOverviewPrepared,
  recordDeckTasteReview,
  recordCompose,
  recordDesignContractCommitted,
  recordDesignReferencePrepared,
  recordImageEmitted,
  recordImagePrepared,
  recordPageRevision,
  recordPreparedImageEmitted,
  recordRaster,
  recordReferenceChunk,
  recordStructuralReview,
  recordTodo,
  recordVisualReview,
} from "./run-ledger.js";
import { commitDesignContract } from "./design-contract.js";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authentic-generation-"));
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.mkdirSync(path.join(root, "_agent", "rasters"), { recursive: true });
  fs.writeFileSync(path.join(root, "deck.pptd"), "title: test\n");
  for (let i = 1; i <= 2; i++) {
    fs.writeFileSync(path.join(root, "pages", `0${i}_page.page`), "pageType: content\n");
    fs.writeFileSync(path.join(root, "_agent", "rasters", `page-${i}.png`), "png");
  }
  writeJson(path.join(root, "_agent", "hands-state.json"), {
    todos: [{ title: "one" }, { title: "two" }],
    writtenPages: [{ id: "page-1" }, { id: "page-2" }],
  });
  const hands = [
    "write_todo",
    "write_page",
    "render_page",
    "write_page",
    "render_page",
    "review_pages",
    "compose_deck",
  ];
  fs.writeFileSync(
    path.join(root, "_agent", "hands-log.jsonl"),
    `${hands.map((name) => JSON.stringify({ name, ok: true })).join("\n")}\n`,
  );
  writeJson(path.join(root, "_agent", "pi-trace.json"), {
    usedPi: true,
    produce: "pi-tools",
    provider: "openai-codex",
    model: "gpt-test",
    sessionId: "session-test",
    agentStart: "2026-08-20T00:00:00.000Z",
    agentEnd: "2026-08-20T00:01:00.000Z",
    events: [
      "agent_start",
      "tool:write_todo",
      "tool:write_page",
      "tool:review_pages",
      "tool:compose_deck",
      "agent_end",
    ],
    skillStack: {
      ok: true,
      compose: true,
      review: true,
      renderCoverage: true,
      oneShotDump: false,
    },
  });
  const context = { commandId: "fixture-command", contextEpochId: "fixture-epoch" };
  ensureRunLedger(root, {
    manifestSha256: "a".repeat(64),
    requirementsId: "b".repeat(64),
    requirements: [
      {
        sourceId: "openkimi:SKILL.md",
        fileSha256: "c".repeat(64),
        chunkIndexes: [0],
        reason: "skill",
      },
    ],
    tasteGate: {
      version: TASTE_EXECUTION_GATE_VERSION,
      visualManifestSha256: "e".repeat(64),
      designSystemId: "consulting/marine-blue-research",
      selectedDesignSourceId: "openkimi:SKILL.md",
      selectedDesignSha256: "c".repeat(64),
      selectedPreviewSourceId: "openkimi-preview:consulting/marine-blue-research",
      selectedPreviewSha256: "f".repeat(64),
    },
  });
  recordReferenceChunk(root, context, {
    sourceId: "openkimi:SKILL.md",
    fileSha256: "c".repeat(64),
    chunkIndex: 0,
    chunkSha256: "d".repeat(64),
  });
  recordDesignReferencePrepared(root, context, {
    sourceId: "openkimi-preview:consulting/marine-blue-research",
    imageSha256: "f".repeat(64),
    src: "_agent/references/selected-design.jpg",
    deliveryToken: "preview-token",
  });
  recordPreparedImageEmitted(root, context, "preview-token");
  const contract = commitDesignContract(root, {
    brief: "test deck",
    categoryId: "management-report",
    designSystemId: "consulting/marine-blue-research",
    references: [
      {
        sourceId: "openkimi:SKILL.md",
        sha256: "c".repeat(64),
        role: "selected-design",
      },
      {
        sourceId: "openkimi-preview:consulting/marine-blue-research",
        sha256: "f".repeat(64),
        role: "selected-preview",
      },
    ],
    draft: {
      audience: "decision makers",
      scene: "monthly review",
      purpose: "make a decision",
      designRead: "strong hierarchy and evidence-led pages",
      necessaryJudgment: {
        removeOrDemote: ["decorative cards"],
        mustRemain: ["claims and evidence"],
        inevitableRelationships: ["claim before action"],
      },
      tasteDials: {
        visualVariance: 4,
        informationDensity: 3,
        brandDistinction: 4,
        typeExpressiveness: 3,
        experimentRisk: 2,
      },
      typeSystem: {
        personality: "authoritative",
        title: "large conclusion",
        body: "compact",
        data: "tabular",
        mixedScript: "balanced",
      },
      palette: {
        background: "#FFFFFF",
        text: "#172033",
        primary: "#153B63",
        accent: "#C8942F",
        neutral: "#8290A3",
        areaRules: ["accent marks conclusions only"],
      },
      grid: "twelve columns with safe margins",
      densityRules: ["one decision per page"],
      chartGrammar: ["direct labels"],
      visualMemory: { feature: "gold rule", recurrence: "section turns", avoid: "not every card" },
      referenceUse: { adopt: ["hierarchy"], adapt: ["density"], doNotCopy: ["literal copy"] },
      antiDefaultLocks: ["no card wall"],
      slidePlan: [
        {
          pageId: "page-1",
          title: "one",
          narrativeJob: "open",
          layoutFamily: "cover",
          focalPoint: "title",
        },
        {
          pageId: "page-2",
          title: "two",
          narrativeJob: "prove",
          layoutFamily: "chart-led",
          focalPoint: "evidence",
        },
      ],
      userOverrides: [],
    },
  });
  recordDesignContractCommitted(root, context, contract.contractSha256);
  recordTodo(root, context, [
    { pageId: "page-1", title: "one", layoutFamily: "cover" },
    { pageId: "page-2", title: "two", layoutFamily: "chart-led" },
  ]);
  for (let i = 1; i <= 2; i++) {
    const pageId = `page-${i}`;
    const page = recordPageRevision(root, context, pageId, { id: pageId, title: pageId });
    const raster = recordRaster(root, page, {
      bytes: Buffer.from(`png-${i}`),
      src: `_agent/rasters/page-${i}.png`,
      width: 960,
      height: 540,
      layoutStatus: "pass",
      layoutIssues: [],
    });
    recordImagePrepared(root, context, raster.fact, raster.deliveryToken);
    recordImageEmitted(root, context, raster.deliveryToken);
    recordVisualReview(root, context, {
      pageId,
      revision: page.revision,
      deliveryToken: raster.deliveryToken,
      verdict: "pass",
      issues: [],
    });
  }
  recordStructuralReview(root, true, []);
  const snapshot = currentDeckSnapshot(root, context.contextEpochId);
  const overview = recordDeckOverviewPrepared(root, context, snapshot, {
    bytes: Buffer.from("overview"),
    src: `_agent/overviews/${snapshot.deckSnapshotSha256}.png`,
    width: 1480,
    height: 540,
    rendererVersion: "deck-overview-v1",
  });
  recordPreparedImageEmitted(root, context, overview.deliveryToken);
  recordDeckTasteReview(root, context, {
    deliveryToken: overview.deliveryToken,
    verdict: "pass",
    axes: DECK_TASTE_AXES.map((axis) => ({
      axis,
      verdict: "pass" as const,
      observations: [`${axis} grounded observation`],
      pageIds: ["page-1", "page-2"],
      contractRules: [`${axis} contract rule`],
    })),
    strongestPageId: "page-2",
    weakestPageId: "page-1",
    visualMemoryObserved: "gold rule recurs",
    summary: "grounded whole-deck pass",
    remainingAiDefaults: [],
    revisionActions: [],
  });
  recordCompose(root, context, "test");
  return root;
}

describe("authentic generation provenance", () => {
  it("accepts a complete provider-backed Pi tool run", () => {
    const status = authenticGenerationStatus(fixture());
    assert.equal(status.ready, true, status.reason);
    assert.equal(status.composeSource, "pi-rpc");
    assert.equal(status.pageCount, 2);
  });

  it("rejects a pretty disk deck without a Pi session", () => {
    const root = fixture();
    const file = path.join(root, "_agent", "pi-trace.json");
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    delete trace.sessionId;
    trace.events.push("host-finish:2");
    writeJson(file, trace);
    const status = authenticGenerationStatus(root);
    assert.equal(status.ready, false);
    assert.match(status.reason, /session id/);
    assert.match(status.reason, /forbidden host/);
  });
});
