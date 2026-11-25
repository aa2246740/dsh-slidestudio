import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  titleOnlyCoverPage,
  type PptdElement,
  type PptdProject,
  type ShapeElement,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import {
  insertChart,
  insertTable,
  openSession,
  renderModel,
  selectElement,
  setChartSeriesFill,
  setPageBackground,
  setSelectedBorder,
  setSelectedFill,
  setSelectedShadow,
  setSelectedTextRangeStyle,
  setSelectedTextStyle,
  setTableCellFill,
  setThemeColor,
  type CanvasSession,
} from "./index.js";

/*
 * M5-SCR-005: an editor setter that stores a colour refuses one the exporter cannot read, in
 * Chinese, and leaves the stored value unchanged. A token the theme defines is accepted and
 * stored as the token, so the export keeps resolving it.
 */
const CONTROLS = [
  "element.shape.border.set",
  "element.shape.fill.set",
  "element.text.style.set",
  "element.text.range.set",
  "element.shadow.set",
  "element.table.cell.fill.set",
  "element.chart.series.color.set",
  "insert.table",
  "insert.chart",
  "theme.background.set",
  "theme.color.set",
];
const REFUSED_UNKNOWN_TOKEN = /"\$accent9" 在主题 colors 中不存在/;
const REFUSED_UNPREFIXED = /缺少 # 前缀/;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-color-write-"));
}

function coverProject(dir: string, elements: PptdElement[]): void {
  const project: PptdProject = createEmptyProject(dir, { title: "颜色写入" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("颜色写入"));
  project.pages[0]!.page.elements = elements;
  project.presentation.theme = { colors: { primary: "#D97757" } };
  saveProject(project);
}

function session(dir: string): CanvasSession {
  return openSession(dir, { allowedControlIds: CONTROLS });
}

function stored<T extends PptdElement>(s: CanvasSession, elementId: string): T {
  const found = s.project.pages[0]!.page.elements.find((e) => e.elementId === elementId);
  assert.ok(found, `element ${elementId} is stored`);
  return found as T;
}

function assertRefused(action: () => void, reason: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, reason);
    assert.match(error.message, /[\u4e00-\u9fff]/);
    return true;
  });
}

const box: ShapeElement = {
  elementId: "box",
  elementType: "shape",
  shapeName: "rect",
  bounds: [60, 80, 300, 150],
  fill: { type: "solid", color: "#FFFFFF" },
  border: { color: "#111111", width: 2 },
};

const headline: TextElement = {
  elementId: "headline",
  elementType: "text",
  bounds: [60, 260, 600, 60],
  content: { text: "标题文字", fontSize: 24, color: "#111111" },
};

describe("editor colour writes (M5-SCR-005)", () => {
  it("refuses an unknown border token and keeps the stored border", () => {
    const dir = tmp();
    coverProject(dir, [box]);
    const s = session(dir);
    selectElement(s, "box");
    assertRefused(() => setSelectedBorder(s, "element.shape.border.set", { color: "$accent9" }), REFUSED_UNKNOWN_TOKEN);
    assert.deepEqual(stored<ShapeElement>(s, "box").border, { color: "#111111", width: 2 });
  });

  it("stores a theme token on a border as the token, and the editor paints its colour", () => {
    const dir = tmp();
    coverProject(dir, [box]);
    const s = session(dir);
    selectElement(s, "box");
    setSelectedBorder(s, "element.shape.border.set", { color: "$primary" });
    assert.equal(stored<ShapeElement>(s, "box").border?.color, "$primary");
    assert.equal(renderModel(s).elements.find((e) => e.id === "box")?.border?.color, "#D97757");
  });

  it("refuses an unknown fill token and an unprefixed gradient stop", () => {
    const dir = tmp();
    coverProject(dir, [box]);
    const s = session(dir);
    selectElement(s, "box");
    assertRefused(() => setSelectedFill(s, "element.shape.fill.set", "$accent9"), REFUSED_UNKNOWN_TOKEN);
    assertRefused(
      () =>
        setSelectedFill(s, "element.shape.fill.set", {
          type: "gradient",
          gradientType: "linear",
          stops: [
            { position: 0, color: "#FFFFFF" },
            { position: 1, color: "2563EB" },
          ],
        }),
      REFUSED_UNPREFIXED,
    );
    assert.deepEqual(stored<ShapeElement>(s, "box").fill, { type: "solid", color: "#FFFFFF" });
    setSelectedFill(s, "element.shape.fill.set", "$primary");
    assert.deepEqual(stored<ShapeElement>(s, "box").fill, { type: "solid", color: "$primary" });
  });

  it("refuses an unknown page background token", () => {
    const dir = tmp();
    coverProject(dir, [box]);
    const s = session(dir);
    const before = structuredClone(s.project.pages[0]!.page.background);
    assertRefused(() => setPageBackground(s, "theme.background.set", "$accent9"), REFUSED_UNKNOWN_TOKEN);
    assert.deepEqual(s.project.pages[0]!.page.background, before);
  });

  it("refuses an invalid theme colour and keeps the theme", () => {
    const dir = tmp();
    coverProject(dir, [box]);
    const s = session(dir);
    assertRefused(
      () => setThemeColor(s, "theme.color.set", "accent1", "$accent9"),
      /主题颜色 colors\.accent1 必须是 #RRGGBB 或 #RRGGBBAA/,
    );
    assert.equal(s.project.presentation.theme?.colors?.accent1, undefined);
    setThemeColor(s, "theme.color.set", "accent1", "#2563EB");
    assert.equal(s.project.presentation.theme?.colors?.accent1, "#2563EB");
  });

  it("refuses an unknown text colour and an unprefixed range colour", () => {
    const dir = tmp();
    coverProject(dir, [headline]);
    const s = session(dir);
    selectElement(s, "headline");
    assertRefused(
      () => setSelectedTextStyle(s, "element.text.style.set", { color: "$accent9" }),
      REFUSED_UNKNOWN_TOKEN,
    );
    assertRefused(
      () => setSelectedTextRangeStyle(s, "element.text.range.set", 0, 2, { color: "2563EB" }),
      REFUSED_UNPREFIXED,
    );
    const content = stored<TextElement>(s, "headline").content;
    assert.equal(content.color, "#111111");
    assert.equal(content.text, "标题文字");
  });

  it("refuses an unknown or unprefixed text highlight and keeps the stored highlight", () => {
    const dir = tmp();
    coverProject(dir, [headline]);
    const s = session(dir);
    selectElement(s, "headline");
    setSelectedTextStyle(s, "element.text.style.set", { backgroundColor: "#FFF59D" });
    assertRefused(
      () => setSelectedTextStyle(s, "element.text.style.set", { backgroundColor: "$accent9" }),
      REFUSED_UNKNOWN_TOKEN,
    );
    assertRefused(
      () => setSelectedTextStyle(s, "element.text.style.set", { backgroundColor: "FFF59D" }),
      REFUSED_UNPREFIXED,
    );
    assert.equal(stored<TextElement>(s, "headline").content.backgroundColor, "#FFF59D");
    setSelectedTextStyle(s, "element.text.style.set", { backgroundColor: "#FFEB3B" });
    assert.equal(stored<TextElement>(s, "headline").content.backgroundColor, "#FFEB3B");
  });

  it("refuses an unknown shadow colour", () => {
    const dir = tmp();
    coverProject(dir, [box]);
    const s = session(dir);
    selectElement(s, "box");
    assertRefused(
      () => setSelectedShadow(s, "element.shadow.set", { blur: 4, color: "$accent9" }),
      REFUSED_UNKNOWN_TOKEN,
    );
    assert.equal(stored<ShapeElement>(s, "box").shadow, undefined);
  });

  it("refuses an unknown table cell fill and an unknown chart series colour", () => {
    const dir = tmp();
    coverProject(dir, [box]);
    const s = session(dir);
    insertTable(s, "insert.table");
    const tableId = s.project.pages[0]!.page.elements.at(-1)!.elementId;
    selectElement(s, tableId);
    assertRefused(() => setTableCellFill(s, "element.table.cell.fill.set", 0, 0, "$accent9"), REFUSED_UNKNOWN_TOKEN);
    const chartId = insertChart(s, "insert.chart");
    selectElement(s, chartId);
    assertRefused(() => setChartSeriesFill(s, "element.chart.series.color.set", 0, "$accent9"), REFUSED_UNKNOWN_TOKEN);
  });
});
