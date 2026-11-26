import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import * as chartRuntime from "@open-slidestudio/pptd-v2";
import { configureChartRuntime, paintChartSvg } from "../public/chart-paint.js";

// The browser hands the painters the `/runtime/` chart modules; Node tests hand them the same
// pptd-v2 build, so the real dispatch runs here.
configureChartRuntime(chartRuntime);
/** @import { ChartRenderElement } from "../public/chart-paint.js" */

/** @template T @param {T | null | undefined} value @returns {T} */
function must(value) {
  assert.ok(value);
  return value;
}
const { CHART_TEXT_PX, measureChartText } = chartRuntime;

/** @type {NonNullable<ChartRenderElement["chartSeries"]>[number]["fill"]} */
const gradient = {
  type: "gradient",
  gradientType: "linear",
  angle: 0,
  stops: [
    { position: 0, color: "#D97757" },
    { position: 1, color: "#467343", alpha: 0.5 },
  ],
};

/** @param {Partial<ChartRenderElement>} overrides @returns {ChartRenderElement} */
function chart(overrides) {
  return {
    id: "chart-dispatch",
    type: "chart",
    bounds: [0, 0, 480, 300],
    rotation: 0,
    opacity: 1,
    chartTitle: "",
    chartLabels: false,
    chartLegend: true,
    chartAxis: {},
    chartColors: ["#D97757", "#467343"],
    ...overrides,
  };
}

/** @param {string} markup */
function mount(markup) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const host = dom.window.document.createElement("div");
  host.innerHTML = markup;
  return host;
}

const context = { elements: [], backgroundCss: "#ffffff", focusRow: -1 };

test("radar charts dispatch to the radar painter with one polygon per series", () => {
  const markup = paintChartSvg(
    chart({
      chartData: {
        cols: ["Dimension", "Team A", "Team B"],
        rows: [
          ["Speed", 3, 1],
          ["Quality", 5, 4],
          ["Cost", 2, 6],
        ],
      },
      chartSeries: [{ type: "radar" }, { type: "radar" }],
    }),
    context,
  );
  const host = mount(markup);
  const polygons = host.querySelectorAll("polygon[data-chart-series]");
  assert.equal(polygons.length, 2);
  for (const polygon of polygons) {
    assert.equal(must(polygon.getAttribute("points")).trim().split(/\s+/).length, 3);
  }
  assert.doesNotMatch(markup, /NaN|Infinity/);
});

test("doughnut charts dispatch to annular slices and keep the pie legend by category", () => {
  const host = mount(
    paintChartSvg(
      chart({
        chartData: {
          cols: ["Channel", "Share"],
          rows: [
            ["Web", 40],
            ["Store", 35],
            ["Partner", 25],
          ],
        },
        chartSeries: [{ type: "doughnut" }],
      }),
      context,
    ),
  );
  assert.equal(host.querySelectorAll("path[data-chart-slice]").length, 3);
  assert.match(host.textContent, /Web/);
  assert.match(host.textContent, /Partner/);
});

/** @param {(string | number | null)[][]} rows */
function doughnutChart(rows) {
  return chart({
    chartData: { cols: ["Channel", "Share"], rows },
    chartSeries: [{ type: "doughnut" }],
  });
}

/**
 * Angular span (radians) of every arc in a path, with its radius. Follows the SVG rules: an arc
 * whose endpoints coincide is omitted, the large-arc flag picks the longer arc between the
 * endpoints, and the sweep flag picks the direction (a positive sweep runs clockwise on screen).
 */
function arcSpans(/** @type {string} */ d, /** @type {{x: number, y: number}} */ centre) {
  const tokens = d.match(/[MLAZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
  const full = Math.PI * 2;
  const spans = [];
  let current = { x: 0, y: 0 };
  let subpathStart = current;
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++];
    if (command === "M" || command === "L") {
      current = { x: Number(tokens[i]), y: Number(tokens[i + 1]) };
      i += 2;
      if (command === "M") subpathStart = current;
    } else if (command === "A") {
      const radius = Number(tokens[i]);
      const large = tokens[i + 3] === "1";
      const sweep = tokens[i + 4] === "1";
      const end = { x: Number(tokens[i + 5]), y: Number(tokens[i + 6]) };
      i += 7;
      if (Math.hypot(end.x - current.x, end.y - current.y) > 1e-9) {
        const from = Math.atan2(current.y - centre.y, current.x - centre.x);
        const to = Math.atan2(end.y - centre.y, end.x - centre.x);
        const turn = (((to - from) % full) + full) % full;
        const short = Math.min(turn, full - turn);
        const span = large ? full - short : short;
        spans.push({ radius, span: sweep ? span : -span });
      }
      current = end;
    } else if (command === "Z") {
      current = subpathStart;
    }
  }
  return spans;
}

/** The one slice path must be a complete ring: outer and inner circles each sweep a full turn. */
/** @param {Element} host */
function assertCompleteRing(host) {
  const slices = [...host.querySelectorAll("path[data-chart-slice]")];
  assert.equal(slices.length, 1, "one slice path for the one positive category");
  const d = must(must(slices[0]).getAttribute("d"));
  const tokens = must(d.match(/[MLAZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g));
  const start = { x: Number(tokens[1]), y: Number(tokens[2]) };
  const firstEnd = { x: Number(tokens[9]), y: Number(tokens[10]) };
  // The first arc is a half circle, so the chart centre is the midpoint of its chord.
  const centre = { x: (start.x + firstEnd.x) / 2, y: (start.y + firstEnd.y) / 2 };
  const radius = Math.hypot(start.x - centre.x, start.y - centre.y);
  assert.ok(radius > 0, "outer radius is positive");
  const spans = arcSpans(d, centre);
  const outer = spans.filter((item) => item.span > 0);
  const inner = spans.filter((item) => item.span < 0);
  /** @param {{span: number}[]} list */
  const sweep = (list) => list.reduce((total, item) => total + Math.abs(item.span), 0);
  assert.ok(Math.abs(sweep(outer) - Math.PI * 2) < 1e-6, `outer circle sweep ${sweep(outer)} should be a full turn`);
  assert.ok(Math.abs(sweep(inner) - Math.PI * 2) < 1e-6, `inner circle sweep ${sweep(inner)} should be a full turn`);
  for (const item of outer) assert.ok(Math.abs(item.radius - radius) < 0.01, "outer radius");
  for (const item of inner) assert.ok(Math.abs(item.radius - radius / 2) < 0.01, "hole radius");
}

test("a doughnut with one positive value draws a complete ring with a hole", () => {
  const host = mount(paintChartSvg(doughnutChart([["Web", 7]]), context));
  assertCompleteRing(host);
});

test("a doughnut with a 100 percent category draws a complete ring and no zero slices", () => {
  const host = mount(
    paintChartSvg(
      doughnutChart([
        ["Web", 100],
        ["Store", 0],
        ["Partner", 0],
      ]),
      context,
    ),
  );
  const indexes = [...host.querySelectorAll("path[data-chart-slice]")].map((node) =>
    node.getAttribute("data-chart-slice"),
  );
  assert.deepEqual(indexes, ["0"]);
  assertCompleteRing(host);
});

test("stacked bars dispatch to segments and percent-stacked fills the full height", () => {
  const data = {
    cols: ["Quarter", "Product", "Service"],
    rows: [
      ["Q1", 10, 4],
      ["Q2", 6, 8],
    ],
  };
  const stacked = mount(
    paintChartSvg(
      chart({
        chartGrouping: "stacked",
        chartData: data,
        chartSeries: [{ type: "bar" }, { type: "bar" }],
      }),
      context,
    ),
  );
  assert.equal(stacked.querySelectorAll("rect[data-chart-segment]").length, 4);

  const percent = mount(
    paintChartSvg(
      chart({
        chartGrouping: "percentStacked",
        chartData: data,
        chartSeries: [{ type: "bar" }, { type: "bar" }],
      }),
      context,
    ),
  );
  // Q1 holds 10 and 4, so its two segments are the shares 10/14 and 4/14 of the full height.
  const q1 = [...percent.querySelectorAll('rect[data-chart-segment][data-category="0"]')];
  assert.equal(q1.length, 2);
  const heights = q1.map((node) => Number(node.getAttribute("height")));
  const sum = heights[0] + heights[1];
  assert.ok(Math.abs(heights[0] / sum - 10 / 14) < 0.01, `share ${heights[0] / sum}`);
  assert.ok(sum > 0);
});

/** Two pixel positions agree to within one pixel. */
/** @param {number} actual @param {number} expected @param {string} label */
function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: expected ${expected}, got ${actual}`);
}

/** Baseline y of a value-axis tick label. Labels are drawn 3 px below their grid line. */
/** @param {Element} host @param {string} text */
function tickY(host, text) {
  const node = [...host.querySelectorAll("text")].find((item) => item.textContent === text);
  assert.ok(node, `tick label ${text}`);
  return Number(node.getAttribute("y")) - 3;
}

/** Top and bottom edges of one stacked segment. */
/** @param {Element} host @param {number} category @param {number} series */
function segmentEdges(host, category, series) {
  const node = host.querySelector(`rect[data-chart-segment][data-category="${category}"][data-series="${series}"]`);
  assert.ok(node, `segment ${category}/${series}`);
  const top = Number(node.getAttribute("y"));
  return { top, bottom: top + Number(node.getAttribute("height")) };
}

test("a percent-stacked bar keeps a negative share below zero on a -100 to 100 percent axis", () => {
  const host = mount(
    paintChartSvg(
      chart({
        chartGrouping: "percentStacked",
        chartLabels: true,
        chartData: { cols: ["Quarter", "Product", "Service"], rows: [["Q1", -25, 75]] },
        chartSeries: [{ type: "bar" }, { type: "bar" }],
      }),
      context,
    ),
  );
  const top = tickY(host, "100%");
  const zero = tickY(host, "0%");
  const bottom = tickY(host, "-100%");
  // The axis spans two units (-100% to 100%); one unit of share is half the axis height.
  const unit = (bottom - top) / 2;
  near(zero, top + unit, "zero sits at the middle of the axis");
  // Shares are taken against the absolute total (25 + 75 = 100): 75% stacks up from zero and
  // -25% stacks down from zero.
  const up = segmentEdges(host, 0, 1);
  near(up.bottom, zero, "the positive share starts at zero");
  near(up.top, zero - 0.75 * unit, "the 75% share reaches up to 75% of the axis");
  const down = segmentEdges(host, 0, 0);
  near(down.top, zero, "the negative share starts at zero");
  near(down.bottom, zero + 0.25 * unit, "the -25% share reaches down to -25% of the axis");
  assert.match(host.textContent, /-25%/);
  assert.match(host.textContent, /75%/);
});

test("an all-positive percent-stacked bar keeps the 0 to 100 percent axis", () => {
  const host = mount(
    paintChartSvg(
      chart({
        chartGrouping: "percentStacked",
        chartData: { cols: ["Quarter", "Product", "Service"], rows: [["Q1", 25, 75]] },
        chartSeries: [{ type: "bar" }, { type: "bar" }],
      }),
      context,
    ),
  );
  const top = tickY(host, "100%");
  const bottom = tickY(host, "0%");
  assert.doesNotMatch(host.textContent, /-\d+%/);
  near(segmentEdges(host, 0, 0).bottom, bottom, "the first share ends at the zero line");
  near(segmentEdges(host, 0, 1).top, top, "the stack fills to 100 percent");
});

test("a percent-stacked axis reserves room so its end-anchored labels start inside the chart", () => {
  /** @type {[(string | number)[][], string][]} */
  const cases = [
    [[["Q1", -25, 75]], "-100%"],
    [[["Q1", 25, 75]], "100%"],
  ];
  for (const [rows, label] of cases) {
    const host = mount(
      paintChartSvg(
        chart({
          chartGrouping: "percentStacked",
          chartData: { cols: ["Quarter", "Product", "Service"], rows },
          chartSeries: [{ type: "bar" }, { type: "bar" }],
        }),
        context,
      ),
    );
    const node = [...host.querySelectorAll('text[text-anchor="end"]')].find((item) => item.textContent === label);
    assert.ok(node, `the ${label} tick is painted`);
    // The label is end-anchored at its axis, so its left edge is the anchor minus the measured width.
    const left = Number(node.getAttribute("x")) - measureChartText(label, CHART_TEXT_PX.tick);
    assert.ok(left >= 0, `${label} starts at ${left.toFixed(1)} px, outside the chart`);
  }
});

/** y of a value-axis label on the left of a combo chart. Those labels are end-anchored. */
/** @param {Element} host @param {string} text */
function leftTickY(host, text) {
  const node = [...host.querySelectorAll('text[text-anchor="end"]')].find((item) => item.textContent === text);
  assert.ok(node, `left tick label ${text}`);
  return Number(node.getAttribute("y")) - 3;
}

/** Vertices of a polyline. */
/** @param {Element} node */
function pointsOf(node) {
  return must(node.getAttribute("points"))
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number));
}

/** Two primary bars and a secondary line. Each bar stack totals 90 and 60; the line runs 20 to 0. */
const comboData = {
  cols: ["Quarter", "A", "B", "Trend"],
  rows: [
    ["Q1", 60, 30, 20],
    ["Q2", 40, 20, 10],
  ],
};
/** @type {NonNullable<ChartRenderElement["chartSeries"]>} */
const comboSeries = [
  { type: "bar", name: "A", encode: { x: "Quarter", y: "A" } },
  { type: "bar", name: "B", encode: { x: "Quarter", y: "B" } },
  { type: "line", name: "Trend", axis: "secondary", encode: { x: "Quarter", y: "Trend" } },
];

test("a stacked combo stacks its two primary bars and plots the line on the secondary axis", () => {
  const host = mount(
    paintChartSvg(chart({ chartGrouping: "stacked", chartData: comboData, chartSeries: comboSeries }), context),
  );
  const zero = leftTickY(host, "0");
  const top = leftTickY(host, "100");
  // The primary axis runs 0 to 100 in steps of 20, so one unit is this many pixels.
  /** @param {number} value */
  const y = (value) => zero - (value / 100) * (zero - top);
  assert.equal(host.querySelectorAll("rect[data-chart-segment]").length, 4);
  // Q1: A stacks from 0 to 60 and B from 60 to the stacked total 90.
  const q1a = segmentEdges(host, 0, 0);
  near(q1a.bottom, y(0), "Q1 A starts at zero");
  near(q1a.top, y(60), "Q1 A ends at 60");
  const q1b = segmentEdges(host, 0, 1);
  near(q1b.bottom, y(60), "Q1 B starts where A ends");
  near(q1b.top, y(90), "Q1 B ends at the stacked total");
  near(segmentEdges(host, 1, 1).top, y(60), "Q2 B ends at the stacked total 60");
  // The line uses the secondary scale, 0 to 20 here: 20 reaches the top and 10 sits halfway up.
  const pts = pointsOf(must(host.querySelector("polyline")));
  near(pts[0][1], top, "line 20 reaches the top of the secondary scale");
  near(pts[1][1], (zero + top) / 2, "line 10 sits halfway up the secondary scale");
});

test("a percent-stacked combo shares its primary bars of the total and keeps the secondary line", () => {
  const host = mount(
    paintChartSvg(
      chart({
        chartGrouping: "percentStacked",
        chartLabels: true,
        chartData: comboData,
        chartSeries: comboSeries,
      }),
      context,
    ),
  );
  const zero = leftTickY(host, "0%");
  const top = leftTickY(host, "100%");
  // Shares of the 90 total: A is 60/90 of the height and B the rest.
  /** @param {number} fraction */
  const share = (fraction) => zero - fraction * (zero - top);
  near(segmentEdges(host, 0, 0).top, share(60 / 90), "Q1 A reaches two thirds");
  near(segmentEdges(host, 0, 1).top, top, "Q1 B ends at 100 percent");
  assert.match(host.textContent, /67%/);
  assert.match(host.textContent, /33%/);
  const pts = pointsOf(must(host.querySelector("polyline")));
  near(pts[0][1], top, "line 20 reaches the top of the secondary scale");
});

test("a gradient series fill emits defs inside the chart SVG and references them", () => {
  const svg = paintChartSvg(
    chart({
      chartGrouping: "stacked",
      chartData: {
        cols: ["Quarter", "Revenue"],
        rows: [
          ["Q1", 10],
          ["Q2", 14],
        ],
      },
      chartSeries: [{ type: "bar", name: "Revenue", fill: gradient }],
    }),
    context,
  );
  assert.match(svg, /^<svg[^>]*><defs><linearGradient id="chart-grad-[0-9a-z]+"/);
  const host = mount(svg);
  const id = must(host.querySelector("linearGradient")).getAttribute("id");
  const bars = host.querySelectorAll("rect[data-chart-segment]");
  assert.equal(bars.length, 2);
  for (const bar of bars) assert.equal(bar.getAttribute("fill"), `url(#${id})`);
});

test("clustered bars keep their existing markup and carry no gradient defs", () => {
  const svg = paintChartSvg(
    chart({
      chartData: {
        cols: ["Quarter", "Revenue"],
        rows: [
          ["Q1", 10],
          ["Q2", 14],
        ],
      },
      chartSeries: [{ type: "bar" }],
    }),
    context,
  );
  assert.doesNotMatch(svg, /<defs>/);
  assert.doesNotMatch(svg, /data-chart-segment/);
  assert.match(svg, /<rect /);
});
