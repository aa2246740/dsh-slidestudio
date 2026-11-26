import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  detectMaterialFigures,
  extractPeriodLabels,
  extractStrongNumbers,
  materialFiguresHint,
  pageChartsForFigures,
  sessionMaterialReadings,
  significantDigits,
  splitChunkPages,
  type MaterialFigureReading,
} from "./material-figures.js";
import { ensureRunLedger, recordMaterialChunk, type RunToolContext } from "./run-ledger.js";
import { readMaterialChunk } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import { chartSubstitutionNote, chartSubstitutionsForPage } from "./template-chart-provenance.js";
import { materializeSplitMaterial, materializeTemplateMaterial } from "./material-figures.support.js";

/** Text modelled on the `monthly-feb.pdf` fixture: one source page with the
 * period-labelled figures, placeholder pages elsewhere. */
const SOURCE_PAGE_1 = "2026年1-2月 达标率 89.64% 87.53% 89.56%";
const SOURCE_PAGE_2 = "2026年1-2月 完成率 XX.X%，环比变化 XX.X 个百分点，待本期数据更新。";
const PAGE_MOVED_PERIOD = "2026年1-9月 达标率 89.64% 87.53% 89.56%";

const reading = (pages: Record<number, string>, id = "m-feb"): MaterialFigureReading => ({
  materialId: id,
  materialName: "monthly-feb.pdf",
  pages: Object.entries(pages).map(([page, text]) => ({ page: Number(page), text })),
});

describe("strong number extraction", () => {
  it("extracts the fixture's three period-labelled figures and skips years and placeholders", () => {
    assert.deepEqual(extractStrongNumbers(SOURCE_PAGE_1), ["89.64%", "87.53%", "89.56%"]);
    assert.deepEqual(extractStrongNumbers(SOURCE_PAGE_2), []);
    assert.deepEqual(extractStrongNumbers("2026年 达标 89.64%"), ["89.64%"]);
  });

  it("requires a decimal point or % and at least 3 significant digits", () => {
    assert.deepEqual(extractStrongNumbers("值 5.93 与 9.6% 以及 0.053 和 123%"), ["5.93", "123%"]);
    assert.deepEqual(extractStrongNumbers("整数 2026 87 4 不算"), []);
  });

  it("never matches 100% or 0%", () => {
    assert.deepEqual(extractStrongNumbers("完成度 100%，其余 0%"), []);
    assert.deepEqual(extractStrongNumbers("100.0% 同样不算"), []);
  });

  it("keeps thousand separators as written and counts 4+ digit values", () => {
    assert.deepEqual(extractStrongNumbers("收入 1,234.56 万元"), ["1,234.56"]);
    assert.equal(significantDigits("1,234.56"), 6);
    assert.equal(significantDigits("89.64%"), 4);
    assert.equal(significantDigits("0.053"), 2);
    assert.equal(significantDigits("10.0%"), 3);
  });
});

describe("period labels", () => {
  it("parses all seven contract forms", () => {
    assert.deepEqual(extractPeriodLabels("2026年1-2月"), ["2026年1-2月"]);
    assert.deepEqual(extractPeriodLabels("截至2026年2月末"), ["2026年2月末"]);
    assert.deepEqual(extractPeriodLabels("26年2月数据"), ["26年2月"]);
    assert.deepEqual(extractPeriodLabels("2026年上半年"), ["2026年上半年"]);
    assert.deepEqual(extractPeriodLabels("2026年下半年"), ["2026年下半年"]);
    assert.deepEqual(extractPeriodLabels("Q1 至 Q4"), ["Q1", "Q4"]);
    assert.deepEqual(extractPeriodLabels("2026年9月"), ["2026年9月"]);
  });

  it("does not re-match the two-digit tail of a four-digit year", () => {
    assert.deepEqual(extractPeriodLabels("2026年9月"), ["2026年9月"]);
    assert.deepEqual(extractPeriodLabels("2026年1-2月与26年3月"), ["2026年1-2月", "26年3月"]);
  });
});

describe("chunk page splitting", () => {
  it("splits on ## 第 N 页 headings and keeps text before the first heading on page 0", () => {
    const pages = splitChunkPages("前言文字\n\n## 第 1 页\n\n第一页正文\n\n## 第 2 页\n\n第二页正文");
    assert.deepEqual(
      pages.map((page) => ({ page: page.page, text: page.text.trim() })),
      [
        { page: 0, text: "前言文字" },
        { page: 1, text: "第一页正文" },
        { page: 2, text: "第二页正文" },
      ],
    );
  });
});

describe("figure detection and hints", () => {
  it("flags quoted figures and reports a period mismatch for the monthly-feb fixture", () => {
    const report = detectMaterialFigures({
      pageText: PAGE_MOVED_PERIOD,
      readings: [reading({ 1: SOURCE_PAGE_1, 2: SOURCE_PAGE_2 })],
    });
    assert.deepEqual(
      report.matches.map((match) => match.value),
      ["89.64%", "87.53%", "89.56%"],
    );
    assert.ok(report.matches.every((match) => match.sourcePage === 1));
    assert.deepEqual(report.matches[0]!.sourcePeriods, ["2026年1-2月"]);
    assert.deepEqual(report.pagePeriods, ["2026年1-9月"]);
    const hint = materialFiguresHint(report, [reading({ 1: SOURCE_PAGE_1, 2: SOURCE_PAGE_2 })]);
    assert.ok(hint);
    assert.match(hint!, /提示：本页的 89\.64%、87\.53%、89\.56% 与资料「monthly-feb\.pdf」第 1 页的原文完全一致；/);
    assert.match(hint!, /资料中的期间是「2026年1-2月」，本页标注为「2026年1-9月」/);
    assert.match(hint!, /沿用原数必须恢复原期间.*类别\/数值对应关系、单位和实体/);
  });

  it("gives no hint when the page keeps the source period", () => {
    const readings = [reading({ 1: SOURCE_PAGE_1 })];
    const report = detectMaterialFigures({ pageText: SOURCE_PAGE_1, readings });
    assert.equal(report.matches.length, 3);
    assert.equal(materialFiguresHint(report, readings), undefined);
  });

  it("gives no hint when nothing matches", () => {
    const readings = [reading({ 1: SOURCE_PAGE_1 })];
    const report = detectMaterialFigures({
      pageText: "本页数字 45.21% 与 78.90% 均为示意。",
      readings,
    });
    assert.deepEqual(report.matches, []);
    assert.equal(materialFiguresHint(report, readings), undefined);
  });

  it("quotes a single number only from 4 significant digits, or 2+ numbers on one page", () => {
    const singleLong = detectMaterialFigures({
      pageText: "营收 1,234.56 万元。",
      readings: [reading({ 3: "第 3 页 营收 1,234.56 万元，2026年1-2月" })],
    });
    assert.equal(singleLong.matches.length, 1);
    assert.equal(singleLong.matches[0]!.sourcePage, 3);

    const singleShort = detectMaterialFigures({
      pageText: "比值 5.93。",
      readings: [reading({ 3: "第 3 页 比值 5.93" })],
    });
    assert.deepEqual(singleShort.matches, []);

    const twoShort = detectMaterialFigures({
      pageText: "比值 5.93 与 4.17。",
      readings: [reading({ 3: "第 3 页 比值 5.93 与 4.17" })],
    });
    assert.deepEqual(
      twoShort.matches.map((match) => match.value),
      ["5.93", "4.17"],
    );
  });

  it("never treats 100% as a quoted figure", () => {
    const report = detectMaterialFigures({
      pageText: "完成度 100%。",
      readings: [reading({ 5: "第 5 页 完成度 100%" })],
    });
    assert.deepEqual(report.matches, []);
  });

  it("attributes copied chart values but only discloses substitution with exact categories", () => {
    const templateReading: MaterialFigureReading = {
      materialId: "template",
      materialName: "运营模板.pptx",
      pages: [],
      templateCharts: [
        {
          sourcePage: 16,
          chartId: "chart-16",
          title: "2026年1-2月运营能力",
          type: "radar",
          categories: ["获客", "转化"],
          series: [{ name: "实际", categories: ["获客", "转化"], values: [4, 8] }],
          sourcePeriods: ["2026年1-2月"],
        },
      ],
    };
    const page = {
      elements: [
        {
          elementType: "chart",
          title: "运营指标",
          data: {
            cols: ["指标", "实际"],
            rows: [
              ["获客", 4],
              ["转化", 8],
            ],
          },
          series: [{ type: "bar", encode: { x: "指标", y: "实际" } }],
        },
      ],
    };
    const report = detectMaterialFigures({
      pageText: "2026年1-2月运营指标",
      pageCharts: pageChartsForFigures(page),
      readings: [templateReading],
    });
    assert.deepEqual(
      report.matches.map((match) => [match.value, match.sourcePage, match.sourcePeriods]),
      [
        ["4", 16, ["2026年1-2月"]],
        ["8", 16, ["2026年1-2月"]],
      ],
    );
    assert.deepEqual(report.matches[0]!.chart, {
      sourceChartId: "chart-16",
      sourceType: "radar",
      outputTypes: ["bar"],
      valueMatch: "exact",
      substitution: { sourceType: "radar", targetType: "bar" },
    });

    const changedCategories = pageChartsForFigures({
      elements: [
        {
          ...page.elements[0],
          data: {
            ...page.elements[0]!.data,
            rows: [
              ["转化", 4],
              ["获客", 8],
            ],
          },
        },
      ],
    });
    const changedReport = detectMaterialFigures({
      pageText: "2026年1-2月运营指标",
      pageCharts: changedCategories,
      readings: [templateReading],
    });
    assert.deepEqual(
      changedReport.matches.map((match) => match.value),
      ["4", "8"],
    );
    assert.ok(changedReport.matches.every((match) => match.chart?.categoriesMatch === false));
    assert.deepEqual(chartSubstitutionsForPage(changedReport.matches), []);
  });

  it("checks each reused series against its own source categories", () => {
    const multiSeriesReading: MaterialFigureReading = {
      materialId: "template",
      materialName: "运营模板.pptx",
      pages: [],
      templateCharts: [
        {
          sourcePage: 7,
          chartId: "chart-7",
          title: "多系列指标",
          type: "line",
          categories: ["获客", "转化"],
          series: [
            { name: "系列一", categories: ["获客", "转化"], values: [4, 8] },
            { name: "系列二", categories: ["浏览", "下单"], values: [4, 8] },
          ],
          sourcePeriods: ["2026年1-2月"],
        },
      ],
    };
    const mismatched = pageChartsForFigures({
      elements: [
        {
          elementType: "chart",
          title: "多系列指标",
          data: {
            cols: ["指标", "系列一", "系列二"],
            rows: [
              ["获客", 4, 4],
              ["转化", 8, 8],
            ],
          },
          series: [
            { type: "line", encode: { x: "指标", y: "系列一" } },
            { type: "line", encode: { x: "指标", y: "系列二" } },
          ],
        },
      ],
    });
    const mismatchReport = detectMaterialFigures({
      pageText: "多系列指标",
      pageCharts: mismatched,
      readings: [multiSeriesReading],
    });
    assert.deepEqual(
      mismatchReport.matches.map((match) => match.value),
      ["4", "8"],
    );
    assert.ok(mismatchReport.matches.every((match) => match.chart?.categoriesMatch === false));

    const correctlyPaired = pageChartsForFigures({
      elements: [
        {
          elementType: "chart",
          title: "多系列指标",
          data: {
            cols: ["指标一", "系列一", "指标二", "系列二"],
            rows: [
              ["获客", 4, "浏览", 4],
              ["转化", 8, "下单", 8],
            ],
          },
          series: [
            { type: "line", encode: { x: "指标一", y: "系列一" } },
            { type: "line", encode: { x: "指标二", y: "系列二" } },
          ],
        },
      ],
    });
    assert.deepEqual(
      detectMaterialFigures({
        pageText: "多系列指标",
        pageCharts: correctlyPaired,
        readings: [multiSeriesReading],
      }).matches.map((match) => [match.value, match.sourcePage]),
      [
        ["4", 7],
        ["8", 7],
      ],
    );
  });
});

describe("chart substitution delivery details", () => {
  it("keeps same-named charts from distinct source pages in separate materials", () => {
    const details = chartSubstitutionsForPage([
      {
        materialId: "first",
        sourcePage: 3,
        chart: {
          sourceChartId: "chart1",
          substitution: { sourceType: "radar", targetType: "bar" },
        },
      },
      {
        materialId: "second",
        sourcePage: 6,
        chart: {
          sourceChartId: "chart1",
          substitution: { sourceType: "radar", targetType: "bar" },
        },
      },
    ]);
    assert.deepEqual(
      details.map((item) => item.sourcePage),
      [3, 6],
    );
    assert.equal(
      chartSubstitutionNote(details),
      "模板第 3 页的雷达图暂以柱状图代替；模板第 6 页的雷达图暂以柱状图代替",
    );
  });
});

describe("chunk continuation page identity", () => {
  let root = "";
  let context: RunToolContext;
  let material: ReturnType<typeof verifyMaterial>;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "material-figures-split-"));
    ensureRunLedger(root, {
      manifestSha256: "fixture",
      requirementsId: "fixture",
      requirements: [],
      executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
    });
    context = { commandId: "cmd-split", contextEpochId: "split-epoch" };
    material = materializeSplitMaterial(root);
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const recordChunk = (epoch: string, chunk: ReturnType<typeof readMaterialChunk>): void => {
    recordMaterialChunk(
      root,
      { commandId: "cmd-split", contextEpochId: epoch },
      {
        materialId: chunk.materialId,
        materialSha256: chunk.materialSha256,
        part: chunk.part,
        chunkIndex: chunk.chunkIndex,
        chunkSha256: chunk.chunkSha256,
        chunkCount: chunk.chunkCount,
      },
    );
  };

  it("keeps the real source page and period for a page that spans a chunk boundary", () => {
    assert.equal(readMaterialChunk({ material, offset: 0 }).chunkCount, 2);
    recordChunk("split-epoch", readMaterialChunk({ material, offset: 0 }));
    recordChunk("split-epoch", readMaterialChunk({ material, offset: 1 }));
    const readings = sessionMaterialReadings(root, "split-epoch");
    const split = readings.find((entry) => entry.materialId === "split-pdf");
    assert.ok(split, "the split material must contribute readings");
    assert.deepEqual(
      split.pages.map((page) => page.page),
      [1, 2],
      "continuation text must join its real page, not page 0",
    );
    const page1 = split.pages.find((page) => page.page === 1)!;
    assert.match(page1.text, /2026年1-2月/);
    assert.match(page1.text, /89\.64%/);
    const report = detectMaterialFigures({
      pageText: "2026年1-9月 达标率 89.64%、87.53%",
      readings,
    });
    assert.ok(report.matches.length >= 2);
    assert.ok(report.matches.every((match) => match.sourcePage === 1));
    assert.deepEqual(report.matches[0]!.sourcePeriods, ["2026年1-2月"]);
    const hint = materialFiguresHint(report, readings);
    assert.ok(hint, "the period change must be detected across the chunk boundary");
    assert.match(hint!, /资料中的期间是「2026年1-2月」，本页标注为「2026年1-9月」/);
  });

  it("attributes a continuation-only read to the page it continues", () => {
    recordChunk("half-epoch", readMaterialChunk({ material, offset: 1 }));
    const readings = sessionMaterialReadings(root, "half-epoch");
    const split = readings.find((entry) => entry.materialId === "split-pdf");
    assert.ok(split);
    assert.match(split.pages.find((page) => page.page === 1)!.text, /89\.64%/);
    const report = detectMaterialFigures({
      pageText: "本期达标率 89.64%、87.53%",
      readings,
    });
    assert.ok(report.matches.length >= 2);
    assert.ok(
      report.matches.every((match) => match.sourcePage === 1),
      "the continuation-only read still reports the true source page",
    );
  });
});

describe("template chart read receipts", () => {
  it("matches source charts only after every charts chunk is read in the current epoch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "material-chart-provenance-"));
    try {
      ensureRunLedger(root, {
        manifestSha256: "fixture",
        requirementsId: "fixture",
        requirements: [],
        executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
      });
      const material = materializeTemplateMaterial(root);
      const context = { commandId: "template-charts", contextEpochId: "template-epoch" };
      const record = (chunk: ReturnType<typeof readMaterialChunk>) =>
        recordMaterialChunk(root, context, {
          materialId: chunk.materialId,
          materialSha256: chunk.materialSha256,
          part: chunk.part,
          chunkIndex: chunk.chunkIndex,
          chunkSha256: chunk.chunkSha256,
          chunkCount: chunk.chunkCount,
        });

      const chartChunk = readMaterialChunk({ material, part: "charts", offset: 0 });
      recordMaterialChunk(
        root,
        { ...context, contextEpochId: "charts-only" },
        {
          materialId: chartChunk.materialId,
          materialSha256: chartChunk.materialSha256,
          part: chartChunk.part,
          chunkIndex: chartChunk.chunkIndex,
          chunkSha256: chartChunk.chunkSha256,
          chunkCount: chartChunk.chunkCount,
        },
      );
      assert.deepEqual(
        sessionMaterialReadings(root, "charts-only")[0]?.templateCharts?.[0]?.sourcePeriods,
        ["2026年1-2月"],
        "periods returned beside chart values also remain available without a slides read",
      );

      record(readMaterialChunk({ material, part: "slides", offset: 0 }));
      let readings = sessionMaterialReadings(root, "template-epoch");
      assert.deepEqual(readings[0]?.templateCharts, undefined);
      assert.deepEqual(sessionMaterialReadings(root, "another-epoch"), []);

      record(readMaterialChunk({ material, part: "charts", offset: 0 }));
      readings = sessionMaterialReadings(root, "template-epoch");
      assert.deepEqual(
        readings[0]?.templateCharts?.map((chart) => chart.sourcePage),
        [16],
      );
      assert.deepEqual(readings[0]?.templateCharts?.[0]?.sourcePeriods, ["2026年1-2月"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
