import assert from "node:assert/strict";
import { test } from "node:test";
import * as chartRuntime from "@open-slidestudio/pptd-v2";
import { configureChartRuntime } from "../public/chart-paint-layout.js";
import { JSDOM } from "jsdom";
import { paintRadarSvg, radarGeometry } from "../public/chart-paint-radar.js";
import { paintDoughnutSvg } from "../public/chart-paint-doughnut.js";
import { paintStackedBarsSvg } from "../public/chart-paint-stacked.js";

// The stacked painter reads the shared percent text from the injected chart runtime.
configureChartRuntime(chartRuntime);
import { areaFillAttributes, chartFillPlan, injectChartDefs } from "../public/chart-paint-gradient.js";

const FONTS = { tick: 10, category: 11, dataLabel: 10 };
const INK = "#626976";
const GRID = "#E5E7EB";
const TOLERANCE = 1;

/** @template T @param {T | null | undefined} value @returns {T} */
function must(value) {
  assert.ok(value);
  return value;
}

/** Parse a painter's markup into a live jsdom subtree. @param {string} markup */
function mount(markup) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const host = dom.window.document.createElement("div");
  host.innerHTML = `<svg viewBox="0 0 400 400">${markup}</svg>`;
  return host;
}

/** @param {Element} node */
function points(node) {
  return must(node.getAttribute("points"))
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number));
}

/** @param {number} actual @param {number} expected @param {string} label @param {number} [tolerance] */
function near(actual, expected, label, tolerance = TOLERANCE) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}

/** @param {string | null} text */
function numbersIn(text) {
  return must((text ?? "").match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)).map(Number);
}

test("radar vertices follow the clockwise category angle and the scale", () => {
  const plot = { x: 20, y: 30, w: 300, h: 260 };
  const scale = { min: 0, max: 6, ticks: [0, 2, 4, 6], tickDecimals: 0 };
  const categories = ["A", "B", "C"];
  const series = [
    { name: "S1", values: [3, 5, 2], paint: "#D97757" },
    { name: "S2", values: [1, 4, 6], paint: "#467343" },
  ];
  const markup = paintRadarSvg({
    plot,
    categories,
    series,
    scale,
    ink: INK,
    gridColor: GRID,
    showLabels: false,
    fonts: FONTS,
    formatTick: String,
    valueText: String,
  });
  assert.doesNotMatch(markup, /NaN|Infinity/);
  const host = mount(markup);
  const geometry = radarGeometry(plot);
  const R = Math.min(plot.w, plot.h) / 2 - 18;
  const { cx, cy } = geometry;
  assert.equal(geometry.radius, R);
  assert.equal(cx, plot.x + plot.w / 2);
  assert.equal(cy, plot.y + plot.h / 2);
  series.forEach((row, s) => {
    const polygon = host.querySelector(`polygon[data-chart-series="${s}"]`);
    assert.ok(polygon, `series ${s} polygon`);
    const pts = points(polygon);
    assert.equal(pts.length, categories.length);
    pts.forEach(([x, y], i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / categories.length;
      const r = (R * (row.values[i] - scale.min)) / (scale.max - scale.min);
      near(x, cx + r * Math.cos(angle), `series ${s} vertex ${i} x`);
      near(y, cy + r * Math.sin(angle), `series ${s} vertex ${i} y`);
    });
  });
  const grids = host.querySelectorAll("polygon[data-chart-grid]");
  assert.equal(grids.length, scale.ticks.length);
  const outer = must([...grids].at(-1));
  assert.equal(points(outer).length, categories.length);
  for (const [x, y] of points(outer)) {
    near(Math.hypot(x - cx, y - cy), R, "outer grid ring radius");
  }
  assert.equal(host.querySelectorAll("line[data-chart-spoke]").length, categories.length);
});

test("stacked vertical bars stack positives up from zero and negatives down", () => {
  const plot = { x: 40, y: 20, w: 300, h: 200 };
  const scale = { min: -5, max: 10, ticks: [-5, 0, 5, 10], tickDecimals: 0 };
  /** @param {number} v */
  const yFor = (v) => plot.y + plot.h - ((v - scale.min) / (scale.max - scale.min)) * plot.h;
  const markup = paintStackedBarsSvg({
    plot,
    orientation: "vertical",
    grouping: "stacked",
    categories: ["Q1", "Q2"],
    series: [
      { name: "a", values: [10, 4], kind: "bar" },
      { name: "b", values: [-5, 6], kind: "bar" },
    ],
    scale,
    focusRow: -1,
    showLabels: false,
    ink: INK,
    gridColor: GRID,
    fonts: FONTS,
    formatTick: String,
    valueText: String,
    categoryY: 240,
    paint: (s) => (s === 0 ? "#D97757" : "#467343"),
  });
  const host = mount(markup);
  /** @param {number} category @param {number} series */
  const segment = (category, series) =>
    must(host.querySelector(`rect[data-chart-segment][data-category="${category}"][data-series="${series}"]`));
  /** @param {Element} node */
  const span = (node) => {
    const top = Number(node.getAttribute("y"));
    return { top, bottom: top + Number(node.getAttribute("height")) };
  };
  // Category 0: a = +10 stacks from zero to 10; b = -5 stacks from zero down to -5.
  const a0 = span(segment(0, 0));
  near(a0.top, yFor(10), "Q1 positive top");
  near(a0.bottom, yFor(0), "Q1 positive bottom");
  const b0 = span(segment(0, 1));
  near(b0.top, yFor(0), "Q1 negative top");
  near(b0.bottom, yFor(-5), "Q1 negative bottom");
  // Category 1: both positive; a fills 0..4 and b stacks on top to the total 10.
  const a1 = span(segment(1, 0));
  near(a1.top, yFor(4), "Q2 a top");
  near(a1.bottom, yFor(0), "Q2 a bottom");
  const b1 = span(segment(1, 1));
  near(b1.top, yFor(10), "Q2 stacked total top");
  near(b1.bottom, yFor(4), "Q2 b bottom");
  assert.ok(a0.bottom <= yFor(0) + TOLERANCE && a1.bottom <= yFor(0) + TOLERANCE);
});

test("percent-stacked bars fill the full plot height with category shares", () => {
  const plot = { x: 40, y: 20, w: 300, h: 200 };
  const markup = paintStackedBarsSvg({
    plot,
    orientation: "vertical",
    grouping: "percentStacked",
    categories: ["A", "B"],
    series: [
      { name: "a", values: [1, 3], kind: "bar" },
      { name: "b", values: [3, 1], kind: "bar" },
    ],
    scale: { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], tickDecimals: 2 },
    focusRow: -1,
    showLabels: true,
    ink: INK,
    gridColor: GRID,
    fonts: FONTS,
    formatTick: (t) => `${Math.round(t * 100)}%`,
    valueText: String,
    categoryY: 240,
    paint: (s) => (s === 0 ? "#D97757" : "#467343"),
  });
  const host = mount(markup);
  for (const category of [0, 1]) {
    const segments = [...host.querySelectorAll(`rect[data-chart-segment][data-category="${category}"]`)];
    assert.equal(segments.length, 2);
    const heights = segments.map((node) => Number(node.getAttribute("height")));
    near(
      heights.reduce((sum, value) => sum + value, 0),
      plot.h,
      `category ${category} full height`,
    );
    const top = Math.min(...segments.map((node) => Number(node.getAttribute("y"))));
    near(top, plot.y, `category ${category} top`);
  }
  assert.match(host.textContent, /25%/);
  assert.match(host.textContent, /75%/);
});

test("stacked horizontal bars extend from zero to the stacked total", () => {
  const plot = { x: 100, y: 20, w: 260, h: 200 };
  const scale = { min: 0, max: 15, ticks: [0, 5, 10, 15], tickDecimals: 0 };
  /** @param {number} v */
  const xFor = (v) => plot.x + (v / 15) * plot.w;
  const markup = paintStackedBarsSvg({
    plot,
    orientation: "horizontal",
    grouping: "stacked",
    categories: ["A", "B"],
    series: [
      { name: "a", values: [10, 4], kind: "bar" },
      { name: "b", values: [5, 6], kind: "bar" },
    ],
    scale,
    focusRow: 0,
    showLabels: false,
    ink: INK,
    gridColor: GRID,
    fonts: FONTS,
    formatTick: String,
    valueText: String,
    categoryY: 240,
    paint: (s) => (s === 0 ? "#D97757" : "#467343"),
  });
  const host = mount(markup);
  const first = must(host.querySelector('rect[data-chart-segment][data-category="0"][data-series="0"]'));
  const second = must(host.querySelector('rect[data-chart-segment][data-category="0"][data-series="1"]'));
  near(Number(first.getAttribute("x")), xFor(0), "a starts at zero");
  near(Number(first.getAttribute("x")) + Number(first.getAttribute("width")), xFor(10), "a ends at 10");
  near(Number(second.getAttribute("x")), xFor(10), "b starts where a ends");
  near(Number(second.getAttribute("x")) + Number(second.getAttribute("width")), xFor(15), "b ends at 15");
  assert.match(first.outerHTML, /stroke="#2f86f0"/);
});

test("stacked combo draws line-kind series as polylines on the bar scale", () => {
  const plot = { x: 40, y: 20, w: 300, h: 200 };
  const scale = { min: 0, max: 15, ticks: [0, 5, 10, 15], tickDecimals: 0 };
  /** @param {number} v */
  const yFor = (v) => plot.y + plot.h - (v / 15) * plot.h;
  const markup = paintStackedBarsSvg({
    plot,
    orientation: "vertical",
    grouping: "stacked",
    categories: ["A", "B"],
    series: [
      { name: "bar", values: [10, 4], kind: "bar" },
      { name: "line", values: [12, 3], kind: "line" },
    ],
    scale,
    focusRow: -1,
    showLabels: false,
    ink: INK,
    gridColor: GRID,
    fonts: FONTS,
    formatTick: String,
    valueText: String,
    categoryY: 240,
    paint: (s) => (s === 0 ? "#D97757" : "#467343"),
  });
  const host = mount(markup);
  assert.equal(host.querySelectorAll("rect[data-chart-segment]").length, 2);
  const line = host.querySelector("polyline[data-chart-line]");
  assert.ok(line, "line series polyline");
  assert.equal(line.getAttribute("stroke-width"), "3");
  const pts = points(line);
  near(pts[0][1], yFor(12), "line point 0 on bar scale");
  near(pts[1][1], yFor(3), "line point 1 on bar scale");
  assert.equal(host.querySelectorAll("circle").length, 2);
});

test("doughnut slices are annular sectors with a 50 percent hole and share-based spans", () => {
  const plot = { x: 10, y: 10, w: 240, h: 200 };
  const markup = paintDoughnutSvg({
    plot,
    categories: ["A", "B", "C"],
    values: [1, 2, 1],
    paints: ["#D97757", "#467343", "#2563EB"],
    ink: INK,
    showLabels: true,
    fonts: FONTS,
  });
  assert.doesNotMatch(markup, /NaN|Infinity/);
  const host = mount(markup);
  const slices = [...host.querySelectorAll("path[data-chart-slice]")];
  assert.equal(slices.length, 3);
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const outerRadius = Math.min(plot.w, plot.h) / 2;
  /** @param {number} x @param {number} y */
  const angleOf = (x, y) => (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
  const shares = [0.25, 0.5, 0.25];
  slices.forEach((node, index) => {
    const n = numbersIn(node.getAttribute("d"));
    const outerStart = /** @type {[number, number]} */ ([n[0], n[1]]);
    const outerEnd = /** @type {[number, number]} */ ([n[7], n[8]]);
    const innerEnd = [n[9], n[10]];
    const outer = Math.hypot(outerStart[0] - cx, outerStart[1] - cy);
    const inner = Math.hypot(innerEnd[0] - cx, innerEnd[1] - cy);
    near(outer, outerRadius, `slice ${index} outer radius`);
    near(inner / outer, 0.5, `slice ${index} inner ratio`, 0.01);
    assert.ok(inner > 0);
    const span = (((angleOf(...outerEnd) - angleOf(...outerStart)) % 360) + 360) % 360;
    near(span, shares[index] * 360, `slice ${index} span degrees`, 1);
  });
  assert.match(host.textContent, /A 25%/);
  assert.match(host.textContent, /B 50%/);
});

test("gradient series fill references a linear gradient in defs with stop opacity", () => {
  const series = [
    {
      type: "bar",
      name: "Count",
      fill: {
        type: "gradient",
        gradientType: "linear",
        angle: 90,
        stops: [
          { position: 0, color: "#D97757" },
          { position: 1, color: "#467343", alpha: 0.5 },
        ],
      },
    },
  ];
  const plan = chartFillPlan("chart-1", series);
  const paint = plan.paintFor(0);
  const match = /^url\(#([A-Za-z][\w-]*)\)$/.exec(paint ?? "");
  assert.ok(match, `url paint ${paint}`);
  const defs = plan.defs;
  assert.match(defs, new RegExp(`<linearGradient id="${match[1]}"`));
  assert.match(defs, /<stop offset="0%" stop-color="#D97757" stop-opacity="1"\/>/);
  assert.match(defs, /<stop offset="100%" stop-color="#467343" stop-opacity="0.5"\/>/);

  const markup = paintStackedBarsSvg({
    plot: { x: 40, y: 20, w: 300, h: 200 },
    orientation: "vertical",
    grouping: "stacked",
    categories: ["A"],
    series: [{ name: "Count", values: [10], kind: "bar" }],
    scale: { min: 0, max: 10, ticks: [0, 10], tickDecimals: 0 },
    focusRow: -1,
    showLabels: false,
    ink: INK,
    gridColor: GRID,
    fonts: FONTS,
    formatTick: String,
    valueText: String,
    categoryY: 240,
    paint: (s) => plan.paintFor(s) ?? "#2563EB",
  });
  const bar = must(mount(markup).querySelector("rect[data-chart-segment]"));
  assert.equal(bar.getAttribute("fill"), `url(#${match[1]})`);

  const svg = injectChartDefs(`<svg viewBox="0 0 10 10"><rect/></svg>`, defs);
  assert.match(svg, /^<svg viewBox="0 0 10 10"><defs><linearGradient /);
});

test("radial gradients and string fills are handled", () => {
  const radial = chartFillPlan("chart-2", [
    {
      type: "bar",
      fill: {
        type: "gradient",
        gradientType: "radial",
        stops: [
          { position: 0, color: "#111111" },
          { position: 1, color: "#EEEEEE" },
        ],
      },
    },
  ]);
  assert.match(radial.defs, /<radialGradient id="/);
  const solid = chartFillPlan("chart-3", [{ type: "bar", fill: "#D97757" }]);
  assert.equal(solid.defs, "");
  assert.equal(solid.paintFor(0), undefined);
});

test("area fills use a colour alpha suffix for solid colours and opacity for gradients", () => {
  assert.equal(areaFillAttributes("#D97757", "55"), 'fill="#D9775755"');
  assert.equal(areaFillAttributes("url(#chart-grad-abc)", "33"), 'fill="url(#chart-grad-abc)" fill-opacity="0.2"');
});
