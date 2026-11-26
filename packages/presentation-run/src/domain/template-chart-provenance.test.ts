import assert from "node:assert/strict";
import { it } from "node:test";
import { detectMaterialFigures, materialFiguresHint, pageChartsForFigures } from "./material-figures.js";
import {
  chartSubstitutionsForPage,
  matchTemplateChartFigures,
  type TemplateChartSource,
} from "./template-chart-provenance.js";

const readings = [
  {
    materialId: "synthetic-template",
    materialName: "synthetic.pptx",
    pages: [],
    templateCharts: [
      {
        sourcePage: 9,
        chartId: "capacity",
        title: "2031年4月能力指标",
        type: "radar",
        categories: ["触达", "留存", "响应"],
        series: [{ name: "实测", categories: ["触达", "留存", "响应"], values: [17, 23, 31] }],
        sourcePeriods: ["2031年4月"],
      },
    ],
  },
];

function chart(categories: readonly string[], values = [17, 23, 31]) {
  return pageChartsForFigures({
    elements: [
      {
        elementType: "chart",
        data: {
          cols: ["类别", "实测"],
          rows: categories.map((category, i) => [category, values[i]]),
        },
        series: [{ type: "bar", encode: { x: "类别", y: "实测" } }],
      },
    ],
  });
}

it("attributes an exact copied numeric series even after its categories and period change", () => {
  const report = detectMaterialFigures({
    pageText: "2031年5月指标",
    pageCharts: chart(["区域甲", "区域乙", "区域丙"]),
    readings,
  });
  assert.deepEqual(
    report.matches.map((match) => [match.value, match.sourcePage]),
    [
      ["17", 9],
      ["23", 9],
      ["31", 9],
    ],
  );
  assert.deepEqual(chartSubstitutionsForPage(report.matches), []);
  const hint = materialFiguresHint(report, readings);
  assert.match(hint ?? "", /类别.*不同.*恢复.*类别.*顺序/);
  assert.match(hint ?? "", /2031年4月.*2031年5月/);
});

it("does not invent a substitution for an unread, omitted or unrelated radar series", () => {
  for (const input of [
    { pageCharts: [], readings },
    { pageCharts: chart(["触达", "留存", "响应"], [19, 29, 37]), readings },
    { pageCharts: chart(["触达", "留存", "响应"]), readings: [] },
  ]) {
    const report = detectMaterialFigures({ pageText: "2031年4月", ...input });
    assert.deepEqual(report.matches, []);
    assert.deepEqual(chartSubstitutionsForPage(report.matches), []);
  }
  const represented = detectMaterialFigures({
    pageText: "2031年4月",
    pageCharts: chart(["触达", "留存", "响应"]),
    readings,
  });
  assert.deepEqual(chartSubstitutionsForPage(represented.matches), [
    { sourcePage: 9, sourceType: "radar", targetType: "bar" },
  ]);
});

it("attributes a reused series in a mixed chart without claiming the whole source chart was substituted", () => {
  const pageCharts = pageChartsForFigures({
    elements: [
      {
        elementType: "chart",
        data: {
          cols: ["类别", "实测", "新数据"],
          rows: [
            ["触达", 17, 19],
            ["留存", 23, 29],
            ["响应", 31, 37],
          ],
        },
        series: [
          { type: "bar", encode: { x: "类别", y: "实测" } },
          { type: "line", encode: { x: "类别", y: "新数据" } },
        ],
      },
    ],
  });
  const report = detectMaterialFigures({ pageText: "2031年4月", pageCharts, readings });
  assert.deepEqual(
    report.matches.map((match) => match.value),
    ["17", "23", "31"],
  );
  assert.deepEqual(chartSubstitutionsForPage(report.matches), []);
});

const precisionCategories = ["甲", "乙", "丙", "丁", "戊"];
const precisionSource = {
  sourcePage: 7,
  chartId: "synthetic-precision",
  title: "合成指标",
  type: "radar",
  categories: precisionCategories,
  series: [
    {
      name: "基准",
      categories: precisionCategories,
      values: [1.2345678901234, 2.3456789012345, 3.4567890123456, 4.5678901234567, 5.6789012345678],
      numFmt: "0.00",
    },
    {
      name: "实测",
      categories: precisionCategories,
      values: [6.7890123456789, 7.8901234567891, 8.9012345678912, 9.0123456789123, 1.1234567891234],
      numFmt: "0.00",
    },
  ],
  sourcePeriods: [],
};

function precisionChart(
  values = [
    [1.23, 2.35, 3.46, 4.57, 5.68],
    [6.79, 7.89, 8.9, 9.01, 1.12],
  ],
  categories = precisionCategories,
) {
  return pageChartsForFigures({
    elements: [
      {
        elementType: "chart",
        data: {
          cols: ["类别", "基准", "实测"],
          rows: categories.map((category, i) => [category, ...values.map((series) => series[i])]),
        },
        series: values.map((_, i) => ({
          type: "bar",
          encode: { x: "类别", y: i === 0 ? "基准" : "实测" },
        })),
      },
    ],
  });
}

it("attributes both five-category radar series at their displayed two-decimal precision", () => {
  const [match] = matchTemplateChartFigures(precisionChart(), [precisionSource]);
  assert.ok(match);
  assert.equal(match.valueMatch, "displayed");
  assert.deepEqual(match.substitution, { sourceType: "radar", targetType: "bar" });
  const report = detectMaterialFigures({
    pageText: "",
    pageCharts: precisionChart(),
    readings: [
      {
        materialId: "synthetic-precision",
        materialName: "synthetic.pptx",
        pages: [],
        templateCharts: [precisionSource],
      },
    ],
  });
  assert.equal(report.matches.length, 10);
  assert.ok(report.matches.every((item) => item.chart?.valueMatch === "displayed"));
  assert.deepEqual(chartSubstitutionsForPage(report.matches), [
    { sourcePage: 7, sourceType: "radar", targetType: "bar" },
  ]);
});

it("does not claim a substitution for coarser, altered, incomplete or relabelled series", () => {
  const normal = [
    [1.23, 2.35, 3.46, 4.57, 5.68],
    [6.79, 7.89, 8.9, 9.01, 1.12],
  ];
  for (const [label, pageCharts] of [
    [
      "one decimal",
      precisionChart([
        [1.2, 2.3, 3.5, 4.6, 5.7],
        [6.8, 7.9, 8.9, 9, 1.1],
      ]),
    ],
    ["off by 0.01", precisionChart([[1.24, 2.35, 3.46, 4.57, 5.68], normal[1]!])],
    ["excess precision", precisionChart([[1.231, 2.35, 3.46, 4.57, 5.68], normal[1]!])],
    ["missing series", precisionChart([normal[0]!])],
    ["extra series", precisionChart([...normal, normal[1]!])],
    ["reordered categories", precisionChart(normal, ["乙", "甲", "丙", "丁", "戊"])],
  ] as const) {
    const matches = matchTemplateChartFigures(pageCharts, [precisionSource]);
    assert.ok(
      matches.every((match) => match.substitution === undefined),
      label,
    );
  }
});

it("requires a parseable source number format for rounded values, but not exact values", () => {
  for (const numFmt of [undefined, "", "General", "0.0E+00", '"0.00"', '0.00"unfinished']) {
    const source: TemplateChartSource = {
      ...precisionSource,
      series: precisionSource.series.map((series) => ({ ...series, numFmt })),
    };
    assert.deepEqual(matchTemplateChartFigures(precisionChart(), [source]), [], String(numFmt));
    const [exact] = matchTemplateChartFigures(precisionChart(precisionSource.series.map((series) => series.values)), [
      source,
    ]);
    assert.equal(exact?.valueMatch, "exact");
    assert.deepEqual(exact?.substitution, { sourceType: "radar", targetType: "bar" });
  }
});

it("reads only the first format section and ignores quoted decimals, percent signs and separators", () => {
  for (const numFmt of ['0.0#".000%;literal";0.0000', '"prefix;"0.00;0.0', '#,##0.00" units"']) {
    const source = {
      ...precisionSource,
      series: precisionSource.series.map((series) => ({ ...series, numFmt })),
    };
    assert.equal(matchTemplateChartFigures(precisionChart(), [source])[0]?.valueMatch, "displayed");
  }
});

it("parses displayed precision with bracketed locale and color metadata", () => {
  for (const numFmt of ["[$-804]#,##0.00", "[Red]0.00;[Blue]-0.00"]) {
    const source = {
      ...precisionSource,
      series: precisionSource.series.map((series) => ({ ...series, numFmt })),
    };
    assert.equal(matchTemplateChartFigures(precisionChart(), [source])[0]?.valueMatch, "displayed", numFmt);
  }
});

it("compares percent formats in displayed percentage points", () => {
  const source = {
    ...precisionSource,
    categories: ["甲"],
    series: [{ name: "比例", categories: ["甲"], values: [0.1234], numFmt: "0.0%" }],
  };
  const [match] = matchTemplateChartFigures(precisionChart([[12.3]], ["甲"]), [source]);
  assert.equal(match?.valueMatch, "displayed");
  assert.deepEqual(match?.substitution, { sourceType: "radar", targetType: "bar" });
  assert.deepEqual(matchTemplateChartFigures(precisionChart([[12.34]], ["甲"]), [source]), []);
});

it("keeps stacked and percent-stacked reuse undisclosed only when the output keeps the grouping", () => {
  const categories = ["甲", "乙", "丙"];
  const values = [17, 23, 31];
  const source = (type: string, grouping?: string): TemplateChartSource => ({
    sourcePage: 5,
    chartId: `synthetic-${type}-${grouping ?? "plain"}`,
    title: "合成堆积",
    type,
    ...(grouping ? { grouping } : {}),
    categories,
    series: [{ name: "实测", categories, values }],
    sourcePeriods: [],
  });
  const output = (grouping?: string) =>
    pageChartsForFigures({
      elements: [
        {
          elementType: "chart",
          ...(grouping ? { grouping } : {}),
          data: {
            cols: ["类别", "实测"],
            rows: categories.map((category, i) => [category, values[i]]),
          },
          series: [{ type: "bar", encode: { x: "类别", y: "实测" } }],
        },
      ],
    });
  for (const grouping of ["stacked", "percentStacked"]) {
    const report = detectMaterialFigures({
      pageText: "",
      pageCharts: output(grouping),
      readings: [
        {
          materialId: "synthetic-stacked",
          materialName: "synthetic.pptx",
          pages: [],
          templateCharts: [source("bar", grouping)],
        },
      ],
    });
    assert.equal(report.matches.length, 3, grouping);
    assert.deepEqual(chartSubstitutionsForPage(report.matches), [], grouping);
    const [flattened] = matchTemplateChartFigures(output(), [source("bar", grouping)]);
    assert.deepEqual(flattened?.substitution, { sourceType: grouping, targetType: "bar" }, grouping);
  }
  const [radarAsStacked] = matchTemplateChartFigures(output("stacked"), [source("radar")]);
  assert.deepEqual(radarAsStacked?.substitution, { sourceType: "radar", targetType: "stacked" });
});
