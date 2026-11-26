/**
 * Chinese "recognized" summary builder. Every parsed attachment gets a
 * `summary.zh` line that names what was actually recognized — encoding,
 * delimiter, dimensions, counts — so the user sees the transparent result,
 * never a silent guess. Each parser id owns one builder; `buildSummaryZh`
 * only dispatches.
 */

/** @type {Record<string, string>} */
const DELIMITER_ZH = {
  ",": "逗号",
  "\t": "制表符",
  ";": "分号",
  "|": "竖线",
};

/** @param {number} value */
const grouped = (value) => value.toLocaleString("en-US");

/** @typedef {{latin?: string|null, ea?: string|null, hans?: string|null}} FontPair */

/** @typedef {{headings?: number, paragraphs?: number, listItems?: number, tables?: number, images?: number}} DocCounts */

/**
 * @typedef {{parserId?: string|null, encoding?: string, delimiter?: string,
 *   rowCount?: number, headers?: string[], chars?: number, extension?: string,
 *   extra?: string[], sheetCount?: number, hiddenSheetCount?: number,
 *   themeColorCount?: number, fonts?: {major?: FontPair|null, minor?: FontPair|null},
 *   fontsUsed?: import("./parsers/pptx-fonts.mjs").FontUse[],
 *   layoutCount?: number, slideCount?: number, logoCandidates?: number, logoSelected?: boolean,
 *   counts?: DocCounts, firstHeading?: string, pageCount?: number, tables?: number,
 *   lowTextPages?: number[], lowTextImagePages?: number[], lowTextBlankPages?: number[],
 *   lowTextUnknownImagePages?: number[], extractedPages?: number, imageCount?: number, format?: string,
 *   width?: number, height?: number, dominant?: string, chartCount?: number}} SummaryInfo
 */

/** @typedef {(info: SummaryInfo, parts: string[], facts: Record<string, unknown>) => void} SummaryBuilder */

/** Shared "列：a、b" push when headers exist.
 * @param {string[]|undefined} headers @param {string[]} parts @param {Record<string, unknown>} facts
 */
function pushHeaders(headers, parts, facts) {
  if (headers?.length) {
    parts.push(`列：${headers.join("、")}`);
    facts.headers = headers;
  }
}

/** @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts */
function textSummary(info, parts, facts) {
  parts.push(`文本（${info.extension ?? ".txt"}）`);
  parts.push(`${grouped(info.chars ?? 0)} 字`);
  facts.chars = info.chars ?? 0;
}

/** @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts */
function csvSummary(info, parts, facts) {
  const label = info.extension === ".tsv" ? "TSV" : "CSV";
  parts.push(label);
  parts.push(`${info.encoding ?? "UTF-8"} 编码`);
  parts.push(`${DELIMITER_ZH[info.delimiter ?? ","] ?? "未知分隔符"}分隔`);
  parts.push(`${grouped(info.rowCount ?? 0)} 行`);
  pushHeaders(info.headers, parts, facts);
  facts.encoding = info.encoding;
  facts.delimiter = info.delimiter;
  facts.rowCount = info.rowCount ?? 0;
}

/** @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts */
function xlsxSummary(info, parts, facts) {
  parts.push("XLSX 表格");
  const hidden = info.hiddenSheetCount ?? 0;
  parts.push(hidden > 0 ? `${info.sheetCount ?? 0} 个工作表（${hidden} 个隐藏）` : `${info.sheetCount ?? 0} 个工作表`);
  parts.push(`共 ${grouped(info.rowCount ?? 0)} 行`);
  pushHeaders(info.headers, parts, facts);
  if (info.chartCount) parts.push(`${info.chartCount} 个图表（数据可读取）`);
  facts.sheetCount = info.sheetCount ?? 0;
  facts.hiddenSheetCount = hidden;
  facts.rowCount = info.rowCount ?? 0;
  if (info.chartCount) facts.chartCount = info.chartCount;
}

/** @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts */
function pptxSummary(info, parts, facts) {
  const fonts = info.fonts ?? {};
  parts.push("PPT 模板");
  parts.push(`${info.themeColorCount ?? 0} 种主题色`);
  const used = (info.fontsUsed ?? [])
    .flatMap((font) => font.sourceFonts)
    .sort((a, b) => b.chars - a.chars || a.latin.localeCompare(b.latin));
  if (used[0]) {
    parts.push(`实际使用主字体 ${fontPair(used[0])}`);
    facts.mainUsedFont = used[0];
  }
  for (const font of used) {
    parts.push(`实际使用字体 ${fontPair(font)}（${font.chars} 字）；${font.note}`);
  }
  if (fonts.major) {
    parts.push(`主题声明标题字体（次要参考） ${fontPair(fonts.major)}`);
    facts.majorFont = fonts.major;
  }
  if (fonts.minor) {
    parts.push(`主题声明正文字体（次要参考） ${fontPair(fonts.minor)}`);
    facts.minorFont = fonts.minor;
  }
  parts.push(`${info.layoutCount ?? 0} 个版式`);
  parts.push(
    info.parserId === "pptx-ooxml-v2"
      ? `${info.slideCount ?? 0} 页样例（文字可按需读取）`
      : `${info.slideCount ?? 0} 页`,
  );
  if (!info.logoCandidates) parts.push("未发现 Logo 候选");
  else if (info.parserId === "pptx-ooxml-v2") {
    parts.push(`${info.logoCandidates} 个 Logo 候选（${info.logoSelected ? "主 Logo 已选" : "未提取主 Logo"}）`);
  } else parts.push(`发现 ${info.logoCandidates} 个 Logo 候选`);
  facts.themeColorCount = info.themeColorCount ?? 0;
  facts.layoutCount = info.layoutCount ?? 0;
  facts.slideCount = info.slideCount ?? 0;
  facts.logoCandidates = info.logoCandidates ?? 0;
}

/** @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts */
function docxSummary(info, parts, facts) {
  const counts = info.counts ?? {};
  parts.push("Word 文档");
  parts.push(`${counts.headings ?? 0} 个标题`);
  if (counts.paragraphs !== undefined) parts.push(`${counts.paragraphs} 个段落`);
  parts.push(`${counts.tables ?? 0} 个表格`);
  parts.push(`${counts.images ?? 0} 张图片`);
  parts.push(`约 ${grouped(roundChars(info.chars ?? 0))} 字`);
  if (info.chartCount) parts.push(`${info.chartCount} 个图表（数据可读取）`);
  facts.headings = counts.headings ?? 0;
  facts.paragraphs = counts.paragraphs ?? 0;
  facts.tables = counts.tables ?? 0;
  facts.images = counts.images ?? 0;
  facts.chars = info.chars ?? 0;
  if (info.chartCount) facts.chartCount = info.chartCount;
  if (info.firstHeading) facts.firstHeading = info.firstHeading;
}

/** PDF: page count, approximate character count, scanned-page honesty.
 * @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts
 */
function pdfSummary(info, parts, facts) {
  parts.push("PDF");
  const extracted = info.extractedPages ?? info.pageCount ?? 0;
  const tableCount = info.tables ?? 0;
  parts.push(`${info.pageCount ?? extracted} 页`);
  if ((info.chars ?? 0) > 0) parts.push(`约 ${grouped(roundChars(info.chars ?? 0))} 字`);
  if (tableCount > 0) parts.push(`${tableCount} 个表格（自动识别，可能有错位）`);
  if (info.lowTextPages?.length) {
    /** @param {number[] | undefined} pages @param {string} description */
    const addPageFact = (pages, description) => {
      if (!pages?.length) return;
      const shown =
        pages.length > 10 ? `${pages.slice(0, 10).join("、")} 等 ${pages.length} 页` : `${pages.join("、")} 页`;
      parts.push(`第 ${shown}${description}`);
    };
    addPageFact(info.lowTextImagePages, "主要是图片，未识别文字（不做 OCR）");
    addPageFact(info.lowTextBlankPages, "几乎没有文字");
    addPageFact(
      info.lowTextUnknownImagePages ?? info.lowTextPages,
      "几乎没有文字（可能是整页图片），未识别（不做 OCR）",
    );
  }
  facts.pageCount = info.pageCount ?? extracted;
  facts.chars = info.chars ?? 0;
  if (tableCount > 0) facts.tables = tableCount;
  if (info.lowTextPages?.length) facts.lowTextPages = info.lowTextPages;
  if (info.lowTextImagePages?.length) facts.lowTextImagePages = info.lowTextImagePages;
  if (info.lowTextBlankPages?.length) facts.lowTextBlankPages = info.lowTextBlankPages;
  if (info.lowTextUnknownImagePages?.length) {
    facts.lowTextUnknownImagePages = info.lowTextUnknownImagePages;
  }
}

/** Image: format, pixel dimensions (orientation-applied), dominant colour.
 * @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts
 */
function imageSummary(info, parts, facts) {
  parts.push(IMAGE_FORMAT_ZH[info.format ?? ""] ?? "图片");
  parts.push(`${info.width ?? 0}×${info.height ?? 0}`);
  if (info.dominant) parts.push(`主色 ${info.dominant}`);
  facts.format = info.format;
  facts.width = info.width ?? 0;
  facts.height = info.height ?? 0;
  if (info.dominant) facts.dominant = info.dominant;
}

/** @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts */
function imagePackSummary(info, parts, facts) {
  const imageCount = info.imageCount ?? 0;
  parts.push(`图片包 · ${grouped(imageCount)} 张图片`);
  facts.imageCount = imageCount;
}

/** SVG: sanitized, then handled as the PNG it was rendered to.
 * @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts
 */
function svgSummary(info, parts, facts) {
  parts.push("SVG 矢量图");
  parts.push(`${info.width ?? 0}×${info.height ?? 0}`);
  if (info.dominant) parts.push(`主色 ${info.dominant}`);
  parts.push("已转为 PNG 图片");
  facts.format = "svg";
  facts.width = info.width ?? 0;
  facts.height = info.height ?? 0;
  if (info.dominant) facts.dominant = info.dominant;
}

/** AVIF: decoded, then handled as the PNG or JPEG it was converted to (named by the parser's `extra`).
 * @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts
 */
function avifSummary(info, parts, facts) {
  parts.push("AVIF 图片");
  parts.push(`${info.width ?? 0}×${info.height ?? 0}`);
  if (info.dominant) parts.push(`主色 ${info.dominant}`);
  facts.format = "avif";
  facts.width = info.width ?? 0;
  facts.height = info.height ?? 0;
  if (info.dominant) facts.dominant = info.dominant;
}

/** Office theme file: a colour scheme and two fonts, nothing to lay pages out from.
 * @param {SummaryInfo} info @param {string[]} parts @param {Record<string, unknown>} facts
 */
function thmxSummary(info, parts, facts) {
  const fonts = info.fonts ?? {};
  /** @param {FontPair|null|undefined} font */
  const pair = (font) => [font?.latin, font?.ea || font?.hans].filter(Boolean).join(" / ") || "未声明";
  parts.push("主题文件");
  parts.push(`${info.themeColorCount ?? 0} 种主题色`);
  parts.push(`标题字体 ${pair(fonts.major)} / 正文字体 ${pair(fonts.minor)}（只提供配色和字体）`);
  facts.themeColorCount = info.themeColorCount ?? 0;
  facts.majorFont = fonts.major ?? null;
  facts.minorFont = fonts.minor ?? null;
}

/** @type {Record<string, string>} */
const IMAGE_FORMAT_ZH = {
  png: "PNG 图片",
  jpeg: "JPG 图片",
  webp: "WebP 图片",
  gif: "GIF 图片",
};

/** @type {Record<string, SummaryBuilder>} */
const BUILDERS = {
  "text-utf8-v1": textSummary,
  "csv-v1": csvSummary,
  "xlsx-ooxml-v1": xlsxSummary,
  "pptx-ooxml-v1": pptxSummary,
  "pptx-ooxml-v2": pptxSummary,
  "docx-ooxml-v1": docxSummary,
  "pdf-unpdf-v1": pdfSummary,
  "pdf-unpdf-v2": pdfSummary,
  "pdf-unpdf-v3": pdfSummary,
  "pdf-unpdf-v4": pdfSummary,
  "image-sharp-v1": imageSummary,
  "image-pack-v1": imagePackSummary,
  "svg-raster-v1": svgSummary,
  "avif-raster-v1": avifSummary,
  "thmx-theme-v1": thmxSummary,
};

/**
 * @param {SummaryInfo} info
 * @returns {{zh: string, facts: Record<string, unknown>}}
 */
export function buildSummaryZh(info) {
  /** @type {string[]} */
  const parts = [];
  /** @type {Record<string, unknown>} */
  const facts = {};
  const builder = info.parserId ? BUILDERS[info.parserId] : undefined;
  if (builder) builder(info, parts, facts);
  else parts.push("已识别");
  if (info.extra?.length) parts.push(...info.extra);
  return { zh: parts.join(" · "), facts };
}

/** Major/minor font display: "Latin / 中文" with empty halves dropped.
 * @param {FontPair} font
 */
function fontPair(font) {
  return [font.latin, font.ea].filter(Boolean).join(" / ") || "未声明";
}

/** Round large character counts so the summary stays honest but readable.
 * @param {number} chars
 */
function roundChars(chars) {
  if (chars >= 10_000) return Math.round(chars / 100) * 100;
  return chars;
}
