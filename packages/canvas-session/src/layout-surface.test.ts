import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  ownPageBody,
  saveProject,
  type Bounds,
  type DeckLayout,
  type DeckMaster,
  type Page,
  type PptdElement,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import {
  applyPageLayout,
  createLayout,
  deleteLayout,
  enterLayout,
  enterMaster,
  exitLayout,
  insertChart,
  insertPageNumber,
  insertSmartArt,
  insertTable,
  layoutPanel,
  openSession,
  persist,
  renameLayout,
  renderAllPages,
  renderModel,
  selectElement,
  setPageBackground,
  setSelectedBounds,
  undo,
  undoLayoutMark,
  addBlankPage,
  type CanvasSession,
} from "./index.js";

/*
 * Layout mode in the canvas session (masters-layouts §5). A layout or the master is edited on its
 * own surface; every layout command is one undo step; pages that use the layout follow on save.
 */
const CONTROLS = [
  "theme.layout.enter",
  "theme.layout.exit",
  "theme.layout.select",
  "theme.layout.create",
  "theme.layout.rename",
  "theme.layout.delete",
  "theme.layout.apply",
  "insert.pagenumber",
  "insert.table",
  "insert.chart",
  "insert.smartart",
  "pages.add",
  "element.move",
  "theme.background.set",
  "chrome.history.undo",
];

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-layout-surface-"));
}

/** Page 1 is a cover; pages 2 to 5 use the body layout; page 6 has no layout. */
function layoutDeck(dir: string): void {
  const project = createEmptyProject(dir, { title: "版式编辑" });
  project.presentation.masters = [MASTER];
  project.presentation.layouts = [COVER, BODY];
  const add = (rel: string, page: Page): void => listComposedPage(project, rel, page);
  add("pages/p1.page", {
    layoutId: "cover",
    elements: [textElement("title", "封面标题", [60, 200, 600, 60])],
  });
  for (let n = 2; n <= 5; n++) {
    add(`pages/p${n}.page`, {
      layoutId: "body",
      elements: [
        textElement("title", `第 ${n} 页标题`, [60, 80, 600, 60]),
        textElement("body-text", "正文", [60, 160, 600, 200]),
      ],
    });
  }
  add("pages/p6.page", {
    elements: [textElement("title", "无版式", [60, 80, 600, 60])],
  });
  saveProject(project);
}

function sessionAt(dir: string, pageIndex: number): CanvasSession {
  const s = openSession(dir, { allowedControlIds: CONTROLS });
  s.pageIndex = pageIndex;
  return s;
}

function elementIds(elements: PptdElement[]): string[] {
  return elements.map((el) => el.elementId);
}

function bodyLayout(s: CanvasSession): DeckLayout {
  const layout = s.project.presentation.layouts?.find((item) => item.id === "body");
  assert.ok(layout, "the body layout exists");
  return layout;
}

describe("layout surface (VAL-LAYOUT-013, VAL-LAYOUT-014)", () => {
  it("enters a layout with the copied element selected, and leaving makes no undo step", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body", "logo-b");
    assert.deepEqual(s.surface, { kind: "layout", layoutId: "body" });
    assert.deepEqual(s.selection, { kind: "element", pageIndex: 2, elementId: "logo-b" });
    assert.equal(s.undoStack.length, 0, "entering a layout is navigation, not an edit");
    exitLayout(s, "theme.layout.exit");
    assert.deepEqual(s.surface, { kind: "page" });
    assert.equal(s.undoStack.length, 0);
  });

  it("a layout move reaches every using page after save, is one undo step, and keeps own content", () => {
    const dir = tmp();
    layoutDeck(dir);
    const before = loadProject(dir);
    const ownBefore = JSON.stringify(ownPageBody(before.pages[2]!.page));
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body", "logo-b");
    setSelectedBounds(s, "element.move", [776, 12, 120, 40]);
    assert.equal(s.undoStack.length, 1, "the move is one undo step");
    assert.equal(undoLayoutMark(s)?.name, "正文", "the step is named after the layout");
    exitLayout(s, "theme.layout.exit");
    persist(s);

    const after = loadProject(dir);
    for (const index of [1, 2, 3, 4]) {
      const copy = after.pages[index]!.page.elements.find((el) => el.elementId === "lyt-body-logo-b");
      assert.deepEqual(copy?.bounds, [776, 12, 120, 40], `body page ${index + 1} follows`);
    }
    const cover = after.pages[0]!.page.elements;
    assert.equal(
      cover.some((el) => el.elementId === "lyt-body-logo-b"),
      false,
      "the cover does not use the body layout",
    );
    assert.equal(
      after.pages[5]!.page.elements.some((el) => el.inherited !== undefined),
      false,
      "page 6 has no layout and gains no copies",
    );
    assert.equal(JSON.stringify(ownPageBody(after.pages[2]!.page)), ownBefore);

    const reopened = sessionAt(dir, 2);
    enterLayout(reopened, "theme.layout.enter", "body", "logo-b");
    assert.equal(undo(reopened, "chrome.history.undo"), false, "the reopened session has no history");
  });

  it("undoing a layout move restores the definition and every page copy", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body", "logo-b");
    setSelectedBounds(s, "element.move", [776, 12, 120, 40]);
    exitLayout(s, "theme.layout.exit");
    assert.equal(undo(s, "chrome.history.undo"), true);
    assert.deepEqual(bodyLayout(s).elements[1]!.bounds, [816, 12, 120, 40]);
    persist(s);
    const after = loadProject(dir);
    const copy = after.pages[2]!.page.elements.find((el) => el.elementId === "lyt-body-logo-b");
    assert.deepEqual(copy?.bounds, [816, 12, 120, 40]);
  });

  it("undo from page mode names the layout and keeps the page surface", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body", "logo-b");
    setSelectedBounds(s, "element.move", [776, 12, 120, 40]);
    exitLayout(s, "theme.layout.exit");
    assert.equal(undoLayoutMark(s)?.name, "正文");
    assert.equal(undo(s, "chrome.history.undo"), true);
    assert.deepEqual(s.surface, { kind: "page" }, "undo does not switch into the layout");
  });

  it("creates a layout that uses the master, and renames it with the schema's rules", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 0);
    const id = createLayout(s, "theme.layout.create");
    assert.equal(id, "layout-2");
    assert.deepEqual(s.surface, { kind: "layout", layoutId: "layout-2" });
    assert.equal(bodyLayout(s).name, "正文", "other layouts are unchanged");
    const created = s.project.presentation.layouts?.find((layout) => layout.id === id);
    assert.equal(created?.masterId, "main");
    assert.equal(created?.name, "新版式 3");
    assert.deepEqual(
      layoutPanel(s).layouts.map((row) => [row.id, row.useCount]),
      [
        ["cover", 1],
        ["body", 4],
        ["layout-2", 0],
      ],
    );

    assert.throws(() => renameLayout(s, "theme.layout.rename", id, "  "), /版式名称不能为空/);
    assert.throws(() => renameLayout(s, "theme.layout.rename", id, "甲".repeat(25)), /版式名称最多 24 个字/);
    assert.throws(() => renameLayout(s, "theme.layout.rename", id, "A&B"), /不能包含/);
    const undoSteps = s.undoStack.length;
    renameLayout(s, "theme.layout.rename", id, "数据页");
    assert.equal(created?.name, "数据页");
    assert.equal(s.undoStack.length, undoSteps + 1, "a rename is one undo step");
  });

  it("deletes an unused layout at once, but needs confirmation before it removes a used one", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    const id = createLayout(s, "theme.layout.create");
    exitLayout(s, "theme.layout.exit");
    deleteLayout(s, "theme.layout.delete", id);
    assert.equal(
      s.project.presentation.layouts?.some((layout) => layout.id === id),
      false,
    );

    assert.throws(
      () => deleteLayout(s, "theme.layout.delete", "body"),
      /版式『正文』正在使用，删除后 4 页会失去版式内容，请确认后删除/,
    );
    assert.equal(bodyLayout(s).id, "body", "an unconfirmed delete keeps the layout");

    deleteLayout(s, "theme.layout.delete", "body", true);
    const pages = s.project.pages.map(({ page }) => page);
    assert.equal(
      pages.some((page) => page.layoutId === "body"),
      false,
      "pages lose the layout",
    );
    assert.equal(
      pages.some((page) => page.elements.some((el) => el.inherited?.ownerId === "body")),
      false,
      "copies of the deleted layout are gone",
    );
    assert.ok(
      pages[1]!.elements.some((el) => el.elementId === "title"),
      "own content stays",
    );
  });

  it("无版式 removes the copies and keeps the page's own content; choosing a layout restores them", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    applyPageLayout(s, "theme.layout.apply", null);
    const page = s.project.pages[2]!.page;
    assert.equal(page.layoutId, undefined);
    assert.equal(
      page.elements.some((el) => el.inherited !== undefined),
      false,
      "no copies remain",
    );
    assert.deepEqual(elementIds(page.elements).sort(), ["body-text", "title"], "own content is kept");
    assert.equal(undo(s, "chrome.history.undo"), true);
    applyPageLayout(s, "theme.layout.apply", "body");
    assert.equal(
      s.project.pages[2]!.page.elements.some((el) => el.elementId === "lyt-body-logo-a"),
      true,
    );
  });

  it("the page number field shows ‹#› on a layout and the page's own number on a page", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body");
    const id = insertPageNumber(s, "insert.pagenumber");
    assert.equal(id, "pagenumber-1");
    const onLayout = renderModel(s).elements.find((el) => el.id === id);
    assert.equal(onLayout?.text, "‹#›");
    exitLayout(s, "theme.layout.exit");
    insertPageNumber(s, "insert.pagenumber");
    const onPage = renderModel(s).elements.find((el) => el.id === "pagenumber-1");
    assert.equal(onPage?.text, "3");
  });

  it("charts, tables and SmartArt are refused on a layout and allowed on a page", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body");
    const refusal = /版式里不能放图表、表格或 SmartArt/;
    assert.throws(() => insertTable(s, "insert.table"), refusal);
    assert.throws(() => insertChart(s, "insert.chart"), refusal);
    assert.throws(() => insertSmartArt(s, "insert.smartart"), refusal);
    exitLayout(s, "theme.layout.exit");
    insertTable(s, "insert.table");
    assert.equal(s.project.pages[2]!.page.elements.at(-1)?.elementType, "table");
  });

  it("a new page keeps the current layout, and no page can be added from a layout", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body");
    assert.throws(() => addBlankPage(s, "pages.add"), /请先点击「完成」退出版式编辑，再新增页面/);
    exitLayout(s, "theme.layout.exit");
    addBlankPage(s, "pages.add");
    const added = s.project.pages.at(-1)!.page;
    assert.equal(added.layoutId, "body");
    assert.equal(added.background, undefined, "the layout supplies the background");
  });

  it("a background set on a page stays that page's own through a layout refresh", () => {
    const dir = tmp();
    layoutDeck(dir);
    const project = loadProject(dir);
    project.presentation.layouts![1]!.background = { type: "solid", color: "#EEEEEE" };
    saveProject(project);
    const s = sessionAt(dir, 2);
    assert.equal(s.project.pages[2]!.page.backgroundInherited, true);
    setPageBackground(s, "theme.background.set", "#FFFFFF");
    persist(s);
    const after = loadProject(dir).pages[2]!.page;
    assert.equal(after.background?.type, "solid");
    assert.equal(after.background?.type === "solid" ? after.background.color : undefined, "#FFFFFF");
    assert.equal(after.backgroundInherited, undefined);
  });

  it("thumbnails keep showing pages while a layout is open", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body");
    const thumbs = renderAllPages(s);
    assert.equal(thumbs.length, 6);
    assert.equal(thumbs[1]!.elements.find((el) => el.id === "mst-main-pageno")?.text, "2");
    assert.equal(s.surface.kind, "layout", "rendering does not change the surface");
  });

  it("a layout shows the master's elements as view-only copies that are never stored", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    enterLayout(s, "theme.layout.enter", "body");
    const copy = renderModel(s).elements.find((el) => el.id === "mst-main-pageno");
    assert.deepEqual(copy?.inherited, {
      scope: "master",
      name: "母版",
      ownerId: "main",
      elementId: "pageno",
    });
    assert.equal(
      bodyLayout(s).elements.some((el) => el.elementId.startsWith("mst-")),
      false,
    );
    assert.throws(
      () => selectElement(s, "mst-main-pageno"),
      /element not found: mst-main-pageno/,
      "a master copy is drawn on the layout but is not an element the layout can select",
    );
  });

  it("the layout panel lists the master and every layout, and names the page's layout", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = sessionAt(dir, 2);
    const panel = layoutPanel(s);
    assert.deepEqual(panel.master, { id: "main", name: "母版" });
    assert.deepEqual(panel.layouts, [
      { id: "cover", name: "封面", useCount: 1 },
      { id: "body", name: "正文", useCount: 4 },
    ]);
    assert.equal(panel.pageLayoutId, "body");
    assert.deepEqual(panel.surface, { kind: "page" });
    enterMaster(s, "theme.layout.select");
    assert.deepEqual(layoutPanel(s).surface, { kind: "master", name: "母版" });
  });

  it("refuses a layout command whose control is not allowed", () => {
    const dir = tmp();
    layoutDeck(dir);
    const s = openSession(dir, { allowedControlIds: [] });
    assert.throws(() => enterLayout(s, "theme.layout.enter", "body"), /control not allowed/);
  });
});
