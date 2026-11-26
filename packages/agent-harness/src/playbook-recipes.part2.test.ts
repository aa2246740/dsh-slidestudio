import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureOfficialRecipePage,
  hasOfficialRecipe,
  paintOfficialRecipePage,
  PAPER_WHITE,
} from "./playbook-recipes.js";
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

describe("official paper-white recipes", () => {
  it("keeps a 勾股 triangle exhibit instead of restamping seed layouts", () => {
    const triangle: SkillPageInput = {
      id: "page-03",
      pageType: "concept",
      background: { type: "solid", color: PAPER_WHITE.paper },
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [48, 28, 860, 52],
          content: { text: "直角边和斜边", bold: true, fontSize: 30, color: PAPER_WHITE.title },
        },
        {
          elementId: "triangle",
          elementType: "shape",
          shapeName: "rtTriangle",
          bounds: [120, 140, 280, 220],
          fill: { type: "solid", color: PAPER_WHITE.leaf },
        },
      ],
    };
    const next = ensureOfficialRecipePage(triangle, {
      brief: "介绍一下勾股定理，面向小学生",
      index: 2,
    });
    assert.equal(next.painted, false);
    assert.ok(next.page.elements.some((el) => el.elementId === "triangle"));
  });

  it("demo uses a pink band and a result bar", () => {
    const demo = paintOfficialRecipePage(
      { ...creamWall, id: "page-05", pageType: "demo" },
      { brief: "给二年级讲一讲种子怎么发芽", index: 4 },
    );
    assert.ok(demo.elements.some((el) => el.elementId === "pink-band"));
    assert.ok(demo.elements.some((el) => el.elementId === "result-bar"));
    assert.equal(hasOfficialRecipe(demo.elements), true);
  });
});
