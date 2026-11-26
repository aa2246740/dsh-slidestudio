import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  type Bounds,
  type DeckLayout,
  type DeckMaster,
  type Page,
  type PptdProject,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import {
  clearSelection,
  openSession,
  renderAllPages,
  renderModel,
  selectElement,
  selectMany,
  tabSelect,
  type CanvasSession,
} from "./index.js";

/*
 * Layout chrome in the editor (VAL-LAYOUT-006, VAL-LAYOUT-012). A copy from a master or layout
 * carries its scope and name. A pageNumber field shows the page's own number and the page total,
 * on copies and on the page's own text alike, while the stored placeholder stays unchanged. Tab,
 * marquee and direct selection never pick a copy.
 */
const CONTROLS = ["selection.tab", "selection.clear"];

function textElement(elementId: string, value: string, bounds: Bounds, field?: "pageNumber"): TextElement {
  return {
    elementId,
    elementType: "text",
    bounds,
    content: field ? { text: value, field } : { text: value },
  };
}

const MASTER: DeckMaster = {
  id: "main",
  name: "母版",
  elements: [
    {
      elementId: "pageno",
      elementType: "text",
      bounds: [880, 506, 60, 22],
      layoutRole: "footer",
      content: { text: "{page}", field: "pageNumber", fontSize: 10 },
    },
  ],
};

const COVER: DeckLayout = {
  id: "cover",
  name: "封面",
  showMasterElements: false,
  elements: [textElement("band", "封面底纹", [0, 0, 960, 40])],
};

const BODY: DeckLayout = {
  id: "body",
  name: "正文",
  masterId: "main",
  elements: [textElement("logo-a", "LOGO A", [24, 12, 120, 40]), textElement("logo-b", "LOGO B", [816, 12, 120, 40])],
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-render-inherited-"));
}

/** The render model's copy marker: the scope and display name of the master or layout. */
function inheritedOf(element: object): { scope: string; name: string } | undefined {
  return (element as { inherited?: { scope: string; name: string } }).inherited;
}

function addPage(project: PptdProject, rel: string, page: Page): void {
  listComposedPage(project, rel, page);
}

/** Six pages: 1 cover, 2 to 5 body, 6 with no layout but its own page-number field. */
function layoutDeck(dir: string): void {
  const project = createEmptyProject(dir, { title: "版式渲染" });
  project.presentation.masters = [MASTER];
  project.presentation.layouts = [COVER, BODY];
  addPage(project, "pages/p1.page", {
    layoutId: "cover",
    elements: [textElement("title", "封面标题", [60, 200, 600, 60])],
  });
  for (let n = 2; n <= 5; n++) {
    addPage(project, `pages/p${n}.page`, {
      layoutId: "body",
      elements: [
        textElement("title", `第 ${n} 页标题`, [60, 80, 600, 60]),
        textElement("body-text", "正文", [60, 160, 600, 200]),
      ],
    });
  }
  addPage(project, "pages/p6.page", {
    elements: [
      textElement("title", "无版式", [60, 80, 600, 60]),
      textElement("own-number", "第 {page} 页 / 共 {pages} 页", [700, 500, 200, 24], "pageNumber"),
      textElement("literal", "{page} 原样", [60, 300, 300, 24]),
    ],
  });
  saveProject(project);
}

/** Two layout pages, each with its own page-number field: a cover (1) and a body page (2). */
function ownNumberDeck(dir: string): void {
  const project = createEmptyProject(dir, { title: "页码归属" });
  project.presentation.masters = [MASTER];
  project.presentation.layouts = [COVER, BODY];
  addPage(project, "pages/p1.page", {
    layoutId: "cover",
    elements: [
      textElement("title", "封面标题", [60, 200, 600, 60]),
      textElement("own-number", "第 {page} 页", [700, 500, 200, 24], "pageNumber"),
    ],
  });
  addPage(project, "pages/p2.page", {
    layoutId: "body",
    elements: [
      textElement("title", "第二页标题", [60, 80, 600, 60]),
      textElement("own-number", "第 {page} 页 / 共 {pages} 页", [700, 500, 200, 24], "pageNumber"),
    ],
  });
  saveProject(project);
}

function sessionAt(dir: string, pageIndex: number): CanvasSession {
  const s = openSession(dir, { allowedControlIds: CONTROLS });
  s.pageIndex = pageIndex;
  return s;
}

describe("layout chrome in the editor (VAL-LAYOUT-006, VAL-LAYOUT-012)", () => {
  it("marks each copy with its scope and name and leaves own content unmarked", () => {
    const dir = tmp();
    layoutDeck(dir);
    const page = renderModel(sessionAt(dir, 1));
    assert.deepEqual(
      page.elements.filter((e) => inheritedOf(e) !== undefined).map((e) => [e.id, inheritedOf(e)]),
      [
        ["mst-main-pageno", { scope: "master", name: "母版", ownerId: "main", elementId: "pageno" }],
        ["lyt-body-logo-a", { scope: "layout", name: "正文", ownerId: "body", elementId: "logo-a" }],
        ["lyt-body-logo-b", { scope: "layout", name: "正文", ownerId: "body", elementId: "logo-b" }],
      ],
    );
    const own = page.elements.find((e) => e.id === "title")!;
    assert.equal("inherited" in own, false, "own elements carry no inherited key");
  });

  it("shows each page's own number on its copies and on its own page-number field", () => {
    const dir = tmp();
    layoutDeck(dir);
    assert.equal(renderModel(sessionAt(dir, 1)).elements.find((e) => e.id === "mst-main-pageno")!.text, "2");
    assert.equal(renderModel(sessionAt(dir, 4)).elements.find((e) => e.id === "mst-main-pageno")!.text, "5");
    const sixth = renderModel(sessionAt(dir, 5)).elements.find((e) => e.id === "own-number")!;
    assert.equal(sixth.text, "第 6 页 / 共 6 页");
    assert.equal(
      sixth.runs?.map((run) => run.text).join(""),
      "第 6 页 / 共 6 页",
      "the runs carry the same substituted text as the text",
    );
  });

  it("keeps literal tokens without the field and never rewrites the stored placeholder", () => {
    const dir = tmp();
    layoutDeck(dir);
    const sixthSession = sessionAt(dir, 5);
    assert.equal(renderModel(sixthSession).elements.find((e) => e.id === "literal")!.text, "{page} 原样");
    const stored = sixthSession.project.pages[5]!.page.elements;
    assert.equal(
      (stored.find((e) => e.elementId === "own-number") as TextElement).content.text,
      "第 {page} 页 / 共 {pages} 页",
    );
    const second = sessionAt(dir, 1);
    renderModel(second);
    assert.equal(
      (second.project.pages[1]!.page.elements.find((e) => e.elementId === "mst-main-pageno") as TextElement).content
        .text,
      "{page}",
    );
  });

  it("hides the master number on a cover whose layout hides master elements", () => {
    const dir = tmp();
    layoutDeck(dir);
    const cover = renderModel(sessionAt(dir, 0));
    assert.equal(
      cover.elements.some((e) => e.id === "mst-main-pageno"),
      false,
    );
    const band = cover.elements.find((e) => e.id === "lyt-cover-band")!;
    assert.equal(inheritedOf(band)?.scope, "layout");
  });

  it("gives thumbnails the chrome with each page's own number", () => {
    const dir = tmp();
    layoutDeck(dir);
    const thumbs = renderAllPages(sessionAt(dir, 0));
    assert.deepEqual(
      thumbs.map((thumb) => thumb.elements.find((e) => e.id === "mst-main-pageno")?.text),
      [undefined, "2", "3", "4", "5", undefined],
    );
    assert.equal(thumbs[5]!.elements.find((e) => e.id === "own-number")!.text, "第 6 页 / 共 6 页");
  });

  it("page-owned numbers count their own position on the cover and on layout pages", () => {
    const dir = tmp();
    ownNumberDeck(dir);
    const cover = renderModel(sessionAt(dir, 0));
    assert.equal(cover.elements.find((e) => e.id === "own-number")!.text, "第 1 页");
    const body = renderModel(sessionAt(dir, 1));
    const ownBody = body.elements.find((e) => e.id === "own-number")!;
    assert.equal(ownBody.text, "第 2 页 / 共 2 页");
    assert.equal(inheritedOf(ownBody), undefined, "the page's own number is not a copy");
    assert.deepEqual(
      renderAllPages(sessionAt(dir, 0)).map((thumb) => thumb.elements.find((e) => e.id === "own-number")?.text),
      ["第 1 页", "第 2 页 / 共 2 页"],
    );
  });

  it("a page without a layout has no copies", () => {
    const dir = tmp();
    layoutDeck(dir);
    const plain = renderModel(sessionAt(dir, 5));
    assert.equal(
      plain.elements.some((e) => inheritedOf(e) !== undefined),
      false,
    );
  });

  it("tab and direct selection skip layout copies", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 1);
    clearSelection(s);
    const steps: string[] = [];
    for (let i = 0; i < 3; i++) {
      tabSelect(s, "selection.tab", 1);
      const sel = renderModel(s).selection;
      steps.push(sel.kind === "element" ? sel.elementId : sel.kind);
    }
    assert.deepEqual(steps, ["title", "body-text", "none"]);
    selectMany(s, ["mst-main-pageno", "title", "lyt-body-logo-a"]);
    assert.deepEqual(renderModel(s).selection, {
      kind: "element",
      pageIndex: 1,
      elementId: "title",
    });
    assert.throws(() => selectElement(s, "lyt-body-logo-a"), /版式和母版的元素只能在版式中修改，不能在页面上选中/);
  });
});
