/**
 * The monthly-update declarations as the model reaches them: `write_todo` through the real
 * presentation run, whose result the model sees. The domain hand's payload is rebuilt there, so a
 * field the domain adds must be forwarded or the model never learns what the Host accepted.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import type { CommandContext, PresentationRun } from "../index.js";
import { createPresentationRun } from "../run.js";
import { readMissingReferences } from "./deck-template.testkit.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { MONTHLY_PARTS, MONTHLY_TEMPLATE_ID, writeMonthlyTemplate } from "./monthly-template.testkit.js";
import { readRunLedger } from "./run-ledger.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const BRIEF = "用上月稿和本月数据做九月月报。";
const PLAN = [{ pageId: "p1", title: "九月经营概览", layoutFamily: "content", exhibits: [] }];

async function openMonthlyDeck(t: TestContext) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "monthly-update-run-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const projectRoot = path.join(temp, "project");
  createEmptyProject(projectRoot, { title: "九月月报" });
  writeMonthlyTemplate(projectRoot);
  writeDomainRuntime(projectRoot, {
    brief: BRIEF,
    designDirection: "self-directed",
    strictExecution: true,
  });
  const run: PresentationRun = createPresentationRun({ repoRoot: REPO_ROOT });
  const handle = await run.open({
    projectRoot,
    sessionId: "monthly-update-run",
    brief: BRIEF,
    editorBaseUrl: "http://127.0.0.1:55200",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "offline" },
  });
  const context: Omit<CommandContext, "toolCallId"> = {
    runId: handle.runId,
    sessionId: handle.sessionId,
    projectRoot,
    abortSignal: new AbortController().signal,
  };
  const material = verifyMaterial(projectRoot, MONTHLY_TEMPLATE_ID);
  for (const part of MONTHLY_PARTS) {
    for (let offset = 0; offset < materialChunkCount(material, part); offset += 1) {
      const read = await run.execute(
        { name: "read_material", args: { materialId: MONTHLY_TEMPLATE_ID, part, offset } },
        { ...context, toolCallId: `read-${part}-${offset}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
  }
  await readMissingReferences(run, context, "monthly");
  return { projectRoot, run, context };
}

it("write_todo returns the accepted periodMap and missingItems to the model through the run", async (t) => {
  const { projectRoot, run, context } = await openMonthlyDeck(t);
  const planned = await run.execute(
    {
      name: "write_todo",
      args: {
        items: PLAN,
        periodMap: { from: "2026-08", to: "2026-09" },
        missingItems: [{ page: 7, title: "专题汇报" }],
      },
    },
    { ...context, toolCallId: "monthly-plan" },
  );
  assert.equal(planned.ok, true, planned.detail);
  assert.deepEqual(planned.payload.periodMap, { from: "2026年8月", to: "2026年9月" });
  assert.deepEqual(planned.payload.missingItems, [
    { materialId: MONTHLY_TEMPLATE_ID, page: 7, kind: "chart", title: "专题汇报" },
  ]);
  const facts = readRunLedger(projectRoot)!.facts;
  assert.equal(facts.filter((fact) => fact.type === "plan.period-map-declared").length, 1);
  assert.equal(facts.filter((fact) => fact.type === "plan.missing-items-declared").length, 1);

  const kept = await run.execute(
    { name: "write_todo", args: { items: PLAN } },
    { ...context, toolCallId: "monthly-plan-again" },
  );
  assert.equal(kept.ok, true, kept.detail);
  assert.deepEqual(kept.payload.periodMap, { from: "2026年8月", to: "2026年9月" });
  assert.equal((kept.payload.missingItems as unknown[]).length, 1);
});

it("write_todo through the run refuses a bad declaration in Chinese and keeps the plan", async (t) => {
  const { projectRoot, run, context } = await openMonthlyDeck(t);
  const refusals: [Record<string, unknown>, RegExp][] = [
    [{ periodMap: { from: "2026-08" } }, /periodMap\.to 缺少期间/],
    [
      {
        periodMap: { from: "2026-08", to: "2026-09" },
        missingItems: [{ page: 7, title: "没有这张" }],
      },
      /第 7 页『没有这张』不是已读模板里的图表或表格/,
    ],
  ];
  for (const [declaration, expected] of refusals) {
    const refused = await run.execute(
      { name: "write_todo", args: { items: PLAN, ...declaration } },
      { ...context, toolCallId: "monthly-refused" },
    );
    assert.equal(refused.ok, false, JSON.stringify(declaration));
    assert.match(refused.detail, expected);
  }
  const facts = readRunLedger(projectRoot)!.facts;
  assert.equal(facts.filter((fact) => fact.type === "todo.committed").length, 0);
  assert.equal(facts.filter((fact) => fact.type === "plan.period-map-declared").length, 0);
});
