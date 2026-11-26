import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { readMaterialChunk } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { tempProject } from "./material-testkit.js";
import { writeCsvQueryMaterial } from "./material-query.testkit.js";
import { ensureRunLedger, recordMaterialChunk } from "./run-ledger.js";
import { planningReferencePreflight } from "./design-source-preflight.js";
import {
  checkReportMaterialDependencies,
  materialPartDependency,
  type ReportRequirement,
} from "./report-requirements.js";

const EPOCH = "epoch-table";
const DEPENDENCY = materialPartDependency("detail", "rows", "table-check");

function tableProject(t: TestContext, rows: number): string {
  const root = tempProject("table-coverage-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeCsvQueryMaterial(root, "detail", rows);
  ensureRunLedger(root, {
    manifestSha256: "0".repeat(64),
    requirementsId: "table-coverage-test",
    requirements: [],
  });
  return root;
}

type WindowOptions = { epoch?: string; sha?: string; chunkSha?: string; rowTotal?: number };

/** Records the receipt `read_material {part:"rows", offset, limit}` leaves in the ledger. */
function readWindow(
  root: string,
  offset: number | undefined,
  limit: number | undefined,
  options: WindowOptions = {},
): void {
  const material = verifyMaterial(root, "detail");
  const read = readMaterialChunk({
    material,
    part: "rows",
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  });
  assert.ok(read.rows, "a table read always returns a row window");
  recordMaterialChunk(
    root,
    { commandId: `read-${offset}-${limit}`, contextEpochId: options.epoch ?? EPOCH },
    {
      materialId: read.materialId,
      materialSha256: options.sha ?? read.materialSha256,
      part: read.part,
      chunkIndex: read.chunkIndex,
      chunkSha256: options.chunkSha ?? read.chunkSha256,
      chunkCount: read.chunkCount,
      rowStart: read.rows.startIndex,
      rowEnd: read.rows.endIndex,
      rowTotal: options.rowTotal ?? read.rows.total,
    },
  );
}

function check(root: string) {
  return checkReportMaterialDependencies(root, EPOCH, [DEPENDENCY]);
}

function missingRows(root: string): string[] {
  return check(root).missing.map((item) => `${item.rows?.start}-${item.rows?.end}`);
}

describe("table dependencies are covered by the union of the rows actually read", () => {
  it("rejects the default first window of a 300-row table and names rows 201-300", (t) => {
    const root = tableProject(t, 300);
    readWindow(root, undefined, undefined);
    const result = check(root);
    assert.equal(result.ok, false);
    assert.deepEqual(missingRows(root), ["201-300"]);
    assert.equal(result.missing[0]?.part, "rows");
    assert.equal(result.missing[0]?.materialId, "detail");
    assert.equal(result.missing[0]?.reason, "table-check");
  });

  it("asks for the whole table when nothing was read", (t) => {
    const root = tableProject(t, 300);
    assert.equal(check(root).ok, false);
    assert.deepEqual(missingRows(root), ["1-300"]);
  });

  it("accepts three limit=100 windows that together cover every row", (t) => {
    const root = tableProject(t, 300);
    readWindow(root, 0, 100);
    assert.deepEqual(missingRows(root), ["101-300"]);
    readWindow(root, 100, 100);
    assert.deepEqual(missingRows(root), ["201-300"]);
    readWindow(root, 200, 100);
    assert.deepEqual(check(root), { ok: true, missing: [], unreadable: [] });
  });

  it("accepts overlapping and out-of-order windows that cover every row", (t) => {
    const root = tableProject(t, 300);
    readWindow(root, 150, 150);
    readWindow(root, 0, 200);
    readWindow(root, 50, 25);
    assert.equal(check(root).ok, true);
  });

  it("reports only the gap between two windows", (t) => {
    const root = tableProject(t, 300);
    readWindow(root, 0, 100);
    readWindow(root, 200, 100);
    assert.deepEqual(missingRows(root), ["101-200"]);
  });

  it("does not count receipts of an old upload, an old epoch or a tampered window", (t) => {
    const root = tableProject(t, 300);
    readWindow(root, 0, 200, { sha: "0".repeat(64) });
    readWindow(root, 0, 200, { epoch: "epoch-earlier" });
    readWindow(root, 0, 200, { chunkSha: "f".repeat(64) });
    readWindow(root, 0, 200, { rowTotal: 250 });
    assert.equal(check(root).ok, false);
    assert.deepEqual(missingRows(root), ["1-300"]);
    readWindow(root, 0, 200);
    assert.deepEqual(missingRows(root), ["201-300"]);
    readWindow(root, 200, 100);
    assert.equal(check(root).ok, true);
  });

  it("accepts a small table read once, and in two custom windows", (t) => {
    const once = tableProject(t, 6);
    assert.equal(check(once).ok, false);
    readWindow(once, undefined, undefined);
    assert.deepEqual(check(once), { ok: true, missing: [], unreadable: [] });

    const split = tableProject(t, 6);
    readWindow(split, 0, 3);
    assert.deepEqual(missingRows(split), ["4-6"]);
    readWindow(split, 3, 3);
    assert.equal(check(split).ok, true);
  });

  it("treats a receipt without row bounds as the default window only", (t) => {
    const root = tableProject(t, 300);
    const material = verifyMaterial(root, "detail");
    const read = readMaterialChunk({ material, part: "rows" });
    recordMaterialChunk(
      root,
      { commandId: "legacy", contextEpochId: EPOCH },
      {
        materialId: read.materialId,
        materialSha256: read.materialSha256,
        part: read.part,
        chunkIndex: 0,
        chunkSha256: read.chunkSha256,
      },
    );
    assert.deepEqual(missingRows(root), ["201-300"]);
  });

  it("tells the planning preflight which rows are still unread", (t) => {
    const root = tableProject(t, 300);
    readWindow(root, undefined, undefined);
    const requirement: ReportRequirement = {
      id: "material:detail:content-source",
      role: "content-source",
      statement: "内容来源：material:detail",
      origin: { kind: "user-request" },
      material: { materialId: "detail", aspects: ["content"] },
    };
    const receipt = planningReferencePreflight(root, root, "write_todo", [], EPOCH, undefined, {}, [requirement]);
    assert.equal(receipt?.ok, false);
    assert.match(receipt?.detail ?? "", /第 201–300 行/);
    assert.match(receipt?.detail ?? "", /offset=200/);
    const payload = receipt?.payload as {
      missingMaterialChunks: { rows?: { start: number; end: number } }[];
      reportRequirementChunks: { rows?: { start: number; end: number } }[];
    };
    assert.deepEqual(
      payload.missingMaterialChunks.map((chunk) => chunk.rows),
      [{ start: 201, end: 300 }],
    );
    assert.deepEqual(
      payload.reportRequirementChunks.map((chunk) => chunk.rows),
      [{ start: 201, end: 300 }],
    );
    readWindow(root, 200, 100);
    assert.equal(
      planningReferencePreflight(root, root, "write_todo", [], EPOCH, undefined, {}, [requirement]),
      undefined,
    );
  });
});
