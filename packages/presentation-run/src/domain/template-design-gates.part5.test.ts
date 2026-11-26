import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "../run.js";
import { listSourceReceipts, recordSourceReceipt } from "../receipts.js";
import { ensureRunLedger, inspectRunLedger } from "./run-ledger.js";
import { executeGenerateTool, type AgentToolState } from "./agent-tools.js";
import { loadPlaybook } from "./playbook.js";
import { PACK_COLOR_ERROR, packColorWriteContext } from "./theme-pack.js";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  plan,
  colorPage,
  writeDesignMaterial,
  writeDesignManifest,
  paintCover,
  readRuntimeSelection,
  openTwoBrandRun,
} from "./template-design-gates.support.js";

describe("template design source gates", () => {
  it("keeps the persisted selection when a later commit_design omits adopted sources", async (t) => {
    const brief = "做一份说明。";
    const { projectRoot, run, context, sourceA, sourceB, brandB } = await openTwoBrandRun(t, {
      brief,
      sessionId: "template-plan-only-commit",
    });
    const selected = [sourceB, sourceA];
    const committed = await run.execute(
      { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: selected } },
      { ...context, toolCallId: "plan-only-commit-ba" },
    );
    assert.equal(committed.ok, true, committed.detail);
    assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, "#112233");

    const planOnly = await run.execute(
      { name: "commit_design", args: { slidePlan: plan() } },
      { ...context, toolCallId: "plan-only-commit-update" },
    );
    assert.equal(planOnly.ok, true, planOnly.detail);
    assert.deepEqual(planOnly.payload.adoptedSourceIds, selected);
    let theme = loadProject(projectRoot).presentation.theme;
    assert.equal(theme?.colors?.accent1, "#112233");
    assert.deepEqual(theme?.textStyles?.schemeMajor?.fontFamily, brandB.major);
    assert.deepEqual(readRuntimeSelection(projectRoot), selected);

    const todo = await run.execute(
      { name: "write_todo", args: { items: plan() } },
      { ...context, toolCallId: "plan-only-commit-todo" },
    );
    assert.equal(todo.ok, true, todo.detail);
    assert.deepEqual(todo.payload.adoptedSourceIds, selected);
    assert.deepEqual(readRuntimeSelection(projectRoot), selected);

    const restarted = createPresentationRun({ repoRoot: REPO_ROOT });
    const again = restarted.hydrate(projectRoot);
    assert.ok(again);
    const todoAgain = await restarted.execute(
      { name: "write_todo", args: { items: plan() } },
      {
        runId: again.runId,
        sessionId: again.sessionId,
        projectRoot,
        abortSignal: new AbortController().signal,
        toolCallId: "plan-only-commit-restart",
      },
    );
    assert.equal(todoAgain.ok, true, todoAgain.detail);
    assert.deepEqual(todoAgain.payload.adoptedSourceIds, selected);
    theme = loadProject(projectRoot).presentation.theme;
    assert.equal(theme?.colors?.accent1, "#112233");
    assert.deepEqual(theme?.textStyles?.schemeMajor?.fontFamily, brandB.major);
    assert.deepEqual(readRuntimeSelection(projectRoot), selected);
  });

  it("refuses colors from a source removed by the current selection", async (t) => {
    const brief = "做一份说明。";
    const { projectRoot, run, context, sourceA, sourceB } = await openTwoBrandRun(t, {
      brief,
      sessionId: "template-shrink-selection",
    });
    const both = await run.execute(
      {
        name: "commit_design",
        args: { slidePlan: plan(), adoptedSourceIds: [sourceA, sourceB] },
      },
      { ...context, toolCallId: "shrink-commit-ab" },
    );
    assert.equal(both.ok, true, both.detail);
    const shrunk = await run.execute(
      { name: "write_todo", args: { items: plan(), adoptedSourceIds: [sourceB] } },
      { ...context, toolCallId: "shrink-todo-b" },
    );
    assert.equal(shrunk.ok, true, shrunk.detail);
    assert.deepEqual(shrunk.payload.adoptedSourceIds, [sourceB]);
    assert.deepEqual(readRuntimeSelection(projectRoot), [sourceB]);
    assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, "#112233");
    assert.ok(
      listSourceReceipts(projectRoot).some(
        (row) => row.sourceId === sourceA && (row.state === "adopted" || row.state === "executed"),
      ),
      "A stays in the receipt audit trail",
    );

    const paletteB = packColorWriteContext([sourceB], projectRoot);
    const tint = [...(paletteB.adoptedPackHexes ?? [])].find((hex) => !["#112233", "#445566", "#778899"].includes(hex));
    assert.ok(tint, "B has a documented tint");
    const accepted = await run.execute(
      { name: "write_page", args: colorPage("#112233") },
      { ...context, toolCallId: "shrink-page-b" },
    );
    assert.equal(accepted.ok, true, accepted.detail);
    const tinted = await run.execute(
      { name: "write_page", args: colorPage(tint) },
      { ...context, toolCallId: "shrink-page-tint" },
    );
    assert.equal(tinted.ok, true, tinted.detail);
    const refused = await run.execute(
      { name: "write_page", args: colorPage("#C8102E") },
      { ...context, toolCallId: "shrink-page-a" },
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.payload.error, PACK_COLOR_ERROR);
    assert.match(refused.detail, /已采用的设计源/);
    assert.match(refused.detail, /#C8102E/);

    const state: AgentToolState = {
      brief,
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [],
      projectRoot,
    };
    const agentAccepted = executeGenerateTool("write_page", colorPage("#112233"), state);
    assert.equal(agentAccepted.ok, true, agentAccepted.detail);
    const agentTint = executeGenerateTool("write_page", colorPage(tint), state);
    assert.equal(agentTint.ok, true, agentTint.detail);
    const agentRefused = executeGenerateTool("write_page", colorPage("#C8102E"), state);
    assert.equal(agentRefused.ok, false);
    assert.equal((agentRefused.payload as Record<string, unknown>).error, PACK_COLOR_ERROR);
    assert.match(agentRefused.detail, /已采用的设计源/);
    assert.match(agentRefused.detail, /#C8102E/);

    paintCover(projectRoot, "#C8102E");
    const blocked = inspectRunLedger(projectRoot);
    assert.equal(
      blocked.composeBlockers.some(
        (blocker) =>
          blocker.includes("pack_color") && blocker.includes("已采用的设计源") && blocker.includes("#C8102E"),
      ),
      true,
      blocked.composeBlockers.join("; "),
    );
    paintCover(projectRoot, "#112233");
    const baseOk = inspectRunLedger(projectRoot);
    assert.equal(
      baseOk.composeBlockers.some((blocker) => blocker.includes("pack_color")),
      false,
      baseOk.composeBlockers.join("; "),
    );
    paintCover(projectRoot, tint);
    const tintOk = inspectRunLedger(projectRoot);
    assert.equal(
      tintOk.composeBlockers.some((blocker) => blocker.includes("pack_color")),
      false,
      tintOk.composeBlockers.join("; "),
    );
  });

  it("clears the selection on an explicit empty array and refuses the template palette", async (t) => {
    const brief = "做一份说明。";
    const designSystemId = "consulting/pine-green-strategy";
    const { projectRoot, run, context, sourceA, sourceB } = await openTwoBrandRun(t, {
      brief,
      sessionId: "template-clear-selection",
      designSystemId,
    });
    const committed = await run.execute(
      {
        name: "commit_design",
        args: {
          slidePlan: plan(),
          adoptedSourceIds: [sourceA, sourceB],
          designAspects: [sourceA, sourceB].map((source) => ({ source, aspects: ["logo"] })),
        },
      },
      { ...context, toolCallId: "clear-commit-ab" },
    );
    assert.equal(committed.ok, true, committed.detail);
    const before = await run.execute(
      { name: "write_page", args: colorPage("#C8102E") },
      { ...context, toolCallId: "clear-page-before" },
    );
    assert.equal(before.ok, false, before.detail);
    assert.equal(before.payload.error, PACK_COLOR_ERROR);
    const cleared = await run.execute(
      { name: "commit_design", args: { slidePlan: plan(), adoptedSourceIds: [] } },
      { ...context, toolCallId: "clear-commit-empty" },
    );
    assert.equal(cleared.ok, true, cleared.detail);
    assert.match(String(cleared.payload.hint), /尚未采用/);
    assert.match(String(cleared.payload.hint), /此提示不阻止本次提交/);
    for (const sourceId of [sourceA, sourceB]) {
      assert.match(String(cleared.payload.hint), new RegExp(sourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.deepEqual(readRuntimeSelection(projectRoot), []);

    const refused = await run.execute(
      { name: "write_page", args: colorPage("#C8102E") },
      { ...context, toolCallId: "clear-page-a" },
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.payload.error, PACK_COLOR_ERROR);
    assert.match(refused.detail, /#C8102E/);
    const pine = await run.execute(
      { name: "write_page", args: colorPage("#03522C") },
      { ...context, toolCallId: "clear-page-pine" },
    );
    assert.equal(pine.ok, true, pine.detail);

    const state: AgentToolState = {
      brief,
      playbook: loadPlaybook({ designSystemId, hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [],
      projectRoot,
    };
    const agentRefused = executeGenerateTool("write_page", colorPage("#C8102E"), state);
    assert.equal(agentRefused.ok, false);
    assert.equal((agentRefused.payload as Record<string, unknown>).error, PACK_COLOR_ERROR);
    assert.match(agentRefused.detail, /#C8102E/);
    const agentPine = executeGenerateTool("write_page", colorPage("#03522C"), state);
    assert.equal(agentPine.ok, true, agentPine.detail);

    paintCover(projectRoot, "#C8102E");
    const blocked = inspectRunLedger(projectRoot);
    assert.equal(
      blocked.composeBlockers.some((blocker) => blocker.includes("pack_color") && blocker.includes("#C8102E")),
      true,
      blocked.composeBlockers.join("; "),
    );
    paintCover(projectRoot, "#03522C");
    const allowed = inspectRunLedger(projectRoot);
    assert.equal(
      allowed.composeBlockers.some((blocker) => blocker.includes("pack_color")),
      false,
      allowed.composeBlockers.join("; "),
    );
  });

  it("falls back to adopted receipts when runtime has no adoptedSourceIds field", (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "template-legacy-selection-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = path.join(temp, "project");
    const brandA = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-brand-a.pptx",
      name: "品牌A.pptx",
      palette: { accent1: "#C8102E", dk1: "#1A1A1A", lt1: "#FFFFFF" },
    };
    const brandB = {
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-brand-b.pptx",
      name: "品牌B.pptx",
      palette: { accent1: "#112233", dk1: "#445566", lt1: "#778899" },
    };
    createEmptyProject(projectRoot, { title: "旧项目" });
    writeDesignMaterial(projectRoot, brandA);
    writeDesignMaterial(projectRoot, brandB);
    writeDesignManifest(projectRoot, [brandA, brandB]);
    fs.writeFileSync(
      path.join(projectRoot, "_agent", "runtime.json"),
      `${JSON.stringify({ brief: "做一份说明。", designDirection: "self-directed" })}\n`,
    );
    recordSourceReceipt(projectRoot, { sourceId: `material:${brandA.id}`, state: "adopted" });
    recordSourceReceipt(projectRoot, { sourceId: `material:${brandB.id}`, state: "executed" });
    assert.equal(readRuntimeSelection(projectRoot), undefined);

    const state: AgentToolState = {
      brief: "做一份说明。",
      playbook: loadPlaybook({ hostDefaults: false }),
      todos: [],
      researchNotes: [],
      writtenPages: [],
      projectRoot,
    };
    for (const color of ["#C8102E", "#112233"]) {
      const written = executeGenerateTool("write_page", colorPage(color), state);
      assert.equal(written.ok, true, `${color}: ${written.detail}`);
    }
    const foreign = executeGenerateTool("write_page", colorPage("#3366FF"), state);
    assert.equal(foreign.ok, false);
    assert.equal((foreign.payload as Record<string, unknown>).error, PACK_COLOR_ERROR);
    assert.match(foreign.detail, /已采用的设计源/);

    ensureRunLedger(projectRoot, {
      manifestSha256: "e".repeat(64),
      requirementsId: "legacy-selection",
      requirements: [],
    });
    paintCover(projectRoot, "#C8102E");
    const allowed = inspectRunLedger(projectRoot);
    assert.equal(
      allowed.composeBlockers.some((blocker) => blocker.includes("pack_color")),
      false,
      allowed.composeBlockers.join("; "),
    );
    paintCover(projectRoot, "#3366FF");
    const blocked = inspectRunLedger(projectRoot);
    assert.equal(
      blocked.composeBlockers.some((blocker) => blocker.includes("pack_color") && blocker.includes("#3366FF")),
      true,
      blocked.composeBlockers.join("; "),
    );
  });

  it("does not keep a keyword template-fit module", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    assert.equal(fs.existsSync(path.join(here, "template-fit.js")), false);
    const runBody = fs.readFileSync(path.join(here, "../run.js"), "utf8");
    const indexBody = fs.readFileSync(path.join(here, "../index.js"), "utf8");
    assert.doesNotMatch(runBody, /template-fit/);
    assert.doesNotMatch(indexBody, /templateFitFromBrief|missingTemplateAdoption/);
  });
});
