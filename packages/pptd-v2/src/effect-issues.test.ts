import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalFillIssues, canonicalWritePageIssues } from "./write-page-schema.js";

const CJK = /[\u4e00-\u9fff]/;

const base = (elementId: string, elementType: string, extra: Record<string, unknown>) => ({
  elementId,
  elementType,
  bounds: [40, 40, 240, 120],
  ...extra,
});

const rect = (elementId: string, extra: Record<string, unknown> = {}) =>
  base(elementId, "shape", {
    shapeName: "rect",
    fill: { type: "solid", color: "#2563EB" },
    ...extra,
  });

const gradient = (stops: Record<string, unknown>[]) => ({
  type: "gradient",
  gradientType: "linear",
  angle: 90,
  stops,
});

/** Two stops; the first carries `alpha` when one is given. */
const twoStops = (alpha?: number) => [
  { position: 0, color: "#FFF4F4", ...(alpha === undefined ? {} : { alpha }) },
  { position: 1, color: "#C00000" },
];

test("accepts the M5 shadow opacity and gradient stop alpha on elements and the page", () => {
  const args = {
    id: "m5-effects",
    background: gradient(twoStops(0.5)),
    elements: [
      rect("shadowed", {
        shadow: { blur: 8, color: "#000000", offsetX: 3, offsetY: 3, opacity: 0.35 },
      }),
      rect("alpha-fill", { fill: gradient(twoStops(0.2)) }),
    ],
  };
  assert.deepEqual(canonicalWritePageIssues(args), []);
});

test("refuses a negative shadow blur in Chinese and names the element", () => {
  const issues = canonicalWritePageIssues({
    id: "shadow-page",
    elements: [rect("blur-negative", { shadow: { blur: -1 } })],
  });
  assert.ok(
    issues.some((issue) => issue.includes('elementId "blur-negative"') && issue.includes("blur") && CJK.test(issue)),
    issues.join("\n"),
  );
});

test("refuses a shadow opacity outside 0 to 1 in Chinese and names the element", () => {
  for (const opacity of [1.5, -0.1]) {
    const issues = canonicalWritePageIssues({
      id: "shadow-page",
      elements: [rect("opacity-out", { shadow: { opacity } })],
    });
    assert.ok(
      issues.some((issue) => issue.includes('elementId "opacity-out"') && issue.includes("opacity") && CJK.test(issue)),
      `opacity ${opacity}: ${issues.join("\n")}`,
    );
  }
});

test("refuses a non-finite shadow offset in Chinese, so NaN never reaches the saved file", () => {
  for (const key of ["offsetX", "offsetY"]) {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const issues = canonicalWritePageIssues({
        id: "shadow-page",
        elements: [rect("offset-bad", { shadow: { [key]: value } })],
      });
      assert.ok(
        issues.some((issue) => issue.includes('elementId "offset-bad"') && issue.includes(key) && CJK.test(issue)),
        `${key} ${value}: ${issues.join("\n")}`,
      );
    }
  }
});

test("refuses a gradient stop alpha outside 0 to 1 on every filled surface", () => {
  const bad = twoStops(1.2);
  const chartData = { cols: ["季度", "营收"], rows: [["Q1", 12]] };
  const args = {
    id: "alpha-page",
    background: gradient(bad),
    elements: [
      rect("shape-fill", { fill: gradient(bad) }),
      base("table-cell", "table", {
        columnWidths: [240],
        rows: [[{ text: "合计", fill: gradient(bad) }]],
      }),
      base("chart-series", "chart", {
        data: chartData,
        series: [{ type: "bar", fill: gradient(bad) }],
      }),
      base("chart-surface", "chart", {
        data: chartData,
        series: [{ type: "bar" }],
        background: gradient(bad),
      }),
      base("icon-fill", "icon", { iconName: "star", fill: gradient(bad) }),
    ],
  };
  const issues = canonicalWritePageIssues(args);
  for (const id of ["shape-fill", "table-cell", "chart-series", "chart-surface", "icon-fill"]) {
    assert.ok(
      issues.some((issue) => issue.includes(`elementId "${id}"`) && issue.includes("alpha") && CJK.test(issue)),
      `${id}: ${issues.join("\n")}`,
    );
  }
  assert.ok(
    issues.some((issue) => issue.startsWith("$.background") && issue.includes("alpha") && CJK.test(issue)),
    issues.join("\n"),
  );
});

test("refuses an out-of-range gradient stop alpha on a single fill edit", () => {
  const issues = canonicalFillIssues(gradient(twoStops(-0.5)));
  assert.ok(
    issues.some((issue) => issue.includes("alpha") && CJK.test(issue)),
    issues.join("\n"),
  );
  assert.deepEqual(canonicalFillIssues(gradient(twoStops(0.5))), []);
});
