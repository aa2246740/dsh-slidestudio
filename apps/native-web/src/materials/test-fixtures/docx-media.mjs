/**
 * In-memory DOCX builders for parser and intake tests. `docxWithMedia` alternates a text
 * paragraph with a paragraph holding one picture, so paragraph ordinals are predictable: the
 * picture of entry `i` (0-based) sits in body paragraph `2 * i + 2`. `docxWithBody` takes the
 * body XML itself, built from `textParagraph`, `pictureParagraph` and `tableOf`, for layouts
 * such as pictures inside table cells. `tableRaw`, `rowRaw`, `cellOf`, `sdtOf` and `customXmlOf`
 * build the wrapped forms (content controls, customXml) around rows, cells and blocks. Entry `i`
 * of the media list is relationship `rIdPic{i+1}`.
 */
import { strToU8, zipSync } from "fflate";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
/** @param {string} type */
const rel = (type) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}`;
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** A paragraph of plain text (also the empty paragraph a table cell must end with).
 * @param {string} text */
export const textParagraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/** The `w:drawing` of media entry `index`, a picture placed inline.
 * @param {number} index */
export function drawingOf(index) {
  return (
    `<w:drawing><wp:inline><wp:extent cx="190500" cy="190500"/>` +
    `<wp:docPr id="${index + 1}" name="图 ${index + 1}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:blipFill><a:blip r:embed="rIdPic${index + 1}"/></pic:blipFill></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

/** A paragraph holding one picture: media entry `index` of the list given to `docxWithBody`.
 * @param {number} index */
export function pictureParagraph(index) {
  return `<w:p><w:r>${drawingOf(index)}</w:r></w:p>`;
}

/** A `w:tc` holding block XML, or `{body, span}` for a cell that spans `span` grid columns.
 * @param {string | {body: string, span?: number}} cell */
export function cellOf(cell) {
  const { body, span } = typeof cell === "string" ? { body: cell, span: 1 } : cell;
  const tcPr = span && span > 1 ? `<w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr>` : "";
  return `<w:tc>${tcPr}${body}</w:tc>`;
}

/** A `w:tr` around `inner`: cells, or wrappers that hold cells.
 * @param {string} inner */
export const rowRaw = (inner) => `<w:tr>${inner}</w:tr>`;

/** A `w:tr` of cells (see `cellOf`).
 * @param {(string | {body: string, span?: number})[]} cells */
export const rowOf = (cells) => rowRaw(cells.map((cell) => cellOf(cell)).join(""));

/** A `w:tbl` around `inner`: rows, or wrappers that hold rows.
 * @param {string} inner */
export const tableRaw = (inner) => `<w:tbl><w:tblPr/>${inner}</w:tbl>`;

/**
 * A table. Each row is a list of cells; a cell is its block XML, or `{body, span}` for a cell
 * that spans `span` grid columns.
 * @param {(string | {body: string, span?: number})[][]} rows
 */
export function tableOf(rows) {
  return tableRaw(rows.map((row) => rowOf(row)).join(""));
}

/** A block, row or cell content control (`w:sdt`) around `inner`.
 * @param {string} inner */
export const sdtOf = (inner) => `<w:sdt><w:sdtPr/><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;

/** XML mapping (`w:customXml`) around blocks, rows or cells.
 * @param {string} inner */
export const customXmlOf = (inner) =>
  `<w:customXml w:uri="urn:oss-test:map" w:element="item">${inner}</w:customXml>`;

/**
 * A DOCX whose body is `bodyXml` and whose media entries are the pictures it refers to.
 * @param {string} bodyXml
 * @param {{name: string, bytes: Uint8Array}[]} media file name under word/media
 * @param {{store?: boolean}} [options] store: true keeps the media uncompressed
 * @returns {Buffer}
 */
export function docxWithBody(bodyXml, media, { store = false } = {}) {
  /** @type {string[]} */
  const rels = [];
  /** @type {Record<string, Uint8Array>} */
  const files = {};
  media.forEach((entry, index) => {
    rels.push(
      `<Relationship Id="rIdPic${index + 1}" Type="${rel("image")}" Target="media/${entry.name}"/>`,
    );
    files[`word/media/${entry.name}`] = store
      ? /** @type {any} */ ([new Uint8Array(entry.bytes), { level: 0 }])
      : new Uint8Array(entry.bytes);
  });
  return Buffer.from(
    zipSync(
      {
        "[Content_Types].xml": strToU8(
          `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
            `<Default Extension="xml" ContentType="application/xml"/>` +
            `<Default Extension="png" ContentType="image/png"/>` +
            `<Default Extension="jpg" ContentType="image/jpeg"/>` +
            `<Default Extension="gif" ContentType="image/gif"/>` +
            `<Default Extension="emf" ContentType="image/x-emf"/>` +
            `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
            `</Types>`,
        ),
        "_rels/.rels": strToU8(
          `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${rel("officeDocument")}" Target="word/document.xml"/></Relationships>`,
        ),
        "word/document.xml": strToU8(
          `${XML_DECL}<w:document ${W_NS}><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`,
        ),
        "word/_rels/document.xml.rels": strToU8(
          `${XML_DECL}<Relationships xmlns="${RELS_NS}">${rels.join("")}</Relationships>`,
        ),
        ...files,
      },
      { level: 6 },
    ),
  );
}

/**
 * @param {{name: string, bytes: Uint8Array}[]} media file name under word/media
 * @param {{store?: boolean}} [options] store: true keeps the media uncompressed
 * @returns {Buffer}
 */
export function docxWithMedia(media, options = {}) {
  const body = media
    .map(
      (_, index) => textParagraph(`第 ${index + 1} 张图之前的说明文字。`) + pictureParagraph(index),
    )
    .join("");
  return docxWithBody(body, media, options);
}
