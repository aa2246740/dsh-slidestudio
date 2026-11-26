import { composedMismatches } from "./monthly-update.support.js";
/**
 * Monthly update flow (CAP-17) through the real domain hands: `write_todo.periodMap` and
 * `missingItems`, stale-figure detection over template charts and tables, and the provenance
 * `data` section. Nothing here runs a model; every call is the same hand the kernel invokes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { MONTHLY_PARTS, MONTHLY_TEMPLATE_ID, writeMonthlyTemplate } from "./monthly-template.testkit.js";
import { ensureRunLedger, readRunLedger } from "./run-ledger.js";

const CONTEXT = { commandId: "monthly", contextEpochId: "monthly-epoch" };
const MAP = { from: "2026-08", to: "2026-09" };
const PLAN = ["p1", "p2", "p3"].map((pageId, index) => ({
  pageId,
  title: `本月月报 ${index + 1}`,
  layoutFamily: "content",
  exhibits: ["none"],
}));

function project(
  t: { after(fn: () => void): void },
  chartOverrides: Parameters<typeof writeMonthlyTemplate>[1] = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monthly-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "月报更新" });
  writeDomainRuntime(root, { brief: "制作 3 页测试：用上月稿和本月数据更新月报。" });
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
  writeMonthlyTemplate(root, chartOverrides);
  return root;
}

function call(root: string, name: string, args: Record<string, unknown>, commandId = name) {
  return runDomainHand(name, { ...args, __openSlideStudio: { ...CONTEXT, commandId } }, root);
}

async function readTemplate(root: string, parts: readonly string[] = MONTHLY_PARTS) {
  const material = verifyMaterial(root, MONTHLY_TEMPLATE_ID);
  for (const part of parts) {
    for (let offset = 0; offset < materialChunkCount(material, part); offset += 1) {
      const read = await call(
        root,
        "read_material",
        { materialId: MONTHLY_TEMPLATE_ID, part, offset },
        `read-${part}-${offset}`,
      );
      assert.equal(read.ok, true, read.detail);
    }
  }
}

function page(id: string, ...lines: string[]) {
  return {
    id,
    pageType: "content",
    elements: [`本月月报 ${id}`, ...lines].map((text, index) => ({
      elementId: `${id}-t${index}`,
      elementType: "text",
      bounds: [80, 80 + index * 70, 800, 60] as [number, number, number, number],
      content: { text, fontSize: index === 0 ? 28 : 20 },
    })),
  };
}

async function write(root: string, args: Record<string, unknown>) {
  const result = await call(root, "write_page", args, `write-${String(args.id)}`);
  assert.equal(result.ok, true, result.detail);
  return result.payload as Record<string, unknown>;
}

const hintOf = (payload: Record<string, unknown>) => String(payload.hint ?? "");

const figuresOf = (root: string, pageId: string) =>
  readRunLedger(root)!.facts.find((fact) => fact.type === "page.material-figures" && fact.pageId === pageId);

describe("VAL-DATA-007: missingItems exempts only the item it declares", () => {
  const two = (name: string, value: number) => [{ name, categories: [name], values: [value], numFmt: "0.00" }];
  // Two charts share template page 7; the plan has no new data for A only.
  const SHARED_SLIDE = {
    "chart-5": { slide: 7, title: "A", series: two("A", 21.43) },
    "chart-7": { slide: 7, title: "B", series: two("B", 89.64) },
  };

  async function declared(
    t: { after(fn: () => void): void },
    overrides: Parameters<typeof writeMonthlyTemplate>[1],
    item: { page: number; title: string },
  ) {
    const root = project(t, overrides);
    await readTemplate(root);
    const planned = await call(root, "write_todo", {
      items: PLAN,
      periodMap: MAP,
      missingItems: [item],
    });
    assert.equal(planned.ok, true, planned.detail);
    return root;
  }

  it("still hints a stale chart on the same template page, and records its mismatch", async (t) => {
    const root = await declared(t, SHARED_SLIDE, { page: 7, title: "A" });
    assert.equal(hintOf(await write(root, page("p1", "2026年9月 A 21.43（沿用上月）"))), "");
    const stale = hintOf(await write(root, page("p2", "2026年9月 B 89.64")));
    assert.match(stale, /89\.64/);
    assert.match(stale, /第 7 页/);
    assert.match(stale, /这条提示不阻止保存。/);
    const fact = figuresOf(root, "p2");
    assert.ok(fact?.type === "page.material-figures");
    assert.equal(fact.matches.find((match) => match.chart)?.chart?.sourceChartId, "chart-7");

    const both = hintOf(await write(root, page("p3", "2026年9月 A 21.43，B 89.64")));
    assert.match(both, /89\.64/);
    assert.doesNotMatch(both, /21\.43/, "the declared chart's value is not asked for again");

    const mismatch = { page: "2026年9月", source: ["2026年8月"], sourcePages: [7] };
    assert.deepEqual((await composedMismatches(root)).slice(1), [mismatch, mismatch]);
  });

  it("exempts a declared table but not the chart on its page", async (t) => {
    const root = await declared(t, {}, { page: 9, title: "s9-table1" });
    assert.equal(hintOf(await write(root, page("p1", "2026年9月 华北收入 1,250.50 万元"))), "");
    const chart = hintOf(await write(root, page("p2", "2026年9月 区域达标率 52.18")));
    assert.match(chart, /52\.18/);
    assert.match(chart, /第 9 页/);
  });

  it("exempts a declared chart but not the table on its page", async (t) => {
    const root = await declared(t, {}, { page: 9, title: "chart-9" });
    assert.equal(hintOf(await write(root, page("p1", "2026年9月 区域达标率 52.18"))), "");
    const table = hintOf(await write(root, page("p2", "2026年9月 华北收入 1,250.50 万元")));
    assert.match(table, /1,250\.50/);
    assert.match(table, /第 9 页/);
  });
});
