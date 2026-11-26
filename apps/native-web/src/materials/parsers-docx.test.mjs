import assert from "node:assert/strict";
import { test } from "node:test";
import { runParseJob } from "./parse-worker.mjs";
import {
  cellOf,
  customXmlOf,
  docxWithBody,
  docxWithMedia,
  drawingOf,
  pictureParagraph,
  rowOf,
  rowRaw,
  sdtOf,
  tableOf,
  tableRaw,
  textParagraph,
} from "./test-fixtures/docx-media.mjs";
import { gatherDocxImages } from "./docx-images.mjs";
import { tinyPng, buildDocx } from "./test-fixtures/docx-parse-kit.mjs";

/**
 * The DOCX read-out of a parse-job derivative as these tests inspect it. Blocks are looked up by
 * type, so the view carries the fields of every block kind the tests read.
 * @typedef {{type: string, text: string, level: number, part: string, paragraph: number,
 *   rows: {text: string, colSpan?: number, vMerge?: string}[][]}} DocxBlockView
 * @typedef {{part: string, bytes?: number, paragraph?: number, table?: number, row?: number,
 *   column?: number}} DocxImageView
 * @typedef {import("./derivative.mjs").Derivative & {document: {blocks: DocxBlockView[],
 *   images: DocxImageView[], counts: {images: number, tables: number}}}} DocxDerivative
 */

test("headings come from 标题 N style names, style outlineLvl and direct outlineLvl", async () => {
  const derivative = /** @type {DocxDerivative} */ (
    await runParseJob({
      materialId: "mh",
      name: "hand.docx",
      bytes: buildDocx(),
    })
  );
  const headings = derivative.document.blocks.filter(
    (/** @type {{ type: string; }} */ block) => block.type === "heading",
  );
  assert.deepEqual(
    headings.map((/** @type {{ level: any; text: any; }} */ heading) => [heading.level, heading.text]),
    [
      [1, "中文样式标题"],
      [2, "二级标题"],
      [3, "直接大纲级别标题"],
    ],
  );
  const types = derivative.document.blocks.map((/** @type {{ type: any; }} */ block) => block.type);
  assert.equal(types.filter((/** @type {string} */ type) => type === "listItem").length, 2);

  // gridSpan / vMerge survive into the table cells.
  const table = /** @type {DocxBlockView} */ (
    derivative.document.blocks.find((/** @type {{ type: string; }} */ block) => block.type === "table")
  );
  assert.equal(table.rows[0][0].colSpan, 2);
  assert.equal(table.rows[0][1].vMerge, "restart");
  assert.equal(table.rows[1][1].vMerge, "continue");
  assert.equal(table.rows[0][0].text, "跨两列");

  // The image resolves through its relationship to the media part.
  const imageBlock = /** @type {DocxBlockView} */ (
    derivative.document.blocks.find((/** @type {{ type: string; }} */ block) => block.type === "image")
  );
  assert.equal(imageBlock.part, "word/media/image1.png");
  // Seven body paragraphs precede it; table cell paragraphs are not counted.
  assert.equal(imageBlock.paragraph, 8);
  assert.equal(derivative.document.images[0].paragraph, 8);
});

test("VAL-PDF-007: a picture used twice keeps the paragraph of its first appearance", async () => {
  const png = tinyPng();
  const derivative = /** @type {DocxDerivative} */ (
    await runParseJob({
      materialId: "mt",
      name: "twice.docx",
      bytes: docxWithMedia([
        { name: "one.png", bytes: png },
        { name: "two.png", bytes: png },
      ]),
    })
  );
  assert.deepEqual(
    derivative.document.images.map(({ part, paragraph }) => [part, paragraph]),
    [
      ["word/media/one.png", 2],
      ["word/media/two.png", 4],
    ],
  );
});

test("pictures inside table cells, nested tables included, keep their table position in document order", async () => {
  const png = tinyPng();
  const media = ["a", "b", "c", "d", "e", "f"].map((name) => ({ name: `${name}.png`, bytes: png }));
  const body = [
    textParagraph("前言"),
    pictureParagraph(0),
    tableOf([
      [pictureParagraph(1), textParagraph("只有文字")],
      [{ body: tableOf([[pictureParagraph(2)]]) + textParagraph("嵌套表格之后") }, pictureParagraph(3)],
      [{ body: pictureParagraph(4), span: 2 }, pictureParagraph(5)],
    ]),
  ].join("");
  const bytes = docxWithBody(body, media);
  const derivative = /** @type {DocxDerivative} */ (
    await runParseJob({ materialId: "mtc", name: "tables.docx", bytes })
  );
  const doc = derivative.document;

  // Body pictures keep their paragraph; table pictures keep table, row and grid column. A
  // nested table is numbered after the table around it, and a spanning cell takes its columns.
  assert.deepEqual(
    doc.images.map((/** @type {DocxImageView} */ image) => [
      image.part.replace("word/media/", ""),
      image.paragraph ?? { table: image.table, row: image.row, column: image.column },
    ]),
    [
      ["a.png", 2],
      ["b.png", { table: 1, row: 1, column: 1 }],
      ["c.png", { table: 2, row: 1, column: 1 }],
      ["d.png", { table: 1, row: 2, column: 2 }],
      ["e.png", { table: 1, row: 3, column: 1 }],
      ["f.png", { table: 1, row: 3, column: 3 }],
    ],
  );
  assert.equal(doc.counts.images, 6, "every appearance is counted, as body pictures are");
  assert.equal(doc.counts.tables, 1, "nested tables are not counted as table blocks");
  assert.equal(
    doc.blocks.filter((/** @type {{ type: string; }} */ block) => block.type === "image").length,
    1,
    "table pictures add no blocks, so the read-out of the table is unchanged",
  );
  assert.equal(
    /** @type {DocxBlockView} */ (doc.blocks.find((/** @type {{ type: string; }} */ block) => block.type === "table"))
      .rows[0][1].text,
    "只有文字",
  );

  const gathered = gatherDocxImages({ bytes, stem: "tables", images: doc.images });
  assert.deepEqual(
    gathered.candidates.map((candidate) => candidate.position),
    [
      { paragraph: 2 },
      { table: 1, row: 1, column: 1 },
      { table: 2, row: 1, column: 1 },
      { table: 1, row: 2, column: 2 },
      { table: 1, row: 3, column: 1 },
      { table: 1, row: 3, column: 3 },
    ],
  );
});

/**
 * Picture positions of a DOCX whose body is `body`, read through the real parse job. Media entry
 * `i` is named `names[i].png`, so each picture is identified by its name.
 * @param {string} body @param {string[]} names
 */
async function picturesOf(body, names) {
  const png = tinyPng();
  const bytes = docxWithBody(
    body,
    names.map((name) => ({ name: `${name}.png`, bytes: png })),
  );
  const derivative = /** @type {DocxDerivative} */ (
    await runParseJob({ materialId: "mw", name: "wrapped.docx", bytes })
  );
  return {
    doc: derivative.document,
    positions: derivative.document.images.map((/** @type {DocxImageView} */ image) => [
      image.part.replace("word/media/", ""),
      image.paragraph !== undefined
        ? { paragraph: image.paragraph }
        : { table: image.table, row: image.row, column: image.column },
    ]),
  };
}

test("a row-level content control: its rows keep table, row and column, and read back as rows", async () => {
  const { doc, positions } = await picturesOf(
    tableRaw(
      sdtOf(rowOf([pictureParagraph(0), textParagraph("文字")]) + rowOf([textParagraph("甲"), pictureParagraph(1)])),
    ),
    ["a", "b"],
  );
  assert.deepEqual(positions, [
    ["a.png", { table: 1, row: 1, column: 1 }],
    ["b.png", { table: 1, row: 2, column: 2 }],
  ]);
  assert.deepEqual(
    /** @type {DocxBlockView} */ (
      doc.blocks.find((/** @type {{ type: string; }} */ block) => block.type === "table")
    ).rows.map((/** @type {any[]} */ row) => row.map((/** @type {{ text: any; }} */ cell) => cell.text)),
    [
      ["", "文字"],
      ["甲", ""],
    ],
  );
  assert.equal(doc.counts.images, 2, "every appearance is counted");
});

test("a customXml wrapper around rows: its rows keep table and row", async () => {
  const { positions } = await picturesOf(
    tableRaw(customXmlOf(rowOf([pictureParagraph(0)]) + rowOf([pictureParagraph(1)]))),
    ["a", "b"],
  );
  assert.deepEqual(positions, [
    ["a.png", { table: 1, row: 1, column: 1 }],
    ["b.png", { table: 1, row: 2, column: 1 }],
  ]);
});

test("a cell-level content control: its cells keep their grid columns, spans included", async () => {
  const { positions } = await picturesOf(
    tableRaw(
      rowRaw(
        sdtOf(cellOf({ body: pictureParagraph(0), span: 2 }) + cellOf(textParagraph("文字"))) +
          cellOf(pictureParagraph(1)),
      ),
    ),
    ["a", "b"],
  );
  // The wrapped cell covers columns 1-2, the text cell is column 3, the last cell is column 4.
  assert.deepEqual(positions, [
    ["a.png", { table: 1, row: 1, column: 1 }],
    ["b.png", { table: 1, row: 1, column: 4 }],
  ]);
});

test("a customXml wrapper around cells: its cells keep their grid columns", async () => {
  const { positions } = await picturesOf(
    tableRaw(rowRaw(customXmlOf(cellOf(pictureParagraph(0))) + cellOf(pictureParagraph(1)))),
    ["a", "b"],
  );
  assert.deepEqual(positions, [
    ["a.png", { table: 1, row: 1, column: 1 }],
    ["b.png", { table: 1, row: 1, column: 2 }],
  ]);
});

test("a customXml wrapper around the blocks of a cell: its paragraphs are read in the cell", async () => {
  const { doc, positions } = await picturesOf(
    tableRaw(rowOf([customXmlOf(pictureParagraph(0) + textParagraph("包裹文字")), pictureParagraph(1)])),
    ["a", "b"],
  );
  assert.deepEqual(positions, [
    ["a.png", { table: 1, row: 1, column: 1 }],
    ["b.png", { table: 1, row: 1, column: 2 }],
  ]);
  assert.equal(
    /** @type {DocxBlockView} */ (doc.blocks.find((/** @type {{ type: string; }} */ block) => block.type === "table"))
      .rows[0][0].text,
    "包裹文字",
  );
});

test("nested content controls and customXml around rows and cells keep their positions", async () => {
  const { positions } = await picturesOf(
    tableRaw(sdtOf(customXmlOf(rowRaw(sdtOf(cellOf(pictureParagraph(0))) + cellOf(pictureParagraph(1)))))),
    ["a", "b"],
  );
  assert.deepEqual(positions, [
    ["a.png", { table: 1, row: 1, column: 1 }],
    ["b.png", { table: 1, row: 1, column: 2 }],
  ]);
});

test("a table in a row-level content control is numbered after the table around it", async () => {
  const { positions } = await picturesOf(
    tableRaw(sdtOf(rowOf([{ body: tableOf([[pictureParagraph(0)]]) }, pictureParagraph(1)]))) +
      tableOf([[pictureParagraph(2)]]),
    ["a", "b", "c"],
  );
  assert.deepEqual(positions, [
    ["a.png", { table: 2, row: 1, column: 1 }],
    ["b.png", { table: 1, row: 1, column: 2 }],
    ["c.png", { table: 3, row: 1, column: 1 }],
  ]);
});

test("a picture in mc:AlternateContent around a drawing in a cell keeps its cell position", async () => {
  const alternate =
    `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<mc:Choice Requires="wps">${drawingOf(0)}</mc:Choice><mc:Fallback><w:pict/></mc:Fallback>` +
    `</mc:AlternateContent></w:r></w:p>`;
  const { positions } = await picturesOf(tableRaw(rowOf([alternate, pictureParagraph(1)])), ["a", "b"]);
  assert.deepEqual(positions, [
    ["a.png", { table: 1, row: 1, column: 1 }],
    ["b.png", { table: 1, row: 1, column: 2 }],
  ]);
});

test("a row that starts with gridBefore places its cells after the empty leading columns", async () => {
  const { positions } = await picturesOf(
    tableRaw(
      rowRaw(`<w:trPr><w:gridBefore w:val="1"/></w:trPr>` + cellOf(pictureParagraph(0)) + cellOf(pictureParagraph(1))),
    ),
    ["a", "b"],
  );
  assert.deepEqual(positions, [
    ["a.png", { table: 1, row: 1, column: 2 }],
    ["b.png", { table: 1, row: 1, column: 3 }],
  ]);
});

test("a customXml wrapper around a nested table in a cell: the nested table keeps its number", async () => {
  const { doc, positions } = await picturesOf(
    tableRaw(rowOf([customXmlOf(tableOf([[pictureParagraph(0)]])) + textParagraph("外层")])) +
      tableOf([[pictureParagraph(1)]]),
    ["a", "b"],
  );
  assert.deepEqual(positions, [
    ["a.png", { table: 2, row: 1, column: 1 }],
    ["b.png", { table: 3, row: 1, column: 1 }],
  ]);
  assert.equal(doc.counts.tables, 2, "a nested table is not a block of its own");
});

test("a customXml wrapper around a whole body table: the table keeps its number and pictures", async () => {
  const { doc, positions } = await picturesOf(
    customXmlOf(tableOf([[pictureParagraph(0), textParagraph("正文表")]])) + textParagraph("后文"),
    ["a"],
  );
  assert.deepEqual(positions, [["a.png", { table: 1, row: 1, column: 1 }]]);
  assert.deepEqual(
    doc.blocks.map((/** @type {{ type: any; }} */ block) => block.type),
    ["table", "paragraph"],
    "the wrapped table reads back as a table block, in order",
  );
  assert.equal(doc.blocks[0].rows[0][1].text, "正文表");
});

test("body-level content controls and customXml keep their paragraph positions", async () => {
  const { doc, positions } = await picturesOf(
    sdtOf(pictureParagraph(0)) + customXmlOf(pictureParagraph(1)) + textParagraph("后文"),
    ["a", "b"],
  );
  assert.deepEqual(positions, [
    ["a.png", { paragraph: 1 }],
    ["b.png", { paragraph: 2 }],
  ]);
  assert.deepEqual(
    doc.blocks
      .filter((/** @type {{ type: string; }} */ block) => block.type === "paragraph")
      .map((/** @type {{ text: any; }} */ block) => block.text),
    ["后文"],
  );
});

test("VAL-PDF-007: DOCX picture gathering enforces the per-image, total and count caps", async () => {
  const png = tinyPng();
  const media = Array.from({ length: 5 }, (_, index) => ({ name: `p${index}.png`, bytes: png }));
  const bytes = docxWithMedia(media);
  const derivative = /** @type {DocxDerivative} */ (await runParseJob({ materialId: "mg", name: "caps.docx", bytes }));
  const images = derivative.document.images;
  const base = { bytes, stem: "caps", images };

  assert.equal(gatherDocxImages(base).candidates.length, 5);
  // The frozen default limits type `maxImages` as the literal 40, so a lower cap needs a cast.
  const fewer = /** @type {Parameters<typeof gatherDocxImages>[0]["limits"]} */ (
    /** @type {unknown} */ ({ maxImages: 3 })
  );
  const capped = gatherDocxImages({ ...base, limits: fewer });
  assert.equal(capped.candidates.length, 3);
  assert.equal(capped.limitReached, true);
  assert.equal(capped.found, 5);
  const oversize = gatherDocxImages({ ...base, limits: { maxImageBytes: 10 } });
  assert.deepEqual(oversize.candidates, []);
  assert.equal(oversize.skipped.tooLarge, 5);
  const total = gatherDocxImages({ ...base, limits: { maxTotalBytes: png.length * 2 + 1 } });
  assert.equal(total.candidates.length, 2);
  assert.equal(total.skipped.tooLarge, 3);
  const missing = gatherDocxImages({ ...base, images: [{ part: "word/media/nope.png" }] });
  assert.equal(missing.skipped.unreadable, 1);
  assert.deepEqual(
    gatherDocxImages(base).candidates.map(({ name, position }) => [
      name,
      /** @type {{paragraph?: number}} */ (position).paragraph,
    ]),
    [0, 1, 2, 3, 4].map((index) => [`caps-p${index}.png`, index * 2 + 2]),
  );
});
