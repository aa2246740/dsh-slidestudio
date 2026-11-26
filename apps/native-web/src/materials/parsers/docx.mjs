/**
 * `docx-ooxml-v1` — Word documents. Blocks (heading, paragraph, listItem,
 * table, image) are read in document order with @xmldom/xmldom: headings come
 * from outline levels (style `w:outlineLvl`, direct `w:outlineLvl`) or style
 * names like "heading 1" / "标题 1" (the styleId "Heading1" counts as a last
 * resort), list items from `w:numPr`, tables keep gridSpan/vMerge, and images
 * are resolved through the document relationships. Pictures inside table cells
 * (nested tables too) are listed with their table position, not as blocks. Content controls
 * (w:sdt) and customXml wrappers are looked through wherever they sit: body, row or cell.
 * CAP-33: the theme colour scheme and heading font become clue-only style
 * hints (`source: "docx-theme"`), and embedded charts are read as cached data.
 */
import { normalizeSourceFonts } from "@open-slidestudio/pptd-v2";
import { MaterialRejection } from "../zip-guard.mjs";
import { buildSummaryZh } from "../summary.mjs";
import {
  PackageReader,
  attrOf,
  childElements,
  childNodesOf,
  descendantsOf,
  firstOf,
  localNameOf,
  parseRels,
  parseXml,
  resolvePartPath,
} from "./ooxml.mjs";
import { diagramText, readDiagram, takeDiagram } from "./ooxml-diagram.mjs";
import { parseTheme } from "./ooxml-theme.mjs";
import { readOfficeCharts } from "./office-charts.mjs";

const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";
const THEME_PART = "word/theme/theme1.xml";
const DOCX_ACCENT_KEYS = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];

/**
 * Theme colours and the major (heading) font as clue-only hints. They are
 * never an adoptable palette: `commit_design` refuses visual aspects for Word
 * sources, and the chip copy says 风格只作线索. No readable accents and fonts
 * → no profile at all.
 * @param {import("./ooxml-theme.mjs").Theme} theme
 */
export function docxThemeStyleProfile(theme) {
  const accents = DOCX_ACCENT_KEYS.map((key) => theme.colors[key])
    .filter((hex) => typeof hex === "string" && hex.length > 0)
    .slice(0, 5);
  const major = theme.fonts.major;
  const declared = [major?.ea, major?.hans, major?.latin].find((name) => typeof name === "string" && name.length > 0);
  const fonts = declared
    ? [
        {
          source: declared,
          share: 1,
          mapped: normalizeSourceFonts({ major, minor: theme.fonts.minor ?? major }).major.mapped,
        },
      ]
    : [];
  if (!accents.length && !fonts.length) return undefined;
  const share = accents.length ? 1 / accents.length : 0;
  return {
    schema: "style-profile/v1",
    source: "docx-theme",
    accentColors: accents.map((hex) => ({ hex, share, roles: ["fill"] })),
    fonts,
  };
}

/** @typedef {{type: "heading", level: number, text: string}|{type: "paragraph", text: string}|{type: "listItem", text: string}|{type: "image", relId: string, part: string, paragraph: number}|{type: "table", rows: DocCell[][]}|{type:"smartart",layout:string,nodes:import("./ooxml-diagram.mjs").DiagramNode[],text:string}} DocBlock */

/** @typedef {{text: string, colSpan?: number, vMerge?: "restart"|"continue"}} DocCell */

/** A picture is listed at its first appearance. `paragraph` is the 1-based ordinal of the body
 * paragraph it sits in (table cells do not count); it is what 「来自文档第 N 段」 names. A
 * picture in a table names its table (1-based, in document order), its row and its grid column
 * (both 1-based), which is what 「来自文档第 N 个表格」 is read from.
 * @typedef {{part: string, bytes?: number, paragraph: number}
 *   | {part: string, bytes?: number, table: number, row: number, column: number}} ImageEntry */

/** @typedef {{images: ImageEntry[], counts: DocCounts,
 *   rels: Map<string, import("./ooxml.mjs").PartRelationship>, pkg: PackageReader,
 *   docPart: string}} MediaContext */

/** @typedef {{headings: number, paragraphs: number, listItems: number, tables: number, images: number,smartArts?:number}} DocCounts */

export const docxParser = {
  id: "docx-ooxml-v1",
  engine: "fflate + @xmldom/xmldom",
  /** @type {"document"} */
  kind: "document",

  /**
   * @param {{name: string, bytes: Uint8Array}} input
   * @returns {import("../derivative.mjs").ParserResult<object>}
   */
  parse({ bytes }) {
    const pkg = new PackageReader(bytes);
    const docPart = "word/document.xml";
    const docText = pkg.text(docPart);
    if (docText === undefined) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);
    const doc = parseXml(docText, docPart);
    const levels = styleHeadingLevels(pkg);
    const rels = parseRels(pkg, docPart);

    const body = firstOf(doc, "body");
    if (!body) throw new MaterialRejection("corrupt", CORRUPT_MESSAGE);

    /** @type {DocBlock[]} */
    const blocks = [];
    /** @type {ImageEntry[]} */
    const images = [];
    /** @type {DocCounts} */
    const counts = { headings: 0, paragraphs: 0, listItems: 0, tables: 0, images: 0 };
    /** @type {import("./ooxml-diagram.mjs").Warning[]} */ const warnings = [];
    const diagramBudget = { count: 0, truncated: false };
    /** @type {MediaContext & {tables: number}} */
    const media = { images, counts, rels, pkg, docPart, tables: 0 };
    let paragraphIndex = 0;
    let chars = 0;

    for (const child of contentOf(body, (local) => local === "p" || local === "tbl")) {
      if (localNameOf(child) === "p") {
        paragraphIndex += 1;
        emitParagraph(child, {
          blocks,
          images,
          counts,
          levels,
          rels,
          pkg,
          docPart,
          warnings,
          diagramBudget,
          paragraphIndex,
        });
      } else {
        emitTable(child, counts, blocks);
        collectTablePictures(child, media);
      }
    }

    for (const block of blocks) {
      if (block.type === "table") {
        for (const row of block.rows) for (const cell of row) chars += Array.from(cell.text).length;
      } else if (block.type !== "image" && block.text) {
        chars += Array.from(block.text).length;
      }
    }

    const firstHeading = blocks.find((block) => block.type === "heading")?.text;
    // CAP-33: theme hints and embedded chart data. The charts list is always
    // present (an empty list is a real 「未识别到图表」 result and is what keeps
    // stored records current); the style profile exists only with a theme.
    const { charts, warnings: chartWarnings } = readOfficeCharts(pkg, docPart, rels);
    warnings.push(...chartWarnings);
    const theme = parseTheme(pkg, THEME_PART);
    const styleProfile = theme ? docxThemeStyleProfile(theme) : undefined;
    return {
      payload: {
        blocks,
        images,
        counts,
        chars,
        charts,
        ...(styleProfile ? { styleProfile } : {}),
      },
      summary: buildSummaryZh({
        parserId: this.id,
        counts,
        chars,
        firstHeading,
        chartCount: charts.length,
        extra: counts.smartArts ? [`含 ${counts.smartArts} 个 SmartArt（文字和层级可读取）`] : [],
      }),
      warnings,
      truncated: { applied: warnings.some((warning) => warning.code === "smartart-truncated") },
    };
  },
};

/**
 * styleId → heading level from styles.xml: an explicit outlineLvl wins, then
 * the style name "heading N" / "标题 N" / "Title" / "标题".
 * @param {PackageReader} pkg
 * @returns {Map<string, number>}
 */
export function styleHeadingLevels(pkg) {
  /** @type {Map<string, number>} */
  const levels = new Map();
  const text = pkg.text("word/styles.xml");
  if (text === undefined) return levels;
  const root = parseXml(text, "word/styles.xml");
  for (const style of descendantsOf(root, "style")) {
    const id = attrOf(style, "styleId");
    if (!id) continue;
    const nameEl = firstOf(style, "name");
    const name = nameEl ? (attrOf(nameEl, "val") ?? "") : "";
    const outlineEl = descendantsOf(style, "outlineLvl")[0];
    const outline = outlineEl ? Number(attrOf(outlineEl, "val")) : Number.NaN;
    if (Number.isInteger(outline) && outline >= 0) {
      levels.set(id, outline + 1);
      continue;
    }
    const byName = /^(?:heading|标题)\s*(\d+)$/i.exec(name);
    if (byName) levels.set(id, Number(byName[1]));
    else if (/^(?:title|标题)$/i.test(name)) levels.set(id, 1);
  }
  return levels;
}

/** styleId itself as a heading fallback ("Heading1", "标题2").
 * @param {string|null} styleId
 * @returns {number|null}
 */
function styleIdLevel(styleId) {
  const byId = /^(?:Heading|标题)(\d+)$/.exec(styleId ?? "");
  return byId ? Number(byId[1]) : null;
}

/** @typedef {MediaContext & {blocks: DocBlock[], levels: Map<string, number>,
 *   warnings: import("./ooxml-diagram.mjs").Warning[],
 *   diagramBudget: import("./ooxml-diagram.mjs").DiagramBudget,
 *   paragraphIndex: number}} ParagraphContext
 */

/**
 * One w:p → heading/paragraph/listItem blocks, image blocks inlined where the
 * drawing appears.
 * @param {import("./ooxml.mjs").DomNode} paragraph @param {ParagraphContext} ctx
 */
function emitParagraph(paragraph, ctx) {
  const { blocks, counts, levels, rels, pkg, docPart } = ctx;
  const pPr = firstOf(paragraph, "pPr");
  const styleEl = pPr ? firstOf(pPr, "pStyle") : null;
  const styleId = styleEl ? attrOf(styleEl, "val") : null;

  /** @type {number|null} */
  let level = null;
  const directOutline = pPr ? firstOf(pPr, "outlineLvl") : null;
  const directVal = directOutline ? Number(attrOf(directOutline, "val")) : Number.NaN;
  if (Number.isInteger(directVal) && directVal >= 0) level = directVal + 1;
  else if (styleId !== null) level = levels.get(styleId) ?? styleIdLevel(styleId);

  const numPr = pPr ? firstOf(pPr, "numPr") : null;
  const numIdEl = numPr ? firstOf(numPr, "numId") : null;
  const numId = numIdEl ? attrOf(numIdEl, "val") : null;
  const isListItem = Boolean(numPr) && numId !== null && numId !== "0";

  // Images inside the paragraph become their own blocks, in run order.
  for (const { relId, part } of pictureRefs(paragraph, ctx)) {
    blocks.push({ type: "image", relId, part, paragraph: ctx.paragraphIndex });
    recordPicture(ctx, part, { paragraph: ctx.paragraphIndex });
  }

  /** @param {string} text */
  function emitText(text) {
    if (!text.trim()) return;
    if (level !== null) {
      blocks.push({ type: "heading", level, text });
      counts.headings += 1;
    } else if (isListItem) {
      blocks.push({ type: "listItem", text });
      counts.listItems += 1;
    } else {
      blocks.push({ type: "paragraph", text });
      counts.paragraphs += 1;
    }
  }
  if (!descendantsOf(paragraph, "relIds").length) {
    emitText(paragraphText(paragraph));
    return;
  }
  let text = "";
  /** @param {import("./ooxml.mjs").DomNode} node */
  function inline(node) {
    const name = localNameOf(node);
    if (["pPr", "rPr", "instrText", "delText", "del"].includes(name)) return;
    if (name === "relIds") {
      emitText(text);
      text = "";
      if (!takeDiagram(ctx.diagramBudget, ctx.warnings)) return;
      const diagram = readDiagram(pkg, docPart, rels, node, null, {
        geometry: false,
        index: counts.smartArts ?? 0,
      });
      ctx.warnings.push(...diagram.warnings);
      blocks.push({
        type: "smartart",
        layout: diagram.layout.family,
        nodes: diagram.nodes,
        text: diagramText(diagram),
      });
      counts.smartArts = (counts.smartArts ?? 0) + 1;
    } else if (name === "t") text += node.textContent ?? "";
    else if (name === "tab") text += "\t";
    else if (name === "br" || name === "cr") text += "\n";
    else for (const child of childElements(node)) inline(child);
  }
  inline(paragraph);
  emitText(text);
}

/**
 * Visible paragraph text: w:t runs with tab/br markers; field instructions
 * and tracked deletions are excluded.
 * @param {import("./ooxml.mjs").DomNode} node
 * @returns {string}
 */
export function paragraphText(node) {
  let out = "";
  for (const child of childNodesOf(node)) {
    if (child.nodeType === 3) {
      out += child.nodeValue ?? "";
      continue;
    }
    if (child.nodeType !== 1) continue;
    const local = localNameOf(child);
    if (local === "t") out += child.textContent ?? "";
    else if (local === "tab") out += "\t";
    else if (local === "br" || local === "cr") out += "\n";
    else if (local === "pPr" || local === "rPr" || local === "instrText" || local === "delText") continue;
    else out += paragraphText(child);
  }
  return out;
}

/** Wrappers Word may put around blocks, rows and cells: content controls (`w:sdt` and its
 * `w:sdtContent`) and XML mapping (`w:customXml`). Their content is read where it sits. */
const WRAPPERS = new Set(["sdt", "sdtContent", "customXml"]);

/**
 * The elements of a container that `accept` names, in document order. A wrapper is looked
 * through at any depth, so a paragraph, row or cell inside one is listed where Word shows it.
 * @param {import("./ooxml.mjs").DomNode} node
 * @param {(local: string) => boolean} accept
 * @returns {import("./ooxml.mjs").DomNode[]}
 */
function contentOf(node, accept) {
  /** @type {import("./ooxml.mjs").DomNode[]} */
  const out = [];
  for (const child of childElements(node)) {
    const local = localNameOf(child);
    if (WRAPPERS.has(local)) out.push(...contentOf(child, accept));
    else if (accept(local)) out.push(child);
  }
  return out;
}

/** The rows of a table, looking through content controls and customXml.
 * @param {import("./ooxml.mjs").DomNode} tableEl */
const rowsOf = (tableEl) => contentOf(tableEl, (local) => local === "tr");

/** The cells of a row, looking through content controls and customXml.
 * @param {import("./ooxml.mjs").DomNode} tr */
const cellsOf = (tr) => contentOf(tr, (local) => local === "tc");

/**
 * One w:tbl → table block with gridSpan/vMerge preserved per cell. Its pictures are collected
 * by `collectTablePictures` instead, so a nested table never becomes a block of its own.
 * @param {import("./ooxml.mjs").DomNode} tableEl @param {DocCounts} counts @param {DocBlock[]} blocks
 */
function emitTable(tableEl, counts, blocks) {
  const rows = rowsOf(tableEl).map((tr) =>
    cellsOf(tr).map((tc) => {
      const tcPr = firstOf(tc, "tcPr");
      const vMergeEl = tcPr ? firstOf(tcPr, "vMerge") : null;
      /** @type {DocCell} */
      const cell = { text: paragraphText(tc).trim() };
      const span = gridSpanOf(tc);
      if (span > 1) cell.colSpan = span;
      if (vMergeEl) cell.vMerge = attrOf(vMergeEl, "val") === "restart" ? "restart" : "continue";
      return cell;
    }),
  );
  blocks.push({ type: "table", rows });
  counts.tables += 1;
}

/**
 * Grid columns a cell covers: its gridSpan, at least 1.
 * @param {import("./ooxml.mjs").DomNode} tc
 */
function gridSpanOf(tc) {
  const tcPr = firstOf(tc, "tcPr");
  const gridSpanEl = tcPr ? firstOf(tcPr, "gridSpan") : null;
  const span = gridSpanEl ? Number(attrOf(gridSpanEl, "val")) : Number.NaN;
  return Number.isInteger(span) && span > 1 ? span : 1;
}

/**
 * Grid columns a row leaves empty before its first cell (`w:trPr/w:gridBefore`).
 * @param {import("./ooxml.mjs").DomNode} tr
 */
function gridBeforeOf(tr) {
  const trPr = firstOf(tr, "trPr");
  const gridBeforeEl = trPr ? firstOf(trPr, "gridBefore") : null;
  const before = gridBeforeEl ? Number(attrOf(gridBeforeEl, "val")) : Number.NaN;
  return Number.isInteger(before) && before > 0 ? before : 0;
}

/**
 * Pictures inside a table, nested tables included, in document order. Tables are numbered in
 * document order, so a nested table comes after the table around it. A picture is placed by
 * its table, its row and the grid column its cell starts in, counted as Word draws the grid
 * (leading gridBefore columns and gridSpan included). Table pictures add no blocks, so the table
 * block reads back as before.
 * @param {import("./ooxml.mjs").DomNode} tableEl
 * @param {MediaContext & {tables: number}} media
 */
function collectTablePictures(tableEl, media) {
  media.tables += 1;
  const table = media.tables;
  rowsOf(tableEl).forEach((tr, rowIndex) => {
    let column = 1 + gridBeforeOf(tr);
    for (const tc of cellsOf(tr)) {
      collectCellPictures(tc, { table, row: rowIndex + 1, column }, media);
      column += gridSpanOf(tc);
    }
  });
}

/**
 * @param {import("./ooxml.mjs").DomNode} node a table cell, or a wrapper inside one
 * @param {{table: number, row: number, column: number}} position
 * @param {MediaContext & {tables: number}} media
 */
function collectCellPictures(node, position, media) {
  for (const child of contentOf(node, (local) => local === "p" || local === "tbl")) {
    if (localNameOf(child) === "p") {
      for (const { part } of pictureRefs(child, media)) recordPicture(media, part, position);
    } else collectTablePictures(child, media);
  }
}

/**
 * The pictures of a node in document order, as relationship id and media part. External links
 * and dangling references are not pictures of the document.
 * @param {import("./ooxml.mjs").DomNode} node
 * @param {{rels: Map<string, import("./ooxml.mjs").PartRelationship>, docPart: string}} ctx
 * @returns {{relId: string, part: string}[]}
 */
function pictureRefs(node, { rels, docPart }) {
  /** @type {{relId: string, part: string}[]} */
  const refs = [];
  for (const blip of descendantsOf(node, "blip")) {
    const relId = attrOf(blip, "r:embed");
    const target = relId ? rels.get(relId) : undefined;
    if (relId && target && !target.external) {
      refs.push({ relId, part: resolvePartPath(docPart, target.target) });
    }
  }
  return refs;
}

/**
 * Count one appearance of a picture. Its first appearance is listed in `images` with its
 * position and its byte size.
 * @param {MediaContext} media
 * @param {string} part
 * @param {{paragraph: number}|{table: number, row: number, column: number}} position
 */
function recordPicture(media, part, position) {
  media.counts.images += 1;
  if (media.images.some((image) => image.part === part)) return;
  const entry = media.pkg.read(part);
  media.images.push({ part, ...(entry ? { bytes: entry.length } : {}), ...position });
}
