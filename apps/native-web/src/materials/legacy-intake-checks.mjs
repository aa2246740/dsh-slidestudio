/**
 * Checks and bookkeeping for a converted legacy package: the refusal copy,
 * the re-validation verdict of the parse pool's answer (including the WPS
 * secure-document decoys), and the conversion block, mark and warnings a
 * successful conversion adds to its derivative.
 */
import { WPS_SECURE_NOTICES } from "./cfb.mjs";
import { readCentralDirectory } from "./zip-guard.mjs";

/** The refusal copy of the conversion design table, one entry per failure class. */
export const LEGACY_COPY = Object.freeze({
  encrypted: "文件已加密（设有打开密码），无法读取；请取消密码后再上传",
  wpsSecure: "这是 WPS 加密文档，只能在 WPS 中打开；请在 WPS 中取消文档加密，再另存为 .docx / .xlsx / .pptx 后上传",
  macro: "文件包含宏，出于安全考虑不予接收；请另存为不含宏的 .pptx / .docx / .xlsx 后再上传",
  corrupt: "文件已损坏或内容不完整，无法转换；请在 Office 或 WPS 中打开后另存为新格式再上传",
  tooLarge: "转换后的文件超过 50 MB，无法使用；请精简后另存为新格式再上传",
  timeout: "旧格式文件转换时间过长，已停止；请在 Office 或 WPS 中另存为 .pptx / .docx / .xlsx 后再上传",
  oom: "旧格式文件转换占用内存过大，已停止；请拆分文件，或另存为新格式后再上传",
  busy: "当前转换任务较多，请稍后重试；也可以先另存为新格式再上传",
  failed: "旧格式文件转换失败；请在 Office 或 WPS 中另存为新格式后再上传",
});

/**
 * @typedef {"doc"|"xls"|"ppt"} LegacyFamily
 * @typedef {import("./legacy-intake.mjs").LegacyDerivative} LegacyDerivative
 * @typedef {import("./legacy-intake.mjs").LegacyParseOutcome} LegacyParseOutcome
 * @typedef {{headerRow?: unknown[], rows?: unknown[][], fullRows?: unknown[][]}} LegacySheet
 */

/**
 * A re-validated failure keeps archive-limit verbatim; the rest maps to the
 * conversion design copy. A parse pool's timeout or out-of-memory keeps its
 * own code and Chinese copy so the record stays a retryable failed one — the
 * same answer a direct upload of the converted package would give.
 * @param {string} code @param {string} message @returns {[string, string]}
 */
export function revalidated(code, message) {
  switch (code) {
    case "archive-limit":
    case "timeout":
    case "out-of-memory":
      return [code, message];
    case "macro-enabled":
      return [code, LEGACY_COPY.macro];
    case "encrypted":
      return [code, LEGACY_COPY.encrypted];
    case "too-large":
      return [code, LEGACY_COPY.tooLarge];
    default:
      return ["corrupt", LEGACY_COPY.corrupt];
  }
}

/** @param {Uint8Array} bytes @returns {boolean} the package carries a spreadsheet media part */
function packageHasMedia(bytes) {
  try {
    return readCentralDirectory(bytes).some((entry) => entry.name.startsWith("xl/media/"));
  } catch {
    return false;
  }
}

/** @param {unknown} value @returns {boolean} a cell a user could actually read */
function readableCell(value) {
  return value !== null && value !== "" && !(typeof value === "string" && value.trim() === "");
}

/**
 * Whether the workbook derivative holds at least one readable cell, headers
 * included. The header row is excluded from `rowCount`, so a normal
 * header-and-logo workbook has rowCount 0 without being a decoy.
 * @param {LegacyDerivative} derivative
 */
function spreadsheetHasReadableCells(derivative) {
  // The workbook parser lists every sheet; the stored-derivative type only names the first.
  const table = /** @type {{sheets?: LegacySheet[]} | undefined} */ (/** @type {unknown} */ (derivative.table));
  for (const sheet of table?.sheets ?? []) {
    if ((sheet.headerRow ?? []).some(readableCell)) return true;
    const rows = Array.isArray(sheet.fullRows) ? sheet.fullRows : (sheet.rows ?? []);
    if (rows.some((row) => (row ?? []).some(readableCell))) return true;
  }
  return false;
}

/**
 * WPS decoys: the secure-document sentences, or a spreadsheet without a
 * single readable cell (headers included) whose package only carries a picture.
 * @param {LegacyDerivative} derivative @param {LegacyFamily} family @param {Uint8Array} convertedBytes
 */
function isWpsDecoy(derivative, family, convertedBytes) {
  const serialized = JSON.stringify(derivative);
  if (WPS_SECURE_NOTICES.some((notice) => serialized.includes(notice))) return true;
  return family === "xls" && !spreadsheetHasReadableCells(derivative) && packageHasMedia(convertedBytes);
}

/**
 * The refusal for a converted package the parse pool answered, or null when
 * it may become a material.
 * @param {LegacyParseOutcome} outcome
 * @param {{kind: string, family: LegacyFamily, convertedBytes: Uint8Array}} expected
 * @returns {[string, string]|null}
 */
export function revalidationRefusal(outcome, { kind, family, convertedBytes }) {
  if (!outcome.ok) return revalidated(outcome.code, outcome.message);
  const derivative = outcome.derivative;
  if (derivative.kind && derivative.kind !== kind) return ["corrupt", LEGACY_COPY.corrupt];
  if (!derivative.kind || derivative.errorCode) {
    return revalidated(derivative.errorCode ?? "corrupt", derivative.message ?? LEGACY_COPY.corrupt);
  }
  return isWpsDecoy(derivative, family, convertedBytes) ? ["encrypted", LEGACY_COPY.wpsSecure] : null;
}

const WARNING_DETAIL = { doc: "段落格式", xls: "公式和图表", ppt: "版式、图表和特效" };
const WPS_LABEL = { doc: "文字", xls: "表格", ppt: "演示" };
const MS_LABEL = { doc: "Word", xls: "Excel", ppt: "PPT" };
const MS_APP = { doc: "Word", xls: "Excel", ppt: "PowerPoint" };
const TARGET = { doc: "docx", xls: "xlsx", ppt: "pptx" };

/**
 * The conversion warning of one family, naming WPS files as WPS.
 * @param {LegacyFamily} family @param {"ms"|"wps"} vendor @param {string} from the shown source extension
 */
export function convertedWarning(family, vendor, from) {
  const to = TARGET[family];
  const label = vendor === "wps" ? `WPS ${WPS_LABEL[family]}（${from}）` : `旧版 ${MS_LABEL[family]}（${from}）`;
  return `已把${label}自动转换成 .${to} 后读取；${WARNING_DETAIL[family]}可能与原文件不同，要完全一致请用 ${MS_APP[family]} 或 WPS 另存为 .${to} 后上传`;
}

/**
 * @typedef {{to: string, engine: string, engineVersion: string|undefined, rule: string,
 *   durationMs: number, convertedSha256: string, convertedBytes: number, isolation: string}} ConversionFacts
 */

/**
 * Turn the parse pool's derivative of the converted package into the record
 * of the user's upload: its source, the mismatch and conversion warnings, the
 * conversion block and the summary mark.
 * @param {LegacyDerivative} derivative mutated in place
 * @param {{mark: {from: string, prefix: string}, family: LegacyFamily, vendor: "ms"|"wps",
 *   extension: string, mismatchMime: string|null, source: LegacyDerivative["source"],
 *   conversion: ConversionFacts}} facts
 */
export function finishConvertedDerivative(derivative, facts) {
  const warnings = [...(derivative.warnings ?? [])];
  if (facts.mismatchMime) {
    warnings.unshift({
      code: "extension-mismatch",
      message: `扩展名为 ${facts.extension}，但实际内容是 ${facts.mismatchMime}，已按内容识别`,
    });
  }
  warnings.push({
    code: "converted-from-legacy",
    message: convertedWarning(facts.family, facts.vendor, facts.mark.from),
  });
  derivative.source = facts.source;
  derivative.warnings = warnings;
  derivative.conversion = { from: facts.mark.from, ...facts.conversion };
  if (derivative.summary?.zh) {
    derivative.summary = { ...derivative.summary, zh: `${facts.mark.prefix}${derivative.summary.zh}` };
  }
}
