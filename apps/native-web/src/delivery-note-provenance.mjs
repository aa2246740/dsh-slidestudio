/**
 * Lines of the 「资料使用情况」 card read from `_agent/delivery-provenance.v1.json`
 * (schema `delivery-provenance/v1`, written by @open-slidestudio/presentation-run).
 * Read-only: the Host recorded every fact; the card repeats them and decides nothing.
 */
import { componentUsageLines } from "./delivery-note-components.mjs";
import { conflictLines } from "./delivery-note-conflicts.mjs";
import { dataLines } from "./delivery-note-data.mjs";
import { provenanceDesignLine } from "./delivery-note-design.mjs";
import { imageUsageLines } from "./delivery-note-images.mjs";
import { provenancePageLines } from "./delivery-note-pages.mjs";
import { array, countField, record, recordsById, sortedPages, text } from "./delivery-note-shared.mjs";
import { userColorLines } from "./delivery-note-user-colors.mjs";
import { visionValueLines } from "./delivery-note-vision.mjs";

const MAX_PAGE_LIST = 10;

/** @param {Record<string, unknown>} provenance @returns {string[]} */
export function provenanceLines(provenance) {
  const materialsById = recordsById(provenance.materials);
  const design = record(provenance.design);
  const images = imageUsageLines(provenance.images, provenance.pages);
  return [
    // An image the card lists below is not also an unread 「参考资料」.
    ...materialUsageLines(array(provenance.materials).filter((item) => !images.ids.has(text(record(item).id)))),
    ...images.lines,
    provenanceDesignLine(design, materialsById),
    ...userColorLines(design.userColors),
    ...provenanceLayoutLines(provenance.layouts),
    ...componentUsageLines(design.components, provenance.layouts, provenance.pages, materialsById),
    ...provenancePageLines(provenance.pages),
    ...dataLines(provenance.data),
    ...conflictLines(provenance.conflicts),
    ...visionValueLines(provenance.pages),
  ];
}

/**
 * One 版式 line naming each layout the pages use, with its picture count when it draws any.
 * A deck without layouts gets no line. @param {unknown} layouts @returns {string[]}
 */
function provenanceLayoutLines(layouts) {
  const used = array(layouts).map((item) => record(item));
  if (!used.length) return [];
  const parts = used.map((layout) => {
    const name = text(layout.name) || text(layout.id) || "未命名版式";
    const media = array(layout.media).length;
    return `『${name}』用于 ${array(layout.pages).length} 页${media ? `（含 ${media} 张图片）` : ""}`;
  });
  return [`版式：${parts.join("；")}`];
}

/**
 * The legacy conversion origin of a material, e.g. 「（由 .ppt 转换）」;
 * WPS uploads keep the vendor name, plain uploads carry no mark.
 * @param {Record<string, unknown>} material @returns {string}
 */
function convertedMark(material) {
  const from = text(material.convertedFrom);
  if (!from) return "";
  return `（由 ${material.convertedFromWps === true ? "WPS " : ""}${from} 转换）`;
}

/** @param {Record<string, unknown>} material @param {string[]} use */
function readStatus(material, use) {
  const read = countField(material.chunksRead);
  // A palette-only PDF is read through its measured colours, not as text chunks.
  if (!read) {
    if (use.includes("design-source")) return "只取了配色";
    return use.includes("computed") ? "已用于计算" : "未使用";
  }
  if (text(material.kind) === "table") return `已读取 ${read} 个行区间`;
  const total = material.chunkCount === null || material.chunkCount === undefined ? 0 : countField(material.chunkCount);
  if (!total) return `已读取 ${read} 段`;
  return read >= total ? `已读完全部 ${total} 段` : `已读取 ${read}/${total} 段`;
}

/** @param {unknown} materials @returns {string[]} */
function materialUsageLines(materials) {
  return array(materials).map((item) => {
    const material = record(item);
    const name = text(material.name) || text(material.id) || "未命名资料";
    const use = array(material.use).map(text);
    const status = readStatus(material, use);
    const detail = readCoverageDetail(material);
    const flags = [
      use.includes("design-source") ? "被采用为设计源" : "",
      use.includes("style-hint") ? "提供风格线索" : "",
      countField(material.chunksRead) && use.includes("computed") ? "用于计算" : "",
    ].filter(Boolean);
    const detailText = detail ? `（${detail}）` : "";
    const flagText = flags.length ? `；${flags.join("；")}` : "";
    return `参考资料：${name}${convertedMark(material)} — ${status}${detailText}${flagText}。`;
  });
}

/** @param {Record<string, unknown>} material @returns {string} */
function readCoverageDetail(material) {
  /** @type {string[]} */
  const parts = [];
  const covered = text(material.pagesCovered);
  if (covered) parts.push(`第 ${covered} 页的文字`);
  const lowTextPages = sortedPages(material.lowTextPages);
  const imagePages = new Set(sortedPages(material.imagePages));
  const blankPages = new Set(sortedPages(material.blankPages));
  const withImage = lowTextPages.filter((page) => imagePages.has(page));
  const blank = lowTextPages.filter((page) => blankPages.has(page));
  const unmeasured = lowTextPages.filter((page) => !imagePages.has(page) && !blankPages.has(page));
  if (withImage.length) parts.push(`${pageList(withImage)}主要是图片，未识别其中的文字`);
  if (blank.length) parts.push(`${pageList(blank)}几乎没有文字`);
  if (unmeasured.length) parts.push(`${pageList(unmeasured)}几乎没有文字，可能是整页图片`);
  return parts.join("；");
}

/** @param {number[]} pages */
function pageList(pages) {
  const listed = pages.slice(0, MAX_PAGE_LIST).join("、");
  return pages.length > MAX_PAGE_LIST ? `第 ${listed} 等 ${pages.length} 页` : `第 ${listed} 页`;
}
