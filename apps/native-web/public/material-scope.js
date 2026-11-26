import { imageMetadataLine } from "./attachment-image-metadata.js";
import { t } from "./i18n.js";

// The copy tables below hold the Chinese source sentences (the i18n keys). Every
// function that hands text to the DOM translates through t(); attachments-i18n.js
// carries the English and a test proves every table sentence has an entry.

/** Extracted DOCX/PDF pictures are ordinary image materials (m4, ruling 90): at most 40 kept
 * per document; sending them spends the per-message 20-image quota. */
const EMBEDDED_MATERIAL_LINE =
  "文档里的图片会提取成可用的图片资料（每份最多保留 40 张），随消息一起发送，占用每条消息 20 张图片的名额。";
const UPLOAD_PPTX = "若需保留原模板外观，请上传 .pptx。";
const CLUE_ONLY = "颜色、字体等只作风格线索，不作为设计来源。";
const PDF_SCOPE = Object.freeze({
  label: "读文字 · 自由风格下可作配色来源",
  detail: `读取可识别的文字；在「自由风格」下可采用它的配色（来自矢量图形和页面图片），字体、版式和装饰只作参考。支持看图的模型可按页查看页面图片。选了首页风格包时，配色以风格包为准。${EMBEDDED_MATERIAL_LINE}${UPLOAD_PPTX}`,
});
const HINT_SCOPE = Object.freeze({
  label: "读文字 · 风格只作线索",
  detail: `只提取可识别的文字；${CLUE_ONLY}${UPLOAD_PPTX}`,
});
const WORD_SCOPE = Object.freeze({
  label: "读文字 · 风格只作线索",
  detail: `读取 Word 中的文字；${CLUE_ONLY}${EMBEDDED_MATERIAL_LINE}${UPLOAD_PPTX}`,
});
const TABLE_SCOPE = Object.freeze({
  label: "读数据 · 可做原生图表",
  detail: "读取表格数据，可据此制作原生图表；不提供配色、字体或版式来源。",
  editUse: "可让 AI 按它更新图表",
});
const TEXT_SCOPE = Object.freeze({
  label: "读文字",
  detail: "只提取文字内容，不提供配色、字体或版式等设计来源。",
});
const PPTX_V1_SCOPE = Object.freeze({
  label: "读取模板线索",
  detail: "识别模板主题色、字体、版式、Logo 候选和页面文字摘要；当前还不提供按需读取的完整页面、表格和图表资料。",
});
const PPTX_V2_SCOPE = Object.freeze({
  label: "风格 · 版式 · 内容按需读取",
  detail:
    "配色、字体、Logo、版式线索、装饰和照片可按需采用；页面文字、表格和图表数据仅在要求使用时按需读取，不会自动导入整页。",
  editUse: "可让 AI 整套换成这个模板",
});
const THMX_SCOPE = Object.freeze({
  label: "主题 · 只提供配色和字体",
  detail: "只提取主题配色和字体，不含版式、页面和 Logo。",
});
const IMAGE_PLACE =
  "附件提供图片文件；由 AI 决定放进哪一页，也可采用它的配色作为设计来源（选了首页风格包时以风格包为准）。";
/** Image detail when the selected model is known not to see pictures. */
export const IMAGE_TEXT_ONLY_DETAIL = `${IMAGE_PLACE}能否读取版式和气质取决于当前模型是否支持看图。`;
const IMAGE_V1_SCOPE = Object.freeze({
  label: "可放进页面 · 可作配色来源",
  detail: `${IMAGE_PLACE}读取版式和气质需要支持看图的模型，文本模型只能看到颜色、尺寸和朝向。`,
  editUse: "可让 AI 用它换图",
});

/** Attach-modal copy, frozen per plan §4.10 (VAL-FMT-007/VAL-HUB-001); both surfaces render
 * from this table (translated with t()) and no page ships a second literal. */
export const MODAL_COPY = Object.freeze({
  supportedLine:
    "支持图片 PNG / JPG / WebP / GIF / AVIF / SVG（SVG 转换为图片）及图片 ZIP 包（内含 JPG / PNG / WebP / GIF）、PPT PPTX / POTX 模板、Office 主题 THMX、Excel XLSX、CSV / TSV、PDF、Word DOCX 与 TXT / MD / JSON。",
  limitLine: "PPTX、POTX 和 PDF 单个不超过 50MB，其他文件单个不超过 20MB；每次最多发送 20 张图片和 6 个其他附件。",
  legacyOff: "旧版 .doc / .xls / .ppt 和 WPS 文件需要先另存为新格式再上传",
  legacyOn: "旧版 .ppt / .doc / .xls 和 WPS 格式会自动转换，效果可能与原文件不同",
  heicHint: "iPhone 的 HEIC 照片请先导出为 JPG",
  capabilityNote:
    "PDF 和 Word 提取文字；PDF 在「自由风格」下可作配色来源，Word 的风格只作线索。表格读取数据，可制作原生图表。PPTX 提供风格、版式和按需读取的内容；图片可放进页面，也可作配色来源。",
});

/** The full #attach-formats-note text; `legacyOn` swaps the legacy sentence after health.
 * @param {boolean} legacyOn */
export function formatsNote(legacyOn) {
  return [
    t(MODAL_COPY.supportedLine),
    t(MODAL_COPY.limitLine),
    t(legacyOn ? MODAL_COPY.legacyOn : MODAL_COPY.legacyOff),
    t("；"),
    t(MODAL_COPY.heicHint),
    t("。"),
  ].join("");
}

/** Per-message quota sentences shared by the Hub and editor quota gates. */
export const QUOTA_COPY = Object.freeze({
  /** @param {number} max */
  imageQuota: (max) => t("每次最多发送 {max} 张图片", { max }),
  /** @param {number} max */
  otherQuota: (max) => t("除图片外，每次最多发送 {max} 个附件", { max }),
});

/** Chip detail lines for the pictures extracted from a DOCX/PDF. */
export const EMBEDDED_COPY = Object.freeze({
  /** @param {number} total @param {string} shown @param {string} rest */
  included: (total, shown, rest) =>
    t("内含 {total} 张图片，已作为图片资料，可放进页面（{shown}{rest}）", { total, shown, rest }),
  /** @param {number} total @param {number} sent @param {number} left @param {string} shown @param {string} rest */
  remaining: (total, sent, left, shown, rest) =>
    t("文档已发送，不会重复发送；内含 {total} 张图片，已发送 {sent} 张，还剩 {left} 张可放进页面（{shown}{rest}）", {
      total,
      sent,
      left,
      shown,
      rest,
    }),
  /** @param {number} omitted @param {number} max @param {boolean} continues */
  omitted: (omitted, max, continues) =>
    t("另有 {omitted} 张内嵌图片没有随本次发送：每次最多 {max} 张图片，名额已满", {
      omitted,
      max,
    }) + (continues ? t("；剩下的会随后续消息继续发送") : ""),
});

/** The collapsed status mark of a converted legacy upload (mark comes from intake). */
export const CONVERSION_COPY = Object.freeze({
  /** @param {string} mark */
  badge: (mark) => t("已从 {mark} 转换", { mark }),
  /** Source sentence; callers translate it with t(). */
  plain: "已识别",
});

/** @typedef {Readonly<{label: string, detail: string, styleHintLine?: string, editUse?: string}>} ScopeCopy */
/** @typedef {Readonly<Record<string, Readonly<Record<string, ScopeCopy>>>>} ScopeMap */

/** Copy is keyed by material kind and parser; PPTX v3+ reuse v2's, unknown parsers get the default. */
/** @type {ScopeMap} */
export const MATERIAL_SCOPE = Object.freeze({
  document: Object.freeze({
    "pdf-unpdf-v1": PDF_SCOPE,
    "pdf-unpdf-v2": PDF_SCOPE,
    "pdf-unpdf-v3": PDF_SCOPE,
    "pdf-unpdf-v4": PDF_SCOPE,
    "docx-ooxml-v1": WORD_SCOPE,
    default: HINT_SCOPE,
  }),
  table: Object.freeze({
    "csv-v1": TABLE_SCOPE,
    "xlsx-ooxml-v1": TABLE_SCOPE,
    default: TABLE_SCOPE,
  }),
  text: Object.freeze({
    "text-utf8-v1": TEXT_SCOPE,
    default: TEXT_SCOPE,
  }),
  "deck-template": Object.freeze({
    "pptx-ooxml-v1": PPTX_V1_SCOPE,
    "pptx-ooxml-v2": PPTX_V2_SCOPE,
    "thmx-theme-v1": THMX_SCOPE,
    default: PPTX_V1_SCOPE,
  }),
  image: Object.freeze({
    "image-sharp-v1": IMAGE_V1_SCOPE,
    default: IMAGE_V1_SCOPE,
  }),
});

const STYLE_WORDS =
  /风格|样式|模板|版式|排版|配色|色调|字体|视觉|外观|仿照|照着|沿用|套用|logo|风格包|主题色|\b(?:style|template|layout|palette|colou?rs?|fonts?|typography|visual|look)\b/i;
const BUSY_STATES = new Set(["queued", "uploading", "parsing"]);
const TEXTUAL_KINDS = new Set(["text", "table"]);

/** @typedef {{kind?: string|null, parser?: string|null, name?: string, status?: string}} ScopeItem */
/** @typedef {{brief?: string, items?: ScopeItem[], designSystemId?: string, stylePackName?: string}} StyleNoticeInput */

/**
 * @param {unknown} kind
 * @param {unknown} parserId
 * @param {Record<string, unknown>} [record]
 * @returns {ScopeCopy|null}
 */
export function materialScope(kind, parserId, record = {}) {
  const scope = sourceScope(kind, parserId, record);
  return scope ? translatedScope(scope) : null;
}

/** The untranslated table entry plus the per-record lines, as materialScope chose it.
 * @param {unknown} kind @param {unknown} parserId @param {Record<string, unknown>} record
 * @returns {ScopeCopy|null} */
function sourceScope(kind, parserId, record) {
  if (typeof kind !== "string") return null;
  const versions = MATERIAL_SCOPE[kind];
  if (!versions) return null;
  const parser = typeof parserId === "string" ? parserId : "";
  const knownDocumentParser = parser.startsWith("pdf-unpdf-") || parser.startsWith("docx-ooxml-");
  const effectiveParser =
    kind === "document" && !knownDocumentParser ? legacyDocumentParser(record.name) || parser : parser;
  const scope =
    versions[effectiveParser] ||
    (kind === "deck-template" && /^pptx-ooxml-v(?:[2-9]|[1-9]\d+)$/.test(parser) ? PPTX_V2_SCOPE : versions.default);
  if (!scope) return null;
  if (kind === "image") {
    const styleHintLine = imageMetadataLine(record);
    if (styleHintLine) return { ...scope, styleHintLine };
  }
  if (kind === "image" && record.needsVision === false) {
    return { ...scope, detail: IMAGE_TEXT_ONLY_DETAIL };
  }
  if (kind === "document" && typeof record.styleHintLine === "string" && record.styleHintLine) {
    return { ...scope, styleHintLine: record.styleHintLine };
  }
  return scope;
}

/** Server style lines are Chinese-only today; t() passes unknown sentences through.
 * @param {ScopeCopy} scope @returns {ScopeCopy} */
function translatedScope(scope) {
  return Object.freeze({
    label: t(scope.label),
    detail: t(scope.detail),
    ...(scope.editUse ? { editUse: t(scope.editUse) } : {}),
    ...(scope.styleHintLine ? { styleHintLine: t(scope.styleHintLine) } : {}),
  });
}

/** Use the filename only for legacy records without a detected parser id.
 * @param {unknown} name */
function legacyDocumentParser(name) {
  if (typeof name !== "string") return "";
  if (/\.docx$/i.test(name)) return "docx-ooxml-v1";
  if (/\.pdf$/i.test(name)) return "pdf-unpdf-v4";
  return "";
}

/**
 *  True only for a style-related brief with parsed Word/text/table references, when those are the only attached kinds and every chip has settled.
 * @param {{brief?: string, items?: ScopeItem[]}} input
 */
export function styleSourceNoticeVisible({ brief = "", items = [] }) {
  if (typeof brief !== "string" || !STYLE_WORDS.test(brief) || !Array.isArray(items) || !items.length) return false;
  if (items.some((item) => !item || BUSY_STATES.has(item.status || ""))) return false;
  if (!items.every((item) => item.status === "parsed" && isTextualReference(item))) return false;
  return items.some((item) => isTextualReference(item));
}

/** The detected parser id is authoritative; the file name is a fallback for legacy records.
 * @param {ScopeItem} item @param {(parserId: string) => boolean} matches */
function matchesDocumentParser(item, matches) {
  if (item.kind !== "document") return false;
  const parser = typeof item.parser === "string" ? item.parser : "";
  if (parser.startsWith("pdf-unpdf-") || parser.startsWith("docx-ooxml-")) return matches(parser);
  if (matches("docx-ooxml-")) return /\.docx$/i.test(item.name || "");
  if (matches("pdf-unpdf-")) return /\.pdf$/i.test(item.name || "");
  return false;
}

/** @param {ScopeItem} item */
function isTextualReference(item) {
  if (TEXTUAL_KINDS.has(item.kind || "")) return true;
  return matchesDocumentParser(item, (parser) => parser.startsWith("docx-ooxml-"));
}

/** @param {ScopeItem} item */
function isStyleCapable(item) {
  if (item.status !== "parsed") return false;
  if (item.kind === "deck-template" || item.kind === "image") return true;
  return matchesDocumentParser(item, (parser) => parser.startsWith("pdf-unpdf-"));
}

/**
 *  Render the selected-pack priority reminder or the non-blocking keyword reminder into a plain status node (no control).
 * @param {HTMLElement} element
 * @param {StyleNoticeInput} input
 * @returns {string}
 */
export function renderStyleSourceNotice(element, input) {
  const items = Array.isArray(input.items) ? input.items : [];
  const trimmed = (/** @type {unknown} */ value) => (typeof value === "string" ? value.trim() : "");
  const designSystemId = trimmed(input.designSystemId);
  const stylePackName = trimmed(input.stylePackName);
  const hasStylePack = Boolean(designSystemId && designSystemId !== "freestyle");
  const hasStyleSource = items.some(isStyleCapable);
  let message = "";
  if (hasStylePack && hasStyleSource) {
    const name = stylePackName || designSystemId;
    message = t(
      "已选择风格『{name}』，配色、字体和装饰以它为准；附件用于 Logo、照片、内容和数据，版式只作参考。要按附件风格，请切回『自由风格』。",
      { name },
    );
  } else if (styleSourceNoticeVisible({ brief: input.brief, items })) {
    message = t(
      "要求里提到了风格，但附件里没有可作风格来源的文件（PPTX、图片或 PDF）；Word、表格和文本只提供文字或数据，不提供设计风格。可不补充，直接发送。",
    );
  }
  element.textContent = message;
  element.hidden = !message;
  return message;
}

/** Paint #style-source-notice from the live chips; the Hub and the editor both call
 * this so the reminder renders from one code path.
 * @param {HTMLElement|null} element
 * @param {{brief?: string, designSystemId?: string, stylePackName?: string}} context
 * @param {Array<{kind?: string|null, parser?: string|null, name?: string, status?: string}>} items */
export function paintStyleSourceNotice(element, context, items) {
  if (!(element instanceof HTMLElement)) return;
  renderStyleSourceNotice(element, {
    ...context,
    items: (Array.isArray(items) ? items : []).map(({ kind, parser, name, status }) => ({
      kind,
      parser,
      name,
      status,
    })),
  });
}
