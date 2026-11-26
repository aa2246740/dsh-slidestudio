import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { buildCatalogDto, loadReferenceCatalog, resolveRepoRoot } from "./catalog.js";
import { writeDomainRuntime } from "./domain/domain-hands.js";
import { readRunLedger } from "./domain/run-ledger.js";
import { listSourceReceipts } from "./receipts.js";
import { createPresentationRun } from "./run.js";

async function openRun(t: TestContext) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slim-references-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const run = createPresentationRun({ repoRoot: resolveRepoRoot() });
  const handle = await run.open({
    projectRoot,
    sessionId: "slim-references",
    editorBaseUrl: "",
    brief: "参考资料目录验收",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "test" },
  });
  writeDomainRuntime(projectRoot, {
    brief: "参考资料目录验收",
    categoryId: "education-training",
    designDirection: "preset",
    designSystemId: "extra/mist-blue-travelogue",
    strictExecution: true,
  });
  const context = {
    ...handle,
    abortSignal: new AbortController().signal,
    toolCallId: "list-references",
  };
  return { run, context };
}

test("unfiltered list_references returns only chunk status and totals within 4096 UTF-8 bytes", async (t) => {
  const { run, context } = await openRun(t);
  const result = await run.execute({ name: "list_references", args: {} }, context);
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  t.diagnostic(`unfiltered receipt: ${bytes} bytes`);
  assert.ok(bytes <= 4096, `complete serialized receipt is ${bytes} bytes`);
  assert.equal(result.ok, true);
  assert.equal(result.payload.hint, "需要目录请带 family 或 kind 参数");
  assert.deepEqual(Object.keys(result.payload).sort(), [
    "familyTotals",
    "hint",
    "kindTotals",
    "listedSourceFiles",
    "listedVisualFiles",
    "missingReferenceChunks",
    "next",
    "referencesComplete",
    "requiredReferenceChunks",
    "sourceFiles",
    "visualFiles",
  ]);
  assert.equal(result.payload.sourceFiles, 73);
  assert.equal(result.payload.visualFiles, 44);
  assert.deepEqual(result.payload.kindTotals, { source: 73, visual: 44 });
  assert.equal(result.payload.referencesComplete, false);
  assert.equal(result.payload.next, "read_reference");
});

test("family, kind and tag filters return only sourceId, kind and chunks", async (t) => {
  const { run, context } = await openRun(t);
  const catalog = loadReferenceCatalog();
  const queries = [
    {
      args: { family: "academic" },
      rows: [...catalog.sources, ...catalog.visuals].filter((row) => row.family === "academic"),
    },
    { args: { kind: "source" }, rows: catalog.sources },
    { args: { kind: "visual" }, rows: catalog.visuals },
    {
      args: { tag: "mist-blue-travelogue" },
      rows: [...catalog.sources, ...catalog.visuals].filter(
        (row) =>
          row.sourceId.endsWith("mist-blue-travelogue.md") ||
          row.sourceId === "openkimi-preview:extra/mist-blue-travelogue",
      ),
    },
    {
      args: { family: "work", kind: "source", tag: "warm-jade" },
      rows: catalog.sources.filter(
        (row) => row.sourceId === "openkimi:reference/design_system/work/warm-jade-annual-report/design.md",
      ),
    },
    { args: { family: "no-such-family" }, rows: [] },
  ];
  for (const { args, rows } of queries) {
    const result = await run.execute({ name: "list_references", args }, context);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.payload.sources,
      rows.map((row) => ({
        sourceId: row.sourceId,
        kind: row.kind,
        chunks: row.chunks ?? [],
      })),
      JSON.stringify(args),
    );
    assert.equal(result.payload.listedSourceFiles, rows.filter((row) => row.kind === "source").length);
    assert.equal(result.payload.listedVisualFiles, rows.filter((row) => row.kind === "visual").length);
    assert.equal(JSON.stringify(result).includes("fileSha256"), false);
    assert.equal(JSON.stringify(result).includes("byteLength"), false);
  }
});

test("every commit_design catalog source is reachable through a family query within 12 KiB", async (t) => {
  const { run, context } = await openRun(t);
  const summary = await run.execute({ name: "list_references", args: {} }, context);
  const expectedTotals = {
    "01_strategy": 6,
    "02_business": 6,
    "03_work": 6,
    "04_promotion": 6,
    "05_academic": 6,
    academic: 12,
    consulting: 12,
    finance: 12,
    promotion: 12,
    work: 12,
    categories: 7,
    general: 6,
    extra: 14,
  };
  assert.deepEqual(summary.payload.familyTotals, expectedTotals);
  const reachable = new Set<string>();
  for (const [family, total] of Object.entries(expectedTotals)) {
    const result = await run.execute({ name: "list_references", args: { family } }, context);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    t.diagnostic(`${family}: ${bytes} bytes`);
    assert.ok(bytes <= 12 * 1024, `${family} receipt is ${bytes} bytes`);
    const rows = result.payload.sources;
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, total, family);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["chunks", "kind", "sourceId"]);
      assert.equal(typeof row.sourceId, "string");
      reachable.add(row.sourceId);
    }
  }
  const catalog = loadReferenceCatalog();
  assert.equal(reachable.size, 117);
  for (const row of [...catalog.sources, ...catalog.visuals]) {
    assert.ok(reachable.has(row.sourceId), row.sourceId);
  }
  for (const style of buildCatalogDto().styles) {
    assert.ok(reachable.has(style.designSourceId), `commit_design source for ${style.id}`);
  }
});

test("listing never satisfies required reads and preserves planning and compose gates", async (t) => {
  const { run, context } = await openRun(t);
  const ledger = readRunLedger(context.projectRoot);
  assert.ok(ledger);
  const required = ledger.sourcePack.requirements.flatMap((requirement) =>
    requirement.chunkIndexes.map((chunkIndex) => ({
      sourceId: requirement.sourceId,
      chunkIndex,
      reason: requirement.reason,
    })),
  );
  assert.equal(required.length, 17);
  const missing = required.map(({ sourceId, chunkIndex }) => ({ sourceId, chunkIndex }));
  for (const args of [{}, { family: "finance" }, { kind: "visual" }, { tag: "no-match" }]) {
    const result = await run.execute({ name: "list_references", args }, context);
    assert.deepEqual(result.payload.requiredReferenceChunks, required);
    assert.deepEqual(result.payload.missingReferenceChunks, missing);
    assert.equal(result.payload.referencesComplete, false);
    assert.equal(result.payload.next, "read_reference");
  }
  assert.deepEqual(readRunLedger(context.projectRoot), ledger);
  assert.deepEqual(listSourceReceipts(context.projectRoot), []);
  const plan = [{ pageId: "p1", title: "封面", layoutFamily: "cover", exhibits: [] }];
  for (const name of ["commit_design", "write_todo", "compose_deck"]) {
    const result = await run.execute(
      { name, args: { slidePlan: plan, items: plan } },
      { ...context, toolCallId: name },
    );
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.payload.missingReferenceChunks, missing);
    assert.equal(result.payload.next, "read_reference");
    assert.equal(result.payload.error, name === "compose_deck" ? "compose_not_ready" : "required_source_chunks_unread");
  }
  for (const { sourceId, chunkIndex } of missing) {
    const read = await run.execute(
      { name: "read_reference", args: { sourceId, chunkIndex } },
      { ...context, toolCallId: `read-${sourceId}-${chunkIndex}` },
    );
    assert.equal(read.ok, true, read.detail);
  }
  const complete = await run.execute({ name: "list_references", args: {} }, context);
  assert.equal(complete.payload.referencesComplete, true);
  assert.deepEqual(complete.payload.requiredReferenceChunks, required);
  assert.deepEqual(complete.payload.missingReferenceChunks, []);
  assert.equal(complete.payload.next, undefined);
  const committed = await run.execute(
    {
      name: "commit_design",
      args: { slidePlan: plan, adoptedSourceIds: ["extra/mist-blue-travelogue"] },
    },
    { ...context, toolCallId: "commit-after-read" },
  );
  assert.equal(committed.ok, true, committed.detail);
});

test("blank or invalid filters cannot accidentally return the whole directory", async (t) => {
  const { run, context } = await openRun(t);
  for (const args of [
    { family: "  ", tag: "" },
    { family: null, kind: "unknown", tag: 1 },
  ]) {
    const result = await run.execute({ name: "list_references", args }, context);
    assert.equal(result.payload.sources, undefined);
    assert.equal(result.payload.hint, "需要目录请带 family 或 kind 参数");
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
  }
});
