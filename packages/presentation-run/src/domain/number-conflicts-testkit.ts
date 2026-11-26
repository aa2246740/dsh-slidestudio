/**
 * Fixture shared by the number-conflict tests that run through the real domain hands: a run with a
 * three-page plan, document materials, `read_material`, `write_page` and `compose_deck`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { DELIVERY_PROVENANCE_REL } from "./delivery-provenance.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { writeMaterialFixture } from "./material-testkit.js";
import { ensureRunLedger, readRunLedger, recordStructuralReview, recordTodo } from "./run-ledger.js";

export const CONTEXT = { commandId: "conflicts", contextEpochId: "conflicts-epoch" };

export type Cleanup = { after(fn: () => void): void };

/** A run with a three-page plan and no materials yet. */
export function emptyProject(t: Cleanup, brief = "制作 3 页测试：季度经营汇报。"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "number-conflicts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "数字冲突" });
  writeDomainRuntime(root, { brief });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  recordTodo(
    root,
    CONTEXT,
    ["p1", "p2", "p3"].map((pageId) => ({
      pageId,
      title: `汇报 ${pageId}`,
      layoutFamily: "content",
      exhibits: ["none"],
    })),
  );
  return root;
}

export function writeDocument(root: string, id: string, name: string, text: string): void {
  writeMaterialFixture(root, {
    id,
    name,
    kind: "document",
    parser: "pdf-unpdf-v1",
    originalBytes: Buffer.from(`%PDF-1.4 fixture ${id}`),
    derivative: { document: { pageCount: 1, pages: [{ index: 1, text }] } },
  });
}

export function call(root: string, name: string, args: Record<string, unknown>, commandId = name) {
  return runDomainHand(name, { ...args, __openSlideStudio: { ...CONTEXT, commandId } }, root);
}

export async function readIds(root: string, ids: readonly string[]): Promise<void> {
  for (const materialId of ids) {
    const read = await call(root, "read_material", { materialId }, `read-${materialId}`);
    assert.equal(read.ok, true, read.detail);
  }
}

export async function write(root: string, args: Record<string, unknown>) {
  const result = await call(root, "write_page", args, `write-${String(args.id)}-${Math.random()}`);
  assert.equal(result.ok, true, result.detail);
  return result.payload as Record<string, unknown>;
}

export const hintOf = (payload: Record<string, unknown>) => String(payload.hint ?? "");

export const conflictFacts = (root: string) =>
  readRunLedger(root)!.facts.filter((fact) => fact.type === "page.number-conflicts");

export async function composeFile(root: string) {
  recordStructuralReview(root, true, []);
  const composed = await call(root, "compose_deck", { title: "数字冲突" });
  assert.equal(composed.ok, true, composed.detail);
  const file = JSON.parse(fs.readFileSync(path.join(root, DELIVERY_PROVENANCE_REL), "utf8")) as {
    conflicts: Record<string, unknown>[];
  };
  return { composed, file };
}

export type Bounds = [number, number, number, number];

/** A one-line text box on the 960×540 slide; the footer band from y=500 stays clear. */
export const textBox = (id: string, content: string, y: number, extra: Record<string, unknown> = {}) => ({
  elementId: id,
  elementType: "text",
  bounds: [80, y, 800, 36] as Bounds,
  content: { text: content, fontSize: 18 },
  ...extra,
});

export function tableBox(rows: readonly (readonly string[])[], columnWidths: readonly number[]) {
  return {
    elementId: "metrics-table",
    elementType: "table",
    bounds: [80, 100, 800, rows.length * 54] as Bounds,
    columnWidths,
    rowHeights: rows.map(() => 54),
    rows: rows.map((row) => row.map((value) => ({ text: value }))),
  };
}

/** A column of text elements, 60 slide pixels apart, the way a figure card stacks caption and value. */
export const stackedTexts = (lines: readonly string[]) =>
  lines.map((line, index) => textBox(`cell-${index}`, line, 100 + index * 60));

export type Sources = readonly [string, string];
export const ENGLISH_SOURCES: Sources = ["Q3 Revenue 1502.25", "Q3 Revenue 1500"];
export const CHINESE_SOURCES: Sources = ["Q3 营收 1502.25 万元", "Q3 营收 1500 万元"];

/**
 * Writes `elements` as page p1 of a run whose sources (source-a.txt, source-b.txt, then source-c.txt
 * for a third) conflict, then composes the deck. p2 and p3 only complete the plan. Reports what each
 * hop recorded for p1.
 */
export async function runPage(
  t: Cleanup,
  elements: readonly Record<string, unknown>[],
  sources: readonly string[] = ENGLISH_SOURCES,
) {
  const root = emptyProject(t);
  const ids = sources.map((_, index) => `source-${String.fromCharCode(97 + index)}`);
  sources.forEach((text, index) => writeDocument(root, ids[index]!, `${ids[index]}.txt`, text));
  await readIds(root, ids);
  const payload = await write(root, {
    id: "p1",
    pageType: "content",
    elements: [textBox("title", "季度指标", 30), ...elements],
  });
  for (const id of ["p2", "p3"]) {
    await write(root, {
      id,
      pageType: "content",
      elements: [
        textBox(`${id}-title`, `汇报 ${id}`, 30),
        textBox(`${id}-body`, "全年经营目标按季度分解，继续保持稳健节奏。", 100),
      ],
    });
  }
  const { file } = await composeFile(root);
  const hint = hintOf(payload);
  return {
    hintLines: hint.split("数字不一致：").length - 1,
    facts: conflictFacts(root).length,
    conflicts: file.conflicts,
  };
}

export type Outcome = Awaited<ReturnType<typeof runPage>>;

/** The page takes the side of source A only: one conflict, A used, both sources listed. */
export function assertConflictUsingA(outcome: Outcome, expected: { unit?: string; label?: string } = {}): void {
  assert.equal(outcome.hintLines, 1, "the write hint reports it");
  assert.equal(outcome.facts, 1, "the ledger records it");
  assert.equal(outcome.conflicts.length, 1, "the delivery provenance carries it");
  const conflict = outcome.conflicts[0]!;
  assert.deepEqual(conflict.used, {
    source: "source-a.txt",
    value: "1502.25",
    ...(expected.unit ? { unit: expected.unit } : {}),
  });
  assert.deepEqual(
    (conflict.values as { source: string }[]).map((entry) => entry.source),
    ["source-a.txt", "source-b.txt"],
  );
  if (expected.label) assert.equal(conflict.label, expected.label);
}

/** The page states a value only under another metric or period: no side is taken, nothing is reported. */
export function assertNoConflict(outcome: Outcome): void {
  assert.deepEqual(
    { hintLines: outcome.hintLines, facts: outcome.facts, conflicts: outcome.conflicts },
    { hintLines: 0, facts: 0, conflicts: [] },
  );
}
