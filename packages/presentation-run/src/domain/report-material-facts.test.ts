import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { createEmptyProject, loadProject } from "@open-slidestudio/pptd-v2";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { sha256Hex } from "./material-pack.js";
import { ensureRunLedger, recordTodo } from "./run-ledger.js";

const context = { commandId: "fixture-report", contextEpochId: "fixture-current" };
const brief = "为合成验收机构制作六页经营月报，使用附件中的指标，不编造数字。";
const page = {
  id: "cover",
  pageType: "cover",
  elements: [
    {
      elementId: "title",
      elementType: "text",
      bounds: [80, 80, 800, 90],
      content: { text: "合成验收月报", fontSize: 32 },
    },
  ],
};

function fixture(t: TestContext, text = "合成验收机构，业务量 9400 万元，达成率 94.0%，缺值待补充。") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-material-facts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "合成验收月报" });
  writeDomainRuntime(root, { brief });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  recordTodo(root, context, [{ pageId: "cover", title: "合成验收月报", layoutFamily: "cover", exhibits: [] }]);
  const dir = path.join(root, "_agent/materials/facts");
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from(text);
  const sha256 = sha256Hex(original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: "facts",
      kind: "text",
      source: { name: "facts.txt", bytes: original.length, sha256, extension: ".txt" },
      parser: { id: "fixture-text" },
      status: "ok",
      text: { text },
    }),
  );
  fs.writeFileSync(path.join(dir, "original.txt"), original);
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    JSON.stringify({
      id: "facts",
      name: "facts.txt",
      kind: "text",
      parser: "fixture-text",
      originalSha256: sha256,
      derivativeSha256: sha256Hex(derivative),
    }),
  );
  fs.writeFileSync(
    path.join(root, "_agent/materials/manifest.json"),
    JSON.stringify({
      version: 1,
      materials: [
        {
          id: "facts",
          name: "facts.txt",
          kind: "text",
          parser: "fixture-text",
          sha256,
          summaryZh: "合成指标",
          needsVision: false,
          parts: [],
        },
      ],
    }),
  );
  return root;
}

async function read(root: string, epoch = context.contextEpochId) {
  const result = await runDomainHand(
    "read_material",
    { materialId: "facts", __openSlideStudio: { ...context, contextEpochId: epoch } },
    root,
  );
  assert.equal(result.ok, true, result.detail);
}
async function write(root: string) {
  return runDomainHand("write_page", { ...page, __openSlideStudio: context }, root);
}

it("writes an operating report page from receipt-verified current material reads without attachments.md", async (t) => {
  const root = fixture(t);
  await read(root);
  const result = await write(root);
  assert.equal(result.ok, true, result.detail);
  assert.equal(loadProject(root).pages.length, 1);
});

it("still refuses unread materials and material reads from a different context", async (t) => {
  const root = fixture(t);
  assert.equal((await write(root)).summary, "要数据");
  await read(root, "fixture-old");
  assert.equal((await write(root)).summary, "要数据");
  assert.equal(loadProject(root).pages.length, 0);
});

it("still refuses material bytes changed after the read receipt", async (t) => {
  const root = fixture(t);
  await read(root);
  fs.appendFileSync(path.join(root, "_agent/materials/facts/original.txt"), "tampered");
  assert.equal((await write(root)).summary, "要数据");
  assert.equal(loadProject(root).pages.length, 0);
});

it("still refuses a read material containing only missing values", async (t) => {
  const root = fixture(t, "合成验收机构：本期指标缺失，待补充。");
  await read(root);
  assert.equal((await write(root)).summary, "要数据");
});
