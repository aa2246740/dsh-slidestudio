import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  loadProject,
  saveProject,
  titleOnlyCoverPage,
  type PptdProject,
} from "@open-slidestudio/pptd-v2";
import {
  openSession,
  selectElement,
  setSelectedText,
  setSelectedBold,
  setSelectedBounds,
  persist,
  renderModel,
  currentPage,
  goToPage,
  pageCount,
  undo,
  redo,
  zoomBy,
  addBlankPage,
  deletePage,
  duplicatePage,
  reorderPages,
  setZoomPercent,
  setPageRailOpen,
  setNotesOpen,
  setPresenting,
  insertText,
  MAX_INSERT_TEXT_LENGTH,
  insertShape,
  insertImage,
  applyNaturalRefine,
  alignSelected,
  distributeSelected,
  flipSelected,
  insertTable,
  MAX_INSERT_TABLE_SIZE,
  insertChart,
  insertLine,
  insertIcon,
  insertSmartArt,
  addSmartArtNode,
  deleteSmartArtNode,
  setSmartArtLayout,
  deleteSelected,
  duplicateSelected,
  copySelected,
  pasteClipboard,
  setSelectedTextStyle,
  setSelectedFill,
  setSelectedRotation,
  setTableCellText,
  addTableRow,
  setChartType,
  setChartData,
  setPageBackground,
  setThemeColor,
  setSelectedLocked,
  setSelectedHidden,
  groupSelected,
  ungroupSelected,
  rebuildSelectedImage,
  setSelectedShadow,
  setTableCellAlign,
  addTableCol,
  deleteTableRow,
  deleteTableCol,
  mergeTableCells,
  setTableCellFill,
  arrangeSelected,
  setSelectedOpacity,
  setChartAxis,
  setChartLabels,
  setPageNotes,
  setPageNotesAt,
  setElementAnimation,
  setImageSrc,
  setIconName,
  setLineArrow,
  setSelectedAdjustments,
  setImageCrop,
  setImageCropShape,
  setLineCurve,
  setLineLabel,
  setLinePoints,
  setPageAnimations,
  selectMany,
  tabSelect,
  clearSelection,
  setChartLegend,
  setChartSeriesFill,
} from "./index.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-"));
}

function listedCoverProject(dir: string, opts: { title?: string } = {}): PptdProject {
  const title = opts.title ?? "Untitled";
  const project = createEmptyProject(dir, { title });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage(title));
  saveProject(project);
  return project;
}

function appendTextPage(project: PptdProject, pathName: string, elementId: string, text: string): void {
  project.presentation.pages.push(pathName);
  project.pages.push({
    path: pathName,
    page: {
      elements: [
        {
          elementId,
          elementType: "text",
          bounds: [0, 0, 100, 40],
          content: { text },
        },
      ],
    },
  });
}

/** Minimal valid PNG (IHDR only) with the given dimensions. */
function makePng(w: number, h: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  ihdr.writeUInt32BE(0, 21);
  return Buffer.concat([sig, ihdr]);
}

const ALLOW = [
  "element.text.content.set",
  "element.text.toolbar.bold.toggle",
  "element.bounds.set",
  "chrome.history.undo",
  "chrome.history.redo",
];

describe("canvas-session", () => {
  it("blocks controls without oracle allowlist", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "Hi" });
    const s = openSession(dir, { allowedControlIds: [] });
    selectElement(s, "title");
    assert.throws(() => setSelectedText(s, "element.text.content.set", "X"), /not allowed/);
  });

  it("edits text when control allowed and persists PPTD", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "Hi" });
    const s = openSession(dir, { allowedControlIds: ALLOW });
    selectElement(s, "title");
    setSelectedText(s, "element.text.content.set", "新标题");
    persist(s);
    const again = loadProject(dir);
    const t = again.pages[0]!.page.elements[0] as {
      content: { text: string };
    };
    assert.equal(t.content.text, "新标题");
    const model = renderModel(s);
    assert.equal(model.elements[0]!.text, "新标题");
  });

  it("infers the canvas surface from a full-slide backdrop shape", () => {
    const dir = tmp();
    const project = listedCoverProject(dir, { title: "Dark" });
    project.pages[0]!.page.elements.unshift({
      elementId: "bg",
      elementType: "shape",
      bounds: [0, 0, 960, 540],
      shapeName: "rect",
      fill: { type: "solid", color: "#0B1F3A" },
    });
    saveProject(project);

    const surface = renderModel(openSession(dir));

    assert.equal(surface.backgroundCss, "#0B1F3A");
  });

  it("toggles bold, moves bounds, and undoes", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "Hi" });
    const s = openSession(dir, { allowedControlIds: ALLOW });
    selectElement(s, "title");
    setSelectedBold(s, "element.text.toolbar.bold.toggle", true);
    setSelectedBounds(s, "element.bounds.set", [10, 20, 300, 50]);
    assert.equal(renderModel(s).elements[0]!.bold, true);
    assert.deepEqual(renderModel(s).elements[0]!.bounds, [10, 20, 300, 50]);
    assert.equal(undo(s), true);
    assert.notDeepEqual(renderModel(s).elements[0]!.bounds, [10, 20, 300, 50]);
    assert.equal(redo(s), true);
    assert.deepEqual(renderModel(s).elements[0]!.bounds, [10, 20, 300, 50]);
  });

  it("navigates pages", () => {
    const dir = tmp();
    const p = listedCoverProject(dir);
    p.presentation.pages.push("pages/2.page");
    p.pages.push({
      path: "pages/2.page",
      page: {
        elements: [
          {
            elementId: "b",
            elementType: "text",
            bounds: [0, 0, 100, 40],
            content: { text: "P2" },
          },
        ],
      },
    });
    saveProject(p);
    const s = openSession(dir);
    assert.equal(pageCount(s), 2);
    goToPage(s, 1);
    assert.equal(renderModel(s).elements[0]!.text, "P2");
    assert.throws(() => goToPage(s, Number.NaN), /page index out of range/);
    assert.throws(() => goToPage(s, Number(undefined)), /page index out of range/);
    const opened = openSession(dir, { pageIndex: 1 });
    assert.equal(opened.pageIndex, 1);
    const clamped = openSession(dir, { pageIndex: 99 });
    assert.equal(clamped.pageIndex, 1);
    const nanOpen = openSession(dir, { pageIndex: Number.NaN });
    assert.equal(nanOpen.pageIndex, 0);
  });

  it("keeps the page rail open across goToPage on multi-page decks", () => {
    const dir = tmp();
    const p = listedCoverProject(dir);
    p.presentation.pages.push("pages/2.page");
    p.pages.push({
      path: "pages/2.page",
      page: {
        elements: [
          {
            elementId: "b",
            elementType: "text",
            bounds: [0, 0, 100, 40],
            content: { text: "P2" },
          },
        ],
      },
    });
    saveProject(p);
    const s = openSession(dir, {
      allowedControlIds: ["chrome.pages.rail.toggle", "chrome.history.undo", "chrome.history.redo"],
    });
    assert.equal(renderModel(s).pageRailOpen, true);
    goToPage(s, 1);
    assert.equal(s.pageIndex, 1);
    assert.equal(renderModel(s).pageRailOpen, true);
    setPageRailOpen(s, "chrome.pages.rail.toggle", false);
    goToPage(s, 0);
    assert.equal(renderModel(s).pageRailOpen, false);
    setPageRailOpen(s, "chrome.pages.rail.toggle", true);
    assert.equal(renderModel(s).pageRailOpen, true);
  });

  it("cascades 12 consecutive shape inserts to distinct in-canvas origins", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: ["insert.shape", "chrome.history.undo", "chrome.history.redo"],
    });
    const canvas = s.project.presentation.size;
    const origins = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const id = insertShape(s, "insert.shape");
      const el = currentPage(s).elements.find((e) => e.elementId === id);
      assert.ok(el, `missing inserted shape ${id}`);
      const [x, y, w, h] = el.bounds;
      assert.equal(Number.isFinite(x) && Number.isFinite(y), true);
      assert.ok(x >= 0 && y >= 0, `origin outside slide: ${x},${y}`);
      assert.ok(x + w <= canvas[0] && y + h <= canvas[1], `clipped ${el.bounds}`);
      const key = `${x},${y}`;
      assert.equal(origins.has(key), false, `duplicate origin ${key}`);
      origins.add(key);
    }
    assert.equal(origins.size, 12);
  });

  it("S1 chrome: zoom, page rail, notes, present are gated", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const blocked = openSession(dir, { allowedControlIds: [] });
    assert.throws(() => zoomBy(blocked, "chrome.zoom.in", "in"), /not allowed/);
    const s = openSession(dir, {
      allowedControlIds: [
        "chrome.zoom.in",
        "chrome.zoom.out",
        "chrome.pages.rail.toggle",
        "chrome.notes.toggle",
        "chrome.present.play",
        "chrome.present.fullscreen",
        "chrome.history.undo",
        "chrome.history.redo",
      ],
    });
    zoomBy(s, "chrome.zoom.in", "in");
    assert.equal(renderModel(s).zoomPercent, 110);
    zoomBy(s, "chrome.zoom.out", "out");
    assert.equal(renderModel(s).zoomPercent, 100);
    setPageRailOpen(s, "chrome.pages.rail.toggle", false);
    assert.equal(renderModel(s).pageRailOpen, false);
    setNotesOpen(s, "chrome.notes.toggle", true);
    assert.equal(renderModel(s).notesOpen, true);
    setPresenting(s, "chrome.present.play", true);
    assert.equal(renderModel(s).presenting, true);
    setPresenting(s, "chrome.present.play", false);
    setPresenting(s, "chrome.present.fullscreen", true);
    assert.equal(renderModel(s).presenting, true);
  });

  it("S1 chrome: add / duplicate / delete page updates PPTD", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: [
        "chrome.pages.add",
        "chrome.pages.duplicate",
        "chrome.pages.delete",
        "chrome.history.undo",
        "chrome.history.redo",
      ],
    });
    assert.equal(pageCount(s), 1);
    addBlankPage(s, "chrome.pages.add");
    assert.equal(pageCount(s), 2);
    assert.equal(s.pageIndex, 1);
    duplicatePage(s, "chrome.pages.duplicate", 0);
    assert.equal(pageCount(s), 3);
    deletePage(s, "chrome.pages.delete", 2);
    assert.equal(pageCount(s), 2);
    persist(s);
    const again = loadProject(dir);
    assert.equal(again.pages.length, 2);
    assert.equal(undo(s), true);
    assert.equal(pageCount(s), 3);
  });

  it("undoes add-page without leaving the renderer on a removed page", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "Original" });
    const s = openSession(dir, {
      allowedControlIds: ["chrome.pages.add", "chrome.history.undo", "chrome.history.redo"],
    });
    selectElement(s, "title");

    addBlankPage(s, "chrome.pages.add");
    assert.equal(s.pageIndex, 1);
    assert.equal(undo(s), true);

    assert.equal(pageCount(s), 1);
    assert.equal(s.pageIndex, 0);
    assert.deepEqual(s.selection, { kind: "element", pageIndex: 0, elementId: "title" });
    assert.equal(renderModel(s).elements[0]?.text, "Original");

    assert.equal(redo(s), true);
    assert.equal(pageCount(s), 2);
    assert.equal(s.pageIndex, 1);
    assert.deepEqual(s.selection, { kind: "none" });
    assert.doesNotThrow(() => renderModel(s));
  });

  it("restores coherent page and selection state for duplicate, delete, and reorder undo/redo", () => {
    const dir = tmp();
    const project = listedCoverProject(dir, { title: "One" });
    appendTextPage(project, "pages/2.page", "second", "Two");
    saveProject(project);

    const duplicate = openSession(dir, {
      allowedControlIds: ["chrome.pages.duplicate", "chrome.history.undo", "chrome.history.redo"],
    });
    selectElement(duplicate, "title");
    duplicatePage(duplicate, "chrome.pages.duplicate", 0);
    assert.equal(undo(duplicate), true);
    assert.equal(duplicate.pageIndex, 0);
    assert.deepEqual(duplicate.selection, { kind: "element", pageIndex: 0, elementId: "title" });
    assert.equal(renderModel(duplicate).elements[0]?.text, "One");
    assert.equal(redo(duplicate), true);
    assert.equal(duplicate.pageIndex, 1);
    assert.deepEqual(duplicate.selection, { kind: "none" });
    assert.equal(renderModel(duplicate).elements[0]?.text, "One");

    const deletion = openSession(dir, {
      allowedControlIds: ["chrome.pages.delete", "chrome.history.undo", "chrome.history.redo"],
      pageIndex: 1,
    });
    selectElement(deletion, "second");
    assert.throws(() => deletePage(deletion, "chrome.pages.delete", Number.NaN), /page index out of range/);
    assert.equal(deletion.pageIndex, 1);
    assert.equal(pageCount(deletion), 2);
    assert.equal(renderModel(deletion).elements[0]?.text, "Two");
    deletePage(deletion, "chrome.pages.delete");
    assert.equal(undo(deletion), true);
    assert.equal(deletion.pageIndex, 1);
    assert.deepEqual(deletion.selection, { kind: "element", pageIndex: 1, elementId: "second" });
    assert.equal(renderModel(deletion).elements[0]?.text, "Two");
    assert.equal(redo(deletion), true);
    assert.equal(deletion.pageIndex, 0);
    assert.deepEqual(deletion.selection, { kind: "none" });
    assert.equal(renderModel(deletion).elements[0]?.text, "One");

    const reorder = openSession(dir, {
      allowedControlIds: ["chrome.pages.reorder", "chrome.history.undo", "chrome.history.redo"],
    });
    selectElement(reorder, "title");
    reorderPages(reorder, "chrome.pages.reorder", 0, 1);
    assert.equal(undo(reorder), true);
    assert.equal(reorder.pageIndex, 0);
    assert.deepEqual(reorder.selection, { kind: "element", pageIndex: 0, elementId: "title" });
    assert.equal(renderModel(reorder).elements[0]?.text, "One");
    assert.equal(redo(reorder), true);
    assert.equal(reorder.pageIndex, 1);
    assert.deepEqual(reorder.selection, { kind: "none" });
    assert.equal(renderModel(reorder).elements[0]?.text, "One");
  });

  it("writes notes to an explicit page without changing the active page or selection", () => {
    const dir = tmp();
    const project = listedCoverProject(dir, { title: "One" });
    appendTextPage(project, "pages/2.page", "second", "Two");
    saveProject(project);
    const s = openSession(dir, {
      allowedControlIds: ["notes.content.set", "chrome.history.undo", "chrome.history.redo"],
      pageIndex: 1,
    });
    selectElement(s, "second");

    setPageNotesAt(s, "notes.content.set", 0, "notes for page one");

    assert.equal(s.project.pages[0]!.page.notes, "notes for page one");
    assert.equal(s.project.pages[1]!.page.notes, undefined);
    assert.equal(s.pageIndex, 1);
    assert.deepEqual(s.selection, { kind: "element", pageIndex: 1, elementId: "second" });
    assert.throws(() => setPageNotesAt(s, "notes.content.set", Number.NaN, "invalid"), /page index out of range/);
    assert.equal(undo(s), true);
    assert.equal(s.project.pages[0]!.page.notes, undefined);
    assert.equal(s.pageIndex, 1);
    assert.deepEqual(s.selection, { kind: "element", pageIndex: 1, elementId: "second" });
  });

  it("S1: last-page delete refuses; reorder persists order", () => {
    const dir = tmp();
    listedCoverProject(dir, { title: "One" });
    const blocked = openSession(dir, { allowedControlIds: [] });
    assert.throws(() => deletePage(blocked, "chrome.pages.delete"), /not allowed/);
    const one = openSession(dir, {
      allowedControlIds: ["chrome.pages.delete", "chrome.history.undo", "chrome.history.redo"],
    });
    assert.throws(() => deletePage(one, "chrome.pages.delete"), /cannot delete the last page/);

    const p = loadProject(dir);
    p.presentation.pages.push("pages/2.page");
    p.pages.push({
      path: "pages/2.page",
      page: {
        elements: [
          {
            elementId: "b",
            elementType: "text",
            bounds: [0, 0, 100, 40],
            content: { text: "SECOND" },
          },
        ],
      },
    });
    saveProject(p);
    const s = openSession(dir, {
      allowedControlIds: ["chrome.pages.reorder", "chrome.history.undo", "chrome.history.redo"],
    });
    assert.throws(
      () => reorderPages(openSession(dir, { allowedControlIds: [] }), "chrome.pages.reorder", 0, 1),
      /not allowed/,
    );
    assert.throws(() => reorderPages(s, "chrome.pages.reorder", Number.NaN, 0), /invalid reorder/);
    reorderPages(s, "chrome.pages.reorder", 0, 1);
    assert.equal(renderModel(s).elements[0]!.text, "One");
    persist(s);
    const reloaded = loadProject(dir);
    assert.equal(reloaded.presentation.pages[0], "pages/2.page");
    assert.equal(reloaded.presentation.pages[1], "pages/cover.page");
  });

  it("S1: zoom percent is gated and sets exact value", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const blocked = openSession(dir, { allowedControlIds: [] });
    assert.throws(() => setZoomPercent(blocked, "chrome.zoom.percent", 80), /not allowed/);
    const s = openSession(dir, {
      allowedControlIds: ["chrome.zoom.percent", "chrome.history.undo", "chrome.history.redo"],
    });
    setZoomPercent(s, "chrome.zoom.percent", 80);
    assert.equal(renderModel(s).zoomPercent, 80);
    setZoomPercent(s, "chrome.zoom.percent", 10);
    assert.equal(renderModel(s).zoomPercent, 25);
    assert.throws(() => setZoomPercent(s, "chrome.zoom.percent", Number.NaN), /finite number/);
  });

  it("S4: each insert type adds one element and persists through reload", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const ids = ["insert.text", "insert.shape", "insert.image", "insert.table", "insert.chart"] as const;
    const blocked = openSession(dir, { allowedControlIds: [] });
    assert.throws(() => insertText(blocked, "insert.text"), /not allowed/);
    const s = openSession(dir, {
      allowedControlIds: [...ids, "chrome.history.undo", "chrome.history.redo"],
    });
    const before = renderModel(s).elements.length;
    insertText(s, "insert.text");
    insertShape(s, "insert.shape");
    insertImage(s, "insert.image");
    insertTable(s, "insert.table");
    insertChart(s, "insert.chart");
    const after = renderModel(s).elements;
    assert.equal(after.length, before + 5);
    assert.equal(after[before]!.type, "text");
    assert.equal(after[before + 1]!.type, "shape");
    assert.equal(after[before + 2]!.type, "image");
    assert.equal(after[before + 3]!.type, "table");
    assert.equal(after[before + 4]!.type, "chart");
    assert.equal(after[before + 4]!.chartBackgroundCss?.toLowerCase(), "#ffffff");
    persist(s);
    const again = loadProject(dir);
    const kinds = again.pages[0]!.page.elements.map((e) => e.elementType);
    assert.ok(kinds.includes("text"));
    assert.ok(kinds.includes("shape"));
    assert.ok(kinds.includes("image"));
    assert.ok(kinds.includes("table"));
    assert.ok(kinds.includes("chart"));
    const persistedChart = again.pages[0]!.page.elements.find((element) => element.elementType === "chart");
    assert.equal(persistedChart?.elementType, "chart");
    if (persistedChart?.elementType === "chart") {
      assert.deepEqual(persistedChart.background, { type: "solid", color: "#FFFFFF" });
    }
    assert.ok(fs.existsSync(path.join(dir, "media", "insert-placeholder.png")));
  });

  it("inserts 1x1 and maximum-size tables as one undoable mutation", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const one = openSession(dir, {
      allowedControlIds: ["insert.table", "chrome.history.undo", "chrome.history.redo"],
    });
    const beforeOne = renderModel(one).elements.length;

    const oneId = insertTable(one, "insert.table", 1, 1);
    const oneTable = renderModel(one).elements.find((element) => element.id === oneId);
    assert.ok(oneTable?.table);
    assert.deepEqual(oneTable.columnWidths, [1]);
    assert.equal(oneTable.tableRows?.length, 1);
    assert.equal(oneTable.tableRows?.[0]?.length, 1);
    assert.equal(oneTable.tableRows?.[0]?.[0]?.text, "列 A");
    assert.equal(oneTable.tableRows?.[0]?.[0]?.bold, true);
    assert.equal(oneTable.tableRows?.[0]?.[0]?.fill, "#F3F4F6");
    assert.equal(one.undoStack.length, 1, "sized insert must add exactly one undo snapshot");

    assert.equal(undo(one), true);
    assert.equal(renderModel(one).elements.length, beforeOne);
    assert.equal(
      renderModel(one).elements.some((element) => element.id === oneId),
      false,
    );
    assert.equal(undo(one), false, "one insert must not require multiple undo steps");
    assert.equal(redo(one), true);
    assert.equal(renderModel(one).elements.find((element) => element.id === oneId)?.tableRows?.length, 1);

    const max = openSession(dir, {
      allowedControlIds: ["insert.table", "chrome.history.undo", "chrome.history.redo"],
    });
    const maxId = insertTable(max, "insert.table", MAX_INSERT_TABLE_SIZE, MAX_INSERT_TABLE_SIZE);
    const maxTable = renderModel(max).elements.find((element) => element.id === maxId);
    assert.equal(maxTable?.tableRows?.length, MAX_INSERT_TABLE_SIZE);
    assert.ok(maxTable?.tableRows?.every((row) => row.length === MAX_INSERT_TABLE_SIZE));
    assert.equal(maxTable?.tableRows?.[0]?.[0]?.text, "列 A");
    assert.equal(maxTable?.tableRows?.[0]?.[5]?.text, "列 F");
    assert.equal(maxTable?.tableRows?.[5]?.[5]?.text, "—");
    assert.ok(maxTable?.columnWidths?.every((width) => width === 1 / MAX_INSERT_TABLE_SIZE));
    assert.equal(max.undoStack.length, 1);
  });

  it("rejects invalid table sizes without changing project, selection, or history", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: ["insert.table", "chrome.history.undo", "chrome.history.redo"],
    });
    insertTable(s, "insert.table");
    assert.equal(undo(s), true);
    const before = structuredClone(s);

    const invalid = [
      [0, 2],
      [MAX_INSERT_TABLE_SIZE + 1, 2],
      [2, 0],
      [2, MAX_INSERT_TABLE_SIZE + 1],
      [1.5, 2],
      [2, Number.NaN],
    ] as const;
    for (const [rows, columns] of invalid) {
      assert.throws(
        () => insertTable(s, "insert.table", rows, columns),
        /insert table (rows|columns) must be (an integer|between 1 and 6)/,
      );
      assert.deepEqual(s, before, `invalid ${rows}x${columns} request must be side-effect free`);
    }

    assert.equal(redo(s), true, "invalid requests must preserve the prior redo entry");
    const table = renderModel(s).elements.at(-1);
    assert.equal(table?.tableRows?.length, 2);
    assert.equal(table?.tableRows?.[0]?.length, 2);
  });

  it("inserts external plain text atomically and rejects invalid payloads before mutation", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: ["insert.text", "chrome.history.undo", "chrome.history.redo"],
    });
    const before = renderModel(s).elements.length;
    const id = insertText(s, "insert.text", "外部剪贴板文本");
    assert.equal(renderModel(s).elements.find((element) => element.id === id)?.text, "外部剪贴板文本");
    persist(s);
    const saved = renderModel(openSession(dir, { allowedControlIds: [] })).elements.find(
      (element) => element.id === id,
    );
    assert.equal(saved?.type, "text");
    assert.equal(saved?.text, "外部剪贴板文本");
    assert.throws(() => insertText(s, "insert.text", 42), /must be a string/);
    assert.throws(() => insertText(s, "insert.text", "x".repeat(MAX_INSERT_TEXT_LENGTH + 1)), /exceeds 20000/);
    assert.equal(renderModel(s).elements.length, before + 1);
  });

  it("S3/S5–S13: selection, style, table, chart, theme persist", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const ids = [
      "insert.text",
      "insert.shape",
      "insert.table",
      "insert.chart",
      "insert.line",
      "insert.icon",
      "element.delete",
      "element.duplicate",
      "element.text.toolbar.italic.toggle",
      "element.text.toolbar.list.set",
      "element.text.toolbar.link.set",
      "element.shape.fill.set",
      "element.chart.legend.set",
      "element.chart.series.color.set",
      "element.rotate.set",
      "element.opacity.set",
      "element.arrange.forward",
      "element.arrange.backward",
      "selection.clear",
      "element.table.cell.set",
      "element.table.row.add",
      "element.table.col.add",
      "element.table.row.delete",
      "element.table.col.delete",
      "element.table.merge",
      "element.table.cell.fill.set",
      "element.chart.type.set",
      "element.chart.data.set",
      "theme.background.set",
      "theme.color.set",
      "element.lock.toggle",
      "element.visibility.toggle",
      "element.text.toolbar.wrap.set",
      "element.group.set",
      "element.ungroup.set",
      "element.shadow.set",
      "element.table.cell.align.set",
      "element.chart.axis.set",
      "element.chart.labels.set",
      "notes.content.set",
      "element.animation.set",
      "element.image.replace",
      "element.icon.name.set",
      "element.line.arrow.set",
      "insert.image",
      "element.shape.adjust.set",
      "element.image.crop.set",
      "element.image.mask.set",
      "element.line.curve.set",
      "element.line.points.set",
      "element.line.label.set",
      "element.animation.timeline.set",
    ];
    const blocked = openSession(dir, { allowedControlIds: [] });
    assert.throws(() => deleteSelected(blocked, "element.delete"), /not allowed/);
    const s = openSession(dir, { allowedControlIds: ids });
    insertText(s, "insert.text");
    setSelectedTextStyle(s, "element.text.toolbar.italic.toggle", {
      italic: true,
      underline: true,
      fontSize: 28,
    });
    assert.equal(renderModel(s).elements.at(-1)!.italic, true);
    assert.equal(renderModel(s).elements.at(-1)!.underline, true);
    setSelectedTextStyle(s, "element.text.toolbar.list.set", { list: "bullet" });
    setSelectedTextStyle(s, "element.text.toolbar.link.set", { href: "https://example.com" });
    assert.equal(renderModel(s).elements.at(-1)!.list, "bullet");
    assert.equal(renderModel(s).elements.at(-1)!.href, "https://example.com");
    setSelectedTextStyle(s, "element.text.toolbar.list.set", { list: null });
    assert.equal(renderModel(s).elements.at(-1)!.list, undefined);
    setSelectedTextStyle(s, "element.text.toolbar.wrap.set", { wrap: false });
    assert.equal(renderModel(s).elements.at(-1)!.wrap, false);
    setSelectedLocked(s, "element.lock.toggle", true);
    assert.equal(renderModel(s).elements.at(-1)!.locked, true);
    assert.throws(() => deleteSelected(s, "element.delete"), /locked/);
    setSelectedLocked(s, "element.lock.toggle", false);
    setSelectedHidden(s, "element.visibility.toggle", true);
    assert.equal(renderModel(s).elements.at(-1)!.hidden, true);
    duplicateSelected(s, "element.duplicate");
    assert.equal(renderModel(s).selection.kind, "element");
    const beforePaste = renderModel(s).elements.length;
    assert.equal(copySelected(s), 1);
    pasteClipboard(s, "element.duplicate");
    assert.equal(renderModel(s).elements.length, beforePaste + 1);
    insertShape(s, "insert.shape", "roundRect");
    setSelectedShadow(s, "element.shadow.set", {
      blur: 12,
      color: "#00000055",
      offsetX: 2,
      offsetY: 4,
    });
    assert.equal(renderModel(s).elements.at(-1)!.shadow?.blur, 12);
    assert.match(String(renderModel(s).elements.at(-1)!.pathD), /A /);
    assert.ok((renderModel(s).elements.at(-1)!.adjustHandles || []).length >= 1);
    insertShape(s, "insert.shape", "triangle");
    setSelectedAdjustments(s, "element.shape.adjust.set", [30000]);
    assert.equal(renderModel(s).elements.at(-1)!.shapeName, "triangle");
    assert.deepEqual(renderModel(s).elements.at(-1)!.adjustments, [30000]);
    assert.ok((renderModel(s).elements.at(-1)!.adjustHandles || []).length >= 1);
    setSelectedFill(s, "element.shape.fill.set", "#FF0000");
    setSelectedFill(s, "element.shape.fill.set", {
      type: "gradient",
      gradientType: "linear",
      angle: 90,
      stops: [
        { position: 0, color: "#111111" },
        { position: 1, color: "#2563EB" },
      ],
    });
    assert.match(String(renderModel(s).elements.at(-1)!.fillCss), /linear-gradient\(180deg/);
    setSelectedRotation(s, "element.rotate.set", 15);
    assert.equal(renderModel(s).elements.at(-1)!.rotation, 15);
    setSelectedOpacity(s, "element.opacity.set", 0.5);
    assert.equal(renderModel(s).elements.at(-1)!.opacity, 0.5);
    const zBefore = renderModel(s).elements.map((e) => e.id);
    arrangeSelected(s, "element.arrange.forward", "front");
    assert.equal(renderModel(s).elements.at(-1)!.id, zBefore[zBefore.length - 1]);
    arrangeSelected(s, "element.arrange.backward", "back");
    assert.equal(renderModel(s).elements[0]!.id, zBefore[zBefore.length - 1]);
    clearSelection(s);
    assert.equal(renderModel(s).selection.kind, "none");
    insertLine(s, "insert.line");
    setLineArrow(s, "element.line.arrow.set", [null, "arrow"]);
    setLineCurve(s, "element.line.curve.set", "smooth");
    setLinePoints(s, "element.line.points.set", "0,4 120,4 240,4 400,4");
    setLineLabel(s, "element.line.label.set", "拉动");
    assert.deepEqual(renderModel(s).elements.at(-1)!.lineArrow, [null, "arrow"]);
    assert.equal(renderModel(s).elements.at(-1)!.lineCurve, "smooth");
    assert.equal(renderModel(s).elements.at(-1)!.lineLabel, "拉动");
    insertIcon(s, "insert.icon");
    setIconName(s, "element.icon.name.set", "fas:heart");
    assert.equal(renderModel(s).elements.at(-1)!.iconName, "fas:heart");
    insertImage(s, "insert.image");
    const imgBounds = renderModel(s).elements.at(-1)!.bounds;
    assert.ok(imgBounds[2] > 0 && imgBounds[3] > 0);
    // real PNG: 240×160 → contain, not the 360×200 default
    const pngPath = path.join(dir, "media", "portrait.png");
    fs.mkdirSync(path.dirname(pngPath), { recursive: true });
    fs.writeFileSync(pngPath, makePng(240, 160));
    const portraitId = insertImage(s, "insert.image", "media/portrait.png");
    const portrait = renderModel(s).elements.find((e) => e.id === portraitId)!;
    assert.equal(portrait.bounds[2], 240);
    assert.equal(portrait.bounds[3], 160);
    assert.equal(portrait.fit, "contain");
    setImageSrc(s, "element.image.replace", "media/replaced.png");
    setImageCrop(s, "element.image.crop.set", { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 });
    const editedImageId =
      renderModel(s).selection.kind === "element"
        ? (renderModel(s).selection as { elementId: string }).elementId
        : null;
    assert.ok(editedImageId);
    setImageCropShape(s, "element.image.mask.set", { shapeName: "ellipse" });
    assert.equal(renderModel(s).elements.at(-1)!.src, "media/replaced.png");
    assert.equal(renderModel(s).elements.at(-1)!.crop?.left, 0.1);
    assert.equal(renderModel(s).elements.at(-1)!.cropShape?.shapeName, "ellipse");
    setPageAnimations(s, "element.animation.timeline.set", [
      { elementId: renderModel(s).elements[0]!.id, effect: "fade-in", trigger: "onClick" },
      { elementId: renderModel(s).elements[1]!.id, effect: "fly-in", trigger: "afterPrevious" },
    ]);
    const anims = renderModel(s).animations as { effect?: string; trigger?: string }[];
    assert.equal(anims[0]?.effect, "fade-in");
    assert.equal(anims[0]?.trigger, "onClick");
    assert.equal(anims[1]?.trigger, "afterPrevious");
    persist(s);
    const reloadedAnims = loadProject(dir).pages[0]!.page.animations as { trigger?: string }[] | undefined;
    assert.equal(reloadedAnims?.[1]?.trigger, "afterPrevious");
    insertTable(s, "insert.table");
    setTableCellText(s, "element.table.cell.set", 1, 0, "单元格");
    setTableCellAlign(s, "element.table.cell.align.set", 1, 0, ["center", "middle"]);
    addTableRow(s, "element.table.row.add");
    addTableCol(s, "element.table.col.add");
    setTableCellFill(s, "element.table.cell.fill.set", 1, 0, "#FEF3C7");
    mergeTableCells(s, "element.table.merge", 0, 0, 0, 1);
    const table = renderModel(s).elements.find((e) => e.table);
    assert.equal(table!.tableRows![1]![0]!.text, "单元格");
    assert.deepEqual(table!.tableRows![1]![0]!.align, ["center", "middle"]);
    assert.equal(table!.tableRows![1]![0]!.fill, "#FEF3C7");
    assert.ok((table!.tableRows![0]![0]!.colSpan || 1) >= 2);
    const colsBefore = table!.tableRows![0]!.length;
    deleteTableCol(s, "element.table.col.delete");
    deleteTableRow(s, "element.table.row.delete");
    const table2 = renderModel(s).elements.find((e) => e.table);
    assert.ok(table2!.tableRows![0]!.length < colsBefore);
    assert.ok(table2!.tableRows!.length < table!.tableRows!.length);
    insertChart(s, "insert.chart");
    setChartType(s, "element.chart.type.set", "line");
    setChartData(s, "element.chart.data.set", {
      cols: ["类目", "数值"],
      rows: [["X", 9]],
    });
    assert.equal(renderModel(s).elements.at(-1)!.chartType, "line");
    setChartLegend(s, "element.chart.legend.set", true);
    setChartSeriesFill(s, "element.chart.series.color.set", 0, "#EF4444");
    setChartLabels(s, "element.chart.labels.set", false);
    setChartAxis(s, "element.chart.axis.set", { x: "月份", y: "销量" });
    assert.equal(renderModel(s).elements.at(-1)!.chartLegend, true);
    assert.equal(renderModel(s).elements.at(-1)!.chartColors?.[0], "#EF4444");
    assert.equal(renderModel(s).elements.at(-1)!.chartLabels, false);
    assert.equal(renderModel(s).elements.at(-1)!.chartAxis?.x, "月份");
    setChartType(s, "element.chart.type.set", "pie");
    setChartData(s, "element.chart.data.set", {
      cols: ["产品", "占比"],
      rows: [
        ["茶饮", 62],
        ["轻食", 38],
      ],
    });
    setChartSeriesFill(s, "element.chart.series.color.set", 0, "#0064BC");
    setChartSeriesFill(s, "element.chart.series.color.set", 1, "#00ACEE");
    assert.deepEqual(renderModel(s).elements.at(-1)!.chartColors, ["#0064BC", "#00ACEE"]);
    const textEl = renderModel(s).elements.find((e) => e.type === "text");
    const shapeEl = renderModel(s).elements.find((e) => e.type === "shape");
    selectMany(s, [textEl!.id, shapeEl!.id]);
    const gid = groupSelected(s, "element.group.set");
    assert.equal(renderModel(s).elements.find((e) => e.id === textEl!.id)!.groupId, gid);
    ungroupSelected(s, "element.ungroup.set");
    assert.equal(renderModel(s).elements.find((e) => e.id === textEl!.id)!.groupId, undefined);
    selectElement(s, textEl!.id);
    setPageBackground(s, "theme.background.set", "#112233");
    setPageBackground(s, "theme.background.set", {
      type: "gradient",
      gradientType: "linear",
      angle: 180,
      stops: [
        { position: 0, color: "#FFFFFF" },
        { position: 1, color: "#112233" },
      ],
    });
    assert.match(String(renderModel(s).backgroundCss), /linear-gradient\(270deg/);
    setPageBackground(s, "theme.background.set", "#112233");
    setThemeColor(s, "theme.color.set", "primary", "#FF6900");
    assert.equal(renderModel(s).themeColors.primary, "#FF6900");
    setPageNotes(s, "notes.content.set", "备注内容");
    setElementAnimation(s, "element.animation.set", "fade");
    persist(s);
    const again = loadProject(dir);
    const bg = again.pages[0]!.page.background as { color?: string } | undefined;
    assert.equal(bg?.color, "#112233");
    assert.equal(again.presentation.theme?.colors?.primary, "#FF6900");
    assert.equal(again.pages[0]!.page.notes, "备注内容");
    const kinds = again.pages[0]!.page.elements.map((e) => e.elementType);
    assert.ok(kinds.includes("line"));
    assert.ok(kinds.includes("icon"));
    const img = again.pages[0]!.page.elements.find((e) => e.elementId === editedImageId) as
      { crop?: { left?: number } } | undefined;
    assert.equal(img?.crop?.left, 0.1);
    selectMany(s, []);
    clearSelection(s);
    assert.equal(s.selection.kind, "none");
  });

  it("NL refine replaces text and sets background on the current page", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: [
        "chrome.workspace.refine",
        "insert.text",
        "element.text.content.set",
        "chrome.history.undo",
        "chrome.history.redo",
      ],
    });
    insertText(s, "insert.text");
    setSelectedText(s, "element.text.content.set", "核聚变研究");
    const out = applyNaturalRefine(s, "chrome.workspace.refine", "把核聚变改成可控核聚变");
    assert.ok(out.applied.some((a) => a.startsWith("replace:")));
    applyNaturalRefine(s, "chrome.workspace.refine", "背景改成蓝色");
    persist(s);
    const page = loadProject(dir).pages[0]!.page;
    const texts = page.elements
      .filter((e) => e.elementType === "text")
      .map((e) => String((e as { content?: { text?: string } }).content?.text || ""));
    assert.ok(
      texts.some((t) => t.includes("可控核聚变")),
      texts.join(" | "),
    );
    assert.equal((page.background as { color?: string } | undefined)?.color, "#2563EB");
  });

  it("aligns and distributes multi-selected elements", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: [
        "insert.text",
        "element.bounds.set",
        "element.arrange.align.set",
        "element.arrange.distribute.set",
        "chrome.history.undo",
        "chrome.history.redo",
      ],
    });
    const a = insertText(s, "insert.text");
    const b = insertText(s, "insert.text");
    const c = insertText(s, "insert.text");
    selectElement(s, a);
    setSelectedBounds(s, "element.bounds.set", [10, 10, 40, 20]);
    selectElement(s, b);
    setSelectedBounds(s, "element.bounds.set", [80, 40, 40, 20]);
    selectElement(s, c);
    setSelectedBounds(s, "element.bounds.set", [200, 80, 40, 20]);
    selectMany(s, [a, b, c]);
    alignSelected(s, "element.arrange.align.set", "top");
    assert.equal(s.project.pages[0]!.page.elements.find((e) => e.elementId === b)!.bounds[1], 10);
    distributeSelected(s, "element.arrange.distribute.set", "h");
    const xs = [a, b, c].map((id) => s.project.pages[0]!.page.elements.find((e) => e.elementId === id)!.bounds[0]);
    assert.ok(xs[1]! > xs[0]! && xs[2]! > xs[1]!, String(xs));
  });

  it("group move follows the dragged anchor when a sibling has the same size", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: ["insert.text", "element.bounds.set", "chrome.history.undo", "chrome.history.redo"],
    });
    const a = insertText(s, "insert.text");
    const b = insertText(s, "insert.text");
    const boundsOf = (id: string) => s.project.pages[0]!.page.elements.find((e) => e.elementId === id)!.bounds;
    selectElement(s, a);
    setSelectedBounds(s, "element.bounds.set", [10, 10, 40, 20]);
    selectElement(s, b);
    setSelectedBounds(s, "element.bounds.set", [90, 60, 40, 20]);
    selectMany(s, [a, b]);
    // The pointer dragged b. a is listed first and shares b's exact size, so a
    // size-only match would move the whole group by the wrong delta.
    setSelectedBounds(s, "element.bounds.set", [102, 67, 40, 20], b);
    assert.deepEqual(boundsOf(a), [22, 17, 40, 20]);
    assert.deepEqual(boundsOf(b), [102, 67, 40, 20]);
  });

  it("tab cycles element selection and esc clears", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: [
        "insert.text",
        "insert.shape",
        "selection.tab",
        "selection.clear",
        "chrome.history.undo",
        "chrome.history.redo",
      ],
    });
    const textId = insertText(s, "insert.text");
    const shapeId = insertShape(s, "insert.shape");
    const order = renderModel(s).elements.map((e) => e.id);
    clearSelection(s);
    tabSelect(s, "selection.tab", 1);
    assert.equal((renderModel(s).selection as { elementId?: string }).elementId, order[0]);
    const steps: string[] = [];
    for (let i = 0; i < order.length; i++) {
      tabSelect(s, "selection.tab", 1);
      const sel = renderModel(s).selection;
      steps.push(sel.kind === "element" ? String((sel as { elementId: string }).elementId) : "none");
    }
    assert.deepEqual(steps, [...order.slice(1), "none"]);
    assert.ok(order.includes(textId));
    assert.ok(order.includes(shapeId));
    tabSelect(s, "selection.tab", 1);
    assert.equal((renderModel(s).selection as { elementId?: string }).elementId, order[0]);
    clearSelection(s);
    assert.equal(renderModel(s).selection.kind, "none");
  });

  it("flips selected element horizontally", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: ["insert.shape", "element.arrange.flip.set", "chrome.history.undo", "chrome.history.redo"],
    });
    insertShape(s, "insert.shape");
    flipSelected(s, "element.arrange.flip.set", "h");
    persist(s);
    const el = loadProject(dir).pages[0]!.page.elements.find((e) => e.elementType === "shape") as {
      flipH?: boolean;
    };
    assert.equal(el.flipH, true);
  });

  it("rebuilds a selected image into selectable text/shape/line nodes", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: [
        "insert.image",
        "element.image.rebuild",
        "element.bounds.set",
        "element.text.content.set",
        "chrome.history.undo",
        "chrome.history.redo",
      ],
    });
    insertImage(s, "insert.image");
    const out = rebuildSelectedImage(s, "element.image.rebuild", "感知, 路由, 决策, 执行");
    const m = renderModel(s);
    assert.ok(m.elements.some((e) => e.type === "text" && e.text?.includes("感知")));
    assert.ok(m.elements.some((e) => e.type === "shape"));
    assert.ok(m.elements.some((e) => e.line && e.connects));
    const text = m.elements.find((e) => e.type === "text" && e.text?.includes("路由"));
    assert.ok(text);
    selectElement(s, text!.id);
    setSelectedText(s, "element.text.content.set", "路由节点");
    assert.equal(renderModel(s).elements.find((e) => e.id === text!.id)!.text, "路由节点");
    const shape = m.elements.find((e) => e.type === "shape")!;
    const lineBefore = renderModel(s).elements.find((e) => e.connects?.[0] === shape.id);
    assert.ok(lineBefore);
    selectElement(s, shape.id);
    const [sx, sy, sw, sh] = shape.bounds;
    setSelectedBounds(s, "element.bounds.set", [sx + 40, sy + 30, sw, sh]);
    const lineAfter = renderModel(s).elements.find((e) => e.id === lineBefore!.id);
    assert.notEqual(lineAfter!.linePoints, lineBefore!.linePoints);
    persist(s);
    const again = loadProject(dir).pages[0]!.page.elements;
    assert.ok(again.some((e) => e.elementType === "text"));
    assert.ok(again.some((e) => e.elementType === "shape"));
    assert.ok(again.some((e) => e.elementType === "line"));
    assert.ok(out.created.length >= 6);
  });

  it("inserts SmartArt nodes and keeps connectors attached when a node moves", () => {
    const dir = tmp();
    listedCoverProject(dir);
    const s = openSession(dir, {
      allowedControlIds: [
        "insert.smartart",
        "element.smartart.node.add",
        "element.smartart.node.delete",
        "element.smartart.layout.set",
        "element.bounds.set",
        "chrome.history.undo",
        "chrome.history.redo",
      ],
    });
    const diagramId = insertSmartArt(s, "insert.smartart", "process");
    const first = renderModel(s);
    const nodes = first.elements.filter((e) => e.smartArt?.role === "node");
    const labels = first.elements.filter((e) => e.smartArt?.role === "label");
    const lines = first.elements.filter((e) => e.connects);
    assert.equal(nodes.length, 3);
    assert.equal(labels.length, 3);
    assert.equal(lines.length, 2);
    assert.equal(nodes[0]!.smartArt?.id, diagramId);
    const firstConnector = lines.find((line) => line.connects?.[0] === nodes[0]!.id)!;
    const [lineStart] = String(firstConnector.linePoints).split(" ");
    const [lineStartX] = lineStart!.split(",").map(Number);
    const absoluteLineStartX = firstConnector.bounds[0] + lineStartX!;
    assert.equal(
      absoluteLineStartX,
      nodes[0]!.bounds[0] + nodes[0]!.bounds[2],
      "SmartArt connector must start at the node edge instead of crossing its label",
    );
    addSmartArtNode(s, "element.smartart.node.add", "反馈");
    assert.equal(renderModel(s).elements.filter((e) => e.smartArt?.role === "node").length, 4);
    assert.equal(renderModel(s).elements.filter((e) => e.connects).length, 3);
    setSmartArtLayout(s, "element.smartart.layout.set", "cycle");
    assert.equal(renderModel(s).elements.filter((e) => e.connects).length, 4);
    const pinnedTarget = renderModel(s).elements.find((e) => e.smartArt?.role === "node")!;
    selectElement(s, pinnedTarget.id);
    const [px, py, pw, ph] = pinnedTarget.bounds;
    setSelectedBounds(s, "element.bounds.set", [px + 30, py + 15, pw, ph]);
    addSmartArtNode(s, "element.smartart.node.add", "临时");
    const pinnedAfter = renderModel(s).elements.find((e) => e.id === pinnedTarget.id)!;
    assert.equal((pinnedAfter.smartArt as { pinned?: boolean } | undefined)?.pinned, true);
    assert.equal(pinnedAfter.bounds[0], px + 30);
    assert.equal(pinnedAfter.bounds[1], py + 15);
    deleteSmartArtNode(s, "element.smartart.node.delete");
    const node = renderModel(s).elements.find((e) => e.smartArt?.role === "node" && e.smartArt.index === 1)!;
    const label = renderModel(s).elements.find((e) => e.smartArt?.role === "label" && e.smartArt.index === 1)!;
    const lineBefore = renderModel(s).elements.find((e) => e.connects?.[0] === node.id);
    selectElement(s, node.id);
    const [nx, ny, nw, nh] = node.bounds;
    setSelectedBounds(s, "element.bounds.set", [nx + 40, ny + 20, nw, nh]);
    const labelAfter = renderModel(s).elements.find((e) => e.id === label.id)!;
    assert.equal(labelAfter.bounds[0], label.bounds[0] + 40);
    assert.equal(labelAfter.bounds[1], label.bounds[1] + 20);
    if (lineBefore) {
      const lineAfter = renderModel(s).elements.find((e) => e.id === lineBefore.id);
      assert.notEqual(lineAfter!.linePoints, lineBefore.linePoints);
    }
    deleteSmartArtNode(s, "element.smartart.node.delete");
    assert.equal(renderModel(s).elements.filter((e) => e.smartArt?.role === "node").length, 3);
    persist(s);
    const again = loadProject(dir).pages[0]!.page.elements;
    assert.ok(again.some((e) => (e as { smartArt?: { role?: string } }).smartArt?.role === "node"));
    assert.ok(again.some((e) => e.elementType === "line"));
  });
});
