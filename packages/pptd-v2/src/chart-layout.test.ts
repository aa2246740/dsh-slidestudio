import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHART_GRID,
  CHART_GRID_NEUTRAL,
  CHART_INK,
  CHART_INK_NEUTRAL,
  CHART_TEXT_PX,
  alignedSecondaryScale,
  chartChrome,
  chartLayout,
  chartNumberFormatCode,
  chartSwatch,
  chartZeroHiddenFormatCode,
  formatChartValue,
  measureChartText,
  niceScale,
  resolveChartLegend,
  seriesDecimals,
} from "./chart-layout.js";

/** HSL saturation of `#RRGGBB`, the measure the palette rule uses for chromatic colours. */
function saturation(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
}

describe("chart chrome", () => {
  it("neutral chrome stays below the palette saturation limit on light and dark surfaces", () => {
    for (const hex of [
      CHART_INK_NEUTRAL.light,
      CHART_INK_NEUTRAL.dark,
      CHART_GRID_NEUTRAL.light,
      CHART_GRID_NEUTRAL.dark,
    ]) {
      assert.ok(saturation(hex) < 0.12, `${hex} would add an accent the palette did not print`);
    }
  });

  it("keeps the pre-palette values for decks without the neutral flag", () => {
    assert.deepEqual(CHART_INK, { light: "#626976", dark: "#CBD5E1" });
    assert.deepEqual(CHART_GRID, { light: "#E5E7EB", dark: "#475569" });
    assert.deepEqual(chartChrome(), {
      ink: { light: "#626976", dark: "#CBD5E1" },
      grid: { light: "#E5E7EB", dark: "#475569" },
    });
    assert.deepEqual(chartChrome({ neutralChrome: false }), chartChrome());
    assert.deepEqual(chartChrome(null), chartChrome());
  });

  it("uses the neutral set only when the theme carries the neutral flag", () => {
    assert.deepEqual(chartChrome({ neutralChrome: true }), {
      ink: { light: "#626976", dark: "#D4D4D4" },
      grid: { light: "#E5E5E5", dark: "#525252" },
    });
  });
});

describe("niceScale", () => {
  it("scales 0.091–8.641 onto 0..10 with step 2", () => {
    const scale = niceScale([0.091, 8.641], { includeZero: true });
    assert.equal(scale.min, 0);
    assert.equal(scale.max, 10);
    assert.equal(scale.step, 2);
    assert.deepEqual(scale.ticks, [0, 2, 4, 6, 8, 10]);
  });

  it("keeps negative ranges below the axis floor", () => {
    const scale = niceScale([-3, 8], { includeZero: true });
    assert.ok(scale.min <= -3);
    assert.ok(scale.max >= 8);
    assert.ok(scale.ticks.includes(0), "zero baseline must be a tick");
    assert.ok(scale.ticks.every((v, i, a) => i === 0 || v > a[i - 1]!));
  });

  it("handles all-zero series as 0..1", () => {
    const scale = niceScale([0, 0, 0], { includeZero: true });
    assert.equal(scale.min, 0);
    assert.equal(scale.max, 1);
  });

  it("pads a single positive value without going negative", () => {
    const scale = niceScale([4, 4, 4], { includeZero: true });
    assert.equal(scale.min, 0);
    assert.ok(scale.max >= 4);
  });

  it("keeps a single negative value on a 0-bound axis", () => {
    const scale = niceScale([-4, -4, -4], { includeZero: true });
    assert.equal(scale.max, 0);
    assert.ok(scale.min <= -4);
  });

  it("scales sub-1 decimals with a fractional step", () => {
    const scale = niceScale([0.02, 0.08], { includeZero: true });
    assert.equal(scale.min, 0);
    assert.ok(scale.max >= 0.08);
    assert.ok(scale.step < 1);
    assert.ok(scale.ticks.length >= 3);
  });

  it("scales large values with a round step", () => {
    const scale = niceScale([1_234_567], { includeZero: true });
    assert.ok(scale.max >= 1_234_567);
    assert.ok(scale.step % 1000 === 0, `step ${scale.step} should be round`);
  });

  it("rejects empty input without NaN", () => {
    const scale = niceScale([]);
    assert.equal(scale.min, 0);
    assert.equal(scale.max, 1);
    assert.ok(scale.ticks.every((v) => Number.isFinite(v)));
  });

  it("aligns a secondary axis to the primary tick count", () => {
    const primary = niceScale([0, 100], { includeZero: true });
    const secondary = alignedSecondaryScale([0.2, 0.9], primary);
    assert.equal(secondary.ticks.length, primary.ticks.length);
  });
});

describe("chart number formatting", () => {
  it("detects the decimals needed per series", () => {
    assert.equal(seriesDecimals([1, 2, 3]), 0);
    assert.equal(seriesDecimals([0.09, 8.641]), 3);
    assert.equal(seriesDecimals([1.5, 2]), 1);
    assert.equal(seriesDecimals([1e-7]), 3);
  });

  it("formats with thousands separators", () => {
    assert.equal(formatChartValue(1234567), "1,234,567");
    assert.equal(formatChartValue(8.641), "8.641");
    assert.equal(formatChartValue(0.09, 2), "0.09");
    assert.equal(formatChartValue(-4, 0, { signed: true }), "−4");
    assert.equal(formatChartValue(4, 0, { signed: true }), "+4");
    assert.equal(formatChartValue(0, 0, { signed: true }), "0");
  });

  it("keeps the minus sign of a negative value whether or not it is signed", () => {
    assert.equal(formatChartValue(-50), "−50");
    assert.equal(formatChartValue(-50, 0, { signed: false }), "−50");
    assert.equal(formatChartValue(-0.5, 2), "−0.50");
    assert.equal(formatChartValue(-1234567), "−1,234,567");
    assert.equal(formatChartValue(0), "0");
    assert.equal(formatChartValue(50), "50");
  });

  it("emits Excel format codes that match the decimals", () => {
    assert.equal(chartNumberFormatCode(0), "#,##0");
    assert.equal(chartNumberFormatCode(2), "#,##0.00");
    assert.equal(chartZeroHiddenFormatCode("#,##0"), "#,##0;-#,##0;;");
  });
});

describe("resolveChartLegend", () => {
  it("covers every PPTD legend form", () => {
    assert.deepEqual(resolveChartLegend(true), { show: true, position: "right" });
    assert.deepEqual(resolveChartLegend(false), { show: false, position: "right" });
    assert.deepEqual(resolveChartLegend(undefined), { show: false, position: "right" });
    assert.deepEqual(resolveChartLegend({ show: true }), { show: true, position: "right" });
    assert.deepEqual(resolveChartLegend({ show: false }), { show: false, position: "right" });
    assert.deepEqual(resolveChartLegend({ position: "bottom" }), {
      show: true,
      position: "bottom",
    });
    assert.deepEqual(resolveChartLegend({ show: false, position: "top" }), {
      show: false,
      position: "top",
    });
    assert.deepEqual(resolveChartLegend({ position: "l" }), { show: true, position: "left" });
    assert.deepEqual(resolveChartLegend({ position: "nonsense" }), {
      show: true,
      position: "right",
    });
  });
});

describe("chartSwatch", () => {
  const el = {
    colors: ["#FF0000"],
    series: [
      { type: "bar", name: "a", fill: "#111111" },
      { type: "bar", name: "b", fill: "#222222" },
    ],
    data: { cols: ["x", "a", "b"], rows: [["q", 1, 2]] },
  } as unknown as Parameters<typeof chartSwatch>[0];

  it("prefers explicit colors, then series fill, then the palette", () => {
    assert.equal(chartSwatch(el, 0, 2), "#FF0000");
    assert.equal(chartSwatch(el, 1, 2), "#222222");
    const noColors = {
      colors: undefined,
      series: [
        { type: "bar", name: "a", fill: "#111111" },
        { type: "bar", name: "b", fill: "#222222" },
      ],
      data: { cols: ["x", "a", "b"], rows: [["q", 1, 2]] },
    } as unknown as Parameters<typeof chartSwatch>[0];
    assert.equal(chartSwatch(noColors, 4, 5), "#8B5CF6");
  });

  it("single-series charts spread explicit colors across categories", () => {
    const single = {
      series: [{ type: "bar", name: "v" }],
      colors: ["#00FF00", "#0000FF"],
      data: { cols: ["x", "v"], rows: [["q", 1]] },
    } as unknown as Parameters<typeof chartSwatch>[0];
    // Category 1 takes colors[1]; a category past the list falls back to the
    // series color colors[0], then the palette.
    assert.equal(chartSwatch(single, 1, 1), "#0000FF");
    assert.equal(chartSwatch(single, 3, 1), "#00FF00");
  });
});

describe("chartLayout", () => {
  const base = {
    legend: resolveChartLegend(false),
    legendItems: [],
    widestTickLabel: "10",
    widestCategoryLabel: "类目",
    categoryCount: 3,
  };

  it("keeps plot inside bounds without a legend", () => {
    const layout = chartLayout({ w: 400, h: 300 }, { ...base, title: "标题" });
    assert.ok(layout.title);
    assert.ok(layout.plot.x >= 0 && layout.plot.y >= 0);
    assert.ok(layout.plot.x + layout.plot.w <= 400);
    assert.ok(layout.plot.y + layout.plot.h <= 300);
    assert.ok(layout.plot.w > 0 && layout.plot.h > 0);
  });

  it("places a right legend inside bounds and never overlapping the plot", () => {
    const layout = chartLayout(
      { w: 400, h: 300 },
      {
        ...base,
        legend: { show: true, position: "right" },
        legendItems: ["2025 增量", "2026 增量"],
      },
    );
    const legend = layout.legend!;
    for (const item of legend.items) {
      assert.ok(item.swatch.x + item.swatch.w <= 400);
      assert.ok(item.text.x + item.text.w <= 400);
      assert.ok(
        item.swatch.x >= layout.plot.x + layout.plot.w ||
          item.swatch.y + item.swatch.h <= layout.plot.y ||
          item.swatch.y >= layout.plot.y + layout.plot.h,
        "legend swatch must not overlap the plot",
      );
    }
  });

  it("wraps a bottom legend into rows without exceeding the width", () => {
    const layout = chartLayout(
      { w: 300, h: 220 },
      {
        ...base,
        legend: { show: true, position: "bottom" },
        legendItems: ["第一个系列名", "第二系列", "第三个", "第四", "第五", "第六个系列"],
      },
    );
    const legend = layout.legend!;
    assert.ok(legend.area.x >= 0 && legend.area.x + legend.area.w <= 300);
    assert.ok(legend.area.y + legend.area.h <= 220);
    assert.ok(legend.items.length === 6);
    const rows = new Set(legend.items.map((item) => item.swatch.y));
    assert.ok(rows.size > 1, "long item lists must wrap onto multiple rows");
  });

  it("reserves space for secondary axis ticks and titles", () => {
    const layout = chartLayout(
      { w: 500, h: 300 },
      {
        ...base,
        hasSecondaryAxis: true,
        widestSecondaryTickLabel: "100%",
        axis: { x: "月份", y: "新增", secondaryY: "复购率" },
      },
    );
    assert.ok(layout.axisTitleX);
    assert.ok(layout.axisTitleY);
    assert.ok(layout.axisTitleSecondaryY);
    assert.ok(layout.axisTitleSecondaryY!.x + layout.axisTitleSecondaryY!.w <= 500);
    assert.ok(layout.plot.x + layout.plot.w <= layout.axisTitleSecondaryY!.x);
  });

  it("two-line category labels never push the plot below zero height", () => {
    const layout = chartLayout(
      { w: 320, h: 180 },
      {
        ...base,
        widestCategoryLabel: "一个非常非常长的类目名称",
        categoryCount: 2,
      },
    );
    assert.ok(layout.plot.h > 0);
    assert.ok(layout.categoryBand);
  });

  it("leaves a band under the plot for a label below a negative bar", () => {
    const plain = chartLayout({ w: 400, h: 300 }, base);
    const reserved = chartLayout({ w: 400, h: 300 }, { ...base, reserveBelowLabel: true });
    assert.ok(plain.categoryBand);
    assert.ok(reserved.categoryBand);
    const gap = reserved.categoryBand.y - (reserved.plot.y + reserved.plot.h);
    const plainGap = plain.categoryBand.y - (plain.plot.y + plain.plot.h);
    assert.ok(gap >= CHART_TEXT_PX.dataLabel + 4);
    assert.ok(gap > plainGap);
    assert.equal(reserved.categoryBand.y, plain.categoryBand.y);
    assert.ok(reserved.plot.h > 0);
  });
});

describe("measureChartText", () => {
  it("gives CJK roughly double the latin width", () => {
    const latin = measureChartText("abcd", 10);
    const cjk = measureChartText("中文文字", 10);
    assert.ok(cjk > latin * 1.5);
  });
});
