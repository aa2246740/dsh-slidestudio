import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { resolveRepoRoot } from "../catalog.js";
import { persistPresentationRunProvider } from "../capabilities.js";
import { createPresentationRun } from "../run.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { verifyOpenKimiPack } from "./openkimi-source-pack.js";
import { OPENKIMI_SECTIONED_REFERENCE_LAYOUT, sectionGroup, sectionSourceId } from "./openkimi-pptd-sections.js";
import { applyModelSwitchContinuity, planModelSwitchContinuity } from "./reference-continuity.js";
import { recordReferenceDelivered, referenceDeliveryConfirmationEnabled } from "./reference-delivery.js";
import { readReferenceResult } from "./reference-hands.js";
import { resolveLedgerReferenceRequirements } from "./reference-layout.js";
import {
  REFERENCE_SECTION_UNREAD_ERROR,
  pageReferenceSectionGroups,
  writePageReferencePreflight,
} from "./reference-section-gate.js";
import {
  RUN_LEDGER_REL,
  bytesSha256,
  inspectRunLedger,
  readRunLedger,
  recordTodo,
  stableSha256,
  type RunToolContext,
} from "./run-ledger.js";

const repoRoot = resolveRepoRoot();
const pack = verifyOpenKimiPack(repoRoot);
const RUNTIME = { brief: "预算验收", designDirection: "self-directed", strictExecution: true } as const;
const PLAN = [
  { pageId: "p1", title: "封面", layoutFamily: "cover", exhibits: [] },
  { pageId: "p2", title: "数据", layoutFamily: "content", exhibits: [] },
];

function project(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ref-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  return root;
}

function ctx(epoch: string, commandId = `cmd-${Math.random()}`): RunToolContext {
  return { contextEpochId: epoch, commandId };
}

function readAll(root: string, context: RunToolContext, chunks: readonly { sourceId: string; chunkIndex: number }[]) {
  for (const chunk of chunks) readReferenceResult(root, context, { ...chunk }, { confirmDelivery: false });
}

/** A ledger as written before v2 shipped: whole-file requirements and no referenceLayout key. */
function writeLegacyLedger(root: string): readonly { sourceId: string; chunkIndexes: readonly number[] }[] {
  const { requirements, requirementsId } = resolveLedgerReferenceRequirements(
    pack,
    { designDirection: { kind: "self-directed" } },
    undefined,
  );
  const ledger = {
    schemaVersion: 1,
    runId: "legacy-run",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    sourcePack: {
      manifestSha256: bytesSha256(fs.readFileSync(pack.manifestPath)),
      requirementsId,
      requirements,
      executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
    },
    facts: [],
  };
  fs.writeFileSync(path.join(root, RUN_LEDGER_REL), `${JSON.stringify(ledger, null, 2)}\n`);
  return requirements;
}

const chartPage = {
  id: "p2",
  elements: [{ elementId: "c1", elementType: "chart", bounds: [0, 0, 400, 300], data: { cols: [], rows: [] } }],
};

describe("v1 run ledgers on disk keep whole-file reference accounting", () => {
  it("re-initializes without changing requirements, id or layout", (t) => {
    const root = project(t);
    const requirements = writeLegacyLedger(root);
    assert.equal(stableSha256({ requirements }), readRunLedger(root)!.sourcePack.requirementsId);
    writeDomainRuntime(root, RUNTIME);
    const ledger = readRunLedger(root)!;
    assert.equal(ledger.runId, "legacy-run");
    assert.equal(ledger.sourcePack.referenceLayout, undefined);
    assert.equal("referenceLayout" in ledger.sourcePack, false);
    const pptd = ledger.sourcePack.requirements.find((r) => r.reason === "pptd")!;
    assert.equal(pptd.sourceId, "openkimi:reference/pptd.md");
    assert.equal(pptd.chunkIndexes.length, 8);
    assert.equal(inspectRunLedger(root, "e1").missingReferenceChunks.length, 11);
  });

  it("never applies the section gate or model-switch carry to a v1 ledger", (t) => {
    const root = project(t);
    writeLegacyLedger(root);
    assert.equal(writePageReferencePreflight(repoRoot, root, chartPage, "e1"), undefined);
    readAll(root, ctx("e1"), inspectRunLedger(root, "e1").missingReferenceChunks);
    assert.equal(inspectRunLedger(root, "e1").referencesComplete, true);
    recordTodo(root, ctx("e1"), PLAN);
    const before = readRunLedger(root)!.facts.length;
    const plan = applyModelSwitchContinuity(root, { fromEpochId: "e1", toEpochId: "e2", repoRoot });
    assert.equal(plan.reason, "legacy-v1-ledger");
    assert.equal(readRunLedger(root)!.facts.length, before);
    assert.equal(inspectRunLedger(root, "e2").referencesComplete, false);
  });
});

describe("new run ledgers use the sectioned v2 layout", () => {
  it("requires SKILL.md, the pptd.md core group and the categories guide", (t) => {
    const root = project(t);
    writeDomainRuntime(root, RUNTIME);
    const ledger = readRunLedger(root)!;
    assert.equal(ledger.sourcePack.referenceLayout, OPENKIMI_SECTIONED_REFERENCE_LAYOUT);
    assert.deepEqual(
      ledger.sourcePack.requirements.map((r) => [r.reason, r.sourceId, r.chunkIndexes.length]),
      [
        ["skill", "openkimi:SKILL.md", 2],
        ["pptd", sectionSourceId("core"), 3],
        ["category-guide", "openkimi:reference/slides_categories.md", 1],
      ],
    );
    writeDomainRuntime(root, RUNTIME);
    assert.equal(readRunLedger(root)!.runId, ledger.runId, "re-initializing keeps the v2 run");
    const missing = inspectRunLedger(root, "e1").missingReferenceChunks;
    const read = readReferenceResult(root, ctx("e1"), { ...missing[2]! });
    assert.ok(Array.isArray((read.payload as Record<string, unknown>).sectionIds));
    readAll(root, ctx("e1"), missing);
    assert.equal(inspectRunLedger(root, "e1").referencesComplete, true);
  });
});

describe("write_page on-demand section gate", () => {
  it("detects chart, table, image, icon, line and animation payloads", () => {
    assert.deepEqual(pageReferenceSectionGroups(chartPage), ["chart"]);
    assert.deepEqual(pageReferenceSectionGroups({ elements: [{ rows: [["a"]] }] }), ["table"]);
    assert.deepEqual(
      pageReferenceSectionGroups({
        elements: [{ item: { type: "group", elements: [{ type: "image", src: "media/a.png" }, { type: "icon" }] } }],
      }),
      ["image", "icon"],
    );
    assert.deepEqual(pageReferenceSectionGroups({ elements: [{ type: "line" }], animations: [{ elementId: "x" }] }), [
      "line",
      "animation",
    ]);
    assert.deepEqual(pageReferenceSectionGroups({ elements: [{ type: "text" }, { elementType: "shape" }] }), []);
  });

  it("refuses a chart page until the chart section is read in this epoch", (t) => {
    const root = project(t);
    writeDomainRuntime(root, RUNTIME);
    const refused = writePageReferencePreflight(repoRoot, root, chartPage, "e1");
    assert.ok(refused);
    assert.equal(refused.payload.error, REFERENCE_SECTION_UNREAD_ERROR);
    assert.equal(refused.payload.next, "read_reference");
    const chart = sectionGroup(pack, "chart");
    assert.deepEqual(
      refused.payload.missingReferenceChunks,
      chart.chunks.map((chunk) => ({ sourceId: chart.sourceId, chunkIndex: chunk.index })),
    );
    assert.match(refused.detail, /openkimi:reference\/pptd\.md::chart#0/);
    readAll(root, ctx("other-epoch"), refused.payload.missingReferenceChunks as never);
    assert.ok(writePageReferencePreflight(repoRoot, root, chartPage, "e1"), "another epoch's read does not count");
    readAll(root, ctx("e1"), refused.payload.missingReferenceChunks as never);
    assert.equal(writePageReferencePreflight(repoRoot, root, chartPage, "e1"), undefined);
    const table = writePageReferencePreflight(repoRoot, root, { elements: [{ elementType: "table" }] }, "e1");
    assert.deepEqual(
      (table?.payload.missingReferenceSections as { sectionId: string }[]).map((s) => s.sectionId),
      ["table"],
    );
  });

  it("refuses through presentation-run write_page before saving", async (t) => {
    const root = project(t);
    const run = createPresentationRun({ repoRoot });
    const handle = await run.open({
      projectRoot: root,
      sessionId: "section-gate",
      editorBaseUrl: "",
      brief: RUNTIME.brief,
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "test" },
    });
    writeDomainRuntime(root, RUNTIME);
    const page = { id: "p1", elements: [{ elementId: "t1", elementType: "table", bounds: [0, 0, 400, 200] }] };
    const receipt = await run.execute(
      { name: "write_page", args: page },
      { ...handle, abortSignal: new AbortController().signal, toolCallId: "gate-1" },
    );
    assert.equal(receipt.ok, false);
    assert.equal(receipt.payload.error, REFERENCE_SECTION_UNREAD_ERROR);
    assert.equal(fs.existsSync(path.join(root, "pages")), false);
  });
});

describe("delivery-confirmed reference accounting", () => {
  it("counts a deferred chunk only after the host confirms delivery in the same epoch", (t) => {
    const root = project(t);
    writeDomainRuntime(root, RUNTIME);
    const target = inspectRunLedger(root, "e1").missingReferenceChunks[0]!;
    const read = readReferenceResult(root, ctx("e1"), { ...target }, { confirmDelivery: true });
    const token = String((read.payload as Record<string, unknown>).deliveryToken);
    assert.equal((read.payload as Record<string, unknown>).deliveryPending, true);
    assert.equal(inspectRunLedger(root, "e1").missingReferenceChunks.length, 6, "prepared is not read");
    assert.deepEqual(recordReferenceDelivered(root, { contextEpochId: "e2" }, token), {
      recorded: false,
      reason: "other-epoch",
    });
    assert.deepEqual(recordReferenceDelivered(root, { contextEpochId: "e1" }, "refdel-nope"), {
      recorded: false,
      reason: "unknown-token",
    });
    const delivered = recordReferenceDelivered(root, { contextEpochId: "e1" }, token);
    assert.equal(delivered.recorded, true);
    assert.equal(inspectRunLedger(root, "e1").missingReferenceChunks.length, 5);
    const again = recordReferenceDelivered(root, { contextEpochId: "e1" }, token);
    assert.equal(again.recorded && again.alreadyDelivered, true);
    const returned = readRunLedger(root)!.facts.filter((fact) => fact.type === "reference.chunk-returned");
    assert.equal(returned.length, 1);
  });

  it("keeps immediate accounting by default and reads the opt-in flag", () => {
    assert.equal(referenceDeliveryConfirmationEnabled({}), false);
    assert.equal(
      referenceDeliveryConfirmationEnabled({ SLIDESTUDIO_FLAG_REFERENCE_DELIVERY_CONFIRMATION: "on" }),
      true,
    );
    assert.equal(
      referenceDeliveryConfirmationEnabled({
        SLIDESTUDIO_REFERENCE_DELIVERY_CONFIRMATION: "0",
        SLIDESTUDIO_FLAG_REFERENCE_DELIVERY_CONFIRMATION: "1",
      }),
      false,
    );
  });
});

describe("model-switch continuity", () => {
  it("carries verified baseline reads into the new epoch only once a plan is committed", (t) => {
    const root = project(t);
    writeDomainRuntime(root, RUNTIME);
    readAll(root, ctx("e1"), inspectRunLedger(root, "e1").missingReferenceChunks);
    assert.equal(
      planModelSwitchContinuity(root, { fromEpochId: "e1", toEpochId: "e2", repoRoot }).reason,
      "no-committed-plan",
    );
    recordTodo(root, ctx("e1"), PLAN);
    const plan = applyModelSwitchContinuity(root, { fromEpochId: "e1", toEpochId: "e2", repoRoot });
    assert.equal(plan.eligible, true);
    assert.equal(plan.carry.length, 6);
    assert.deepEqual(plan.stillRequired, []);
    assert.deepEqual(plan.unfinishedPageIds, ["p1", "p2"]);
    assert.equal(inspectRunLedger(root, "e2").referencesComplete, true);
    const carried = readRunLedger(root)!.facts.filter((fact) => fact.type === "reference.epoch-carried");
    assert.equal(carried.length, 6);
    assert.ok(carried.every((fact) => fact.type === "reference.epoch-carried" && fact.fromEpochId === "e1"));
    applyModelSwitchContinuity(root, { fromEpochId: "e1", toEpochId: "e2", repoRoot });
    assert.equal(readRunLedger(root)!.facts.filter((f) => f.type === "reference.epoch-carried").length, 6);
    assert.ok(writePageReferencePreflight(repoRoot, root, chartPage, "e2"), "specialized sections are never carried");
  });

  it("carries only what was verified and leaves the rest required", (t) => {
    const root = project(t);
    writeDomainRuntime(root, RUNTIME);
    const missing = inspectRunLedger(root, "e1").missingReferenceChunks;
    readAll(
      root,
      ctx("e1"),
      missing.filter((chunk) => chunk.sourceId === "openkimi:SKILL.md"),
    );
    recordTodo(root, ctx("e1"), PLAN);
    const plan = applyModelSwitchContinuity(root, { fromEpochId: "e1", toEpochId: "e2", repoRoot });
    assert.equal(plan.carry.length, 2);
    assert.equal(plan.stillRequired.length, 4);
    assert.equal(inspectRunLedger(root, "e2").missingReferenceChunks.length, 4);
  });

  it("runs on a provider/model switch and can be turned off", (t) => {
    for (const continuity of [true, false]) {
      const root = project(t);
      writeDomainRuntime(root, RUNTIME);
      readAll(root, ctx("dsh-a"), inspectRunLedger(root, "dsh-a").missingReferenceChunks);
      recordTodo(root, ctx("dsh-a"), PLAN);
      const binding = path.join(root, "_agent", "presentation-run.v1.json");
      fs.writeFileSync(
        binding,
        JSON.stringify({ contextEpochId: "dsh-a", provider: { providerId: "p", modelId: "m1" } }),
      );
      assert.equal(
        persistPresentationRunProvider(root, { providerId: "p", modelId: "m2" }, { referenceContinuity: continuity }),
        true,
      );
      const epoch = (JSON.parse(fs.readFileSync(binding, "utf8")) as { contextEpochId: string }).contextEpochId;
      assert.notEqual(epoch, "dsh-a");
      assert.equal(inspectRunLedger(root, epoch).referencesComplete, continuity, `continuity=${continuity}`);
    }
  });
});
