import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  createEmptyProject,
  listComposedPage,
  saveProject,
  type DeckLayout,
  type DeckMaster,
  type Page,
  type PptdProject,
  type TableElement,
  type TextElement,
} from "@open-slidestudio/pptd-v2";
import { exportProjectToPptx } from "./export-pptd.js";
import { assertWellFormedXml } from "./xml-lint.js";

/*
 * Ruling 138: a text box on a page marked content.field "pageNumber" shows that page's own number
 * in the exported package, with or without a layout. `{page}` becomes a slide-number field whose
 * cached text is the page's own number, and `{pages}` is the static page count, reported as such.
 * Ordinary text keeps its literal tokens, and the stored placeholder is never rewritten.
 */

function lintXml(xml: string, label: string): void {
  assertWellFormedXml(xml, label);
}

async function partText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  assert.ok(file, `${name} is missing from the export`);
  return file.async("string");
}

/** The `p:sp` whose cNvPr carries this name, as written. */
function shapeBlock(xml: string, name: string): string {
  const at = xml.indexOf(`name="${name}"`);
  assert.ok(at >= 0, `${name} is in the part`);
  return enclosingShape(xml, at);
}

/** The `p:sp` that holds this exact text run, as written. */
function shapeHolding(xml: string, text: string): string {
  const at = xml.indexOf(`<a:t>${text}</a:t>`);
  assert.ok(at >= 0, `${text} is in the part`);
  return enclosingShape(xml, at);
}

function enclosingShape(xml: string, at: number): string {
  const start = xml.lastIndexOf("<p:sp>", at);
  const end = xml.indexOf("</p:sp>", at) + "</p:sp>".length;
  return xml.slice(start, end);
}

function textElement(elementId: string, text: string): TextElement {
  return {
    elementId,
    elementType: "text",
    bounds: [40, 500, 300, 24],
    content: { text, fontSize: 12, color: "#6B7280", align: ["left", "middle"] },
  };
}

/** A text box that shows the page's own number: its content carries the pageNumber field. */
function pageNumberElement(elementId: string, text: string): TextElement {
  return {
    elementId,
    elementType: "text",
    bounds: [40, 500, 300, 24],
    content: {
      text,
      fontSize: 12,
      color: "#6B7280",
      align: ["left", "middle"],
      field: "pageNumber",
    },
  };
}

/** An ordinary table whose cells carry literal page tokens, as an example would. */
function tableElement(elementId: string, cells: string[]): TableElement {
  return {
    elementId,
    elementType: "table",
    bounds: [40, 100, 400, 80],
    columnWidths: cells.map(() => 400 / cells.length),
    rows: [cells.map((text) => ({ text }))],
  };
}

type DeckOptions = {
  pages: Page[];
  layouts?: DeckLayout[];
  masters?: DeckMaster[];
};

/** A saved project in a scratch directory. The caller removes it. */
function deckOf(options: DeckOptions): PptdProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-page-number-"));
  const project = createEmptyProject(dir, { title: "页码域" });
  if (options.masters) project.presentation.masters = options.masters;
  if (options.layouts) project.presentation.layouts = options.layouts;
  options.pages.forEach((page, index) => {
    listComposedPage(project, `pages/p${String(index + 1).padStart(2, "0")}.page`, page);
  });
  saveProject(project);
  return project;
}

describe("export of a page-owned pageNumber field (ruling 138)", () => {
  it("writes {page} as a slide-number field in its own text box, with no layout", async () => {
    const project = deckOf({
      pages: [
        { elements: [textElement("title", "第一页")] },
        {
          elements: [pageNumberElement("pn", "第 {page} 页 / 共 {pages} 页"), textElement("plain", "{page} 原样")],
        },
        { elements: [textElement("title", "第三页")] },
      ],
    });
    try {
      const result = await exportProjectToPptx(project);
      const zip = await JSZip.loadAsync(result.data);
      const slide2 = await partText(zip, "ppt/slides/slide2.xml");
      lintXml(slide2, "slide2.xml");
      const block = shapeBlock(slide2, "pn");
      assert.match(
        block,
        /<a:fld id="\{[^}]*\}" type="slidenum">(?:<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>)<a:t>2<\/a:t><\/a:fld>/,
        "the {page} token is a slidenum field whose cached text is the page's own number",
      );
      assert.match(block, /<a:t>第 <\/a:t>/, "the text before the number is its own run");
      assert.match(block, /<a:t> 页 \/ 共 3 页<\/a:t>/, "{pages} is the static page count");
      assert.doesNotMatch(block, /\{pages?\}/, "no token is left in the text box");
      assert.match(
        await partText(zip, "ppt/slides/slide3.xml"),
        /<a:t>第三页<\/a:t>/,
        "other pages keep their own text",
      );
      const plain = shapeHolding(slide2, "{page} 原样");
      assert.match(plain, /<a:t>\{page\} 原样<\/a:t>/, "ordinary text keeps its literal token");
      assert.doesNotMatch(plain, /slidenum/, "ordinary text has no field");
      assert.equal(
        (project.pages[1]!.page.elements[0] as TextElement).content.text,
        "第 {page} 页 / 共 {pages} 页",
        "the stored placeholder is not rewritten",
      );
    } finally {
      fs.rmSync(project.rootDir, { recursive: true, force: true });
    }
  });

  it("writes the same field on a page that uses a layout", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", elements: [textElement("pageno", "第 {page} 页")] }],
      layouts: [{ id: "body", name: "正文", masterId: "main", elements: [] }],
      pages: [
        { layoutId: "body", elements: [pageNumberElement("pn", "第 {page} 页")] },
        { layoutId: "body", elements: [pageNumberElement("pn", "第 {page} 页 / 共 {pages} 页")] },
      ],
    });
    try {
      const result = await exportProjectToPptx(project);
      const zip = await JSZip.loadAsync(result.data);
      const slide2 = await partText(zip, "ppt/slides/slide2.xml");
      lintXml(slide2, "slide2.xml");
      assert.match(
        shapeBlock(slide2, "pn"),
        /type="slidenum">(?:<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>)<a:t>2<\/a:t><\/a:fld>/,
        "the page's own field shows 2 on page 2 beside its layout",
      );
      assert.match(shapeBlock(slide2, "pn"), /<a:t> 页 \/ 共 2 页<\/a:t>/, "{pages} is the static total of the deck");
      const master = await partText(zip, "ppt/slideMasters/slideMaster1.xml");
      assert.match(master, /type="slidenum"/, "the master's own field is still a slide number");
    } finally {
      fs.rmSync(project.rootDir, { recursive: true, force: true });
    }
  });

  it("reports a page-owned {pages} as a static page count with a Chinese note", async () => {
    const project = deckOf({
      pages: [
        { elements: [textElement("title", "一")] },
        { elements: [pageNumberElement("pn", "共 {pages} 页")] },
        { elements: [textElement("title", "三")] },
      ],
    });
    try {
      const result = await exportProjectToPptx(project);
      const note = result.report.degradations.find(
        (item) => item.kind === "static-page-count" && item.elementId === "pn",
      );
      assert.ok(note, "the static page count is reported on its own page and element");
      assert.equal(note.slideIndex, 1);
      assert.match(note.reason, /第 2 页中的 \{pages\} 导出为固定的 3 页/);
      assert.match(note.reason, /PowerPoint 没有总页数域/);
      assert.match(note.reason, /重新导出/);
    } finally {
      fs.rmSync(project.rootDir, { recursive: true, force: true });
    }
  });

  /** The page-number box is patched alone: a normal table after it keeps its literal tokens. */
  async function assertTableKeepsTokens(project: PptdProject): Promise<void> {
    const result = await exportProjectToPptx(project);
    const zip = await JSZip.loadAsync(result.data);
    const slide2 = await partText(zip, "ppt/slides/slide2.xml");
    lintXml(slide2, "slide2.xml");
    const fields = slide2.match(/type="slidenum"/g) ?? [];
    assert.equal(fields.length, 1, "only the marked text box holds a slide-number field");
    assert.match(
      shapeBlock(slide2, "pn"),
      /type="slidenum">(?:<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>)<a:t>2<\/a:t><\/a:fld>/,
      "the marked text box shows its own number",
    );
    const table = slide2.slice(slide2.indexOf("<p:graphicFrame>"), slide2.indexOf("</p:graphicFrame>"));
    assert.ok(table.includes("<a:tbl>"), "the table is in the slide");
    assert.match(table, /<a:t>\{page\}<\/a:t>/, "the table keeps its literal {page}");
    assert.match(table, /<a:t>\{pages\}<\/a:t>/, "the table keeps its literal {pages}");
    assert.doesNotMatch(table, /slidenum/, "the table has no field");
    const stored = project.pages[1]!.page.elements.find((item) => item.elementId === "tbl");
    assert.equal((stored as TableElement).rows[0]![0]!.text, "{page}", "the stored table text is not rewritten");
  }

  it("leaves the literal tokens of a table after the number box, with no layout", async () => {
    const project = deckOf({
      pages: [
        { elements: [textElement("title", "一")] },
        {
          elements: [
            pageNumberElement("pn", "第 {page} 页 / 共 {pages} 页"),
            tableElement("tbl", ["{page}", "{pages}"]),
          ],
        },
      ],
    });
    try {
      await assertTableKeepsTokens(project);
    } finally {
      fs.rmSync(project.rootDir, { recursive: true, force: true });
    }
  });

  it("leaves the literal tokens of a table after the number box, on a layout page", async () => {
    const project = deckOf({
      masters: [{ id: "main", name: "母版", elements: [textElement("pageno", "第 {page} 页")] }],
      layouts: [{ id: "body", name: "正文", masterId: "main", elements: [] }],
      pages: [
        { layoutId: "body", elements: [textElement("title", "一")] },
        {
          layoutId: "body",
          elements: [
            pageNumberElement("pn", "第 {page} 页 / 共 {pages} 页"),
            tableElement("tbl", ["{page}", "{pages}"]),
          ],
        },
      ],
    });
    try {
      await assertTableKeepsTokens(project);
    } finally {
      fs.rmSync(project.rootDir, { recursive: true, force: true });
    }
  });

  it("writes no field and no note for a deck whose text has no pageNumber field", async () => {
    const project = deckOf({
      pages: [{ elements: [textElement("plain", "共 {pages} 页 {page}")] }],
    });
    try {
      const result = await exportProjectToPptx(project);
      const zip = await JSZip.loadAsync(result.data);
      assert.doesNotMatch(await partText(zip, "ppt/slides/slide1.xml"), /slidenum/);
      assert.match(await partText(zip, "ppt/slides/slide1.xml"), /<a:t>共 \{pages\} 页 \{page\}<\/a:t>/);
      assert.equal(
        result.report.degradations.some((item) => item.kind === "static-page-count"),
        false,
      );
    } finally {
      fs.rmSync(project.rootDir, { recursive: true, force: true });
    }
  });
});
