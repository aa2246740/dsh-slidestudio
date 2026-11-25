import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { layoutDuplicateIssues } from "./layout-duplicates.js";
import type { DeckLayout, Page, PptdElement, Presentation } from "./types.js";

const LOGO_SRC = "assets/logo.png";
const BODY: DeckLayout = {
  id: "body",
  name: "正文",
  elements: [
    {
      elementId: "logo",
      elementType: "image",
      bounds: [860, 20, 80, 40],
      src: LOGO_SRC,
    } as PptdElement,
  ],
};

function deck(): Presentation {
  return { version: "v2", size: [960, 540], pages: [], layouts: [BODY] };
}

function image(elementId: string, src: string, x: number, y: number): PptdElement {
  return { elementId, elementType: "image", bounds: [x, y, 80, 40], src } as PptdElement;
}

/** `null` means a page without a layout; an omitted argument is the layout "body". */
function page(elements: PptdElement[], layoutId: string | null = "body"): Page {
  return { elements, ...(layoutId === null ? {} : { layoutId }) } as Page;
}

describe("layoutDuplicateIssues: a page must not redraw an element its layout already shows", () => {
  it("rejects an own image with the layout logo's src within 4 px, in Chinese", () => {
    const issues = layoutDuplicateIssues(deck(), page([image("my-logo", LOGO_SRC, 864, 20)]));
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ["duplicate_layout_element"],
    );
    assert.match(issues[0]!.detail, /已在版式『正文』里，不要在页面上重复画/);
  });

  it("names a repeated logo as Logo, the wording the model and the editor show", () => {
    const issues = layoutDuplicateIssues(deck(), page([image("my-logo", LOGO_SRC, 864, 20)]));
    assert.equal(issues[0]!.detail, "Logo 已在版式『正文』里，不要在页面上重复画");
  });

  it("names a repeated picture that is not a logo by its kind, not by the layout id", () => {
    const frame: DeckLayout = {
      id: "frame",
      name: "图框",
      elements: [
        {
          elementId: "photo-frame",
          elementType: "image",
          bounds: [100, 100, 80, 40],
          src: "assets/frame.png",
        } as PptdElement,
      ],
    };
    const issues = layoutDuplicateIssues(
      { version: "v2", size: [960, 540], pages: [], layouts: [frame] },
      page([image("own-frame", "assets/frame.png", 100, 100)], "frame"),
    );
    assert.equal(issues[0]!.detail, "这张图片已在版式『图框』里，不要在页面上重复画");
  });

  it("accepts the same src 5 px away from the layout logo", () => {
    assert.deepEqual(layoutDuplicateIssues(deck(), page([image("my-logo", LOGO_SRC, 865, 20)])), []);
  });

  it("accepts a different src at the same position", () => {
    assert.deepEqual(layoutDuplicateIssues(deck(), page([image("my-photo", "assets/photo.png", 860, 20)])), []);
  });

  it("ignores pages without a layout and copies the page already carries", () => {
    const own = image("my-logo", LOGO_SRC, 860, 20);
    assert.deepEqual(layoutDuplicateIssues(deck(), page([own], null)), []);
    const copy = {
      ...image("lyt-body-logo", LOGO_SRC, 860, 20),
      inherited: { scope: "layout", ownerId: "body", elementId: "logo" },
    } as PptdElement;
    assert.deepEqual(layoutDuplicateIssues(deck(), page([copy])), []);
  });

  it("does not match a dangling layoutId, which layoutReferenceIssues reports instead", () => {
    assert.deepEqual(layoutDuplicateIssues(deck(), page([image("my-logo", LOGO_SRC, 860, 20)], "nope")), []);
  });
});
