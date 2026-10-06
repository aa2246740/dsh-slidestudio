import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, listComposedPage, saveProject } from "@open-slidestudio/pptd-v2";
import { inspectProjectExecution as projectExecution } from "./execution-observation.js";
import { projectExecution as projectExecutionPure } from "./execution.js";
import { ensureRunLedger } from "./domain/run-ledger.js";
import type { CapabilitySnapshot } from "./types.js";

const defaultCapability: CapabilitySnapshot = {
  research: { configured: true, via: "native" },
  imageSearch: { configured: false, via: "env" },
  imageGenerate: { configured: false, via: "env" },
  vision: { mode: "none", via: "env" },
  runtime: { kind: "dsh" },
  web: true,
  render: true,
  exportPptx: true,
  note: "structural fallback",
};

function tempProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-test-"));
  const project = createEmptyProject(root, { title: "Execution Test" });
  saveProject(project);
  ensureRunLedger(root, {
    manifestSha256: "manifest",
    requirementsId: "req",
    requirements: [],
  });
  return root;
}

describe("projectExecution candidate regressions", () => {
  it("projects planning status when plan is missing", () => {
    const root = tempProjectRoot();
    const result = projectExecution({
      root,
      agentBusy: false,
      capability: defaultCapability,
    });
    assert.equal(result.status.kind, "planning");
    assert.equal(result.plan.kind, "missing");
    assert.ok(result.blockers.some((b) => b.code === "missing_plan"));
    assert.equal(result.blockers[0]?.next, "commit_design");
    assert.equal(result.recovery.kind, "continue");
  });

  it("projects planning status when plan is legacy-incomplete", () => {
    const root = tempProjectRoot();
    const ledger = JSON.parse(fs.readFileSync(path.join(root, "_agent", "run-ledger.v1.json"), "utf8"));
    ledger.facts.push({
      type: "todo.committed", factId: "fact-todo-legacy", at: new Date().toISOString(),
      contextEpochId: "epoch-1", todoSha256: "todo-sha", itemCount: 2, pageIds: ["1_cover", "2_body"],
    });
    fs.writeFileSync(path.join(root, "_agent", "run-ledger.v1.json"), JSON.stringify(ledger, null, 2));
    const result = projectExecution({
      ledger,
      root,
      agentBusy: false,
      capability: defaultCapability,
    });
    assert.equal(result.status.kind, "planning");
    assert.equal(result.plan.kind, "legacy-incomplete");
    assert.ok(result.blockers.some((b) => b.code === "legacy_incomplete_plan"));
  });

  it("supports a valid single-page plan without requiring arbitrary minimum pages", () => {
    const root = tempProjectRoot();
    const context = { commandId: "cmd-1", contextEpochId: "epoch-1" };
    const project = createEmptyProject(root, { title: "Single Page Deck" });
    listComposedPage(project, "pages/1_cover.page", {
      pageType: "cover",
      elements: [],
    });
    saveProject(project);

    // Save full plan with 1 page
    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, "_agent", "run-ledger.v1.json"), "utf8"),
    );
    ledger.facts.push({
      type: "todo.committed",
      factId: "fact-todo-single",
      at: new Date().toISOString(),
      contextEpochId: "epoch-1",
      todoSha256: "todo-sha",
      itemCount: 1,
      pageIds: ["1_cover"],
      pagePlan: [
        {
          pageId: "1_cover",
          title: "Cover",
          layoutFamily: "cover",
          exhibits: [],
        },
      ],
    });
    fs.writeFileSync(
      path.join(root, "_agent", "run-ledger.v1.json"),
      JSON.stringify(ledger, null, 2),
    );

    const result = projectExecution({
      root,
      agentBusy: false,
      capability: defaultCapability,
      ledger,
    });
    assert.equal(result.plan.kind, "complete");
    assert.equal(result.plan.pages?.length, 1);
    // Page is already on disk, so it should advance to reviewing (structural review needed)
    assert.equal(result.status.kind, "reviewing");
    assert.ok(result.blockers.some((b) => b.code === "structural_review_needed"));
  });

  it("projects authoring status when planned pages are missing from disk", () => {
    const root = tempProjectRoot();
    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, "_agent", "run-ledger.v1.json"), "utf8"),
    );
    ledger.facts.push({
      type: "todo.committed",
      factId: "fact-todo-2",
      at: new Date().toISOString(),
      contextEpochId: "epoch-1",
      todoSha256: "todo-sha",
      itemCount: 2,
      pageIds: ["1_cover", "2_body"],
      pagePlan: [
        { pageId: "1_cover", title: "Cover", layoutFamily: "cover", exhibits: [] },
        { pageId: "2_body", title: "Body", layoutFamily: "content", exhibits: ["chart:bar"] },
      ],
    });
    fs.writeFileSync(
      path.join(root, "_agent", "run-ledger.v1.json"),
      JSON.stringify(ledger, null, 2),
    );

    const result = projectExecution({
      root,
      agentBusy: false,
      capability: defaultCapability,
      ledger,
    });
    assert.equal(result.status.kind, "authoring");
    const missing = result.blockers.find((b) => b.code === "missing_pages");
    assert.ok(missing);
    assert.deepEqual(missing?.pageIds, ["1_cover", "2_body"]);
    assert.equal(missing?.next, "write_page");
  });

  it("does not project delivered while agent is still busy even if export exists", () => {
    const root = tempProjectRoot();
    const result = projectExecution({
      root,
      agentBusy: true,
      capability: defaultCapability,
      verifiedDelivery: {
        artifactPath: "export/deck.pptx",
        artifactSha256: "hash1",
        artifactBytes: 1000,
        reportPath: "export/export-report.json",
        reportSha256: "hash2",
        slideCount: 4,
        inputFingerprint: "fingerprint",
      },
    });
    assert.notEqual(result.status.kind, "delivered");
    assert.equal(result.recovery.kind, "wait-or-stop");
  });

  it("does not bypass absent plan and QA merely because delivery metadata was supplied", () => {
    const root = tempProjectRoot();
    const delivery = {
      artifactPath: "export/deck.pptx",
      artifactSha256: "hash1",
      artifactBytes: 1000,
      reportPath: "export/export-report.json",
      reportSha256: "hash2",
      slideCount: 4,
      inputFingerprint: "fingerprint",
    };
    const result = projectExecution({
      root,
      agentBusy: false,
      capability: defaultCapability,
      verifiedDelivery: delivery,
    });
    assert.notEqual(result.status.kind, "delivered");
    assert.equal(result.delivery, undefined);
    assert.equal(result.recovery.kind, "continue");
  });

  it("projects paused on rate limit and failed on fatal fault", () => {
    const root = tempProjectRoot();
    const paused = projectExecution({
      root,
      agentBusy: false,
      capability: defaultCapability,
      terminalFault: {
        code: "rate_limit",
        message: "wait 30s",
        phase: "paused",
      },
    });
    assert.equal(paused.status.kind, "paused");
    assert.equal(paused.recovery.kind, "continue");
    const waiting = projectExecution({ root, capability: defaultCapability, agentBusy: false, retryScheduled: true });
    assert.equal(waiting.recovery.kind, "wait-or-stop");

    const failed = projectExecution({
      root,
      agentBusy: false,
      capability: defaultCapability,
      terminalFault: {
        code: "invalid_syntax",
        message: "bad token",
        recoverable: false,
      },
    });
    assert.equal(failed.status.kind, "failed");
    assert.equal(failed.recovery.kind, "resolve");
  });

  it("projects paused on host provider-* fault codes even without a paused phase", () => {
    const root = tempProjectRoot();
    for (const code of ["provider-auth", "provider-rate-limit", "operator-stop", "host-interrupted"]) {
      const result = projectExecution({
        root,
        agentBusy: false,
        capability: defaultCapability,
        terminalFault: { code, message: "pause me" },
      });
      assert.equal(result.status.kind, "paused", `${code} must project paused`);
    }
    const unknown = projectExecution({
      root,
      agentBusy: false,
      capability: defaultCapability,
      terminalFault: { code: "agent-error", message: "boom" },
    });
    assert.equal(unknown.status.kind, "failed");
  });

  it("keeps delivered when the turn faults after a verified export", () => {
    // Regression: export_deck succeeded and verified, then the model's closing
    // message hit CONTEXT_WINDOW_EXCEEDED. The fault must not mask delivery.
    const result = projectExecutionPure({
      ledger: JSON.parse(JSON.stringify({
        schemaVersion: 1, runId: "r", createdAt: "t", updatedAt: "t",
        sourcePack: { manifestSha256: "m", requirementsId: "r", requirements: [] },
        facts: [{
          type: "todo.committed", factId: "fact-todo", at: "t", contextEpochId: "e",
          todoSha256: "todo-sha", itemCount: 1, pageIds: ["1_cover"],
          pagePlan: [{ pageId: "1_cover", title: "Cover", layoutFamily: "hero", exhibits: ["none"] }],
        }],
      })),
      identity: { kind: "resolved", pages: new Map([["1_cover", "pages/1_cover.pptd"]]), aliases: new Map() },
      inspection: {
        initialized: true, referencesComplete: true, missingReferenceChunks: [], todoCount: 1,
        pages: [{ pageId: "1_cover", revision: 1, pageSha256: "p", raster: true, imageEmitted: false, visualReview: "missing", layout: "pass" }],
        structuralReview: "pass", composeReady: true, composeBlockers: [], composed: true,
      },
      agentBusy: false,
      capability: defaultCapability,
      verifiedDelivery: {
        artifactPath: "export/deck.pptx", artifactSha256: "a", artifactBytes: 1000,
        reportPath: "export/export-report.json", reportSha256: "b",
        slideCount: 1, inputFingerprint: "fp",
      },
      terminalFault: { code: "provider-error", message: "context overflow", recoverable: true },
    });
    assert.equal(result.status.kind, "delivered");
    assert.equal(result.recovery.kind, "none");
    assert.ok(result.delivery);
  });

  it("still projects the fault when delivery is not verified", () => {
    const result = projectExecutionPure({
      ledger: JSON.parse(JSON.stringify({
        schemaVersion: 1, runId: "r", createdAt: "t", updatedAt: "t",
        sourcePack: { manifestSha256: "m", requirementsId: "r", requirements: [] },
        facts: [{
          type: "todo.committed", factId: "fact-todo", at: "t", contextEpochId: "e",
          todoSha256: "todo-sha", itemCount: 1, pageIds: ["1_cover"],
          pagePlan: [{ pageId: "1_cover", title: "Cover", layoutFamily: "hero", exhibits: ["none"] }],
        }],
      })),
      identity: { kind: "resolved", pages: new Map([["1_cover", "pages/1_cover.pptd"]]), aliases: new Map() },
      inspection: {
        initialized: true, referencesComplete: true, missingReferenceChunks: [], todoCount: 1,
        pages: [{ pageId: "1_cover", revision: 1, pageSha256: "p", raster: true, imageEmitted: false, visualReview: "missing", layout: "pass" }],
        structuralReview: "pass", composeReady: true, composeBlockers: [], composed: true,
      },
      agentBusy: false,
      capability: defaultCapability,
      verifiedDelivery: null,
      terminalFault: { code: "provider-error", message: "context overflow", recoverable: true },
    });
    assert.equal(result.status.kind, "failed");
    assert.equal(result.recovery.kind, "continue");
  });
});
