import assert from "node:assert/strict";
import test from "node:test";
import { canonicalWritePageIssues, type TextElement } from "@open-slidestudio/pptd-v2";
import { parseSkillPage } from "./skill-pages.js";

test("canonical generation preserves all seven native element kinds without dialect conversion", () => {
  const base = {
    bounds: [24, 36, 300, 120],
    rotation: 15,
    opacity: 0.8,
    flipH: true,
    flipV: false,
    locked: true,
    hidden: false,
    groupId: "group-a",
    shadow: { blur: 2, color: "#123456", offsetX: 1, offsetY: 3 },
    layoutRole: "content",
    exhibitRole: "comparison-card",
    smartArt: { id: "process-a", layout: "process", role: "node", index: 0, pinned: true },
  };
  const fill = { type: "solid", color: "#112233" };
  const border = { style: "solid", width: 2, color: "#223344" };
  const elements = [
    {
      ...base,
      elementId: "text",
      elementType: "text",
      content: {
        text: "  勾股定理  ",
        style: "$title",
        fontSize: 50,
        color: "#5C4630",
        fontFamily: { latin: "Inter", ea: "MiSans" },
        bold: false,
        italic: true,
        underline: true,
        backgroundColor: "#FFFFFF",
        lineHeight: 1.2,
        letterSpacing: 0.5,
        align: ["center", "middle"],
        wrap: false,
        list: "bullet",
        href: "https://example.com/",
      },
    },
    {
      ...base,
      elementId: "shape",
      elementType: "shape",
      shapeName: "roundRect",
      fill,
      border,
      adjustments: [0.2],
    },
    {
      ...base,
      elementId: "image",
      elementType: "image",
      src: "media/a.png",
      fit: { mode: "cover" },
      crop: { left: 0.1, top: 0.2, right: 0.1, bottom: 0.2 },
      cropShape: { shapeName: "ellipse", adjustments: [0.3] },
    },
    {
      ...base,
      elementId: "table",
      elementType: "table",
      columnWidths: [300],
      rowHeights: [120],
      rows: [
        [
          {
            text: "3×3",
            bold: true,
            color: "#223344",
            fill,
            align: ["right", "middle"],
            rowSpan: 1,
            colSpan: 1,
          },
        ],
      ],
    },
    {
      ...base,
      elementId: "chart",
      elementType: "chart",
      data: {
        cols: ["category", "value"],
        rows: [
          ["A", 9],
          ["B", null],
        ],
      },
      series: [
        {
          type: "bar",
          name: "Area",
          encode: { item: "category", y: "value" },
          fill: "#112233",
          axis: "secondary",
        },
      ],
      colors: ["#112233"],
      background: fill,
      title: { text: "Areas" },
      legend: { position: "bottom" },
      labels: true,
      axis: { x: "category", y: "area", secondaryY: "other" },
    },
    { ...base, elementId: "icon", elementType: "icon", iconName: "check", fill },
    {
      ...base,
      elementId: "line",
      elementType: "line",
      viewBox: [300, 120],
      points: "M0 0 L300 120",
      border,
      curve: "straight",
      arrow: [null, "stealth"],
      connects: ["shape", "text"],
      label: "equals",
    },
  ];
  const input = {
    id: "native-page",
    pageType: "content",
    elements,
    notes: "  Speaker notes\n",
    background: {
      type: "image",
      src: "media/background.png",
      fit: { mode: "cover" },
      opacity: 0.6,
    },
    animations: [
      {
        elementId: "text",
        effect: "fade-in",
        trigger: "onClick",
        direction: "up",
        durationMs: 400,
        delayMs: 50,
      },
    ],
  };
  assert.deepEqual(canonicalWritePageIssues(input), []);
  const page = parseSkillPage(input);
  assert.ok(page);
  assert.deepEqual(page, input);
  // Later layout work must not mutate the caller's validated request object.
  page.elements[0]!.bounds[0] = 99;
  assert.equal(elements[0]!.bounds[0], 24);
  page.animations![0]!.durationMs = 700;
  assert.equal(input.animations[0]!.durationMs, 400);
});

test("canonical fidelity path leaves legacy page conversion available", () => {
  const page = parseSkillPage({
    id: "legacy",
    elements: [{ type: "text", x: 24, y: 36, width: 300, height: 120, text: "Legacy", fontSize: 40 }],
  });
  assert.ok(page);
  assert.equal(page.elements[0]?.elementType, "text");
  assert.equal((page.elements[0] as TextElement).content.fontSize, 40);
});
