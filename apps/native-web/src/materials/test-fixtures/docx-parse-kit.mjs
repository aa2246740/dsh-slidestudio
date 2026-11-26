import { strToU8, zipSync } from "fflate";
import { tinyPng } from "../../testlib/pptx-fixture.mjs";

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
export const rel = (/** @type {string} */ type) =>
  `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}`;

export const esc = (/** @type {string} */ text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A body paragraph, optionally with a paragraph style. @param {string} text @param {string} [style] */
export const wp = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

/** Heading declared by a direct outline level instead of a style. */
export const wpOutline = (/** @type {string} */ text, /** @type {number} */ lvl) =>
  `<w:p><w:pPr><w:outlineLvl w:val="${lvl}"/></w:pPr><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`;

export const wpList = (/** @type {string} */ text, numId = "1") =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` +
  `<w:r><w:t>${esc(text)}</w:t></w:r></w:p>`;

/** 4×4 red PNG, the same picture the PPTX fixtures embed. */
export { tinyPng };

export const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** Document with a Chinese-named heading style, an outlineLvl style, direct
 * outline levels, list items, a merged table and one image. */
export function buildDocx() {
  const styles =
    `${XML_DECL}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:style w:type="paragraph" w:styleId="Biaoti1"><w:name w:val="标题 1"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="LvlTwo"><w:name w:val="自定义样式"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>` +
    `</w:styles>`;
  const body = [
    wp("中文样式标题", "Biaoti1"),
    wp("二级标题", "LvlTwo"),
    wpOutline("直接大纲级别标题", 2),
    wp("正文段落：合并单元格检查。"),
    wpList("列表项一"),
    wpList("列表项二"),
    // numId="0" removes list semantics — a plain paragraph.
    wpList("编号为零不是列表", "0"),
    `<w:tbl><w:tblPr/>` +
      `<w:tr>` +
      `<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${wp("跨两列")}</w:tc>` +
      `<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${wp("合并起始")}</w:tc>` +
      `</w:tr>` +
      `<w:tr><w:tc>${wp("普通")}</w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr>${wp("")}</w:tc></w:tr>` +
      `</w:tbl>`,
    `<w:p><w:r><w:drawing><wp:inline>` +
      `<wp:extent cx="190500" cy="190500"/><wp:docPr id="1" name="图"/>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
  ].join("");

  return Buffer.from(
    zipSync(
      {
        "[Content_Types].xml": strToU8(
          `${XML_DECL}<Types xmlns="${RELS_NS}">` +
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
            `<Default Extension="xml" ContentType="application/xml"/>` +
            `<Default Extension="png" ContentType="image/png"/>` +
            `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
            `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
            `</Types>`,
        ),
        "_rels/.rels": strToU8(
          `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${rel("officeDocument")}" Target="word/document.xml"/></Relationships>`,
        ),
        "word/document.xml": strToU8(`${XML_DECL}<w:document ${W_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`),
        "word/_rels/document.xml.rels": strToU8(
          `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rIdImg" Type="${rel("image")}" Target="media/image1.png"/></Relationships>`,
        ),
        "word/styles.xml": strToU8(styles),
        "word/media/image1.png": new Uint8Array(tinyPng()),
      },
      { level: 6 },
    ),
  );
}
