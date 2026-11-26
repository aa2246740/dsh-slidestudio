import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureOfficialRecipePage,
  fallbackTitle,
  hasHomemadeFourCircles,
  hasKidsDoodle,
  hasOfficialRecipe,
  isFragmentTitle,
  isHostNoteCopy,
  keepWrittenClassroomPage,
  officialRecipesMarkdown,
  paintOfficialRecipePage,
  PAPER_WHITE,
} from "./playbook-recipes.js";
import { coursewarePageIssues, pageText } from "./layout-qa.js";
import type { SkillPageInput } from "./skill-pages.js";

const creamWall: SkillPageInput = {
  id: "page-02",
  pageType: "content",
  background: { type: "solid", color: PAPER_WHITE.paper },
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
      content: { text: "种皮、胚、子叶。", fontSize: 16 },
    },
  ],
};

const fourCircles: SkillPageInput = {
  id: "page-02",
  pageType: "route",
  background: { type: "solid", color: PAPER_WHITE.paper },
  elements: [
    {
      elementId: "title",
      elementType: "text",
      bounds: [48, 28, 860, 52],
      content: { text: "发芽之旅", bold: true, fontSize: 30, color: PAPER_WHITE.title },
    },
    ...[0, 1, 2, 3].map((i) => ({
      elementId: `step-${i}`,
      elementType: "shape" as const,
      shapeName: "ellipse",
      bounds: [72 + i * 210, 168, 96, 96] as [number, number, number, number],
      fill: { type: "solid" as const, color: PAPER_WHITE.coral },
    })),
  ],
};

describe("official paper-white recipes", () => {
  it("documents paper-white + education-training page types", () => {
    const md = officialRecipesMarkdown();
    assert.match(md, /paper-white-courseware/);
    assert.match(md, /education-training/);
    assert.match(md, /cover · route · concept · method · demo · transfer/);
    assert.match(md, /4-step/);
    assert.match(md, /capability/);
  });

  it("cover is giant blush circle + leaf title band, not a seed doodle", () => {
    const cover = paintOfficialRecipePage(
      { ...creamWall, id: "page-01", pageType: "cover" },
      { brief: "给二年级讲一讲种子怎么发芽", index: 0 },
    );
    assert.equal(cover.pageType, "cover");
    assert.equal(hasOfficialRecipe(cover.elements), true);
    assert.equal(hasKidsDoodle(cover.elements), false);
    assert.ok(cover.elements.some((el) => el.elementId === "circle"));
    assert.ok(cover.elements.some((el) => el.elementId === "title-band"));
    assert.doesNotMatch(pageText(cover.elements), /Cover page|Cream background/);
    assert.match(pageText(cover.elements), /种子怎么发芽/);
    const title = cover.elements.find((el) => el.elementId === "title") as { content?: { text?: string } } | undefined;
    assert.ok((title?.content?.text ?? "").length <= 12);
    assert.equal(coursewarePageIssues(cover, { body: true }).length, 0);
  });

  it("route uses a vertical path, not four numbered circles or list pills", () => {
    assert.equal(hasHomemadeFourCircles(fourCircles.elements), true);
    const route = ensureOfficialRecipePage(fourCircles, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 1,
    });
    assert.equal(route.applied, true);
    assert.equal(route.page.pageType, "route");
    assert.equal(hasHomemadeFourCircles(route.page.elements), false);
    assert.equal(hasOfficialRecipe(route.page.elements), true);
    assert.ok(route.page.elements.some((el) => el.elementId === "path-spine"));
    assert.ok(route.page.elements.some((el) => el.elementId === "step-0"));
    assert.equal(
      route.page.elements.some((el) => el.elementId === "panel-0"),
      false,
    );
    assert.ok(route.page.elements.some((el) => el.elementId === "rule"));
    assert.match(pageText(route.page.elements), /先喝饱水/);
    assert.doesNotMatch(pageText(route.page.elements), /认识种子|发芽条件/);
  });

  it("keeps YAML notes off the canvas title", () => {
    assert.equal(isFragmentTitle("外壳（种皮）："), true);
    assert.equal(isFragmentTitle("种子怎么发芽"), false);
    const colonTitle: SkillPageInput = {
      id: "page-03",
      pageType: "concept",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 28, 720, 52],
          content: { text: "种子里面有什么：小小的生命大世界", bold: true, fontSize: 32 },
        },
        {
          elementId: "panel-0",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [48, 112, 864, 80],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
      ],
    };
    const shortened = keepWrittenClassroomPage(colonTitle, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
      pageCount: 6,
    });
    const shortTitle = shortened.page.elements.find((el) => el.elementId === "title") as
      { content?: { text?: string } } | undefined;
    assert.equal(shortTitle?.content?.text, "种子里面有什么");
    assert.equal(shortened.restamped, false);
    assert.equal(shortened.painted, false);
    assert.equal(isHostNoteCopy("Cover page: Cream background"), true);
    assert.equal(fallbackTitle("给二年级讲一讲种子怎么发芽", "cover"), "种子怎么发芽");
    const noted: SkillPageInput = {
      id: "cover",
      pageType: "cover",
      notes: "Cover page: Cream background, pale green panel #D7EBCE",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [40, 40, 400, 40],
          content: { text: "Cover page: Cream background", bold: true, fontSize: 22 },
        },
      ],
    };
    const painted = paintOfficialRecipePage(noted, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 0,
    });
    assert.doesNotMatch(pageText(painted.elements), /Cover page|Cream background/);
    assert.match(pageText(painted.elements), /种子怎么发芽/);
  });

  it("keeps official header/circle/band chrome and shortens a long cover title", () => {
    const written: SkillPageInput = {
      id: "page-01",
      pageType: "cover",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "circle",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [-70, -30, 430, 430],
          fill: { type: "solid", color: PAPER_WHITE.blush },
        },
        {
          elementId: "title-band",
          elementType: "shape",
          shapeName: "rect",
          bounds: [36, 348, 560, 156],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
        {
          elementId: "title",
          elementType: "text",
          bounds: [80, 80, 800, 120],
          content: {
            text: "让我们一起探究小小的种子是如何破土而出，长成绿油油的小苗的！",
            bold: true,
            fontSize: 40,
            color: PAPER_WHITE.title,
          },
        },
        {
          elementId: "body",
          elementType: "text",
          bounds: [80, 220, 600, 200],
          content: {
            text: "让我们一起探究小小的种子是如何破土而出，长成绿油油的小苗的！小朋友们，准备好了吗？",
            fontSize: 16,
            color: PAPER_WHITE.body,
          },
        },
      ],
    };
    const next = ensureOfficialRecipePage(written, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 0,
    });
    const title = next.page.elements.find((el) => el.elementId === "title") as
      { content?: { text?: string }; bounds: number[] } | undefined;
    assert.equal(next.painted, false);
    assert.ok(next.page.elements.some((el) => el.elementId === "circle"));
    assert.ok(next.page.elements.some((el) => el.elementId === "title-band"));
    assert.equal(
      next.page.elements.some((el) => el.elementId === "cover-stem"),
      false,
    );
    assert.ok((title?.content?.text ?? "").length <= 12);
    assert.doesNotMatch(title?.content?.text ?? "", /让我们一起探究|外壳（种皮）/);
    assert.ok((title?.bounds[1] ?? 0) >= 348);
    const ids = next.page.elements.map((el) => el.elementId);
    assert.ok(ids.indexOf("title-band") < ids.indexOf("title"));
  });

  it("rewrites a fragment concept title without restamping official list chrome", () => {
    const written = paintOfficialRecipePage(
      { ...creamWall, id: "page-03", pageType: "concept" },
      { brief: "给二年级讲一讲种子怎么发芽", index: 2 },
    );
    const withFragment: SkillPageInput = {
      ...written,
      elements: written.elements.map((el) =>
        el.elementId === "title"
          ? {
              ...el,
              content: { ...(el as { content?: object }).content, text: "外壳（种皮）：" },
            }
          : el,
      ) as SkillPageInput["elements"],
    };
    const next = ensureOfficialRecipePage(withFragment, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    const title = next.page.elements.find((el) => el.elementId === "title") as
      { content?: { text?: string } } | undefined;
    assert.equal(next.painted, false);
    assert.ok(next.page.elements.some((el) => el.elementId === "aside"));
    assert.ok(next.page.elements.some((el) => el.elementId === "ring-outer"));
    assert.equal(isFragmentTitle(title?.content?.text ?? ""), false);
    assert.doesNotMatch(title?.content?.text ?? "", /外壳（种皮）|[：:]$/);
  });

  it("lands two blush circles onto the official one-circle cover with title on the band", () => {
    const twoCircles: SkillPageInput = {
      id: "page-01",
      pageType: "cover",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "circle",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [550, 100, 200, 200],
          fill: { type: "solid", color: PAPER_WHITE.blush },
        },
        {
          elementId: "circle",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [700, 300, 120, 120],
          fill: { type: "solid", color: PAPER_WHITE.blush },
        },
        {
          elementId: "title-band",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [36, 348, 560, 156],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
        {
          elementId: "lead",
          elementType: "text",
          bounds: [64, 260, 512, 72],
          content: { text: "让我们一起探索一颗小小的种子如何破土而出", wrap: true },
        },
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 180, 860, 64],
          content: { text: "种子怎么发芽", bold: true, fontSize: 36 },
        },
      ],
    };
    const next = ensureOfficialRecipePage(twoCircles, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 0,
    });
    const ellipses = next.page.elements.filter((el) => {
      return el.elementType === "shape" && (el as { shapeName?: string }).shapeName === "ellipse";
    });
    const title = next.page.elements.find((el) => el.elementId === "title") as
      { content?: { text?: string }; bounds: number[] } | undefined;
    const band = next.page.elements.find((el) => el.elementId === "title-band");
    assert.equal(ellipses.length, 1);
    assert.ok((ellipses[0]?.bounds[2] ?? 0) >= 280);
    assert.equal(title?.content?.text, "种子怎么发芽");
    assert.ok((title?.bounds[1] ?? 0) >= (band?.bounds[1] ?? 9999));
    assert.doesNotMatch(JSON.stringify(next.page.elements), /让我们一起探索/);
    assert.equal(next.painted, false);
  });

  it("lands route list pills onto official rule+chapter chrome", () => {
    const pills: SkillPageInput = {
      id: "page-02",
      pageType: "route",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 28, 720, 52],
          content: { text: "探究之旅", bold: true, fontSize: 32, color: PAPER_WHITE.title },
        },
        {
          elementId: "panel-0",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [48, 112, 864, 80],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
        {
          elementId: "well-0",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [68, 128, 48, 48],
          fill: { type: "solid", color: PAPER_WHITE.white },
        },
      ],
    };
    const next = ensureOfficialRecipePage(pills, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 1,
    });
    assert.ok(next.page.elements.some((el) => el.elementId === "rule"));
    assert.ok(next.page.elements.some((el) => el.elementId === "chapter"));
    assert.ok(next.page.elements.some((el) => el.elementId === "path-spine"));
    assert.equal(
      next.page.elements.some((el) => el.elementId === "panel-0"),
      false,
    );
    const names = next.page.elements
      .filter((el) => el.elementId.startsWith("item-n-"))
      .map((el) => (el as { content?: { text?: string } }).content?.text ?? "");
    assert.deepEqual(names, ["先喝饱水", "种皮裂开", "小根钻出来", "芽顶出土"]);
    assert.equal(next.painted, false);
  });

  it("does not mash leftover route titles onto a second note list", () => {
    const mashed: SkillPageInput = {
      id: "page-02",
      pageType: "route",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 28, 720, 52],
          content: { text: "探索种子的奥秘", bold: true },
        },
        {
          elementId: "item-n-0",
          elementType: "text",
          bounds: [136, 124, 740, 28],
          content: { text: "01" },
        },
        {
          elementId: "item-n-1",
          elementType: "text",
          bounds: [136, 212, 740, 28],
          content: { text: "认识种子：小小的身躯里藏着什么秘密？" },
        },
        {
          elementId: "item-d-1",
          elementType: "text",
          bounds: [136, 242, 740, 28],
          content: { text: "软了之后，壳会裂开一条缝。" },
        },
        {
          elementId: "panel-0",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [48, 112, 864, 80],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
      ],
    };
    const next = ensureOfficialRecipePage(mashed, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 1,
    });
    const blob = JSON.stringify(next.page.elements);
    assert.match(blob, /先喝饱水/);
    assert.doesNotMatch(blob, /认识种子|发芽条件/);
    assert.equal(
      next.page.elements.some(
        (el) =>
          el.elementId.startsWith("item-n-") &&
          /^[0-9]{1,2}$/.test((el as { content?: { text?: string } }).content?.text ?? ""),
      ),
      false,
    );
    assert.equal(
      next.page.elements.some((el) => el.elementId === "panel-0"),
      false,
    );
    assert.ok(next.page.elements.some((el) => el.elementId === "path-spine"));
  });

  it("concept lists seed parts, not germination conditions", () => {
    const wrong: SkillPageInput = {
      id: "page-03",
      pageType: "concept",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 28, 720, 52],
          content: { text: "种子里面有什么", bold: true },
        },
        {
          elementId: "aside",
          elementType: "shape",
          shapeName: "rect",
          bounds: [480, 116, 432, 360],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
        {
          elementId: "ring-outer",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [560, 196, 200, 140],
          fill: { type: "solid", color: PAPER_WHITE.blush },
        },
        {
          elementId: "rule",
          elementType: "shape",
          shapeName: "rect",
          bounds: [48, 88, 72, 6],
          fill: { type: "solid", color: PAPER_WHITE.coral },
        },
        {
          elementId: "l1",
          elementType: "text",
          bounds: [48, 236, 400, 72],
          content: { text: "适量的水" },
        },
        {
          elementId: "l2",
          elementType: "text",
          bounds: [48, 316, 400, 72],
          content: { text: "充足的空气" },
        },
        {
          elementId: "l3",
          elementType: "text",
          bounds: [48, 396, 400, 72],
          content: { text: "合适的温度" },
        },
      ],
    };
    const next = ensureOfficialRecipePage(wrong, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    const blob = JSON.stringify(next.page.elements);
    assert.match(blob, /种皮/);
    assert.match(blob, /子叶/);
    assert.match(blob, /胚/);
    assert.doesNotMatch(blob, /适量的水|充足的空气|合适的温度/);
    assert.ok(next.page.elements.some((el) => el.elementId === "aside"));
    assert.ok(next.page.elements.some((el) => el.elementId === "ring-outer"));
  });

  it("lands concept list pills onto the official editorial recipe", () => {
    const pills: SkillPageInput = {
      id: "page-03",
      pageType: "concept",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 28, 720, 52],
          content: { text: "种子里面有什么", bold: true, fontSize: 32, color: PAPER_WHITE.title },
        },
        {
          elementId: "panel-0",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [48, 112, 864, 80],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
        {
          elementId: "well-0",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [68, 128, 48, 48],
          fill: { type: "solid", color: PAPER_WHITE.white },
        },
      ],
    };
    const next = ensureOfficialRecipePage(pills, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    assert.ok(next.page.elements.some((el) => el.elementId === "aside"));
    assert.ok(next.page.elements.some((el) => el.elementId === "ring-outer"));
    assert.ok(next.page.elements.some((el) => el.elementId === "rule"));
    assert.equal(
      next.page.elements.some((el) => el.elementId === "panel-0"),
      false,
    );
    assert.equal(next.painted, false);
  });

  it("does not restamp a page that already matches the official recipe", () => {
    const good = paintOfficialRecipePage(creamWall, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    const again = ensureOfficialRecipePage(good, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    assert.equal(again.applied, false);
    assert.equal(again.page, good);
  });

  it("restamps leftover two-column cover + seed doodle onto the official cover", () => {
    const leftoverCover: SkillPageInput = {
      id: "page-01",
      pageType: "cover",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "panel",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [36, 36, 430, 468],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
        {
          elementId: "chip",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [56, 56, 72, 72],
          fill: { type: "solid", color: PAPER_WHITE.coral },
        },
        {
          elementId: "title",
          elementType: "text",
          bounds: [56, 150, 390, 150],
          content: { text: "种子怎么发芽", bold: true, fontSize: 34, color: PAPER_WHITE.title },
        },
        {
          elementId: "stage",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [500, 80, 420, 380],
          fill: { type: "solid", color: PAPER_WHITE.blush },
        },
        {
          elementId: "cover-soil",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [626, 298, 168, 52],
          fill: { type: "solid", color: "#8B5A2B" },
        },
        {
          elementId: "cover-sun",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [754, 180, 40, 40],
          fill: { type: "solid", color: "#F4C542" },
        },
      ],
    };
    assert.equal(hasOfficialRecipe(leftoverCover.elements), false);
    const next = ensureOfficialRecipePage(leftoverCover, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 0,
    });
    assert.equal(next.applied, true);
    assert.equal(next.painted, false);
    assert.ok(next.page.elements.some((el) => el.elementId === "circle"));
    assert.ok(next.page.elements.some((el) => el.elementId === "title-band"));
    assert.equal(hasKidsDoodle(next.page.elements), false);
    assert.equal(
      next.page.elements.some((el) => el.elementId === "cover-stem"),
      false,
    );
  });

  it("restamps leftover seed-anatomy concept onto the official editorial recipe", () => {
    const leftoverConcept: SkillPageInput = {
      id: "page-03",
      pageType: "concept",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "rule",
          elementType: "shape",
          shapeName: "rect",
          bounds: [48, 86, 88, 8],
          fill: { type: "solid", color: PAPER_WHITE.coral },
        },
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 28, 860, 52],
          content: { text: "种子里面有什么", bold: true, fontSize: 30, color: PAPER_WHITE.title },
        },
        {
          elementId: "stage",
          elementType: "shape",
          shapeName: "roundRect",
          bounds: [40, 120, 420, 360],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
        {
          elementId: "seed",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [130, 210, 220, 120],
          fill: { type: "solid", color: "#C4A35A" },
        },
        {
          elementId: "cot",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [176, 232, 128, 76],
          fill: { type: "solid", color: PAPER_WHITE.blush },
        },
        {
          elementId: "embryo",
          elementType: "shape",
          shapeName: "ellipse",
          bounds: [214, 250, 48, 36],
          fill: { type: "solid", color: "#6B9F3A" },
        },
      ],
    };
    assert.equal(hasOfficialRecipe(leftoverConcept.elements), false);
    const next = ensureOfficialRecipePage(leftoverConcept, {
      brief: "给二年级讲一讲种子怎么发芽",
      index: 2,
    });
    assert.equal(next.applied, true);
    assert.equal(next.painted, false);
    assert.ok(next.page.elements.some((el) => el.elementId === "aside"));
    assert.ok(next.page.elements.some((el) => el.elementId === "ring-outer"));
    assert.equal(
      leftoverConcept.elements.some((el) => el.elementId === "seed"),
      true,
    );
    assert.equal(
      next.page.elements.some((el) => el.elementId === "seed"),
      false,
    );
  });
});
