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
} from "@open-slidestudio/pptd-v2";
import { openSession, renderModel } from "./index.js";

/*
 * A table cell's text colour and solid fill are theme tokens. The export writes the #RRGGBB each
 * token resolves to, and the editor paints that same hex. A cell whose token cannot resolve takes
 * the fallback the export writes (pptd-v2 color-fallback.ts): the colour is dropped and the cell
 * keeps its default. The stored project is never changed.
 */

const THEME: NonNullable<PptdProject["presentation"]["theme"]> = {
  colors: { accent1: "#C2410C", accent2: "#FDE68A", a: "$b", b: "$a" },
};

const gradient = (stops: { position: number; color: string }[]) => ({
  type: "gradient",
  gradientType: "linear",
  angle: 0,
  stops,
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canvas-table-cell-color-"));
}

function tableDeck(rows: unknown[][]): string {
  const dir = tmp();
  const project = createEmptyProject(dir, { title: "表格颜色令牌" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("表格颜色令牌"));
  project.pages[0]!.page.elements = [
    {
      elementId: "grid",
      elementType: "table",
      bounds: [60, 60, 400, 120],
      columnWidths: [0.5, 0.5],
      rows,
    },
  ] as PptdElement[];
  project.presentation.theme = THEME;
  saveProject(project);
  return dir;
}

/** The painted cells of the table in row order, from the render model the editor paints. */
function paintedRow(dir: string, row: number) {
  const table = renderModel(openSession(dir)).elements.find((el) => el.id === "grid");
  const cells = table?.tableRows?.[row];
  assert.ok(cells, `render model has row ${row}`);
  return cells;
}

describe("render model table cell colours", () => {
  it("paints a cell's theme tokens as the hex the export writes", () => {
    const dir = tableDeck([
      [{ text: "甲", color: "$accent1", fill: { type: "solid", color: "$accent2" } }, { text: "乙" }],
    ]);
    const [first, second] = paintedRow(dir, 0);
    assert.equal(first?.color, "#C2410C");
    assert.equal(first?.fill, "#FDE68A");
    assert.equal(second?.color, "#1A1917", "a cell without its own colour takes the text default");
    assert.equal(second?.fill, undefined, "a cell without its own fill takes the CSS default");
  });

  it("paints an #RRGGBBAA cell colour as the opaque hex the export writes", () => {
    const dir = tableDeck([[{ text: "甲", color: "#C2410C80", fill: { type: "solid", color: "#FDE68A80" } }]]);
    const [first] = paintedRow(dir, 0);
    assert.equal(first?.color, "#C2410C");
    assert.equal(first?.fill, "#FDE68A");
  });

  it("falls back for an unknown or cyclic cell token and keeps the stored token", () => {
    const dir = tableDeck([
      [
        { text: "甲", color: "$accent9", fill: { type: "solid", color: "$missing" } },
        { text: "乙", color: "$a", fill: { type: "solid", color: "$a" } },
      ],
    ]);
    const [first, second] = paintedRow(dir, 0);
    assert.equal(first?.color, "#1A1917", "the table text default, as the export writes it");
    assert.equal(first?.fill, undefined, "no fill, so the CSS header/body default paints");
    assert.equal(second?.color, "#1A1917");
    assert.equal(second?.fill, undefined);
    const raw = fs.readFileSync(path.join(dir, "pages", "cover.page"), "utf8");
    assert.match(raw, /\$accent9/);
    assert.match(raw, /\$missing/);
  });

  it("paints a one-stop gradient cell fill as its stop colour, and a two-stop gradient as no solid fill", () => {
    const dir = tableDeck([
      [{ text: "甲", fill: gradient([{ position: 0, color: "$accent2" }]) }],
      [
        {
          text: "乙",
          fill: gradient([
            { position: 0, color: "#112233" },
            { position: 1, color: "#FFFFFF" },
          ]),
        },
      ],
    ]);
    const [first] = paintedRow(dir, 0);
    const [second] = paintedRow(dir, 1);
    assert.equal(first?.fill, "#FDE68A", "a one-stop gradient paints its stop colour, as the file does");
    assert.equal(second?.fill, undefined, "a two-stop gradient has no solid fill, so the CSS default paints");
  });
});
