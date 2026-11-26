import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { runDomainHand } from "./domain-hands.js";
import { MaterialPackError } from "./material-pack.js";
import { QUERY_RESULTS_REL, readQueryResult } from "./material-query-ledger.js";
import { queryMaterialResult } from "./material-query-hand.js";
import { writeCsvQueryMaterial, writeMonthlyQueryMaterial } from "./material-query.testkit.js";
import { tempProject, writeMaterialFixture } from "./material-testkit.js";
import { ensureRunLedger, readRunLedger } from "./run-ledger.js";

const sha = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");

function project(): string {
  const root = tempProject("oss-query-hand-");
  writeCsvQueryMaterial(root, "csv-1", 300);
  writeMonthlyQueryMaterial(root, "xlsx-1");
  writeMaterialFixture(root, {
    id: "doc-1",
    name: "说明.pdf",
    kind: "document",
    parser: "pdf-unpdf-v1",
    originalBytes: Buffer.from("%PDF-1.4 fixture"),
    derivative: { document: { pageCount: 1, pages: [{ index: 1, text: "无表格" }] } },
  });
  ensureRunLedger(root, {
    manifestSha256: "q".repeat(64),
    requirementsId: "query-hand",
    requirements: [],
  });
  return root;
}

const context = (n: number) => ({ commandId: `cmd-${n}`, contextEpochId: "epoch-1" });
const facts = (root: string) =>
  (readRunLedger(root)?.facts ?? []).filter((fact) => fact.type === "material.query-computed");
const storedResults = (root: string) => {
  const dir = path.join(root, QUERY_RESULTS_REL);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

const ARGS = {
  materialId: "csv-1",
  groupBy: ["地区"],
  measures: [{ op: "sum", column: "金额", as: "合计" }],
  sort: [{ by: "合计", dir: "desc" }],
};

describe("VAL-DATA-004: a query returns a receipt and writes material.query-computed", () => {
  it("returns rows with a receipt bound to the material, and stores the result", (t) => {
    const root = project();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const before = Date.now();
    const result = queryMaterialResult(root, context(1), ARGS);
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.name, "query_material");
    const payload = result.payload as Record<string, unknown>;
    assert.deepEqual(payload.cols, ["地区", "合计"]);
    assert.equal((payload.rows as unknown[]).length, 6);
    assert.equal(payload.name, "明细.csv");
    const receipt = payload.receipt as Record<string, unknown>;
    const original = fs.readFileSync(path.join(root, "_agent/materials/csv-1/original.csv"));
    assert.equal(receipt.materialId, "csv-1");
    assert.equal(receipt.originalSha256, sha(original));
    assert.equal(receipt.querySha256, payload.querySha256);
    assert.equal(receipt.resultSha256, payload.resultSha256);
    assert.equal(receipt.rowsScanned, 300);
    assert.equal(receipt.rowsMatched, 300);
    assert.equal(receipt.rowsReturned, 6);
    assert.equal((receipt.query as Record<string, unknown>).part, "rows");
    assert.ok(Date.parse(String(receipt.computedAt)) >= before - 1);
    assert.match(result.detail, /返回 6 行/);
    assert.match(result.detail, /两位小数/);
    assert.equal(result.detail.includes("华东"), false, "rows live in the payload, not the detail");

    const written = facts(root);
    assert.equal(written.length, 1);
    assert.deepEqual(
      {
        materialId: (written[0] as Record<string, unknown>).materialId,
        querySha256: (written[0] as Record<string, unknown>).querySha256,
        resultSha256: (written[0] as Record<string, unknown>).resultSha256,
        contextEpochId: (written[0] as Record<string, unknown>).contextEpochId,
      },
      {
        materialId: "csv-1",
        querySha256: payload.querySha256,
        resultSha256: payload.resultSha256,
        contextEpochId: "epoch-1",
      },
    );
    const stored = readQueryResult(root, {
      querySha256: String(payload.querySha256),
      resultSha256: String(payload.resultSha256),
    });
    assert.deepEqual(stored?.rows, payload.rows);
    assert.equal(stored?.materialSha256, sha(original));
  });

  it("writes one fact per call and gives the same hashes for the same query", (t) => {
    const root = project();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const first = queryMaterialResult(root, context(1), ARGS).payload as Record<string, unknown>;
    const second = queryMaterialResult(root, context(2), ARGS).payload as Record<string, unknown>;
    assert.equal(facts(root).length, 2);
    assert.equal(second.querySha256, first.querySha256);
    assert.equal(second.resultSha256, first.resultSha256);
    queryMaterialResult(root, context(1), ARGS);
    assert.equal(facts(root).length, 2, "replaying the same command does not duplicate its fact");
    assert.equal(storedResults(root).length, 1);
  });

  it("refuses a tampered derivative or original with the round-1 error and writes no fact", async (t) => {
    const root = project();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const derivative = path.join(root, "_agent/materials/csv-1/derivative.json");
    const intact = fs.readFileSync(derivative);
    fs.writeFileSync(derivative, Buffer.concat([intact, Buffer.from(" ")]));
    assert.throws(
      () => queryMaterialResult(root, context(1), ARGS),
      (error: unknown) => error instanceof MaterialPackError && /解析结果已变化/.test(error.message),
    );
    const viaTool = await runDomainHand("query_material", { ...ARGS, __openSlideStudio: context(2) }, root);
    assert.equal(viaTool.ok, false);
    assert.match(viaTool.detail, /资料「明细\.csv」解析结果已变化，请重新上传后再发送/);
    assert.equal(JSON.stringify(viaTool.payload).includes("华东"), false);
    fs.writeFileSync(derivative, intact);
    const original = path.join(root, "_agent/materials/csv-1/original.csv");
    fs.appendFileSync(original, "\n999,华东,1.00");
    const originalTampered = await runDomainHand("query_material", { ...ARGS, __openSlideStudio: context(3) }, root);
    assert.equal(originalTampered.ok, false);
    assert.match(originalTampered.detail, /原文件已变化/);
    assert.equal(facts(root).length, 0);
    assert.deepEqual(storedResults(root), []);
  });

  it("writes no fact and stores nothing for every refused call", async (t) => {
    const root = project();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ materialId: "nope", measures: [{ op: "count", as: "行数" }] }, /资料不存在/],
      [{ materialId: "doc-1", measures: [{ op: "count", as: "行数" }] }, /是文档.*不是表格/],
      [{ materialId: "csv-1", measures: [{ op: "sum", column: "金额*2", as: "x" }] }, /没有列「金额\*2」/],
      [{ materialId: "csv-1", measures: [{ op: "sum", column: "地区", as: "x" }] }, /列「地区」.*不是数值/],
      [{ materialId: "csv-1", measures: [{ op: "median", column: "金额", as: "x" }] }, /可用：sum、count/],
      [{ materialId: "csv-1", groupBy: ["序号"], measures: [{ op: "count", as: "x" }] }, /结果超过 200 行/],
      [{ materialId: "xlsx-1", part: "sheet:没有", measures: [{ op: "count", as: "x" }] }, /没有名为「没有」的工作表/],
      [{ materialId: "xlsx-1", measures: [{ op: "count", as: "x" }] }, /有多个工作表/],
      [{ measures: [{ op: "count", as: "x" }] }, /资料参数无效/],
    ];
    for (const [index, [args, pattern]] of refused.entries()) {
      const result = await runDomainHand("query_material", { ...args, __openSlideStudio: context(index + 1) }, root);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.match(result.detail, pattern);
    }
    assert.equal(facts(root).length, 0);
    assert.deepEqual(storedResults(root), []);
  });

  it("runs through the registered domain tool and the hands log", async (t) => {
    const root = project();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = await runDomainHand(
      "query_material",
      {
        materialId: "xlsx-1",
        part: "sheet:经营指标",
        groupBy: ["类别"],
        measures: [{ op: "sum", column: "2026-09", as: "本月" }],
        __openSlideStudio: context(7),
      },
      root,
    );
    assert.equal(result.ok, true, result.detail);
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.part, "sheet:经营指标");
    assert.equal(facts(root).length, 1);
    const log = fs.readFileSync(path.join(root, "_agent/hands-log.jsonl"), "utf8");
    assert.match(log, /"name":"query_material"/);
  });

  it("is refused like the other material tools when the run ledger is missing", async (t) => {
    const root = tempProject("oss-query-noledger-");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeCsvQueryMaterial(root, "csv-1", 5);
    const result = await runDomainHand("query_material", ARGS, root);
    assert.equal(result.ok, false);
    assert.match(result.detail, /run ledger is not initialized/);
  });
});
