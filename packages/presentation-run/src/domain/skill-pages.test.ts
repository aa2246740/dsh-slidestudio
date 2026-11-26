import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillPage } from "./skill-pages.js";

describe("OpenKimi nested chart dialect", () => {
  it("persists chart.rows without cols instead of silently dropping the figure", () => {
    const page = parseSkillPage({
      id: "market",
      pageType: "content",
      elements: [
        {
          elementType: "chart",
          bounds: [600, 212, 320, 240],
          chart: {
            type: "bar",
            rows: [
              ["2024", 181],
              ["2028E", 483],
            ],
            encode: { x: "年份", y: "规模" },
            series: [{ type: "bar", fill: "#007ACC" }],
          },
        },
      ],
    });
    const chart = page?.elements.find((el) => el.elementType === "chart") as
      | {
          elementType: "chart";
          data: { cols: string[]; rows: unknown[] };
          series: Array<{ type?: string }>;
        }
      | undefined;
    assert.equal(chart?.elementType, "chart");
    assert.deepEqual(chart?.data.cols, ["年份", "规模"]);
    assert.equal(chart?.data.rows.length, 2);
    assert.equal(chart?.series[0]?.type, "bar");
  });
});

describe("canonical write_page text style", () => {
  it("merges sibling style into PPTD text content without overriding content fields", () => {
    const page = parseSkillPage({
      id: "1_cover",
      pageType: "cover",
      elements: [
        {
          elementId: "cover_title",
          elementType: "text",
          bounds: [72, 80, 816, 52],
          content: {
            text: "資本支出收到 600–640 億，是產能不夠。",
            color: "#FFFFFF",
          },
          style: {
            color: "#F4ECDD",
            fontSize: 40,
            fontFamily: { latin: "Unna", ea: "Noto Serif CJK TC" },
            bold: false,
            lineHeight: 1.18,
            letterSpacing: 0.5,
            align: '["right","middle"]',
            wrap: false,
          },
        },
      ],
    });
    const title = page?.elements[0];
    assert.equal(title?.elementType, "text");
    if (title?.elementType !== "text") assert.fail("text element was not parsed");
    assert.deepEqual(title.content, {
      text: "資本支出收到 600–640 億，是產能不夠。",
      wrap: false,
      bold: false,
      fontSize: 40,
      color: "#FFFFFF",
      fontFamily: { latin: "Unna", ea: "Noto Serif CJK TC" },
      lineHeight: 1.18,
      letterSpacing: 0.5,
      align: ["right", "middle"],
    });
  });

  it("preserves finite numeric text from canonical payloads", () => {
    const page = parseSkillPage({
      id: "10_risk",
      elements: [
        {
          elementId: "p10_r1_num",
          elementType: "text",
          bounds: [72, 158, 28, 28],
          content: { text: 1 },
          style: {
            color: "#A95228",
            fontSize: 22,
            fontFamily: { latin: "Unna", ea: "Noto Serif CJK TC" },
          },
        },
      ],
    });
    assert.ok(page);
    const number = page.elements[0] as
      { elementType?: string; content?: { text?: string; color?: string; fontSize?: number } } | undefined;
    assert.equal(number?.elementType, "text");
    assert.equal(number?.content?.text, "1");
    assert.equal(number?.content?.color, "#A95228");
    assert.equal(number?.content?.fontSize, 22);
  });
});
