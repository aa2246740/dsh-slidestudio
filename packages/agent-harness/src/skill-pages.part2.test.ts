import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type ChartElement } from "@open-slidestudio/pptd-v2";
import { parseBounds, parseSkillPage } from "./skill-pages.js";

describe("skill PPTD pages", () => {
  it("parses official bounds tuples and object bounds", () => {
    assert.deepEqual(parseBounds([40, 36, 880, 48]), [40, 36, 880, 48]);
    assert.deepEqual(parseBounds({ left: 40, top: 36, width: 880, height: 48 }), [40, 36, 880, 48]);
    assert.equal(parseBounds([40, 36, 0, 48]), null);
  });

  it("unescapes JSON-style \\n so body copy is real line breaks", () => {
    const page = parseSkillPage(
      {
        id: "page-02",
        pageType: "content",
        elements: [
          {
            elementId: "body",
            elementType: "text",
            bounds: [40, 100, 880, 360],
            content: { text: "上午：浅草\\n· 雷门" },
          },
        ],
      },
      1,
    );
    assert.ok(page);
    const el = page.elements[0] as { content?: { text?: string } };
    assert.equal(el.content?.text?.includes("\\n"), false);
    assert.match(el.content?.text ?? "", /上午：浅草\n· 雷门/);
  });

  it("preserves an explicit layout role from write_page", () => {
    const page = parseSkillPage({
      id: "page-02",
      elements: [
        {
          elementId: "foot",
          elementType: "text",
          bounds: [40, 512, 880, 18],
          layoutRole: "footer",
          content: { text: "来源｜02", fontSize: 10 },
        },
      ],
    });
    assert.equal(page?.elements[0]?.layoutRole, "footer");
  });

  it("preserves an explicit exhibit role from write_page", () => {
    const page = parseSkillPage({
      id: "page-11",
      elements: [
        {
          elementId: "funnel-band",
          elementType: "shape",
          shapeName: "trapezoid",
          bounds: [120, 120, 600, 72],
          exhibitRole: "funnel",
        },
      ],
    });
    assert.equal(page?.elements[0]?.exhibitRole, "funnel");
  });

  it("preserves combination-chart series and secondary-axis metadata", () => {
    const page = parseSkillPage({
      id: "page-12",
      elements: [
        {
          elementId: "member-combo",
          elementType: "chart",
          bounds: [80, 120, 800, 300],
          data: {
            cols: ["月", "新增", "复购率"],
            rows: [["7月", 12.8, 26.4]],
          },
          series: [
            { type: "bar", encode: { x: "月", y: "新增" } },
            {
              type: "line",
              encode: { x: "月", y: "复购率" },
              axis: "secondary",
            },
          ],
          colors: ["#0064BC", "#00ACEE"],
          axis: { x: "月份", y: "新增会员（万）", secondaryY: "复购率（%）" },
        },
      ],
    });
    const chart = page?.elements[0] as ChartElement | undefined;
    assert.equal(chart?.elementType, "chart");
    if (chart?.elementType !== "chart") return;
    assert.equal(chart.series[1]?.axis, "secondary");
    assert.deepEqual(chart.colors, ["#0064BC", "#00ACEE"]);
    assert.equal(chart.axis?.secondaryY, "复购率（%）");
  });

  it("parses background.fill objects and textColor", () => {
    const page = parseSkillPage({
      id: "page-1",
      pageType: "cover",
      elements: [
        {
          type: "rect",
          left: 80,
          top: 80,
          width: 400,
          height: 280,
          background: { fill: "#D7EBCE" },
        },
        {
          type: "text",
          left: 80,
          top: 120,
          width: 800,
          height: 80,
          content: "种子怎么发芽？",
          textColor: "#44712E",
          fontSize: 56,
        },
      ],
    });
    assert.ok(page);
    const panel = page?.elements.find((el) => el.elementType === "shape") as { fill?: { color?: string } } | undefined;
    const title = page?.elements.find((el) => el.elementType === "text") as
      { content?: { text?: string; color?: string } } | undefined;
    assert.equal(panel?.fill?.color, "#D7EBCE");
    assert.equal(title?.content?.text, "种子怎么发芽？");
    assert.equal(title?.content?.color, "#44712E");
  });

  it("parses left/top/width/height and background as a shape fill", () => {
    const page = parseSkillPage({
      id: "page-1",
      pageType: "cover",
      elements: [
        {
          type: "rect",
          left: 100,
          top: 100,
          width: 760,
          height: 340,
          background: "#D7EBCE",
        },
        {
          type: "text",
          left: 200,
          top: 128,
          width: 400,
          height: 48,
          text: "种子是怎么发芽的？",
          color: "#44712E",
          fontSize: 42,
        },
      ],
    });
    assert.ok(page);
    const panel = page?.elements.find((el) => el.elementType === "shape") as
      { fill?: { color?: string }; bounds: number[] } | undefined;
    assert.deepEqual(panel?.bounds, [100, 100, 760, 340]);
    assert.equal(panel?.fill?.color, "#D7EBCE");
  });

  it("accepts a write_page with title/body and no elements[]", () => {
    const page = parseSkillPage({
      id: "page-02",
      pageType: "content",
      title: "水把种子叫醒",
      body: "种子先喝水，外壳变软，小根才能钻出来。",
    });
    assert.ok(page);
    assert.equal(page?.id, "page-02");
    assert.equal(page?.elements.length, 2);
    const texts = page?.elements.map((el) =>
      el.elementType === "text" ? (el as { content: { text: string } }).content.text : "",
    );
    assert.deepEqual(texts, ["水把种子叫醒", "种子先喝水，外壳变软，小根才能钻出来。"]);
  });

  it("accepts official header/list/circle/band vocab from write_page", () => {
    const cover = parseSkillPage({
      id: "page-1",
      pageType: "cover",
      elements: [
        { type: "header", content: "种子怎么发芽", tag: "二年级", size: "hero", color: "#44712E" },
        { type: "circle", size: "giant", background: "#F9DED8" },
        { type: "band", size: "medium", background: "#D7EBCE" },
      ],
    });
    assert.ok(cover);
    assert.ok(cover?.elements.some((el) => el.elementId === "title"));
    assert.ok(cover?.elements.some((el) => el.elementId === "circle"));
    assert.ok(cover?.elements.some((el) => el.elementId === "title-band"));
    const route = parseSkillPage({
      id: "page-2",
      pageType: "route",
      elements: [
        {
          type: "header",
          title: "一粒种子要走过哪几步",
          bounds: { left: 80, top: 60, width: 800, height: 100 },
        },
        {
          type: "list",
          items: ["先喝饱水", "种皮裂开", "小根钻出来", "芽顶出土"],
          bounds: { left: 80, top: 180, width: 800, height: 300 },
        },
      ],
    });
    assert.ok(route);
    assert.ok(route?.elements.some((el) => el.elementId === "panel-0"));
    assert.ok(route?.elements.some((el) => el.elementId === "well-0"));
    assert.match(JSON.stringify(route?.elements), /先喝饱水/);
    const ruled = parseSkillPage({
      id: "page-2",
      pageType: "route",
      elements: [
        {
          type: "header",
          title: "发芽要什么条件",
          bounds: { left: 80, top: 60, width: 800, height: 80 },
        },
        { type: "rule", color: "#F5987E", bounds: { left: 80, top: 150, width: 72, height: 6 } },
        { type: "list", items: ["要喝水", "要呼吸", "要暖一暖"] },
      ],
    });
    assert.ok(ruled?.elements.some((el) => el.elementId === "rule"));
    const firstOfficial = parseSkillPage({
      id: "page-1",
      pageType: "cover",
      elements: [
        {
          type: "header",
          size: "hero",
          content: "🌱 种子是怎么发芽的",
          tag: "二年级科学自然课",
          color: "#44712E",
        },
        {
          type: "text",
          size: "body",
          content: "让我们一起探究小小的种子是如何破土而出，长成绿油油的小苗的！",
        },
        { type: "circle", size: "giant", background: "#F9DED8" },
        { type: "band", size: "medium", background: "#D7EBCE" },
      ],
    });
    assert.ok(firstOfficial);
    assert.ok(firstOfficial?.elements.some((el) => el.elementId === "title"));
    assert.ok(firstOfficial?.elements.some((el) => el.elementId === "circle"));
    assert.ok(firstOfficial?.elements.some((el) => el.elementId === "title-band"));
    const rgbCover = parseSkillPage({
      id: "page-1",
      pageType: "cover",
      elements: [
        { type: "circle", bounds: [60, 80, 400, 400], color: [249, 222, 216] },
        { type: "band", bounds: [36, 348, 560, 156], color: [215, 235, 206] },
        { type: "header", text: "种子怎么发芽" },
      ],
    });
    assert.ok(rgbCover);
    const blush = rgbCover?.elements.find((el) => el.elementId === "circle") as
      { fill?: { color?: string } } | undefined;
    assert.equal(blush?.fill?.color?.toUpperCase(), "#F9DED8");
    const concept = parseSkillPage({
      id: "page-3",
      pageType: "concept",
      elements: [
        { type: "header", text: "种子里面有什么：小小的生命大世界" },
        {
          type: "concept",
          columns: [
            {
              title: "外部与营养",
              items: [
                { title: "种皮（保护伞）", desc: "坚硬的外衣，保护里面柔嫩的生命。" },
                { title: "子叶（营养库）", desc: "肥厚的部分，存贮发芽所需的营养。" },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(
      concept?.elements.some((el) => el.elementId === "panel-0"),
      false,
    );
    assert.ok(concept?.elements.some((el) => el.elementId === "lead"));
    assert.match(JSON.stringify(concept?.elements), /种皮（保护伞）/);
    assert.match(JSON.stringify(concept?.elements), /坚硬的外衣/);
    const result = parseSkillPage({
      id: "page-5",
      pageType: "demo",
      elements: [
        { type: "header", text: "种子发芽的奇妙过程：从破土到长成幼苗" },
        {
          type: "result",
          steps: [
            { title: "吸水膨胀", desc: "干种子吸水后肚子变大。" },
            { title: "胚根向下", desc: "胚根先钻出来。" },
          ],
        },
      ],
    });
    assert.equal(
      result?.elements.some((el) => el.elementId === "panel-0"),
      false,
    );
    assert.match(JSON.stringify(result?.elements), /吸水膨胀/);
    const placed = parseSkillPage({
      id: "page-1",
      pageType: "cover",
      elements: [
        { type: "circle", x: 550, y: 100, size: 200 },
        { type: "header", text: "二年级科学趣味课堂" },
        { type: "title", text: "种子怎么发芽" },
        { type: "band", text: "看一粒种子怎样醒来" },
      ],
    });
    const circle = placed?.elements.find((el) => el.elementId === "circle") as { bounds?: number[] } | undefined;
    assert.deepEqual(circle?.bounds, [-70, -30, 430, 430]);
    const chip = placed?.elements.find((el) => el.elementId === "chip") as
      { content?: { text?: string }; bounds?: number[] } | undefined;
    const titleEl = placed?.elements.find((el) => el.elementId === "title") as { bounds?: number[] } | undefined;
    assert.equal(chip?.content?.text, "二年级");
    assert.ok((chip?.bounds?.[1] ?? 0) >= 348);
    assert.ok((titleEl?.bounds?.[1] ?? 0) >= 348);
    assert.equal(
      placed?.elements.filter(
        (el) => el.elementType === "shape" && (el as { shapeName?: string }).shapeName === "ellipse",
      ).length,
      1,
    );
    assert.ok(placed?.elements.some((el) => el.elementId === "title-band"));
    assert.match(JSON.stringify(placed?.elements), /看一粒种子怎样醒来/);
    assert.doesNotMatch(JSON.stringify(placed?.elements), /二年级科学趣味课堂/);
  });

  it("parses style fill/left percent canvas shorthand onto PPTD bounds", () => {
    const page = parseSkillPage({
      id: "page-1",
      pageType: "cover",
      elements: [
        {
          type: "shape",
          shape: "ellipse",
          style: { fill: "#F9DED8", left: "-8%", top: "-18%", width: "52%", height: "92%" },
        },
        {
          type: "text",
          content: "种子怎么发芽",
          style: {
            left: 80,
            top: 478,
            width: 480,
            height: 56,
            fontSize: 44,
            color: "#44712E",
            fontWeight: "700",
          },
        },
      ],
    });
    assert.ok(page);
    const circle = page?.elements.find((el) => el.elementType === "shape") as
      { bounds?: number[]; fill?: { color?: string }; shapeName?: string } | undefined;
    assert.equal(circle?.shapeName, "ellipse");
    assert.equal(circle?.fill?.color?.toUpperCase(), "#F9DED8");
    assert.ok(circle?.bounds);
    assert.ok(Math.abs((circle?.bounds?.[0] ?? 0) - -0.08 * 960) < 1);
    const title = page?.elements.find((el) => el.elementType === "text") as
      { content?: { text?: string; color?: string; bold?: boolean } } | undefined;
    assert.equal(title?.content?.text, "种子怎么发芽");
    assert.equal(title?.content?.color?.toUpperCase(), "#44712E");
    assert.equal(title?.content?.bold, true);
  });

  it("preserves sibling text style on canonical elementType payloads", () => {
    const page = parseSkillPage({
      id: "1_cover",
      pageType: "cover",
      elements: [
        {
          elementId: "cover_title",
          elementType: "text",
          bounds: [72, 80, 816, 52],
          content: { text: "資本支出收到 600–640 億，是產能不夠。" },
          style: {
            color: "#F4ECDD",
            fontSize: 40,
            fontFamily: { latin: "Unna", ea: "Noto Serif CJK TC" },
            bold: false,
            italic: true,
            underline: false,
            backgroundColor: "#0E2A47",
            lineHeight: 1.18,
            letterSpacing: 0.5,
            align: '["right","middle"]',
            wrap: false,
            list: "bullet",
            href: "https://example.test/source",
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
      italic: true,
      underline: false,
      fontSize: 40,
      color: "#F4ECDD",
      fontFamily: { latin: "Unna", ea: "Noto Serif CJK TC" },
      backgroundColor: "#0E2A47",
      lineHeight: 1.18,
      letterSpacing: 0.5,
      align: ["right", "middle"],
      list: "bullet",
      href: "https://example.test/source",
    });
  });

  it("preserves finite numeric text from canonical elementType payloads", () => {
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
