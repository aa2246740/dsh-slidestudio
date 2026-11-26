import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "../run.js";
import { writeDomainRuntime } from "./domain-hands.js";
import {
  SOURCE_ID,
  T1_COLORS,
  readMissingReferences,
  readTemplateDesign,
  writeTemplate,
} from "./deck-template.testkit.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("commit_design theme token seeding", () => {
  it("copies scheme colors and mapped font pairs onto the deck without choosing new ones", async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "theme-seed-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const projectRoot = path.join(temp, "project");
    createEmptyProject(projectRoot, { title: "公司介绍" });
    writeTemplate(projectRoot);
    writeDomainRuntime(projectRoot, {
      brief: "给董事会做一份上半年经营汇报。",
      designDirection: "self-directed",
      strictExecution: true,
    });
    const run = createPresentationRun({ repoRoot: REPO_ROOT });
    const handle = await run.open({
      projectRoot,
      sessionId: "theme-seed",
      brief: "给董事会做一份上半年经营汇报。",
      editorBaseUrl: "http://127.0.0.1:55200",
      design: { kind: "self-directed" },
      provider: { providerId: "test", modelId: "offline" },
    });
    const context = {
      runId: handle.runId,
      sessionId: handle.sessionId,
      projectRoot,
      abortSignal: new AbortController().signal,
    };
    const plan = [{ pageId: "cover", title: "公司介绍", layoutFamily: "cover", exhibits: [] }];
    const beforeRead = await run.execute(
      { name: "commit_design", args: { slidePlan: plan, adoptedSourceIds: [SOURCE_ID] } },
      { ...context, toolCallId: "theme-seed-before-read" },
    );
    assert.equal(beforeRead.ok, false);
    assert.equal(loadProject(projectRoot).presentation.theme?.colors?.accent1, undefined);
    assert.equal(loadProject(projectRoot).presentation.theme?.colors?.primary, "#2563EB");

    await readTemplateDesign(run, context, projectRoot, "theme-seed");
    await readMissingReferences(run, context, "theme-seed");
    const committed = await run.execute(
      { name: "commit_design", args: { slidePlan: plan, adoptedSourceIds: [SOURCE_ID] } },
      { ...context, toolCallId: "theme-seed-commit" },
    );
    assert.equal(committed.ok, true, committed.detail);
    const theme = loadProject(projectRoot).presentation.theme;
    for (const [key, hex] of Object.entries(T1_COLORS)) {
      assert.equal(theme?.colors?.[key], hex);
    }
    assert.equal(theme?.colors?.primary, T1_COLORS.accent1, "primary follows the adopted accent1");
    assert.equal(theme?.neutralChrome, undefined, "a deck-template adoption keeps the legacy table and chart chrome");
    const major = theme?.textStyles?.schemeMajor?.fontFamily as { latin?: string; ea?: string };
    const minor = theme?.textStyles?.schemeMinor?.fontFamily as { latin?: string; ea?: string };
    assert.deepEqual(major, { latin: "Arial", ea: "微软雅黑" });
    assert.deepEqual(minor, { latin: "Georgia", ea: "宋体" });
    const dumped = JSON.stringify(theme);
    assert.equal(dumped.includes("Montserrat"), false);
    assert.equal(dumped.includes("思源黑体"), false);
    assert.equal(dumped.includes("Calibri"), false);
    assert.equal(dumped.includes("等线"), false);
  });
});
