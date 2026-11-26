/**
 * Type detection for untrusted uploads. Signatures in the file's first bytes
 * decide the real type; the extension and the browser-declared MIME are hints
 * that can only add a mismatch warning, never override the content. OOXML
 * containers are inspected through the zip guard (central directory only) and
 * their `[Content_Types].xml`, including macro detection.
 */
import { MaterialRejection, readCentralDirectory, readZipEntry } from "./zip-guard.mjs";
import { PARSER_IDS } from "./derivative.mjs";
import { inspectImagePack } from "./image-pack.mjs";
import { extensionRefusal, heicRefusal, isoPhotoFamily, looksLikeSvg, presentationMime } from "./detect-formats.mjs";
import { wpsLegacyRefusal } from "./legacy-copy.mjs";

export const SUPPORTED_TYPES_ZH =
  "可上传 PNG/JPG/WebP/GIF/AVIF/SVG 图片、图片 ZIP 包、PDF、Word（.docx）、Excel（.xlsx）、PPT（.pptx/.potx）、主题（.thmx）、CSV/TSV、TXT/MD/JSON";

const POTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.template";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const THMX_MIME = "application/vnd.ms-officetheme";
const SVG_MIME = "image/svg+xml";
const AVIF_MIME = "image/avif";

const NOT_SVG_MESSAGE = () => `文件不是有效的 SVG 图片；请重新导出为 SVG 或 PNG 后再上传。${SUPPORTED_TYPES_ZH}`;

const CORRUPT_MESSAGE = "文件已损坏或内容不完整，无法解析；请重新导出后上传";

const LEGACY_PARTS = {
  word: { label: "Word", ext: ".doc", target: ".docx" },
  excel: { label: "Excel", ext: ".xls", target: ".xlsx" },
  ppt: { label: "PPT", ext: ".ppt", target: ".pptx" },
};

/** @param {Uint8Array} bytes @param {number[]} magic */
const startsWith = (bytes, magic) => magic.every((b, i) => bytes[i] === b);

/** @param {Uint8Array} bytes @param {number} offset @param {string} text */
const asciiAt = (bytes, offset, text) => {
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

/** @param {Uint8Array} bytes @param {string} name */
function oleHasEntry(bytes, name) {
  const encoded = [];
  for (let i = 0; i < name.length; i += 1) {
    encoded.push(name.charCodeAt(i) & 0xff, name.charCodeAt(i) >> 8);
  }
  for (let i = 0; i + encoded.length <= bytes.length; i += 1) {
    let matched = true;
    for (let j = 0; j < encoded.length; j += 1) {
      if (bytes[i + j] !== encoded[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The refusal for any OLE container: an encrypted OOXML package, a WPS file,
 * a legacy Office file, or an OLE file that is none of them.
 * @param {Uint8Array} bytes @param {string} extension
 * @returns {DetectFailure}
 */
function oleRefusal(bytes, extension) {
  if (oleHasEntry(bytes, "EncryptedPackage") || oleHasEntry(bytes, "EncryptionInfo")) {
    return {
      ok: false,
      code: "encrypted",
      message: "文件已加密（设有打开密码），无法读取；请取消密码后再上传",
    };
  }
  const wps = wpsLegacyRefusal(bytes, extension);
  if (wps) return wps;
  const word = oleHasEntry(bytes, "WordDocument");
  const excel = oleHasEntry(bytes, "Workbook") || oleHasEntry(bytes, "Book");
  if (word || excel || oleHasEntry(bytes, "PowerPoint Document")) {
    const legacy = word ? LEGACY_PARTS.word : excel ? LEGACY_PARTS.excel : LEGACY_PARTS.ppt;
    return {
      ok: false,
      code: "legacy-office-format",
      message: `这是旧版 ${legacy.label} 文件（${legacy.ext}），暂不支持；请在 ${legacy.label} 中“另存为” ${legacy.target} 后再上传`,
    };
  }
  return {
    ok: false,
    code: "legacy-office-format",
    message: "这是旧版 Office 文件，暂不支持；请用对应软件“另存为”新格式（.docx / .xlsx / .pptx）后再上传",
  };
}

/** @param {string} ext */
const textExtension = (ext) => [".txt", ".md", ".csv", ".tsv", ".json"].includes(ext);

/** @param {string} mime */
export function mimeTypeZh(mime) {
  /** @type {Record<string, string>} */
  const zh = {
    "image/png": "PNG 图片",
    "image/jpeg": "JPEG 图片",
    "image/gif": "GIF 图片",
    "image/webp": "WebP 图片",
    [AVIF_MIME]: "AVIF 图片",
    "application/zip": "ZIP 图片包",
    "application/pdf": "PDF 文档",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word 文档",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel 表格",
    [PPTX_MIME]: "PPT 模板",
    "application/msword": "旧版 Word 文档（.doc）",
    "application/vnd.ms-excel": "旧版 Excel 表格（.xls）",
    "application/vnd.ms-powerpoint": "旧版 PPT 演示（.ppt）",
    [POTX_MIME]: "PPT 模板文件（.potx）",
    [THMX_MIME]: "Office 主题文件",
    [SVG_MIME]: "SVG 矢量图",
    "text/csv": "CSV 表格",
    "text/tab-separated-values": "TSV 表格",
    "text/plain": "文本文件",
    "text/markdown": "Markdown 文本",
    "application/json": "JSON 文本",
  };
  return zh[mime] ?? mime;
}

/** @type {Record<string, string>} */
const EXTENSION_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": AVIF_MIME,
  // Never detected as such, so a HEIC name over AVIF content gets the mismatch warning.
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": PPTX_MIME,
  ".potx": POTX_MIME,
  ".thmx": THMX_MIME,
  ".svg": SVG_MIME,
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

/**
 * @typedef {{ok: true, kind: "text"|"table"|"document"|"deck-template"|"image",
 *   parserId: string, detectedMime: string, extension: string,
 *   extensionMismatch: boolean, warnings: {code: string, message: string}[]}} DetectOk
 * @typedef {{ok: false, code: string, message: string}} DetectFailure
 */

const MACRO_REFUSAL = Object.freeze({
  ok: /** @type {const} */ (false),
  code: "macro-enabled",
  message: "文件包含宏，出于安全考虑不予接收；请另存为不含宏的同类型新格式后再上传",
});

const UNSUPPORTED_MESSAGE = () => `暂不支持该文件类型；${SUPPORTED_TYPES_ZH}`;

/** @typedef {{kind: DetectOk["kind"], parserId: string, mime: string}} Detected */
/** @typedef {(detected: Detected) => DetectOk} Finish */

/** Signature-identified images and PDF, in precedence order. */
/** @type {{test: (bytes: Uint8Array) => boolean, kind: DetectOk["kind"], parserId: string, mime: string}[]} */
const SIGNATURES = [
  {
    test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    kind: "image",
    parserId: "image-sharp-v1",
    mime: "image/png",
  },
  { test: (b) => startsWith(b, [0xff, 0xd8, 0xff]), kind: "image", parserId: "image-sharp-v1", mime: "image/jpeg" },
  {
    test: (b) => asciiAt(b, 0, "GIF87a") || asciiAt(b, 0, "GIF89a"),
    kind: "image",
    parserId: "image-sharp-v1",
    mime: "image/gif",
  },
  {
    test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP"),
    kind: "image",
    parserId: "image-sharp-v1",
    mime: "image/webp",
  },
  { test: (b) => asciiAt(b, 0, "%PDF-"), kind: "document", parserId: PARSER_IDS.pdf, mime: "application/pdf" },
];

/** @param {unknown} error @returns {DetectFailure} */
function rejectionOf(error) {
  if (error instanceof MaterialRejection) return { ok: false, code: error.code, message: error.message };
  throw error;
}

/** @param {string} contentTypes @returns {Detected[]} */
function ooxmlParts(contentTypes) {
  return [
    {
      kind: "document",
      parserId: "docx-ooxml-v1",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      kind: "table",
      parserId: "xlsx-ooxml-v1",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    { kind: "deck-template", parserId: PARSER_IDS.pptx, mime: presentationMime(contentTypes, POTX_MIME, PPTX_MIME) },
    { kind: "deck-template", parserId: PARSER_IDS.thmx, mime: THMX_MIME },
  ];
}
const OOXML_SUFFIXES = ["word/document.xml", "xl/workbook.xml", "ppt/presentation.xml", "theme/theme/theme1.xml"];
const MAIN_CONTENT_TYPES = [
  "wordprocessingml.document.main+xml",
  "spreadsheetml.sheet.main+xml",
  "presentationml.presentation.main+xml",
  "presentationml.template.main+xml",
];

/**
 * A zip container: an OOXML package by its main part, or an image pack.
 * @param {Uint8Array} bytes @param {Finish} finish
 * @returns {DetectOk | DetectFailure}
 */
function zipType(bytes, finish) {
  /** @type {import("./zip-guard.mjs").ZipEntry[]} */
  let entries;
  try {
    entries = readCentralDirectory(bytes);
  } catch (error) {
    return rejectionOf(error);
  }
  if (entries.some((e) => e.name.endsWith("vbaProject.bin"))) return MACRO_REFUSAL;
  const ctEntry = entries.find((e) => e.name === "[Content_Types].xml");
  if (!ctEntry) {
    try {
      inspectImagePack(bytes);
    } catch (error) {
      return rejectionOf(error);
    }
    return finish({ kind: "image", parserId: PARSER_IDS.imagePack, mime: "application/zip" });
  }
  let contentTypes = "";
  try {
    contentTypes = new TextDecoder().decode(readZipEntry(bytes, ctEntry));
  } catch (error) {
    return rejectionOf(error);
  }
  if (contentTypes.includes("macroEnabled")) return MACRO_REFUSAL;
  const index = OOXML_SUFFIXES.findIndex((suffix) => entries.some((e) => e.name.endsWith(suffix)));
  const part = index >= 0 ? ooxmlParts(contentTypes)[index] : undefined;
  if (part) return finish(part);
  // A content-types sheet that declares a main document part while the
  // part itself is missing means the package is damaged, not unknown.
  if (MAIN_CONTENT_TYPES.some((ct) => contentTypes.includes(ct))) {
    return { ok: false, code: "corrupt", message: CORRUPT_MESSAGE };
  }
  return { ok: false, code: "unsupported-type", message: UNSUPPORTED_MESSAGE() };
}

/**
 * Text kinds by extension after a binary-content check.
 * @param {Uint8Array} bytes @param {string} extension @param {Finish} finish
 * @returns {DetectOk | DetectFailure}
 */
function textType(bytes, extension, finish) {
  if (looksBinary(bytes)) {
    return { ok: false, code: "unsupported-type", message: "文件不是有效的文本内容；请上传真正的文本文件" };
  }
  const mime = /** @type {string} */ (EXTENSION_MIME[extension]);
  if (extension === ".csv" || extension === ".tsv") return finish({ kind: "table", parserId: "csv-v1", mime });
  return finish({ kind: "text", parserId: "text-utf8-v1", mime });
}

/**
 * Builds the success record for a detected type, with the extension-mismatch warning.
 * @param {string} extension @returns {Finish}
 */
function finisher(extension) {
  return ({ kind, parserId, mime }) => {
    const declared = EXTENSION_MIME[extension];
    const extensionMismatch = declared !== undefined && declared !== mime;
    const warnings = extensionMismatch
      ? [
          {
            code: "extension-mismatch",
            message: `扩展名为 ${extension}，但实际内容是 ${mimeTypeZh(mime)}，已按内容识别`,
          },
        ]
      : [];
    return { ok: true, kind, parserId, detectedMime: mime, extension, extensionMismatch, warnings };
  };
}

/**
 * Decide the real type of an upload. Never inflates zip entry data except the
 * small `[Content_Types].xml` after the archive guard passed.
 * @param {{name: string, bytes: Uint8Array, declaredMime?: string}} upload
 * @returns {DetectOk | DetectFailure}
 */
export function detectType({ name, bytes }) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot) : "";
  const finish = finisher(extension);
  if (!bytes.length) return { ok: false, code: "empty", message: "文件为空" };
  const signature = SIGNATURES.find((candidate) => candidate.test(bytes));
  if (signature) return finish(signature);
  // ISO-BMFF photos: the ftyp brand decides, never the name.
  const heic = heicRefusal(bytes);
  if (heic) return heic;
  if (isoPhotoFamily(bytes) === "avif") return finish({ kind: "image", parserId: PARSER_IDS.avif, mime: AVIF_MIME });
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return zipType(bytes, finish);
  // OLE containers: encrypted OOXML or legacy Office.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return oleRefusal(bytes, extension);
  // SVG is sanitized and rasterized, never kept or served as markup.
  if (looksLikeSvg(bytes)) return finish({ kind: "image", parserId: PARSER_IDS.svg, mime: SVG_MIME });
  const byName = extensionRefusal(extension, NOT_SVG_MESSAGE());
  if (byName) return byName;
  if (textExtension(extension)) return textType(bytes, extension, finish);
  return { ok: false, code: "unsupported-type", message: UNSUPPORTED_MESSAGE() };
}

/**
 * Heuristic binary sniff for text-candidate files: a NUL byte or a high share
 * of control characters means "not text" — never mojibake it into a record.
 * @param {Uint8Array} bytes
 */
export function looksBinary(bytes) {
  const window = bytes.subarray(0, 8192);
  let controls = 0;
  for (const byte of window) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return window.length > 0 && controls / window.length > 0.3;
}
