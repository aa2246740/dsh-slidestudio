import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewSkillPages } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";
import type { TodoExhibitContract } from "./layout-qa.js";
import type { ChartElement } from "@open-slidestudio/pptd-v2";

describe("layout QA — measurable taste gates", () => {
  const frame = (target: SkillPageInput): SkillPageInput[] => [
    {
      id: "cover",
      pageType: "cover",
      elements: [
        {
          elementId: "cover-title",
          elementType: "text",
          bounds: [80, 200, 800, 60],
          content: { text: "封面", bold: true, fontSize: 40 },
        },
      ],
    },
    target,
    {
      id: "close",
      pageType: "close",
      elements: [
        {
          elementId: "close-title",
          elementType: "text",
          bounds: [80, 200, 800, 60],
          content: { text: "谢谢", bold: true, fontSize: 40 },
        },
      ],
    },
  ];
  const issuesFor = (target: SkillPageInput, opts?: { tasteGates?: boolean }) =>
    reviewSkillPages(frame(target), { mode: "compose", tasteGates: true, ...opts }).issues.filter(
      (issue) => issue.pageId === target.id,
    );

  const goodBody: SkillPageInput = {
    id: "page-02",
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [60, 40, 700, 44],
        content: { text: "七月经营概览", bold: true, fontSize: 28 },
      },
      {
        elementId: "kicker",
        elementType: "text",
        bounds: [60, 100, 400, 24],
        content: { text: "收入与毛利双升", fontSize: 14 },
      },
      {
        elementId: "panel",
        elementType: "shape",
        shapeName: "rect",
        bounds: [120, 150, 640, 320],
        fill: { type: "solid", color: "#1B6B93" },
      },
    ],
  };

  it("passes a well-scaled, breathing body page", () => {
    assert.deepEqual(issuesFor(goodBody), []);
  });

  it("rejects a 14pt title and 9pt supporting copy", () => {
    const weak: SkillPageInput = {
      id: "page-03",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 40, 700, 30],
          content: { text: "太小的标题", bold: true, fontSize: 14 },
        },
        {
          elementId: "note",
          elementType: "text",
          bounds: [60, 100, 400, 20],
          content: { text: "9pt 的脚注", fontSize: 9 },
        },
      ],
    };
    const issues = issuesFor(weak);
    assert.ok(issues.some((i) => i.code === "weak_title"));
    assert.ok(issues.some((i) => i.code === "tiny_text" && /note/.test(i.message)));
  });

  it("rejects a text wall over the density budget", () => {
    const wall: SkillPageInput = {
      id: "page-04",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 40, 700, 44],
          content: { text: "密度超标", bold: true, fontSize: 28 },
        },
        {
          elementId: "body",
          elementType: "text",
          bounds: [60, 100, 840, 400],
          content: { text: "字".repeat(901), fontSize: 14 },
        },
      ],
    };
    assert.ok(issuesFor(wall).some((i) => i.code === "text_wall"));
  });

  it("rejects a chart pileup and an unreadable chart", () => {
    const chart = (elementId: string, x: number, w: number): ChartElement =>
      ({
        elementId,
        elementType: "chart",
        bounds: [x, 120, w, 300],
        series: [{ type: "bar", fill: "#1B6B93" }],
        data: { cols: ["月份"], rows: [["7月"]] },
      }) as unknown as ChartElement;
    const pileup: SkillPageInput = {
      id: "page-05",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 40, 700, 44],
          content: { text: "图表堆叠", bold: true, fontSize: 28 },
        },
        chart("c1", 20, 280),
        chart("c2", 340, 280),
        chart("c3", 660, 280),
      ],
    };
    assert.ok(issuesFor(pileup).some((i) => i.code === "chart_pileup"));

    const small: SkillPageInput = {
      ...pileup,
      id: "page-06",
      elements: [pileup.elements[0]!, chart("tiny", 20, 120)],
    };
    assert.ok(issuesFor(small).some((i) => i.code === "chart_too_small"));
  });

  it("rejects text clinging to the slide edge", () => {
    const cling: SkillPageInput = {
      id: "page-07",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 40, 700, 44],
          content: { text: "贴边文字", bold: true, fontSize: 28 },
        },
        {
          elementId: "edge",
          elementType: "text",
          bounds: [4, 120, 300, 24],
          content: { text: "贴着左边", fontSize: 14 },
        },
      ],
    };
    assert.ok(issuesFor(cling).some((i) => i.code === "edge_cling" && /edge/.test(i.message)));
  });

  it("holds cover pages to a larger title but skips body-only budgets", () => {
    const cover: SkillPageInput = {
      id: "page-01",
      pageType: "cover",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [80, 200, 800, 60],
          content: { text: "封面标题太小", bold: true, fontSize: 22 },
        },
      ],
    };
    const issues = issuesFor(cover);
    assert.ok(issues.some((i) => i.code === "weak_title"));
    assert.ok(!issues.some((i) => i.code === "tiny_text" || i.code === "overstuffed"));
  });

  it("stays silent when taste gates are off", () => {
    const weak: SkillPageInput = {
      ...goodBody,
      id: "page-08",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 40, 700, 30],
          content: { text: "小标题", bold: true, fontSize: 14 },
        },
      ],
    };
    const issues = reviewSkillPages(frame(weak), { mode: "compose" }).issues;
    assert.ok(!issues.some((i) => i.code === "weak_title"));
  });
});

describe("layout QA — gauge composition gate", () => {
  const gaugeTodo: TodoExhibitContract = { title: "逾期仪表盘", exhibits: ["diagram:gauge"] };

  it("rejects a donut beside a flattened offset ellipse", () => {
    const page: SkillPageInput = {
      id: "page-10",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 40, 700, 44],
          content: { text: "回款健康", bold: true, fontSize: 28 },
        },
        {
          elementId: "g1",
          elementType: "shape",
          exhibitRole: "gauge",
          shapeName: "donut",
          bounds: [752, 158, 80, 80],
          fill: { type: "solid", color: "#1B7F4A" },
        },
        {
          elementId: "g2",
          elementType: "shape",
          exhibitRole: "gauge",
          shapeName: "ellipse",
          bounds: [812, 178, 100, 50],
          fill: { type: "solid", color: "#E8F5EE" },
        },
        {
          elementId: "gt",
          elementType: "text",
          bounds: [760, 250, 160, 30],
          content: { text: "逾期 2.1%", fontSize: 14 },
        },
      ],
    };
    const issues = reviewSkillPages([page], {
      mode: "compose",
      tasteGates: true,
      todos: [gaugeTodo],
    }).issues;
    const gauge = issues.filter((i) => i.code === "broken_gauge");
    assert.ok(gauge.length >= 1, `expected broken_gauge, got ${JSON.stringify(issues.map((i) => i.code))}`);
    assert.ok(gauge.some((i) => /flattened/.test(i.message)));
  });

  it("accepts concentric circular discs", () => {
    const page: SkillPageInput = {
      id: "page-11",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [60, 40, 700, 44],
          content: { text: "回款健康", bold: true, fontSize: 28 },
        },
        {
          elementId: "ring-outer",
          elementType: "shape",
          exhibitRole: "gauge",
          shapeName: "donut",
          bounds: [700, 150, 120, 120],
          fill: { type: "solid", color: "#E5E7EB" },
        },
        {
          elementId: "ring-value",
          elementType: "shape",
          exhibitRole: "gauge",
          shapeName: "arc",
          bounds: [708, 158, 104, 104],
          fill: { type: "solid", color: "#10B981" },
        },
        {
          elementId: "gt",
          elementType: "text",
          bounds: [720, 190, 80, 30],
          content: { text: "96.2%", fontSize: 16 },
        },
      ],
    };
    const issues = reviewSkillPages([page], {
      mode: "compose",
      tasteGates: true,
      todos: [{ title: "逾期仪表盘", exhibits: ["diagram:gauge"] }],
    }).issues.filter((i) => i.code === "broken_gauge");
    assert.deepEqual(issues, []);
  });

  it("ignores pages that never promised a gauge", () => {
    const page: SkillPageInput = {
      id: "page-12",
      pageType: "content",
      elements: [
        {
          elementId: "blob",
          elementType: "shape",
          exhibitRole: "gauge",
          shapeName: "ellipse",
          bounds: [100, 150, 200, 60],
          fill: { type: "solid", color: "#E8F5EE" },
        },
      ],
    };
    const issues = reviewSkillPages([page], { mode: "compose", tasteGates: true }).issues;
    assert.ok(!issues.some((i) => i.code === "broken_gauge"));
  });
});
