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
import { DELIVERY_PROVENANCE_REL } from "./delivery-provenance.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { MONTHLY_PARTS, MONTHLY_TEMPLATE_ID, writeMonthlyTemplate } from "./monthly-template.testkit.js";
import { ensureRunLedger, readRunLedger, recordStructuralReview } from "./run-ledger.js";
import { composedMismatches } from "./monthly-update.support.js";

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

describe("VAL-DATA-007: write_todo.periodMap", () => {
  it("records the map, normalizes the ISO form, and keeps it when a later plan omits it", async (t) => {
    const root = project(t);
    const first = await call(root, "write_todo", { items: PLAN, periodMap: MAP });
    assert.equal(first.ok, true, first.detail);
    assert.deepEqual((first.payload as Record<string, unknown>).periodMap, {
      from: "2026年8月",
      to: "2026年9月",
    });
    const declared = () => readRunLedger(root)!.facts.filter((fact) => fact.type === "plan.period-map-declared");
    assert.equal(declared().length, 1);
    assert.deepEqual(declared()[0]!.periodMap, { from: "2026年8月", to: "2026年9月" });

    const again = await call(root, "write_todo", { items: PLAN });
    assert.equal(again.ok, true, again.detail);
    assert.equal(declared().length, 1, "an omitted periodMap keeps the earlier declaration");
    assert.deepEqual((again.payload as Record<string, unknown>).periodMap, {
      from: "2026年8月",
      to: "2026年9月",
    });

    const replaced = await call(root, "write_todo", {
      items: PLAN,
      periodMap: { from: "2026年9月", to: "2026年10月" },
    });
    assert.equal(replaced.ok, true, replaced.detail);
    assert.equal(declared().length, 2);
    assert.deepEqual(declared().at(-1)!.periodMap, { from: "2026年9月", to: "2026年10月" });
  });

  it("refuses an invalid shape in Chinese and leaves the plan and the map untouched", async (t) => {
    const root = project(t);
    const refused = await call(root, "write_todo", { items: PLAN, periodMap: "2026-09" });
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /periodMap 必须是对象/);
    const facts = readRunLedger(root)!.facts;
    assert.equal(facts.filter((fact) => fact.type === "todo.committed").length, 0);
    assert.equal(facts.filter((fact) => fact.type === "plan.period-map-declared").length, 0);
  });
});

describe("VAL-DATA-007: stale figures in template charts and tables", () => {
  it("flags a two-decimal value copied from a many-decimal cached chart value under the new period", async (t) => {
    const root = project(t);
    await readTemplate(root);
    assert.equal((await call(root, "write_todo", { items: PLAN, periodMap: MAP })).ok, true);

    const stale = await write(root, page("p1", "2026年9月 达标率 89.64，较上月提升。"));
    const hint = hintOf(stale);
    assert.match(hint, /89\.64/);
    assert.match(hint, /第 5 页/);
    assert.match(hint, /2026年8月/);
    assert.match(hint, /2026年9月/);
    assert.match(hint, /missingItems/);
    assert.match(hint, /这条提示不阻止保存。/);
    const fact = figuresOf(root, "p1");
    assert.ok(fact?.type === "page.material-figures");
    const chart = fact.matches.find((match) => match.chart);
    assert.equal(chart?.sourcePage, 5);
    assert.equal(chart?.chart?.sourceChartId, "chart-5");
    assert.equal(chart?.chart?.valueMatch, "displayed", "cached 89.6400000000001 displays as 89.64");
    assert.deepEqual(fact.periodMap, { from: "2026年8月", to: "2026年9月" });

    assert.equal(hintOf(await write(root, page("p2", "2026年9月 达标率 89.65"))), "");
  });

  it("stays quiet for the new value, a page that cites the old period, and a quoted chart", async (t) => {
    const root = project(t);
    await readTemplate(root);
    assert.equal((await call(root, "write_todo", { items: PLAN, periodMap: MAP })).ok, true);
    assert.equal(hintOf(await write(root, page("p1", "2026年9月 达标率 93.07"))), "");
    assert.equal(hintOf(await write(root, page("p2", "上月（2026年8月）达标率 89.64"))), "");
    const first = figuresOf(root, "p1");
    assert.ok(first?.type === "page.material-figures");
    assert.deepEqual(first.matches, []);
  });

  it("treats a page that names no period as the new period", async (t) => {
    const root = project(t);
    await readTemplate(root);
    assert.equal((await call(root, "write_todo", { items: PLAN, periodMap: MAP })).ok, true);
    const hint = hintOf(await write(root, page("p1", "达标率 89.64")));
    assert.match(hint, /89\.64/);
    assert.match(hint, /2026年9月/);
  });

  it("flags a number copied from a template table cell", async (t) => {
    const root = project(t);
    await readTemplate(root);
    assert.equal((await call(root, "write_todo", { items: PLAN, periodMap: MAP })).ok, true);
    const hint = hintOf(await write(root, page("p1", "2026年9月 华北收入 1,250.50 万元")));
    assert.match(hint, /1,250\.50/);
    assert.match(hint, /第 9 页/);
  });

  it("changes nothing without a periodMap (M2 behaviour)", async (t) => {
    const root = project(t);
    await readTemplate(root);
    assert.equal((await call(root, "write_todo", { items: PLAN })).ok, true);
    const payload = await write(root, page("p1", "2026年9月 达标率 89.64"));
    assert.equal(hintOf(payload), "");
    const fact = figuresOf(root, "p1");
    assert.ok(fact?.type === "page.material-figures");
    assert.deepEqual(fact.matches, []);
    assert.equal(fact.periodMap, undefined);
  });
});

describe("VAL-DATA-008: missingItems", () => {
  it("records a verified item with its template page and chart title", async (t) => {
    const root = project(t);
    await readTemplate(root);
    const planned = await call(root, "write_todo", {
      items: PLAN,
      periodMap: MAP,
      missingItems: [{ page: 7, title: "专题汇报" }],
    });
    assert.equal(planned.ok, true, planned.detail);
    assert.deepEqual((planned.payload as Record<string, unknown>).missingItems, [
      { materialId: MONTHLY_TEMPLATE_ID, page: 7, kind: "chart", title: "专题汇报" },
    ]);
    const fact = readRunLedger(root)!.facts.find((entry) => entry.type === "plan.missing-items-declared");
    assert.ok(fact?.type === "plan.missing-items-declared");
    assert.deepEqual(fact.items, [
      {
        materialId: MONTHLY_TEMPLATE_ID,
        sourcePage: 7,
        kind: "chart",
        itemId: "chart-7",
        title: "专题汇报",
      },
    ]);
  });

  it("accepts the item by chart id and names a table by its slide", async (t) => {
    const root = project(t);
    await readTemplate(root);
    const planned = await call(root, "write_todo", {
      items: PLAN,
      periodMap: MAP,
      missingItems: [
        { page: 5, title: "chart-5" },
        { page: 9, title: "s9-table1" },
      ],
    });
    assert.equal(planned.ok, true, planned.detail);
    const echoed = (planned.payload as { missingItems: { page: number; kind: string; title: string }[] }).missingItems;
    assert.deepEqual(
      echoed.map((item) => [item.page, item.kind, item.title]),
      [
        [5, "chart", "经营概览"],
        [9, "table", "区域对比"],
      ],
    );
  });

  it("refuses an item that cannot be traced, in Chinese, and keeps the plan unchanged", async (t) => {
    const root = project(t);
    const refuse = async (args: Record<string, unknown>, expected: RegExp) => {
      const result = await call(root, "write_todo", { items: PLAN, ...args });
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.match(result.detail, expected);
      const facts = readRunLedger(root)!.facts;
      assert.equal(facts.filter((fact) => fact.type === "todo.committed").length, 0);
      assert.equal(facts.filter((fact) => fact.type === "plan.missing-items-declared").length, 0);
    };
    await refuse({ missingItems: "x" }, /missingItems 必须是数组/);
    await refuse({ periodMap: MAP, missingItems: [5] }, /missingItems\[0\] 必须是对象/);
    await refuse({ periodMap: MAP, missingItems: [{ title: "x" }] }, /missingItems\[0\]\.page/);
    await refuse({ periodMap: MAP, missingItems: [{ page: 7 }] }, /missingItems\[0\]\.title/);
    await refuse({ missingItems: [{ page: 7, title: "专题汇报" }] }, /missingItems 需要先用 periodMap/);
    await refuse(
      { periodMap: MAP, missingItems: [{ page: 7, title: "专题汇报" }] },
      /先用 read_material 读完.*charts.*tables/,
    );

    await readTemplate(root, ["slides"]);
    await refuse(
      { periodMap: MAP, missingItems: [{ page: 7, title: "专题汇报" }] },
      /先用 read_material 读完.*charts.*tables/,
    );

    await readTemplate(root, ["charts", "tables"]);
    await refuse(
      { periodMap: MAP, missingItems: [{ page: 7, title: "不存在的图" }] },
      /第 7 页『不存在的图』不是已读模板里的图表或表格.*第 5 页『经营概览』.*第 7 页『专题汇报』/,
    );
    await refuse(
      { periodMap: MAP, missingItems: [{ page: 8, title: "专题汇报" }] },
      /第 8 页『专题汇报』不是已读模板里的图表或表格/,
    );
  });

  it("does not hint a stale figure on a page whose item the plan declared missing", async (t) => {
    const root = project(t);
    await readTemplate(root);
    const planned = await call(root, "write_todo", {
      items: PLAN,
      periodMap: MAP,
      missingItems: [{ page: 5, title: "经营概览" }],
    });
    assert.equal(planned.ok, true, planned.detail);
    const acknowledged = await write(root, page("p1", "2026年9月 达标率 89.64（沿用上月）"));
    assert.equal(hintOf(acknowledged), "");
    const fact = figuresOf(root, "p1");
    assert.ok(fact?.type === "page.material-figures");
    assert.ok(
      fact.matches.some((match) => match.sourcePage === 5),
      "the match is still recorded",
    );
    const other = await write(root, page("p2", "2026年9月 专题完成率 34.51"));
    assert.match(hintOf(other), /第 7 页/);
  });
});

describe("provenance data section", () => {
  async function composeFixture(root: string, plan: Record<string, unknown>) {
    await readTemplate(root);
    const planned = await call(root, "write_todo", { items: PLAN, ...plan });
    assert.equal(planned.ok, true, planned.detail);
    await write(root, page("p1", "2026年9月 达标率 93.07，本月更新。"));
    await write(root, page("p2", "2026年9月 专题完成率 34.51，专题数据待补充。"));
    await write(root, page("p3", "本月结论：整体稳定，下月继续跟进各项指标。"));
    recordStructuralReview(root, true, []);
    const composed = await call(root, "compose_deck", { title: "九月月报" });
    assert.equal(composed.ok, true, composed.detail);
    return {
      summary: String((composed.payload as Record<string, unknown>).provenanceSummary ?? ""),
      file: JSON.parse(fs.readFileSync(path.join(root, DELIVERY_PROVENANCE_REL), "utf8")) as {
        data: { periodMap?: unknown; missingItems?: unknown };
        pages: { detected: { periodMismatch: unknown } | null }[];
      },
    };
  }

  it("copies periodMap and the verified missing item into data and the compose summary", async (t) => {
    const root = project(t);
    const { file, summary } = await composeFixture(root, {
      periodMap: MAP,
      missingItems: [{ page: 7, title: "专题汇报" }],
    });
    assert.deepEqual(file.data, {
      periodMap: { from: "2026年8月", to: "2026年9月" },
      missingItems: ["第 7 页『专题汇报』：未提供本期数据"],
    });
    assert.match(summary, /期间：2026年8月 → 2026年9月/);
    assert.match(summary, /没有本期数据的项目：第 7 页『专题汇报』/);
    assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= 1536);
    assert.equal(file.pages[0]!.detected, null, "the new value matches no template figure");
  });

  it("lists nothing when every item has data, and stays empty without a map", async (t) => {
    const covered = await composeFixture(project(t), { periodMap: MAP });
    assert.deepEqual(covered.file.data, {
      periodMap: { from: "2026年8月", to: "2026年9月" },
      missingItems: [],
    });
    assert.doesNotMatch(covered.summary, /没有本期数据/);
    const plain = await composeFixture(project(t), {});
    assert.deepEqual(plain.file.data, {});
  });

  it("names the template page on a period mismatch recorded under a map", async (t) => {
    const root = project(t);
    await readTemplate(root);
    assert.equal((await call(root, "write_todo", { items: PLAN, periodMap: MAP })).ok, true);
    await write(root, page("p1", "2026年9月 达标率 89.64，沿用。"));
    await write(root, page("p2", "2026年9月 专题完成率 34.51，沿用。"));
    await write(root, page("p3", "本月结论：整体稳定，下月继续跟进各项指标。"));
    recordStructuralReview(root, true, []);
    const composed = await call(root, "compose_deck", { title: "九月月报" });
    assert.equal(composed.ok, true, composed.detail);
    const file = JSON.parse(fs.readFileSync(path.join(root, DELIVERY_PROVENANCE_REL), "utf8")) as {
      pages: { detected: { periodMismatch: unknown; sourcePages: number[] } | null }[];
    };
    assert.deepEqual(file.pages[0]!.detected?.periodMismatch, {
      page: "2026年9月",
      source: ["2026年8月"],
      sourcePages: [5],
    });
    assert.deepEqual(file.pages[1]!.detected?.periodMismatch, {
      page: "2026年9月",
      source: ["2026年8月"],
      sourcePages: [7],
    });
  });
});

function tablePage(id: string, value: string) {
  const base = page(id, "2026年9月 合成指标");
  return {
    ...base,
    elements: [
      ...base.elements,
      {
        elementId: `${id}-table`,
        elementType: "table",
        bounds: [80, 240, 700, 160],
        columnWidths: [350, 350],
        rowHeights: [80, 80],
        rows: [
          [
            { text: "指标", fontSize: 20 },
            { text: "数值", fontSize: 20 },
          ],
          [
            { text: "净额", fontSize: 20 },
            { text: value, fontSize: 20 },
          ],
        ],
      },
    ],
  };
}

type PeriodMismatch = { page: string; source: string[]; sourcePages: number[] } | null;

const CLOSING = page("p3", "本月结论：整体稳定，下月继续跟进各项指标。");

describe("VAL-DATA-007: a negative cached chart value copied under the new period", () => {
  // Profit and growth are often negative; the cache holds the sign, so the page must keep it too.
  const NEGATIVE_CHART = {
    "chart-5": {
      title: "净额",
      series: [{ name: "净额", categories: ["华北"], values: [-123.45], numFmt: "0.00" }],
    },
  };
  const OLD_PERIOD = { page: "2026年9月", source: ["2026年8月"], sourcePages: [5] };

  async function planned(t: { after(fn: () => void): void }, plan: Record<string, unknown> = {}) {
    const root = project(t, NEGATIVE_CHART);
    await readTemplate(root);
    assert.equal((await call(root, "write_todo", { items: PLAN, ...plan })).ok, true);
    return root;
  }

  function assertStale(hint: string, value = "-123.45") {
    assert.ok(hint.includes(value), hint);
    assert.match(hint, /第 5 页/);
    assert.match(hint, /2026年8月/);
    assert.match(hint, /2026年9月/);
    assert.match(hint, /missingItems/);
    assert.match(hint, /这条提示不阻止保存。/);
  }

  it("hints the value in text, written with an ASCII hyphen or the Unicode minus sign", async (t) => {
    const root = await planned(t, { periodMap: MAP });
    assertStale(hintOf(await write(root, page("p1", "2026年9月 净额 -123.45"))));
    assertStale(hintOf(await write(root, page("p2", "2026年9月 净额 \u2212123.45"))));
    for (const id of ["p1", "p2"]) {
      const fact = figuresOf(root, id);
      assert.ok(fact?.type === "page.material-figures");
      const chart = fact.matches.find((match) => match.chart);
      assert.equal(chart?.value, "-123.45");
      assert.equal(chart?.sourcePage, 5);
      assert.equal(chart?.chart?.sourceChartId, "chart-5");
    }
  });

  it("hints the value in a native table cell", async (t) => {
    const root = await planned(t, { periodMap: MAP });
    assertStale(hintOf(await write(root, tablePage("p1", "-123.45"))));
    assertStale(hintOf(await write(root, tablePage("p2", "\u2212123.45"))));
  });

  it("stays quiet for a different current-period negative value and for the opposite sign", async (t) => {
    const root = await planned(t, { periodMap: MAP });
    assert.equal(hintOf(await write(root, page("p1", "2026年9月 净额 -98.76"))), "");
    assert.equal(hintOf(await write(root, tablePage("p2", "-98.76"))), "");
    assert.equal(hintOf(await write(root, page("p3", "2026年9月 净额 123.45"))), "");
    for (const id of ["p1", "p2", "p3"]) {
      const fact = figuresOf(root, id);
      assert.ok(fact?.type === "page.material-figures");
      assert.deepEqual(fact.matches, [], id);
    }
  });

  it("does not read a hyphen between two numbers as a minus sign", async (t) => {
    const root = await planned(t, { periodMap: MAP });
    assert.equal(hintOf(await write(root, page("p1", "2026年9月 净额区间 98.76-123.45"))), "");
  });

  it("records the period mismatch for the text, the table and the unsigned control alike", async (t) => {
    const root = await planned(t, { periodMap: MAP });
    await write(root, page("p1", "2026年9月 净额 -123.45"));
    await write(root, tablePage("p2", "\u2212123.45"));
    await write(root, page("p3", "2026年9月 指标 52.18，沿用上月。"));
    assert.deepEqual(await composedMismatches(root), [
      OLD_PERIOD,
      OLD_PERIOD,
      { page: "2026年9月", source: ["2026年8月"], sourcePages: [9] },
    ]);
  });

  it("records no mismatch for a current-period negative value", async (t) => {
    const root = await planned(t, { periodMap: MAP });
    await write(root, page("p1", "2026年9月 净额 -98.76"));
    await write(root, tablePage("p2", "-98.76"));
    await write(root, CLOSING);
    assert.deepEqual(await composedMismatches(root), [undefined, undefined, undefined]);
  });

  it("changes nothing without a periodMap", async (t) => {
    const root = await planned(t);
    assert.equal(hintOf(await write(root, page("p1", "2026年9月 净额 -123.45"))), "");
    assert.equal(hintOf(await write(root, tablePage("p2", "-123.45"))), "");
    for (const id of ["p1", "p2"]) {
      const fact = figuresOf(root, id);
      assert.ok(fact?.type === "page.material-figures");
      assert.deepEqual(fact.matches, [], id);
    }
  });
});
