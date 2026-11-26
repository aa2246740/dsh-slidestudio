import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  footerZoneTopForSlide,
  type ImageElement,
  type PptdElement,
  type ShapeElement,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import {
  pageGeometryIssues,
  pageHasReadableCopy,
  pageHasVisibleContent,
  reusedFullBleedSrcIssue,
  reviewSkillPages,
  writePageSchemaError,
  writePageSchemaIssues,
} from "./layout-qa.js";
import { pageImageSrcs } from "./page-image-srcs.js";
import { PACK_COLOR_ERROR, packColorWriteContextFrom } from "./theme-pack.js";
import type { SkillPageInput } from "./skill-pages.js";

type Box = [number, number, number, number];

/** A copy of a layout element, as saveProject materialises it onto a using page. */
function fromLayout(element: PptdElement): PptdElement {
  return {
    ...element,
    inherited: { scope: "layout", ownerId: "body", elementId: element.elementId },
  } as PptdElement;
}

function text(id: string, bounds: Box, value: string, layoutRole?: "footer"): PptdElement {
  return {
    elementId: id,
    elementType: "text",
    bounds,
    content: { text: value, fontSize: 18 },
    ...(layoutRole ? { layoutRole } : {}),
  } as TextElement;
}

function image(id: string, bounds: Box, src: string): PptdElement {
  return { elementId: id, elementType: "image", bounds, src } as ImageElement;
}

function shape(id: string, bounds: Box, color: string): PptdElement {
  return {
    elementId: id,
    elementType: "shape",
    shapeName: "rect",
    bounds,
    fill: { type: "solid", color },
  } as ShapeElement;
}

function page(id: string, elements: PptdElement[]): SkillPageInput {
  return { id, pageType: "content", layoutId: "body", elements };
}

describe("layout QA merge rules (VAL-LAYOUT-007)", () => {
  it("a page holding only inherited elements has no visible content or readable copy", () => {
    const copies = page("p2", [
      fromLayout(image("logo", [860, 20, 80, 40], "media/logo.png")),
      fromLayout(text("header", [80, 20, 600, 24], "公司名称")),
    ]);
    assert.equal(pageHasVisibleContent(copies), false);
    assert.equal(pageHasReadableCopy(copies), false);
    const review = reviewSkillPages([copies], { mode: "compose" });
    assert.ok(review.issues.some((issue) => issue.code === "empty" && issue.pageId === "p2"));
  });

  it("an own title over an inherited logo text reports overlap_layout at the severity of an own overlap", () => {
    const withCopy = page("p3", [
      fromLayout(text("header", [600, 20, 300, 40], "页眉")),
      text("title", [620, 30, 200, 40], "标题"),
    ]);
    assert.deepEqual(
      pageGeometryIssues(withCopy).map((issue) => issue.code),
      ["overlap_layout"],
    );
    assert.equal(writePageSchemaError(writePageSchemaIssues(withCopy), withCopy)?.error, "overlap_layout");
    const ownOnly = page("p4", [text("header", [600, 20, 300, 40], "页眉"), text("title", [620, 30, 200, 40], "标题")]);
    assert.equal(writePageSchemaError(writePageSchemaIssues(ownOnly), ownOnly)?.error, "overlap");
  });

  it("the same inherited full-bleed image on many pages does not trigger reused_cover_src", () => {
    const texture = fromLayout(image("bg", [0, 0, 960, 540], "media/texture.png"));
    const second = page("p2", [texture, text("t2", [80, 120, 600, 60], "第二页")]);
    const third = page("p3", [texture, text("t3", [80, 120, 600, 60], "第三页")]);
    const siblings = [{ pageId: "p2", src: "media/texture.png" }];
    assert.equal(reusedFullBleedSrcIssue(third, siblings), undefined);
    assert.equal(
      writePageSchemaError(writePageSchemaIssues(third, { siblingImageSrcs: siblings }), third, {
        siblingImageSrcs: siblings,
      }),
      undefined,
    );
    assert.deepEqual(pageImageSrcs(second), []);
  });

  it("an inherited footer satisfies footer_zone, and an own text in the footer zone is still checked", () => {
    const footerTop = footerZoneTopForSlide(540);
    const inheritedFooter = page("p2", [
      text("title", [80, 120, 600, 60], "标题"),
      fromLayout(text("footer", [80, footerTop + 4, 600, 20], "页脚", "footer")),
      fromLayout(text("pageno", [820, footerTop + 4, 60, 20], "第 2 页")),
    ]);
    assert.equal(
      pageGeometryIssues(inheritedFooter).some((issue) => issue.code === "footer_zone"),
      false,
    );
    const ownNote = page("p3", [
      text("title", [80, 120, 600, 60], "标题"),
      text("note", [80, footerTop + 4, 600, 20], "自己的脚注"),
    ]);
    assert.deepEqual(
      pageGeometryIssues(ownNote).map((issue) => issue.code),
      ["footer_zone"],
    );
    const ownFooter = page("p4", [text("note", [80, footerTop + 4, 600, 20], "脚注", "footer")]);
    assert.equal(
      pageGeometryIssues(ownFooter).some((issue) => issue.code === "footer_zone"),
      false,
    );
  });

  it("layout overflow and pack colour are judged once at write_layout, not on each using page", () => {
    const wideCopy = page("p2", [
      fromLayout(text("header", [800, 20, 300, 30], "超出版心的页眉")),
      text("title", [80, 120, 600, 60], "标题"),
    ]);
    assert.equal(
      pageGeometryIssues(wideCopy).some((issue) => issue.code === "overflow"),
      false,
    );
    const pine = packColorWriteContextFrom({ designSystemId: "consulting/pine-green-strategy" });
    const copyRule = page("p3", [
      fromLayout(shape("rule", [80, 60, 800, 4], "#3366FF")),
      text("title", [80, 120, 600, 60], "标题"),
    ]);
    assert.equal(
      writePageSchemaIssues(copyRule, pine).some((issue) => issue.code === "pack_color"),
      false,
    );
    const ownRule = page("p4", [shape("rule", [80, 60, 800, 4], "#3366FF"), text("title", [80, 120, 600, 60], "标题")]);
    assert.equal(writePageSchemaError(writePageSchemaIssues(ownRule, pine), ownRule, pine)?.error, PACK_COLOR_ERROR);
  });
});
