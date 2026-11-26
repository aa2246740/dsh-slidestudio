import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchTemplateChartTokens, periodUpdateHint } from "./period-figures.js";
import type { TemplateChartSource } from "./template-chart-provenance.js";

function chart(
  values: readonly unknown[],
  numFmt: string | undefined,
  overrides: Partial<TemplateChartSource> = {},
): TemplateChartSource {
  return {
    sourcePage: 5,
    chartId: "chart-5",
    title: "经营概览",
    type: "bar",
    categories: ["华北", "华东", "华南"],
    series: [
      {
        name: "达标率",
        categories: ["华北", "华东", "华南"],
        values,
        ...(numFmt ? { numFmt } : {}),
      },
    ],
    sourcePeriods: ["2026年8月"],
    ...overrides,
  };
}

describe("per-value matching against cached template chart values", () => {
  it("matches a two-decimal number to a value cached with many decimals through numFmt", () => {
    const [match] = matchTemplateChartTokens(["89.64"], [chart([89.6400000000001, 87.5], "0.00")]);
    assert.equal(match?.valueMatch, "displayed");
    assert.deepEqual(match?.values, ["89.64"]);
    assert.equal(match?.sourcePage, 5);
    assert.deepEqual(match?.sourcePeriods, ["2026年8月"]);
  });

  it("does not match a different number, a coarser one or one finer than the display", () => {
    const source = chart([89.6400000000001], "0.00");
    for (const token of ["89.65", "89.6", "89.640", "89.64000"]) {
      assert.deepEqual(matchTemplateChartTokens([token], [source]), [], token);
    }
  });

  it("reports an exact match as exact, with or without a numFmt", () => {
    assert.equal(matchTemplateChartTokens(["34.51"], [chart([34.51], undefined)])[0]?.valueMatch, "exact");
    assert.equal(matchTemplateChartTokens(["34.51"], [chart([34.51], "0.00")])[0]?.valueMatch, "exact");
  });

  it("reads a percent number against a percent-formatted cache and against a plain one", () => {
    assert.equal(
      matchTemplateChartTokens(["89.64%"], [chart([0.896400000000001], "0.00%")])[0]?.valueMatch,
      "displayed",
    );
    assert.equal(matchTemplateChartTokens(["89.64%"], [chart([89.6400000000001], "0.00")])[0]?.valueMatch, "displayed");
    assert.equal(matchTemplateChartTokens(["89.64%"], [chart([89.64], "0.00")])[0]?.valueMatch, "exact");
  });

  it("needs two numbers, or one with four significant digits, before a chart counts as quoted", () => {
    const source = chart([5.9, 12.3, 7.77], "0.0");
    assert.deepEqual(matchTemplateChartTokens(["5.9"], [source]), [], "one 2-digit hit is noise");
    assert.deepEqual(matchTemplateChartTokens(["5.9", "12.3"], [source])[0]?.values, ["5.9", "12.3"]);
    assert.deepEqual(matchTemplateChartTokens(["7.77"], [source]), [], "3 digits alone is not enough");
    assert.deepEqual(matchTemplateChartTokens(["1,250.50"], [chart([1250.5], "0.00")])[0]?.values, ["1,250.50"]);
  });

  it("skips non-numeric cached values and charts without any hit", () => {
    assert.deepEqual(matchTemplateChartTokens(["89.64"], [chart(["n/a", null, "x"], "0.00")]), []);
    assert.deepEqual(matchTemplateChartTokens([], [chart([89.64], "0.00")]), []);
  });
});

describe("period update hint", () => {
  it("states the old period, the new one and both ways out, and does not block", () => {
    const hint = periodUpdateHint({
      name: "上月月报.pptx",
      page: 5,
      values: ["89.64", "87.53"],
      sourcePeriods: ["2026年8月"],
      periodMap: { from: "2026年8月", to: "2026年9月" },
    });
    assert.match(hint, /89\.64、87\.53.*上月月报\.pptx.*第 5 页.*上期数值完全一致/);
    assert.match(hint, /期间 2026年8月.*更新到 2026年9月/);
    assert.match(hint, /换成 2026年9月 的新数据/);
    assert.match(hint, /missingItems/);
    assert.match(hint, /这条提示不阻止保存。$/);
  });

  it("leaves out the page for an unpaged document source", () => {
    const hint = periodUpdateHint({
      name: "上月月报.pdf",
      page: 0,
      values: ["89.64%"],
      sourcePeriods: ["2026年8月"],
      periodMap: { from: "2026年8月", to: "2026年9月" },
    });
    assert.match(hint, /资料「上月月报\.pdf」的上期数值/);
  });
});
