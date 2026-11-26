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
import { exportProjectToPptx } from "./export-pptd.js";

/*
 * The table cell hex the export writes. The editor's table cell test (canvas-session
 * table-cell-color.test.ts) and its browser test (native-web table-cell-token-dom.test.mjs) assert
 * the same values, so the three surfaces are checked against one set of colours.
 */

const THEME: NonNullable<PptdProject["presentation"]["theme"]> = {
  colors: { accent1: "#C2410C", accent2: "#FDE68A", a: "$b", b: "$a" },
};

function tableDeck(rows: unknown[][]): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-table-cell-color-"));
  const project = createEmptyProject(dir, { title: "表格颜色令牌" });
  listComposedPage(project, "pages/cover.page", titleOnlyCoverPage("表格颜色令牌"));
  project.pages[0]!.page.elements = [
    {
      elementId: "grid",
      elementType: "table",
      bounds: [60, 60, 400, 160],
      columnWidths: [0.5, 0.5],
      rows,
    },
  ] as PptdElement[];
  project.presentation.theme = THEME;
  saveProject(project);
  return project;
}

const gradient = (stops: { position: number; color: string }[]) => ({
  type: "gradient",
  gradientType: "linear",
  angle: 0,
  stops,
});

async function slideXml(data: Buffer): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("ppt/slides/slide1.xml")?.async("string");
  assert.ok(xml, "slide1.xml present");
  return xml;
}

/** The exported `a:tc` that holds the given text. */
function exportedCell(xml: string, text: string): string {
  const cell = xml.match(/<a:tc\b[\s\S]*?<\/a:tc>/g)?.find((tc) => tc.includes(`>${text}</a:t>`));
  assert.ok(cell, `exported cell ${text}`);
  return cell;
}

/** The text colour: the solid fill inside the run properties. */
const textHex = (cell: string) => {
  const runProperties = cell.match(/<a:rPr\b[^>]*>([\s\S]*?)<\/a:rPr>/)?.[1] ?? "";
  return runProperties.match(/srgbClr val="([0-9A-Fa-f]{6})"/)?.[1];
};

/** The cell fill: the solid fill that follows the four border rules in the cell properties. */
const fillHex = (cell: string) => {
  const tcPr = cell.match(/<a:tcPr\b[\s\S]*?<\/a:tcPr>/)?.[0] ?? "";
  const cellFill = tcPr.replace(/<a:ln[LRTB]\b[\s\S]*?<\/a:ln[LRTB]>/g, "");
  return cellFill.match(/<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1];
};

describe("export table cell colours", () => {
  it("exports a cell's theme tokens as the hex the editor paints", async () => {
    const project = tableDeck([
      [{ text: "甲", color: "$accent1", fill: { type: "solid", color: "$accent2" } }, { text: "乙" }],
    ]);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true);
    const xml = await slideXml(result.data);
    const first = exportedCell(xml, "甲");
    assert.equal(textHex(first)?.toUpperCase(), "C2410C");
    assert.equal(fillHex(first)?.toUpperCase(), "FDE68A");
  });

  it("exports the table defaults for an unknown or cyclic cell token", async () => {
    const project = tableDeck([
      [
        { text: "甲", color: "$accent9", fill: { type: "solid", color: "$missing" } },
        { text: "丁", color: "$a", fill: { type: "solid", color: "$a" } },
      ],
      [{ text: "丙", color: "$accent9", fill: { type: "solid", color: "$missing" } }],
    ]);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true);
    const xml = await slideXml(result.data);
    const header = exportedCell(xml, "甲");
    assert.equal(textHex(header)?.toUpperCase(), "1A1917", "the table text default");
    assert.equal(fillHex(header)?.toUpperCase(), "F3F4F6", "the header fill default");
    const body = exportedCell(xml, "丙");
    assert.equal(fillHex(body)?.toUpperCase(), "FFFFFF", "the body fill default");
    assert.doesNotMatch(xml, /\$accent9|\$missing|\$a\b/);
  });

  it("exports a one-stop gradient cell fill as its stop colour, and a two-stop gradient as no solid fill", async () => {
    const project = tableDeck([
      [{ text: "甲", fill: gradient([{ position: 0, color: "$accent2" }]) }],
      [
        {
          text: "丙",
          fill: gradient([
            { position: 0, color: "#112233" },
            { position: 1, color: "#FFFFFF" },
          ]),
        },
      ],
    ]);
    const result = await exportProjectToPptx(project);
    assert.equal(result.report.ok, true);
    const xml = await slideXml(result.data);
    assert.equal(fillHex(exportedCell(xml, "甲"))?.toUpperCase(), "FDE68A");
    assert.equal(fillHex(exportedCell(xml, "丙"))?.toUpperCase(), "FFFFFF", "the body fill default");
  });
});
