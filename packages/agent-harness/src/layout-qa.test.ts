import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coursewarePageIssues,
  hasCoursewareColor,
  hasDrawnExhibit,
  hasPaperWhiteStructure,
  inferBriefPageExhibits,
  isNeutralHex,
  pageText,
  resolveTodoExhibits,
  reviewSkillPages,
} from "./layout-qa.js";
import { ensureKidsCoursewarePage, isHostNoteCopy, paintKidsCoursewarePage } from "./kids-courseware.js";
import type { SkillPageInput } from "./skill-pages.js";
import type { TodoExhibitContract } from "./layout-qa.js";
import type { ChartElement } from "@open-slidestudio/pptd-v2";

const creamWall: SkillPageInput = {
  id: "page-02",
  pageType: "content",
  background: { type: "solid", color: "#FDFAF5" },
  elements: [
    {
      elementId: "title",
      elementType: "text",
      bounds: [80, 60, 800, 50],
      content: { text: "种子里面有什么？", bold: true, fontSize: 22 },
    },
    {
      elementId: "body",
      elementType: "text",
      bounds: [80, 170, 800, 350],
      content: {
        text: "【种子皮】像铠甲。\n【胚】小生命。\n【子叶】便当。",
        fontSize: 16,
      },
    },
  ],
};

describe("layout QA — official paper-white recipes", () => {
  it("treats cream and near-black as neutral", () => {
    assert.equal(isNeutralHex("#FDFAF5"), true);
    assert.equal(isNeutralHex("#000000"), true);
    assert.equal(isNeutralHex("#FFFFFF"), true);
    assert.equal(isNeutralHex("#44712E"), false);
    assert.equal(isNeutralHex("#F5987E"), false);
  });

  it("rejects a cream + black text wall", () => {
    assert.equal(hasCoursewareColor(creamWall), false);
    const issues = coursewarePageIssues(creamWall, { body: true });
    assert.ok(issues.some((i) => i.code === "no_color"));
    assert.ok(issues.some((i) => i.code === "no_exhibit" || i.code === "doc_wall"));
    const review = reviewSkillPages([creamWall], { mode: "compose", courseware: true });
    assert.equal(review.ok, false);
  });

  it("accepts agent-drawn paper-white route/concept/transfer without host recipe ids", () => {
    const route: SkillPageInput = {
      id: "02_route",
      pageType: "route",
      elements: [
        {
          elementId: "el-01",
          elementType: "shape",
          shapeName: "rect",
          bounds: [48, 36, 72, 6],
          fill: { type: "solid", color: "#F5987E" },
        },
        {
          elementId: "el-02",
          elementType: "text",
          bounds: [48, 56, 400, 40],
          content: { text: "今天学什么", bold: true },
        },
        {
          elementId: "el-04",
          elementType: "shape",
          shapeName: "rect",
          bounds: [120, 140, 4, 320],
          fill: { type: "solid", color: "#D7EBCE" },
        },
        {
          elementId: "el-05",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [108, 148, 28, 28],
          fill: { type: "solid", color: "#F5987E" },
        },
        {
          elementId: "el-08",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [108, 230, 28, 28],
          fill: { type: "solid", color: "#44712E" },
        },
        {
          elementId: "el-11",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [108, 312, 28, 28],
          fill: { type: "solid", color: "#F5987E" },
        },
        {
          elementId: "el-14",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [108, 394, 28, 28],
          fill: { type: "solid", color: "#44712E" },
        },
        {
          elementId: "n1",
          elementType: "text",
          bounds: [160, 148, 320, 28],
          content: { text: "认识种子" },
        },
      ],
    };
    const concept: SkillPageInput = {
      id: "03_concept",
      pageType: "concept",
      elements: [
        {
          elementId: "el-01",
          elementType: "shape",
          shapeName: "rect",
          bounds: [48, 36, 72, 6],
          fill: { type: "solid", color: "#F5987E" },
        },
        {
          elementId: "el-02",
          elementType: "text",
          bounds: [48, 56, 400, 40],
          content: { text: "发芽是什么", bold: true },
        },
        {
          elementId: "el-05",
          elementType: "text",
          bounds: [48, 156, 400, 160],
          content: { text: "发芽是胚重新开始生长。" },
        },
        {
          elementId: "el-10",
          elementType: "text",
          bounds: [530, 160, 390, 280],
          content: { text: "种皮、胚、子叶。" },
        },
      ],
    };
    const transfer: SkillPageInput = {
      id: "06_transfer",
      pageType: "transfer",
      elements: [
        {
          elementId: "el-01",
          elementType: "shape",
          shapeName: "rect",
          bounds: [0, 0, 960, 64],
          fill: { type: "solid", color: "#D7EBCE" },
        },
        {
          elementId: "el-02",
          elementType: "text",
          bounds: [48, 18, 700, 36],
          content: { text: "迁移：回家种一颗", color: "#44712E", bold: true },
        },
        {
          elementId: "el-04",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [48, 150, 864, 260],
          fill: { type: "solid", color: "#D7EBCE" },
        },
        {
          elementId: "el-05",
          elementType: "text",
          bounds: [72, 172, 800, 28],
          content: { text: "下一步行动" },
        },
        {
          elementId: "el-06",
          elementType: "text",
          bounds: [72, 210, 800, 180],
          content: { text: "绿豆对照实验。" },
        },
      ],
    };
    assert.equal(hasPaperWhiteStructure(route.elements), true);
    assert.equal(hasPaperWhiteStructure(concept.elements), true);
    assert.equal(hasPaperWhiteStructure(transfer.elements), true);
    assert.equal(
      coursewarePageIssues(route, { body: true }).length,
      0,
      JSON.stringify(coursewarePageIssues(route, { body: true })),
    );
    assert.equal(
      coursewarePageIssues(concept, { body: true }).length,
      0,
      JSON.stringify(coursewarePageIssues(concept, { body: true })),
    );
    assert.equal(
      coursewarePageIssues(transfer, { body: true }).length,
      0,
      JSON.stringify(coursewarePageIssues(transfer, { body: true })),
    );
  });

  it("paints a cream classroom page into a colored exhibit", () => {
    const painted = paintKidsCoursewarePage(creamWall, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    assert.equal(hasCoursewareColor(painted), true);
    assert.equal(coursewarePageIssues(painted, { body: true }).length, 0);
    assert.ok(painted.elements.some((el) => el.elementType === "shape"));
    const review = reviewSkillPages(
      [
        paintKidsCoursewarePage(
          { ...creamWall, id: "page-01", pageType: "cover" },
          {
            brief: "给二年级讲一讲种子怎么发芽",
            index: 0,
          },
        ),
        painted,
        paintKidsCoursewarePage(
          { ...creamWall, id: "page-03", pageType: "close" },
          {
            brief: "给二年级讲一讲种子怎么发芽",
            index: 2,
          },
        ),
      ],
      { mode: "strict", courseware: true },
    );
    assert.equal(review.ok, true, JSON.stringify(review.issues));
  });

  it("rejects an empty color box and paints a drawing onto it", () => {
    const emptyBox: SkillPageInput = {
      id: "page-03",
      pageType: "content",
      background: { type: "solid", color: "#D7EBCE" },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 28, 860, 52],
          content: { text: "发芽要什么？", bold: true, fontSize: 28, color: "#44712E" },
        },
        {
          elementId: "panel",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [40, 120, 880, 360],
          fill: { type: "solid", color: "#F5987E" },
        },
      ],
    };
    assert.equal(hasCoursewareColor(emptyBox), true);
    assert.equal(hasDrawnExhibit(emptyBox.elements), false);
    const issues = coursewarePageIssues(emptyBox, { body: true });
    assert.ok(
      issues.some((i) => i.code === "empty_box"),
      JSON.stringify(issues),
    );
    const ensured = ensureKidsCoursewarePage(emptyBox, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 3,
      body: true,
    });
    assert.equal(ensured.applied, true);
    assert.equal(hasDrawnExhibit(ensured.page.elements), true);
    assert.equal(coursewarePageIssues(ensured.page, { body: true }).length, 0);
  });

  it("rejects a cover that is only empty color boxes", () => {
    const emptyCover: SkillPageInput = {
      id: "cover",
      pageType: "cover",
      background: { type: "solid", color: "#FDFAF5" },
      elements: [
        {
          elementId: "panel",
          elementType: "shape",
          shapeName: "rect",
          bounds: [60, 170, 840, 300],
          fill: { type: "solid", color: "#D7EBCE" },
        },
        {
          elementId: "bar",
          elementType: "shape",
          shapeName: "rect",
          bounds: [90, 360, 220, 40],
          fill: { type: "solid", color: "#F5987E" },
        },
      ],
    };
    const issues = coursewarePageIssues(emptyCover, { body: true });
    assert.ok(
      issues.some((i) => i.code === "empty_box" || i.code === "doc_wall"),
      JSON.stringify(issues),
    );
    const ensured = ensureKidsCoursewarePage(emptyCover, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 0,
      body: true,
    });
    assert.equal(ensured.applied, true);
    assert.ok(hasDrawnExhibit(ensured.page.elements));
    assert.match(pageText(ensured.page.elements), /\S/);
  });

  it("rejects takeaway cards+copy and paints a drawn close", () => {
    const cards: SkillPageInput = {
      id: "takeaway",
      pageType: "takeaway",
      background: { type: "solid", color: "#FDFAF5" },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [80, 40, 600, 50],
          content: { text: "总结回顾：小小种子力量大", bold: true, fontSize: 32, color: "#44712E" },
        },
        {
          elementId: "card-a",
          elementType: "shape",
          shapeName: "rect",
          bounds: [80, 150, 800, 100],
          fill: { type: "solid", color: "#D7EBCE" },
        },
        {
          elementId: "copy-a",
          elementType: "text",
          bounds: [110, 165, 740, 70],
          content: { text: "今日收获：水、温度、空气。", fontSize: 18, color: "#555555" },
        },
        {
          elementId: "card-b",
          elementType: "shape",
          shapeName: "rect",
          bounds: [80, 280, 800, 150],
          fill: { type: "solid", color: "#F9DED8" },
        },
        {
          elementId: "copy-b",
          elementType: "text",
          bounds: [110, 300, 740, 90],
          content: { text: "课后作业：种一粒豆子，记观察日记。", fontSize: 16, color: "#555555" },
        },
      ],
    };
    assert.equal(hasDrawnExhibit(cards.elements), false);
    const issues = coursewarePageIssues(cards, { body: true });
    assert.ok(
      issues.some((i) => i.code === "empty_box"),
      JSON.stringify(issues),
    );
    const ensured = ensureKidsCoursewarePage(cards, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 5,
      pageCount: 6,
      body: true,
    });
    assert.equal(ensured.applied, true);
    assert.equal(hasDrawnExhibit(ensured.page.elements), true);
    assert.equal(coursewarePageIssues(ensured.page, { body: true }).length, 0);
    const review = reviewSkillPages(
      [
        paintKidsCoursewarePage(
          { ...creamWall, id: "cover", pageType: "cover" },
          {
            brief: "给二年级讲一讲种子怎么发芽",
            index: 0,
          },
        ),
        paintKidsCoursewarePage(creamWall, { brief: "给二年级讲一讲种子怎么发芽", index: 2 }),
        ensured.page,
      ],
      { mode: "strict", courseware: true },
    );
    assert.equal(review.ok, true, JSON.stringify(review.issues));
  });

  it("does not put YAML notes on the visible title", () => {
    assert.equal(isHostNoteCopy("Cover page: Cream background"), true);
    assert.equal(isHostNoteCopy("Concept page: Seed anatomy"), true);
    assert.equal(isHostNoteCopy("种子怎么发芽"), false);
    const noted: SkillPageInput = {
      id: "cover",
      pageType: "cover",
      notes: "Cover page: Cream background, pale green panel #D7EBCE",
      background: { type: "solid", color: "#FDFAF5" },
      elements: [],
    };
    const painted = paintKidsCoursewarePage(noted, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 0,
    });
    assert.match(pageText(painted.elements), /种子怎么发芽/);
    assert.doesNotMatch(pageText(painted.elements), /Cover page|Cream background/);
    const paintedBody = paintKidsCoursewarePage(creamWall, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    const leaked: SkillPageInput = {
      ...paintedBody,
      elements: paintedBody.elements.map((el) => {
        if (el.elementType !== "text" || el.elementId !== "title") return el;
        const text = el as { content?: { text?: string } };
        return { ...el, content: { ...text.content, text: "Concept page: Seed anatomy" } };
      }),
    };
    const fixed = ensureKidsCoursewarePage(leaked, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
      body: true,
    });
    assert.doesNotMatch(pageText(fixed.page.elements), /Concept page|Seed anatomy|Cover page/);
    assert.equal(hasDrawnExhibit(fixed.page.elements), true);
  });

  it("does not repaint a page that already has color and an exhibit", () => {
    const good = paintKidsCoursewarePage(creamWall, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    const again = ensureKidsCoursewarePage(good, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
      body: true,
    });
    assert.equal(again.painted, false);
    assert.equal(again.page, good);
  });
});

describe("layout QA — chart semantics", () => {
  const pageWithChart = (chart: SkillPageInput["elements"][number]): SkillPageInput => ({
    id: "risk",
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [40, 20, 880, 40],
        content: { text: "风险矩阵" },
      },
      chart,
    ],
  });

  it("rejects a named advanced chart without valid encoded columns", () => {
    const review = reviewSkillPages(
      [
        pageWithChart({
          elementId: "risk-chart",
          elementType: "chart",
          bounds: [40, 80, 880, 400],
          data: { cols: ["风险", "可能", "影响"], rows: [["断货", 4.5, 4.8]] },
          series: [{ type: "scatter", encode: { x: "不存在", y: "影响" } }],
        }),
      ],
      { mode: "compose" },
    );
    assert.ok(review.issues.some((issue) => issue.code === "invalid_chart_data"));
  });

  it("accepts a scatter chart with real x/y data", () => {
    const review = reviewSkillPages(
      [
        pageWithChart({
          elementId: "risk-chart",
          elementType: "chart",
          bounds: [40, 80, 880, 400],
          data: { cols: ["风险", "可能", "影响"], rows: [["断货", 4.5, 4.8]] },
          series: [{ type: "scatter", encode: { x: "可能", y: "影响" } }],
        }),
      ],
      { mode: "compose" },
    );
    assert.equal(
      review.issues.some((issue) => issue.code === "invalid_chart_data" || issue.code === "unsupported_chart"),
      false,
    );
  });
});

describe("layout QA — promised exhibit contract", () => {
  const title = {
    elementId: "title",
    elementType: "text" as const,
    bounds: [40, 20, 880, 40] as [number, number, number, number],
    content: { text: "经营分析" },
  };

  it("rejects a pie chart when write_todo promised a waterfall", () => {
    const review = reviewSkillPages(
      [
        {
          id: "page-07",
          elements: [
            title,
            {
              elementId: "cost-pie",
              elementType: "chart",
              bounds: [40, 80, 880, 400],
              data: { cols: ["项目", "金额"], rows: [["原料", 4672]] },
              series: [{ type: "pie", encode: { x: "项目", y: "金额" } }],
            },
          ],
        },
      ],
      { mode: "compose", todos: [{ title: "毛利", note: "右侧毛利率瀑布" }] },
    );
    assert.ok(
      review.issues.some(
        (issue) => issue.code === "missing_requested_exhibit" && issue.message.includes("chart:waterfall"),
      ),
      JSON.stringify(review.issues),
    );
  });

  it("does not accept a text element named funnel as a funnel", () => {
    const review = reviewSkillPages(
      [
        {
          id: "page-11",
          elements: [
            title,
            {
              elementId: "funnel",
              elementType: "text",
              bounds: [80, 100, 600, 200],
              content: { text: "到店 → 下单 → 支付" },
            },
          ],
        },
      ],
      { mode: "compose", todos: [{ title: "销售", exhibits: ["diagram:funnel"] }] },
    );
    assert.ok(review.issues.some((issue) => issue.code === "missing_requested_exhibit"));
  });

  it("requires a real secondary axis for a promised combo chart", () => {
    const combo = (secondary: boolean): SkillPageInput => ({
      id: "page-12",
      elements: [
        title,
        {
          elementId: "member-combo",
          elementType: "chart",
          bounds: [60, 80, 840, 380],
          data: {
            cols: ["月", "新增", "复购率"],
            rows: [["7月", 12.8, 26.4]],
          },
          series: [
            { type: "bar", encode: { x: "月", y: "新增" } },
            {
              type: "line",
              encode: { x: "月", y: "复购率" },
              ...(secondary ? { axis: "secondary" as const } : {}),
            },
          ],
        },
      ],
    });
    const missing = reviewSkillPages([combo(false)], {
      mode: "compose",
      todos: [{ title: "会员", exhibits: ["chart:combo"] }],
    });
    const present = reviewSkillPages([combo(true)], {
      mode: "compose",
      todos: [{ title: "会员", exhibits: ["chart:combo"] }],
    });
    assert.ok(missing.issues.some((issue) => issue.code === "missing_requested_exhibit"));
    assert.equal(
      present.issues.some((issue) => issue.code === "missing_requested_exhibit"),
      false,
      JSON.stringify(present.issues),
    );
  });

  it("rejects a microscopic transparent chart used only to satisfy the exhibit contract", () => {
    const review = reviewSkillPages(
      [
        {
          id: "page-04",
          elements: [
            title,
            {
              elementId: "hidden-scatter",
              elementType: "chart",
              bounds: [0, 0, 2, 2],
              opacity: 0.02,
              data: {
                cols: ["可能性", "影响"],
                rows: [[4, 5]],
              },
              series: [{ type: "scatter", encode: { x: "可能性", y: "影响" } }],
            },
          ],
        },
      ],
      { mode: "compose", todos: [{ title: "风险", exhibits: ["chart:scatter"] }] },
    );

    assert.ok(
      review.issues.some((issue) => issue.code === "missing_requested_exhibit"),
      JSON.stringify(review.issues),
    );
  });

  it("rejects implicit chart colors in taste-gated review", () => {
    const chart: ChartElement = {
      elementId: "regions",
      elementType: "chart",
      bounds: [60, 80, 840, 360],
      data: { cols: ["区域", "营收"], rows: [["华东", 4887]] },
      series: [{ type: "bar", encode: { x: "区域", y: "营收" } }],
    };
    const bar: SkillPageInput = {
      id: "page-05",
      elements: [title, chart],
    };
    const missing = reviewSkillPages([bar], {
      mode: "compose",
      requireExplicitChartColors: true,
    });
    chart.series[0]!.fill = "#0064BC";
    const present = reviewSkillPages([bar], {
      mode: "compose",
      requireExplicitChartColors: true,
    });

    assert.ok(missing.issues.some((issue) => issue.code === "implicit_chart_palette"));
    assert.equal(
      present.issues.some((issue) => issue.code === "implicit_chart_palette"),
      false,
      JSON.stringify(present.issues),
    );
  });

  it("requires one explicit color per pie category", () => {
    const chart: ChartElement = {
      elementId: "cost-mix",
      elementType: "chart",
      bounds: [60, 80, 840, 360],
      data: {
        cols: ["成本", "金额"],
        rows: [
          ["原料", 4672],
          ["乳品水果", 1680],
          ["包材", 967],
        ],
      },
      series: [
        {
          type: "pie",
          encode: { category: "成本", value: "金额" },
          fill: "#0064BC",
        },
      ],
    };
    const pie: SkillPageInput = {
      id: "page-07",
      elements: [title, chart],
    };
    const missing = reviewSkillPages([pie], {
      mode: "compose",
      requireExplicitChartColors: true,
    });
    chart.colors = ["#0064BC", "#00ACEE", "#E8943A"];
    const present = reviewSkillPages([pie], {
      mode: "compose",
      requireExplicitChartColors: true,
    });

    assert.ok(missing.issues.some((issue) => issue.code === "implicit_chart_palette"));
    assert.equal(
      present.issues.some((issue) => issue.code === "implicit_chart_palette"),
      false,
      JSON.stringify(present.issues),
    );
  });

  it("accepts a funnel made from marked editable shapes and labels", () => {
    const shapes = [
      [120, 110, 600, 70],
      [170, 190, 500, 70],
      [220, 270, 400, 70],
    ] as const;
    const page: SkillPageInput = {
      id: "page-11",
      elements: [
        title,
        ...shapes.map((bounds, index) => ({
          elementId: `funnel-shape-${index}`,
          elementType: "shape" as const,
          exhibitRole: "funnel" as const,
          shapeName: "trapezoid",
          bounds: [...bounds] as [number, number, number, number],
        })),
        ...["到店", "支付"].map((text, index) => ({
          elementId: `funnel-label-${index}`,
          elementType: "text" as const,
          exhibitRole: "funnel" as const,
          bounds: [300, 125 + index * 160, 160, 30] as [number, number, number, number],
          content: { text },
        })),
      ],
    };
    const review = reviewSkillPages([page], {
      mode: "compose",
      todos: [{ title: "销售", exhibits: ["diagram:funnel"] }],
    });
    assert.equal(
      review.issues.some((issue) => issue.code === "missing_requested_exhibit"),
      false,
      JSON.stringify(review.issues),
    );
  });

  it("rejects a matrix contract backed by transparent proxy shapes", () => {
    const page: SkillPageInput = {
      id: "page-2",
      elements: [
        title,
        ...[0, 1, 2, 3].map((index) => ({
          elementId: `proxy-${index}`,
          elementType: "shape" as const,
          exhibitRole: "matrix" as const,
          shapeName: "rect",
          bounds: [100 + (index % 2) * 220, 120 + Math.floor(index / 2) * 120, 200, 100] as [
            number,
            number,
            number,
            number,
          ],
          fill: { type: "solid" as const, color: "#FFFFFF00" },
        })),
        ...["投入", "收益"].map((text, index) => ({
          elementId: `proxy-label-${index}`,
          elementType: "text" as const,
          exhibitRole: "matrix" as const,
          bounds: [120 + index * 220, 140, 100, 24] as [number, number, number, number],
          content: { text },
        })),
      ],
    };
    const review = reviewSkillPages([page], {
      mode: "compose",
      todos: [{ title: "决策", exhibits: ["diagram:matrix"] }],
    });
    assert.ok(
      review.issues.some((issue) => issue.code === "missing_requested_exhibit"),
      JSON.stringify(review.issues),
    );
  });

  it("extracts each page's visual obligations from a structured brief", () => {
    const brief = [
      "【第6页 收入趋势】",
      "左：营收折线+同比柱。右：贡献瀑布。底表：工作日日均。",
      "【第10页 现金流与回款】",
      "版式：上瀑布，下左仪表盘，下右账龄条。",
    ].join("\n");
    assert.deepEqual(inferBriefPageExhibits(brief, 6), ["chart:waterfall", "chart:line", "chart:bar", "table"]);
    assert.deepEqual(inferBriefPageExhibits(brief, 10), ["chart:waterfall", "chart:bar", "diagram:gauge"]);
  });

  it("does not turn an explicit no-table page into a table obligation", () => {
    const brief = ["【第1页 封面】无图表、无经营数字。", "【第2页 目录】左右分栏，无数据表。"].join("\n");
    assert.deepEqual(inferBriefPageExhibits(brief, 1), []);
    assert.deepEqual(inferBriefPageExhibits(brief, 2), []);
  });

  it("recognizes editable matrix and timeline obligations without duplicating a risk scatter", () => {
    const brief = [
      "【第4页 优先级】二维矩阵展示四项用例。",
      "【第10页 风险】可能性×影响的风险矩阵散点。",
      "【第11页 路线图】90天时间线与三个里程碑。",
    ].join("\n");
    assert.deepEqual(inferBriefPageExhibits(brief, 4), ["diagram:matrix"]);
    assert.deepEqual(inferBriefPageExhibits(brief, 10), ["chart:scatter"]);
    assert.deepEqual(inferBriefPageExhibits(brief, 11), ["diagram:timeline"]);
  });

  it("recognizes Chinese keyword fallbacks for all five diagram types", () => {
    const brief = [
      "【第1页 转化】全链路转化漏斗分析。",
      "【第2页 达成率】核心目标进度环与达成率环。",
      "【第3页 架构】客户分层层级塔。",
      "【第4页 评估】四象限与九宫格评估矩阵。",
      "【第5页 历程】公司发展历程、时间轴与演进路线。",
      "【第6页 风险】可能性与影响的风险矩阵散点。",
    ].join("\n");
    assert.deepEqual(inferBriefPageExhibits(brief, 1), ["diagram:funnel"]);
    assert.deepEqual(inferBriefPageExhibits(brief, 2), ["diagram:gauge"]);
    assert.deepEqual(inferBriefPageExhibits(brief, 3), ["diagram:pyramid"]);
    assert.deepEqual(inferBriefPageExhibits(brief, 4), ["diagram:matrix"]);
    assert.deepEqual(inferBriefPageExhibits(brief, 5), ["diagram:timeline"]);
    assert.deepEqual(inferBriefPageExhibits(brief, 6), ["chart:scatter"]);
  });

  it("merges explicit, legacy-outline, and page-specific brief requirements", () => {
    const brief = ["【第1页 封面】无图表。", "【第2页 会员】中左金字塔，底双轴图。"].join("\n");
    assert.deepEqual(
      resolveTodoExhibits(
        {
          title: "会员 KPI",
          note: "六张卡片",
          exhibits: ["none", "chart:bar"],
        },
        1,
        brief,
      ),
      ["chart:bar", "kpi-cards", "chart:combo", "diagram:pyramid"],
    );
  });
});
