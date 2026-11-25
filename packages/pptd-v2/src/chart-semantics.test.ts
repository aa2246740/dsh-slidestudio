import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChartElement } from "./types.js";
import {
  categoricalChartModel,
  chartKind,
  chartSurfaceColor,
  isDarkChartSurface,
  placeScatterLabels,
  scatterChartModel,
  waterfallChartModel,
} from "./chart-semantics.js";

/** A 420 x 200 chart at (40, 40), and a page that is white unless a test says otherwise. */
const CHART_BOUNDS: [number, number, number, number] = [40, 40, 420, 200];
const SLIDE_BOUNDS: [number, number, number, number] = [0, 0, 960, 540];

function surfaceOf(overrides: Partial<Parameters<typeof chartSurfaceColor>[0]> = {}): string {
  return chartSurfaceColor({ bounds: CHART_BOUNDS, below: [], pageCss: "#FFFFFF", ...overrides });
}

/** A plain preset rectangle under the chart, painted in `solidCss` and covering the chart. */
function panelUnder(solidCss: string | undefined, overrides: Record<string, unknown> = {}) {
  return { bounds: SLIDE_BOUNDS, plainRect: true, solidCss, ...overrides };
}

describe("chart semantics", () => {
  it("honors reversed bar encodings as a horizontal chart", () => {
    const chart = {
      data: {
        cols: ["区域", "金额"],
        rows: [
          ["华东", 4887],
          ["华南", 2829],
          ["华北", 2315],
        ],
      },
      series: [{ type: "bar", name: "金额", encode: { x: "金额", y: "区域" } }],
    } as Pick<ChartElement, "data" | "series">;

    const model = categoricalChartModel(chart);

    assert.equal(model.kind, "bar");
    assert.equal(model.orientation, "horizontal");
    assert.deepEqual(model.categories, ["华东", "华南", "华北"]);
    assert.deepEqual(model.series[0]?.values, [4887, 2829, 2315]);
    assert.ok(model.valueMax >= 4887 && model.valueMax <= 5000);
  });

  it("uses every series' declared value column", () => {
    const chart = {
      data: {
        cols: ["层级", "人数pct", "收入pct"],
        rows: [
          ["黑金", 2.8, 22],
          ["金卡", 8.6, 28],
        ],
      },
      series: [
        { type: "bar", name: "人数%", encode: { x: "层级", y: "人数pct" } },
        { type: "bar", name: "收入%", encode: { x: "层级", y: "收入pct" } },
      ],
    } as Pick<ChartElement, "data" | "series">;

    const model = categoricalChartModel(chart);

    assert.equal(model.orientation, "vertical");
    assert.deepEqual(model.categories, ["黑金", "金卡"]);
    assert.deepEqual(
      model.series.map((series) => series.values),
      [
        [2.8, 8.6],
        [22, 28],
      ],
    );
  });

  it("keeps each combination series kind and value axis", () => {
    const chart = {
      data: {
        cols: ["月", "新增", "复购率"],
        rows: [
          ["6月", 11.2, 25.8],
          ["7月", 12.8, 26.4],
        ],
      },
      series: [
        { type: "bar", name: "新增", encode: { x: "月", y: "新增" } },
        {
          type: "line",
          name: "复购率",
          encode: { x: "月", y: "复购率" },
          axis: "secondary",
        },
      ],
    } as Pick<ChartElement, "data" | "series">;

    const model = categoricalChartModel(chart);

    assert.deepEqual(
      model.series.map((series) => ({ kind: series.kind, axis: series.axis })),
      [
        { kind: "bar", axis: "primary" },
        { kind: "line", axis: "secondary" },
      ],
    );
  });

  it("keeps a derived cash-flow subtotal on the opening-cash baseline", () => {
    const chart = {
      data: {
        cols: ["步", "额", "tot"],
        rows: [
          ["期初现金", 5280, null],
          ["经营流入", 12210, null],
          ["经营流出", -10860, null],
          ["经营净额", 1350, null],
          ["投资", -486, null],
          ["筹资", -180, null],
          ["期末", 5964, null],
        ],
      },
      series: [{ type: "waterfall", encode: { x: "步", y: "额", isTotal: "tot" } }],
    } as Pick<ChartElement, "data" | "series">;

    const model = waterfallChartModel(chart);

    assert.equal(chartKind(chart), "waterfall");
    assert.deepEqual(model.bars[3], {
      label: "经营净额",
      value: 1350,
      start: 5280,
      end: 6630,
      kind: "subtotal",
    });
    assert.deepEqual(model.bars[4], {
      label: "投资",
      value: -486,
      start: 6630,
      end: 6144,
      kind: "decrease",
    });
    assert.ok(model.valueMax >= 17490 && model.valueMax <= 20000);
    assert.ok(model.valueMin <= 5280 && model.valueMin >= 0);
    assert.equal(model.scale.step % 1 === 0 || model.scale.step < 1, true);
    assert.equal(model.bars.at(-1)?.end, 5964);
  });

  it("uses scatter encode columns and preserves point labels", () => {
    const chart = {
      data: {
        cols: ["风险", "可能", "影响"],
        rows: [
          ["爆品缺货", 4.5, 4.8],
          ["华北同店", 4.2, 4.5],
        ],
      },
      series: [{ type: "scatter", encode: { x: "可能", y: "影响" } }],
    } as Pick<ChartElement, "data" | "series">;

    const model = scatterChartModel(chart);

    assert.equal(chartKind(chart), "scatter");
    assert.equal(model.xName, "可能");
    assert.equal(model.yName, "影响");
    assert.deepEqual(model.points[0], { label: "爆品缺货", x: 4.5, y: 4.8 });
    assert.ok(model.xMax >= 4.5 && model.xMax <= 5);
    assert.ok(model.yMax >= 4.8 && model.yMax <= 5.5);
  });

  it("places clustered scatter labels without overlapping boxes", () => {
    const placements = placeScatterLabels(
      [
        { label: "爆品缺货", x: 352, y: 34 },
        { label: "华北同店", x: 333, y: 52 },
        { label: "一线离职", x: 307, y: 129 },
        { label: "抖音ROI", x: 320, y: 150 },
        { label: "茶叶成本", x: 288, y: 164 },
      ],
      { left: 2, top: 4, right: 398, bottom: 336 },
    );
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const left = placements[i]!.box;
        const right = placements[j]!.box;
        const overlapWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
        const overlapHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
        assert.equal(overlapWidth * overlapHeight, 0);
      }
    }
  });
});

describe("waterfall value domain", () => {
  const bridge = {
    data: {
      cols: ["步", "pct", "tot"],
      rows: [
        ["6 月", 37.5, null],
        ["原料", -0.8, null],
        ["茶饮结构", 0.6, null],
        ["损耗", 0.3, null],
        ["促销", -0.2, null],
        ["7 月", 37.8, null],
      ],
    },
    series: [{ type: "waterfall", encode: { x: "步", y: "pct", isTotal: "tot" } }],
  } as never;

  it("spans the floating extents so small deltas stay readable", () => {
    const model = waterfallChartModel(bridge as Parameters<typeof waterfallChartModel>[0]);
    assert.ok(model.valueMin <= 36.6 && model.valueMin >= 30);
    assert.ok(model.valueMax >= 37.8 && model.valueMax <= 45);
    assert.ok(model.scale.step <= 2, "small bridge needs a step of 2 or less");
  });

  it("tightens the domain even for a simple build so deltas stay visible", () => {
    const chart = {
      data: {
        cols: ["步", "额"],
        rows: [
          ["期初", 100],
          ["流入", 50],
          ["期末", 150],
        ],
      },
      series: [{ type: "waterfall", encode: { x: "步", y: "额" } }],
    } as unknown as Parameters<typeof waterfallChartModel>[0];
    const model = waterfallChartModel(chart);
    assert.ok(model.valueMin <= 100);
    assert.ok(model.valueMax >= 150);
    assert.ok(model.valueMax - model.valueMin <= 200);
  });
});

describe("chart surface: the colour a chart's ink reads against", () => {
  it("takes the chart's own background before anything painted beneath it", () => {
    assert.equal(surfaceOf({ chartCss: "#111111", below: [panelUnder("#FFFFFF")] }), "#111111");
  });

  it("takes an opaque solid plain rectangle that covers the chart", () => {
    assert.equal(surfaceOf({ below: [panelUnder("#111111")] }), "#111111");
  });

  it("takes the topmost covering panel and ignores one that does not cover the chart", () => {
    const below = [
      panelUnder("#111111"),
      panelUnder("#EEEEEE"),
      { ...panelUnder("#000000"), bounds: [100, 40, 400, 200] as [number, number, number, number] },
    ];
    assert.equal(surfaceOf({ below }), "#EEEEEE");
  });

  it("ignores hidden, custom, translucent, gradient and unpainted panels", () => {
    const excluded = [
      panelUnder("#111111", { hidden: true }),
      panelUnder("#111111", { plainRect: false }),
      panelUnder("rgba(17, 17, 17, 0.5)"),
      panelUnder("linear-gradient(90deg, #111111 0%, #FFFFFF 100%)"),
      panelUnder(undefined),
    ];
    for (const panel of excluded) {
      assert.equal(surfaceOf({ below: [panel] }), "#FFFFFF", JSON.stringify(panel));
    }
  });

  it("reads the surface from the colour a candidate carries, and a picture carries none", () => {
    assert.equal(surfaceOf({ below: [panelUnder("#E5E7EB")] }), "#E5E7EB");
    assert.equal(surfaceOf({ below: [panelUnder(undefined)] }), "#FFFFFF");
  });

  it("falls back to the page surface, or to nothing when the page is unknown", () => {
    assert.equal(surfaceOf({ pageCss: "#FFFFFF" }), "#FFFFFF");
    assert.equal(surfaceOf({ pageCss: "" }), "");
  });

  it("reads a surface as dark when its first colour has YIQ brightness below 140", () => {
    const dark = [
      "#111111",
      "#000",
      "#888888",
      "rgb(17, 17, 17)",
      "rgba(17, 17, 17, 0.5)",
      "#11111180",
      "linear-gradient(90deg, #102E52 0%, #ffffff 100%)",
      // The first stop decides, even when it is translucent and the second stop is white.
      "linear-gradient(90deg, rgba(0, 0, 0, 0.5) 0%, #FFFFFF 100%)",
    ];
    const light = [
      "#FFFFFF",
      "#FFF",
      "#8C8C8C",
      "rgb(255, 255, 255)",
      "#E5E7EB",
      "linear-gradient(90deg, #FFFFFF 0%, #111111 100%)",
      "",
      "not a colour",
    ];
    for (const css of dark) assert.equal(isDarkChartSurface(css), true, css);
    for (const css of light) assert.equal(isDarkChartSurface(css), false, css);
  });
});
