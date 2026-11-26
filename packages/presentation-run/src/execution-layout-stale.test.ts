import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { inspectProjectCapabilities } from "./capabilities.js";
import {
  changePageContent,
  COMPOSED_DECK_CONTEXT,
  composeFixtureDeck,
  createComposedDeckProject,
  editBodyLayoutAsAgent,
  editBodyLayoutAsEditor,
  renderFixturePage,
  type ComposedDeck,
} from "./domain/composed-deck.testkit.js";
import { resolveProjectPageIdentities } from "./domain/page-identity.js";
import { inspectRunLedger, readRunLedger, recordExportSucceeded } from "./domain/run-ledger.js";
import { inspectProjectExecution } from "./execution-observation.js";
import { projectExecution } from "./execution.js";

// A manual editor layout change after a completed composition leaves the generation finished and
// the composition stale. Every fact below comes from the real domain tools; only the render is a
// synthetic raster (no renderer, browser or model runs).
const ENV_KEYS = ["SLIDESTUDIO_VISION_REVIEWER", "SLIDESTUDIO_LLM_IMAGE"] as const;
const ATTEMPT = "attempt-current";

describe("manual layout change after a completed composition", () => {
  const roots: string[] = [];
  const previous = ENV_KEYS.map((key) => process.env[key]);
  before(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  after(() => {
    ENV_KEYS.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  async function composedDeck(): Promise<{ root: string; deck: ComposedDeck }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-layout-stale-"));
    roots.push(root);
    createComposedDeckProject(root);
    return { root, deck: await composeFixtureDeck(root) };
  }
  const shift = (iso: string, deltaMs: number) => new Date(Date.parse(iso) + deltaMs).toISOString();
  function observe(
    root: string,
    startedAt: string | null | undefined,
    overrides: Partial<Parameters<typeof inspectProjectExecution>[0]> = {},
  ) {
    return inspectProjectExecution({
      root,
      agentBusy: false,
      retryScheduled: false,
      capability: inspectProjectCapabilities(root),
      currentAttemptId: ATTEMPT,
      currentAttemptStartedAt: startedAt,
      ...overrides,
    });
  }
  const codes = (result: ReturnType<typeof observe>) => result.blockers.map((item) => item.code);

  it("offers no generation continuation while only layout-stale pages and the composition remain", async () => {
    const { root, deck } = await composedDeck();
    const startedAt = shift(deck.composed.at, -60_000);
    assert.equal(inspectRunLedger(root).composed, true);
    assert.equal(observe(root, startedAt).status.kind, "ready-to-export");

    editBodyLayoutAsEditor(root);
    const inspection = inspectRunLedger(root);
    assert.equal(inspection.composed, false);
    assert.deepEqual(
      inspection.pages.filter((page) => page.chromeStale).map((page) => page.pageId),
      [...deck.bodyPageIds],
    );
    const result = observe(root, startedAt);
    assert.equal(result.status.kind, "reviewing");
    assert.equal(result.next, "render_page");
    assert.deepEqual(
      codes(result),
      deck.bodyPageIds.map(() => "page_render_needed"),
    );
    assert.deepEqual(
      result.blockers.flatMap((item) => item.pageIds),
      [...deck.bodyPageIds],
    );
    assert.equal(result.recovery.kind, "none");
    assert.equal(result.attemptId, ATTEMPT);
  });

  it("keeps compose_needed and the compose_deck next step when only the composition is stale", async () => {
    const { root, deck } = await composedDeck();
    editBodyLayoutAsEditor(root);
    // The editor never renders. This stands in for a state whose pages already show the new chrome
    // and holds the facts the real run recorded; only the page evidence is replaced.
    const real = inspectRunLedger(root);
    const inspection = {
      ...real,
      composeReady: true,
      pages: real.pages.map((page) => ({
        ...page,
        raster: true,
        chromeStale: false,
        layout: "pass" as const,
      })),
    };
    const result = projectExecution({
      ledger: readRunLedger(root),
      identity: resolveProjectPageIdentities(root),
      inspection,
      agentBusy: false,
      capability: inspectProjectCapabilities(root),
      currentAttemptStartedAt: shift(deck.composed.at, -60_000),
    });
    assert.equal(inspection.composed, false);
    assert.deepEqual(codes(result), ["compose_needed"]);
    assert.equal(result.status.kind, "ready-to-compose");
    assert.equal(result.next, "compose_deck");
    assert.equal(result.recovery.kind, "none");
  });

  it("ignores the export that was recorded between the composition and the layout change", async () => {
    const { root, deck } = await composedDeck();
    recordExportSucceeded(root, COMPOSED_DECK_CONTEXT, {
      commandId: "export-fixture",
      artifactPath: "exports/deck.pptx",
      artifactSha256: "a".repeat(64),
      artifactBytes: 10,
      reportPath: "exports/deck.report.json",
      reportSha256: "b".repeat(64),
      slideCount: deck.pageIds.length,
      materialFingerprint: "fixture",
      producer: "agent-tool",
    });
    editBodyLayoutAsEditor(root);
    assert.equal(observe(root, shift(deck.composed.at, -1)).recovery.kind, "none");
  });

  it("keeps recovery for an attempt that began after the composition", async () => {
    const { root, deck } = await composedDeck();
    editBodyLayoutAsEditor(root);
    for (const startedAt of [shift(deck.composed.at, 1), shift(deck.composed.at, 60_000)]) {
      const result = observe(root, startedAt);
      assert.equal(result.recovery.kind, "continue", startedAt);
      assert.equal(result.blockers[0]?.code, "page_render_needed");
    }
  });

  it("keeps recovery when the attempt start is missing or malformed", async () => {
    const { root, deck } = await composedDeck();
    editBodyLayoutAsEditor(root);
    for (const startedAt of [undefined, null, "", "yesterday", "0", "2026-13-45T99:00:00Z"]) {
      assert.equal(observe(root, startedAt).recovery.kind, "continue", String(startedAt));
    }
    assert.equal(observe(root, shift(deck.composed.at, -1)).recovery.kind, "none");
  });

  it("keeps recovery when the Agent rendered, changed layouts, pages or the plan after the composition", async () => {
    const startedAtOf = (deck: ComposedDeck) => shift(deck.composed.at, -60_000);

    const layout = await composedDeck();
    editBodyLayoutAsEditor(layout.root);
    await editBodyLayoutAsAgent(layout.root);
    assert.equal(observe(layout.root, startedAtOf(layout.deck)).recovery.kind, "continue");

    const rendered = await composedDeck();
    editBodyLayoutAsEditor(rendered.root);
    for (const pageId of rendered.deck.bodyPageIds) renderFixturePage(rendered.root, pageId);
    const afterRender = observe(rendered.root, startedAtOf(rendered.deck));
    assert.deepEqual(codes(afterRender), ["compose_needed"]);
    assert.equal(afterRender.status.kind, "ready-to-compose");
    assert.equal(afterRender.recovery.kind, "continue");

    const page = await composedDeck();
    editBodyLayoutAsEditor(page.root);
    changePageContent(page.root, page.deck.bodyPageIds[0]!);
    assert.equal(observe(page.root, startedAtOf(page.deck)).recovery.kind, "continue");

    const plan = await composedDeck();
    editBodyLayoutAsEditor(plan.root);
    const ledger = readRunLedger(plan.root)!;
    const todo = [...ledger.facts].reverse().find((fact) => fact.type === "todo.committed")!;
    fs.writeFileSync(
      path.join(plan.root, "_agent", "run-ledger.v1.json"),
      JSON.stringify({ ...ledger, facts: [...ledger.facts, { ...todo, factId: "later-plan" }] }),
    );
    assert.equal(observe(plan.root, startedAtOf(plan.deck)).recovery.kind, "continue");
  });

  it("keeps recovery when no editor layout change followed the composition", async () => {
    const { root, deck } = await composedDeck();
    const result = observe(root, shift(deck.composed.at, -60_000));
    assert.equal(result.status.kind, "ready-to-export");
    assert.equal(result.recovery.kind, "continue");
  });

  it("keeps busy, retry, fault and identity guards in force", async () => {
    const { root, deck } = await composedDeck();
    const startedAt = shift(deck.composed.at, -60_000);
    editBodyLayoutAsEditor(root);
    assert.equal(observe(root, startedAt, { agentBusy: true }).recovery.kind, "wait-or-stop");
    assert.equal(observe(root, startedAt, { retryScheduled: true }).recovery.kind, "wait-or-stop");
    assert.equal(observe(root, startedAt, { agentBusy: undefined }).recovery.kind, "resolve");
    const paused = observe(root, startedAt, {
      terminalFault: {
        attemptId: ATTEMPT,
        code: "provider-quota",
        phase: "paused",
        recoverable: true,
      },
    });
    assert.equal(paused.status.kind, "paused");
    assert.equal(paused.recovery.kind, "continue");
    const failed = observe(root, startedAt, {
      terminalFault: { attemptId: ATTEMPT, code: "provider-auth", recoverable: false },
    });
    assert.equal(failed.recovery.kind, "resolve");

    const blocked = projectExecution({
      ledger: readRunLedger(root),
      identity: { kind: "unreadable", detail: "pages/p02.page cannot be read" },
      inspection: inspectRunLedger(root),
      agentBusy: false,
      capability: inspectProjectCapabilities(root),
      currentAttemptStartedAt: startedAt,
    });
    assert.equal(blocked.recovery.kind, "resolve");
  });
});
