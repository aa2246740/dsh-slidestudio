import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildDeliveryProvenance, PROVENANCE_SUMMARY_MAX_BYTES } from "./delivery-provenance.js";
import { applyWritePageProvenance } from "./material-figures.js";
import { queryMaterialResult } from "./material-query-hand.js";
import {
  checkComputedFigures,
  epochComputedCells,
  figureTokens,
  matchComputedFigures,
  type ComputedCell,
} from "./material-query-figures.js";
import { QUERY_RESULTS_REL, type PageComputedFiguresFact } from "./material-query-ledger.js";
import {
  writeCsvQueryMaterial,
  writeMonthlyQueryMaterial,
  writeSheetsQueryMaterial,
} from "./material-query.testkit.js";
import { tempProject } from "./material-testkit.js";
import {
  ensureRunLedger,
  readRunLedger,
  recordPageRevision,
  type DeckComposedFact,
  type RunToolContext,
} from "./run-ledger.js";

const CONTEXT: RunToolContext = { commandId: "fig-cmd", contextEpochId: "fig-epoch" };

function project(): string {
  const root = tempProject("oss-query-figures-");
  writeCsvQueryMaterial(root, "csv-1", 50);
  writeMonthlyQueryMaterial(root, "xlsx-1");
  ensureRunLedger(root, {
    manifestSha256: "f".repeat(64),
    requirementsId: "query-figures",
    requirements: [],
  });
  return root;
}

const MONTHLY_QUERY = {
  materialId: "xlsx-1",
  part: "sheet:经营指标",
  groupBy: ["类别"],
  measures: [
    { op: "sum", column: "2026-09", as: "本月" },
    { op: "sum", column: "2026-08", as: "上月" },
    { op: "sum", column: "2025-09", as: "去年同月" },
  ],
  derive: [
    { as: "同比", op: "yoy", of: "本月", base: "去年同月" },
    { as: "环比", op: "mom", of: "本月", base: "上月" },
  ],
};

function runQuery(root: string, commandId = "q1", context = CONTEXT): string {
  const result = queryMaterialResult(root, { ...context, commandId }, MONTHLY_QUERY);
  assert.equal(result.ok, true, result.detail);
  return String((result.payload as Record<string, unknown>).resultSha256);
}

function page(id: string, body: string) {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: `${id}-body`,
        elementType: "text",
        bounds: [80, 160, 800, 60],
        content: { text: body, fontSize: 16 },
      },
    ],
  };
}

const PAGE_TEXT = "指标A 本月 1,250.5 万元，同比 +25.05%，环比 13.66%";

function write(root: string, id: string, body: string, args: Record<string, unknown> = {}) {
  const content = page(id, body);
  const revision = recordPageRevision(root, CONTEXT, id, content);
  const hint = applyWritePageProvenance(
    root,
    CONTEXT,
    { pageId: id, revision: revision.revision, pageSha256: revision.pageSha256 },
    content,
    args,
  );
  return { revision, hint };
}

const storedResultFiles = (root: string) => fs.readdirSync(path.join(root, QUERY_RESULTS_REL));

const computedFacts = (root: string) =>
  (readRunLedger(root)?.facts ?? []).filter(
    (fact): fact is PageComputedFiguresFact => fact.type === "page.computed-figures",
  );

function seal(root: string, ids: string[]): DeckComposedFact {
  const revisions = Object.fromEntries(
    ids.map((id) => {
      const fact = (readRunLedger(root)?.facts ?? [])
        .filter((entry) => entry.type === "page.revision-committed" && entry.pageId === id)
        .at(-1);
      assert.ok(fact && fact.type === "page.revision-committed");
      return [id, fact.pageSha256];
    }),
  );
  return {
    type: "deck.composed",
    factId: "fig-seal",
    at: "2026-01-01T00:00:00.000Z",
    contextEpochId: CONTEXT.contextEpochId,
    title: "月报",
    deckSha256: "c".repeat(64),
    pageRevisions: revisions,
  };
}

describe("figureTokens: numbers a page states", () => {
  it("keeps decimals, percentages and 4-digit integers, with their displayed precision", () => {
    const tokens = figureTokens("同比 +25.05%，收入 1,250.5 万元，共 12345 笔，7204.53");
    assert.deepEqual(
      tokens.map((token) => [token.raw, token.magnitude, token.decimals, token.percent]),
      [
        ["25.05%", 25.05, 2, true],
        ["1,250.5", 1250.5, 1, false],
        ["12345", 12345, 0, false],
        ["7204.53", 7204.53, 2, false],
      ],
    );
  });

  it("skips years, small integers, totals and one-digit decimals", () => {
    const tokens = figureTokens("2026年9月 第 3 页 共 350 家 100% 0% 0.5% 2026 12.3");
    assert.deepEqual(
      tokens.map((token) => token.raw),
      ["12.3"],
    );
  });
});

describe("matchComputedFigures: displayed precision, exact cells", () => {
  const cell = (column: string, value: number, display: ComputedCell["display"] = "number"): ComputedCell => ({
    column,
    display,
    value,
    resultSha256: "a".repeat(64),
  });

  it("matches a value the page rounds to its displayed decimals, in either direction", () => {
    const cells = [cell("同比", 0.25049, "percent"), cell("本月", 1250.5), cell("合计", 7204.53)];
    const matched = (value: string) => matchComputedFigures([value], cells).map((m) => m.column);
    assert.deepEqual(matched("25.05%"), ["同比"]);
    assert.deepEqual(matched("25.0%"), ["同比"]);
    assert.deepEqual(matched("25.06%"), []);
    assert.deepEqual(matched("1,250.5"), ["本月"]);
    assert.deepEqual(matched("1250.51"), []);
    assert.deepEqual(matched("7205"), ["合计"]);
    assert.deepEqual(matched("7210"), []);
  });

  it("matches a percent token to a measure cell that already holds percent points", () => {
    assert.deepEqual(
      matchComputedFigures(["12.34%"], [cell("均值", 12.34)]).map((m) => m.column),
      ["均值"],
    );
  });

  it("returns one match per value and result, never twice", () => {
    const cells = [cell("甲", 12.34), cell("乙", 12.34)];
    assert.equal(matchComputedFigures(["12.34", "12.34"], cells).length, 1);
  });
});

describe("VAL-DATA-006: computed numbers trace to the query event", () => {
  it("collects only measure and derive cells of this epoch's verified results", () => {
    const root = project();
    const resultSha256 = runQuery(root);
    runQuery(root, "other-epoch", { ...CONTEXT, contextEpochId: "other" });
    const cells = epochComputedCells(root, CONTEXT.contextEpochId);
    assert.ok(cells.length > 0);
    assert.ok(cells.every((cell) => cell.resultSha256 === resultSha256));
    assert.deepEqual(
      [...new Set(cells.map((cell) => cell.column))].sort(),
      ["上月", "去年同月", "同比", "本月", "环比"].sort(),
    );
    assert.equal(cells.find((cell) => cell.column === "同比")?.display, "percent");
    assert.deepEqual(epochComputedCells(root, "no-queries-here"), []);
  });

  it("ignores a stored result whose rows no longer hash to its name", () => {
    const root = project();
    runQuery(root);
    const file = path.join(root, QUERY_RESULTS_REL, storedResultFiles(root)[0]!);
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { rows: unknown[][] };
    stored.rows[0]![1] = 999999;
    fs.writeFileSync(file, JSON.stringify(stored));
    assert.deepEqual(epochComputedCells(root, CONTEXT.contextEpochId), []);
  });

  it("records the page's computed numbers against the query result, without a hint", () => {
    const root = project();
    const resultSha256 = runQuery(root);
    const { revision, hint } = write(root, "p1", PAGE_TEXT, {
      provenance: { basis: "material", quoted: [{ value: "25.05%" }] },
    });
    assert.equal(hint, undefined);
    const [fact] = computedFacts(root);
    assert.equal(fact?.pageId, "p1");
    assert.equal(fact?.revision, revision.revision);
    assert.deepEqual(
      fact?.matches.map((match) => [match.value, match.column, match.resultSha256]),
      [
        ["1,250.5", "本月", resultSha256],
        ["25.05%", "同比", resultSha256],
        ["13.66%", "环比", resultSha256],
      ],
    );
    const check = checkComputedFigures(root, CONTEXT, { pageText: PAGE_TEXT });
    assert.equal(check.covers("25.05%"), true);
    assert.equal(check.covers("26.05%"), false);
  });

  it("hints a quoted value that is in neither the read chunks nor any query result", () => {
    const root = project();
    runQuery(root);
    const { hint } = write(root, "p1", `${PAGE_TEXT}，达标率 12.3%`, {
      provenance: { basis: "material", quoted: [{ value: "12.3%" }, { value: "25.05%" }] },
    });
    assert.equal(hint, "你标为原样引用的 12.3% 没有出现在已读资料或计算结果里，请核对或改标为示意。");
  });

  it("keeps the read-only wording when the run has no query result", () => {
    const root = project();
    const { hint } = write(root, "p1", "达标率 12.3%", {
      provenance: { basis: "material", quoted: [{ value: "12.3%" }] },
    });
    assert.equal(hint, "你标为原样引用的 12.3% 没有出现在已读资料里，请核对或改标为示意。");
    assert.deepEqual(computedFacts(root), []);
  });

  it("does not count a result from another context epoch", () => {
    const root = project();
    runQuery(root, "q-old", { ...CONTEXT, contextEpochId: "old-epoch" });
    write(root, "p1", PAGE_TEXT);
    assert.deepEqual(computedFacts(root), []);
  });

  it("puts pages[].queries and a per-page count into the delivery provenance and receipt summary", () => {
    const root = project();
    const resultSha256 = runQuery(root);
    write(root, "p1", PAGE_TEXT, { provenance: { basis: "material" } });
    write(root, "p2", "没有计算数字的一页，正文说明。");
    const built = buildDeliveryProvenance(root, seal(root, ["p1", "p2"]));
    const [first, second] = built.file.pages;
    assert.deepEqual(first?.queries, [`material.query-computed:${resultSha256}`]);
    assert.equal((first as { computedFigureCount?: number }).computedFigureCount, 3);
    assert.deepEqual(second?.queries, []);
    assert.equal("computedFigureCount" in second!, false);
    assert.match(built.summary, /第 1 页：3 个数字来自表格计算（查询资料数据）/);
    assert.match(built.summary, /第 2 页：.*未说明来源/);
    assert.ok(Buffer.byteLength(JSON.stringify(built.summary), "utf8") <= PROVENANCE_SUMMARY_MAX_BYTES);
    const ledgerFacts = readRunLedger(root)!.facts;
    assert.ok(
      ledgerFacts.some((fact) => fact.type === "material.query-computed" && fact.resultSha256 === resultSha256),
      "the traced event exists in the ledger",
    );
    const material = built.file.materials.find((entry) => entry.id === "xlsx-1");
    assert.ok(material?.use.includes("computed"));
    assert.equal(material?.chunksRead, 0);
  });

  it("only counts the page's current revision", () => {
    const root = project();
    runQuery(root);
    write(root, "p1", PAGE_TEXT);
    write(root, "p1", "改写后不再引用计算数字。");
    const built = buildDeliveryProvenance(root, seal(root, ["p1"]));
    assert.deepEqual(built.file.pages[0]?.queries, []);
  });

  it("states several pages' computed counts inside the summary budget", () => {
    const root = project();
    runQuery(root);
    const ids = Array.from({ length: 40 }, (_, index) => `p${index + 1}`);
    for (const id of ids) write(root, id, PAGE_TEXT);
    const built = buildDeliveryProvenance(root, seal(root, ids));
    assert.match(built.summary, /第 1 页：3 个数字来自表格计算/);
    assert.ok(Buffer.byteLength(JSON.stringify(built.summary), "utf8") <= PROVENANCE_SUMMARY_MAX_BYTES);
    assert.match(built.summary, /等 \d+ 页$/);
  });
});

describe("VAL-DATA-006: two queries that return the same rows keep their own column meaning", () => {
  // One summary row. The first query derives 同比 from the two amounts (shown as a percentage);
  // the second reads the sheet's own 同比 column back (a plain number). Same cols and rows.
  const RATE_SHEET = {
    name: "指标",
    header: ["指标", "本期", "去年同期", "同比"],
    rows: [["营收", 1250.5, 1000, 0.2505]],
  };
  const AMOUNTS = [
    { op: "sum", column: "本期", as: "本期" },
    { op: "sum", column: "去年同期", as: "去年同期" },
  ];
  const RECOMPUTED_RATE = {
    materialId: "rate-1",
    part: "sheet:指标",
    measures: AMOUNTS,
    derive: [{ as: "同比", op: "yoy", of: "本期", base: "去年同期" }],
  };
  const CHECKED_RATE = {
    materialId: "rate-1",
    part: "sheet:指标",
    measures: [...AMOUNTS, { op: "avg", column: "同比", as: "同比" }],
  };
  const RATE_PAGE = "本期营收 1,250.5 万元，同比 25.05%";

  type QueryPayload = {
    querySha256: string;
    resultSha256: string;
    columns: { name: string; display: string }[];
  };

  function rateProject(): string {
    const root = project();
    writeSheetsQueryMaterial(root, "rate-1", [RATE_SHEET]);
    return root;
  }

  function runRate(root: string, query: Record<string, unknown>, commandId: string): QueryPayload {
    const result = queryMaterialResult(root, { ...CONTEXT, commandId }, query);
    assert.equal(result.ok, true, result.detail);
    return result.payload as unknown as QueryPayload;
  }

  const rateDisplays = (root: string) =>
    epochComputedCells(root, CONTEXT.contextEpochId)
      .filter((cell) => cell.column === "同比")
      .map((cell) => cell.display)
      .sort();

  for (const [label, order] of [
    ["percentage first", [RECOMPUTED_RATE, CHECKED_RATE]],
    ["plain number first", [CHECKED_RATE, RECOMPUTED_RATE]],
  ] as const) {
    it(`traces the written percentage to its query, ${label}`, () => {
      const root = rateProject();
      const [first, second] = order.map((query, index) => runRate(root, query, `rate-${index}`));
      assert.equal(first!.resultSha256, second!.resultSha256, "the fixture returns identical cols and rows");
      assert.notEqual(first!.querySha256, second!.querySha256);
      assert.deepEqual(
        [first!, second!].map((run) => run.columns.find((item) => item.name === "同比")?.display).sort(),
        ["number", "percent"],
      );

      assert.deepEqual(rateDisplays(root), ["number", "percent"]);
      assert.equal(storedResultFiles(root).length, 2, "each query keeps its own stored result");

      const { hint } = write(root, "p1", RATE_PAGE, {
        provenance: { basis: "material", quoted: [{ value: "25.05%" }] },
      });
      assert.equal(hint, undefined, "the percentage keeps its source");
      const [fact] = computedFacts(root);
      assert.deepEqual(
        fact?.matches.map((match) => [match.value, match.column, match.resultSha256]),
        [
          ["1,250.5", "本期", first!.resultSha256],
          ["25.05%", "同比", first!.resultSha256],
        ],
      );
      assert.equal(checkComputedFigures(root, CONTEXT, { pageText: RATE_PAGE }).covers("25.05%"), true);

      const page = buildDeliveryProvenance(root, seal(root, ["p1"])).file.pages[0];
      assert.deepEqual(page?.queries, [`material.query-computed:${first!.resultSha256}`]);
      assert.equal((page as { computedFigureCount?: number }).computedFigureCount, 2);
    });
  }

  it("treats an identical retry as the same query: one stored result, no duplicate cells", () => {
    const root = rateProject();
    const first = runRate(root, RECOMPUTED_RATE, "retry-1");
    const again = runRate(root, RECOMPUTED_RATE, "retry-2");
    assert.equal(again.querySha256, first.querySha256);
    assert.equal(again.resultSha256, first.resultSha256);
    assert.equal(storedResultFiles(root).length, 1);
    assert.equal(epochComputedCells(root, CONTEXT.contextEpochId).length, 3);
  });

  it("still reads a result stored under its result hash, as earlier runs filed it", () => {
    const root = rateProject();
    const run = runRate(root, RECOMPUTED_RATE, "legacy");
    const dir = path.join(root, QUERY_RESULTS_REL);
    fs.renameSync(path.join(dir, storedResultFiles(root)[0]!), path.join(dir, `${run.resultSha256}.json`));
    assert.deepEqual(rateDisplays(root), ["percent"]);
  });

  it("does not trust a stored result filed under another query's name", () => {
    const root = rateProject();
    const percent = runRate(root, RECOMPUTED_RATE, "own");
    const number = runRate(root, CHECKED_RATE, "other");
    const dir = path.join(root, QUERY_RESULTS_REL);
    const files = storedResultFiles(root);
    const percentFile = files.find((name) => name.startsWith(percent.querySha256));
    const numberFile = files.find((name) => name.startsWith(number.querySha256));
    assert.ok(percentFile && numberFile, "one stored result per query");
    fs.copyFileSync(path.join(dir, percentFile), path.join(dir, numberFile));
    assert.deepEqual(rateDisplays(root), ["percent"]);
  });
});
