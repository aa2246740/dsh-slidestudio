import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHART_TEXT_PX, measureChartText } from "@open-slidestudio/pptd-v2";
import { chart, exportChartParts } from "./export-chart-support.js";

function labelFlagsOn(xml: string): string[] {
  return (xml.match(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g) ?? []).flatMap((block) =>
    [
      ...block.matchAll(/<c:(showLegendKey|showVal|showCatName|showSerName|showPercent|showBubbleSize) val="1"\/>/g),
    ].map((match) => match[1]!),
  );
}

describe("export-native: data labels follow labels:false in the final chart XML", () => {
  it("exports a doughnut saved with labels:false with no visible data label", async () => {
    const [doughnut] = await exportChartParts([
      chart("doughnut-off", [{ type: "doughnut", name: "甲", encode: { x: "类别", y: "甲" } }], {
        labels: false,
      }),
    ]);
    assert.match(doughnut!, /<c:doughnutChart>/);
    assert.deepEqual(labelFlagsOn(doughnut!), []);
  });

  it("keeps the category and percent labels of a doughnut with labels on", async () => {
    const [doughnut] = await exportChartParts([
      chart("doughnut-on", [{ type: "doughnut", name: "甲", encode: { x: "类别", y: "甲" } }]),
    ]);
    const flags = labelFlagsOn(doughnut!);
    assert.ok(flags.includes("showCatName"), `category label on: ${flags}`);
    assert.ok(flags.includes("showPercent"), `percent label on: ${flags}`);
    assert.ok(!flags.includes("showVal"), `value label stays off: ${flags}`);
  });

  it("writes a labelled pie as the editor paints it: category and percent, never the value", async () => {
    const [pie] = await exportChartParts([
      chart("pie-on", [{ type: "pie", name: "甲", encode: { x: "类别", y: "甲" } }]),
    ]);
    const flags = labelFlagsOn(pie!);
    assert.ok(flags.includes("showCatName"), `category label on: ${flags}`);
    assert.ok(flags.includes("showPercent"), `percent label on: ${flags}`);
    assert.ok(!flags.includes("showVal"), `value label stays off: ${flags}`);
    // `c:separator` is element text. The space between the name and the percent is the text of
    // each point's `c:dLbl` and of the series `c:dLbls`, with no `val` attribute.
    const pointLabels = pie!.match(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g) ?? [];
    const seriesLabels = (pie!.match(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g) ?? []).map((block) =>
      block.replace(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g, ""),
    );
    const separatorsOf = (blocks: string[]) =>
      blocks.flatMap((block) =>
        [...block.matchAll(/<c:separator(\s[^>]*?)?(?:\/>|>([^<]*)<\/c:separator>)/g)].map((match) => ({
          attributes: match[1] ?? "",
          text: match[2],
        })),
      );
    const pointSeparators = separatorsOf(pointLabels);
    const seriesSeparators = separatorsOf(seriesLabels);
    assert.equal(pointSeparators.length, 3, "each point label has a separator");
    assert.equal(seriesSeparators.length, 1, "the series label has a separator");
    for (const separator of [...pointSeparators, ...seriesSeparators]) {
      assert.deepEqual(
        separator,
        { attributes: "", text: " " },
        "the name and percent share one space as element text",
      );
    }
    // The editor shows whole percentages ("name 25%"); a value format would print "0".
    const formats = (pie!.match(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g) ?? []).flatMap((block) =>
      [...block.matchAll(/<c:numFmt formatCode="([^"]*)"/g)].map((match) => match[1]),
    );
    assert.ok(formats.length > 0, "the pie writes its label format");
    assert.deepEqual([...new Set(formats)], ["0%"], `label format: ${formats}`);
  });

  it("hides the data labels of every other categorical kind saved with labels:false", async () => {
    const elements = [
      chart("pie-off", [{ type: "pie", name: "甲", encode: { x: "类别", y: "甲" } }], {
        labels: false,
      }),
      chart("bar-off", [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" } }], {
        labels: false,
      }),
      chart("stacked-off", [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" } }], {
        grouping: "stacked",
        labels: false,
      }),
      chart("percent-off", [{ type: "bar", name: "甲", encode: { x: "类别", y: "甲" } }], {
        grouping: "percentStacked",
        labels: false,
      }),
      chart(
        "combo-off",
        [
          { type: "bar", name: "甲", encode: { x: "类别", y: "甲" } },
          { type: "line", name: "乙", encode: { x: "类别", y: "乙" } },
        ],
        { grouping: "stacked", labels: false },
      ),
      chart("line-off", [{ type: "line", name: "乙", encode: { x: "类别", y: "乙" } }], {
        labels: false,
      }),
      chart("area-off", [{ type: "area", name: "甲", encode: { x: "类别", y: "甲" } }], {
        labels: false,
      }),
      chart("radar-off", [{ type: "radar", encode: { x: "类别" } }], { labels: false }),
    ];
    const parts = await exportChartParts(elements);
    for (const [index, element] of elements.entries()) {
      assert.deepEqual(labelFlagsOn(parts[index]!), [], `${element.elementId} shows no label`);
    }
  });
});

describe("export-native: the percent axis reserves room for its widest label", () => {
  it("keeps the plot clear of a -100% tick label on a percent-stacked bar with a negative share", async () => {
    const [xml] = await exportChartParts([
      chart(
        "percent-negative",
        [
          { type: "bar", name: "甲", encode: { x: "类别", y: "甲" } },
          { type: "bar", name: "乙", encode: { x: "类别", y: "乙" } },
        ],
        { grouping: "percentStacked" },
        {
          cols: ["类别", "甲", "乙"],
          rows: [
            ["一月", -25, 75],
            ["二月", 40, 60],
          ],
        },
      ),
    ]);
    // The helper's chart is 420 px wide, and the plot's manual x is a fraction of that width.
    const plotX = /<c:plotArea><c:layout>[\s\S]*?<c:x val="([\d.]+)"/.exec(xml!)?.[1];
    assert.ok(plotX, "the plot area has a manual layout");
    const reserved = Number(plotX) * 420;
    const needed = measureChartText("-100%", CHART_TEXT_PX.tick) + 8;
    assert.ok(
      reserved >= needed,
      `the plot starts at ${reserved.toFixed(1)} px; the -100% label needs ${needed.toFixed(1)} px`,
    );
  });
});
