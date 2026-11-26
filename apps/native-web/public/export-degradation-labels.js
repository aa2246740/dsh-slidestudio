import { t } from "./i18n.js";

/**
 * Export result wording for degradations. Each kind maps to one line group; a
 * group with an item becomes one counted line, in the fixed order below.
 * Unknown kinds share a generic line that never claims a cause.
 * @typedef {{kind?: string}} ExportDegradation
 * @typedef {{slideCount: number, bytes: number, degradations?: number, degradationKinds?: {kind: string}[], embeddedFonts: {typeface: string}[], skippedFonts: {typeface: string, reason: string}[]}} ExportReport
 */

/** Group id -> kinds it covers. Kind-to-group is the single source for the wording below. */
export const EXPORT_DEGRADATION_GROUPS = Object.freeze({
  image: ["missing-image", "full-page-raster", "background-only", "unsupported-element"],
  shadow: ["shadow-not-exported"],
  "color-fallback": ["color-fallback"],
  "chart-approximate": ["chart-type-fallback"],
  "chart-labels": ["chart-percent-labels-as-values"],
  "chart-failed": ["chart-export-failed"],
  "static-page-count": ["static-page-count"],
});

/**
 * Line order on the export panel, with the Chinese source key (translated by
 * `t`, English in export-i18n.js) for each group. The generic line is last.
 * @type {[string, string][]}
 */
export const EXPORT_DEGRADATION_LINES = [
  ["image", "{count} 处以图片保底"],
  ["shadow", "{count} 处文本框阴影未导出，文字仍可编辑"],
  ["color-fallback", "{count} 处颜色无法解析，已改用默认色"],
  ["chart-approximate", "{count} 处图表以近似方式导出"],
  ["chart-labels", "{count} 处百分比堆叠图标签导出为原始数值"],
  ["chart-failed", "{count} 处图表未能导出"],
  ["static-page-count", "{count} 处总页数已导出为固定文字，在 PowerPoint 中增减页面后需重新导出"],
  ["other", "{count} 处效果未完整导出"],
];

/** @param {string} kind */
function groupOf(kind) {
  for (const [group, kinds] of Object.entries(EXPORT_DEGRADATION_GROUPS)) {
    if (kinds.includes(kind)) return group;
  }
  return "other";
}

/** @param {ExportDegradation[] | number | null | undefined} degradations @returns {ExportDegradation[]} */
function degradationItems(degradations) {
  if (typeof degradations === "number") {
    const count = Number.isFinite(degradations) ? Math.max(0, Math.floor(degradations)) : 0;
    return Array.from({ length: count }, () => ({ kind: "missing-image" }));
  }
  return Array.isArray(degradations) ? degradations : [];
}

/**
 * Result lines for a degradation list. A bare number is a count-only report
 * from an older server; it keeps its image fallback wording.
 * @param {ExportDegradation[] | number | null | undefined} degradations
 * @returns {string[]}
 */
export function exportDegradationLines(degradations) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of degradationItems(degradations)) {
    const group = groupOf(typeof item?.kind === "string" ? item.kind : "");
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return EXPORT_DEGRADATION_LINES.flatMap(([group, key]) => {
    const count = counts.get(group) ?? 0;
    return count > 0 ? [t(key, { count })] : [];
  });
}

/** @param {unknown} value */
function escapeText(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

/**
 * Markup for the export result panel: one escaped `<small>` element per line.
 * @param {ExportDegradation[] | number | null | undefined} degradations
 */
export function exportDegradationHtml(degradations) {
  return exportDegradationLines(degradations)
    .map((line) => `<small class="export-deg">${escapeText(line)}</small>`)
    .join("");
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value */
function count(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError("Invalid export count");
  return value;
}

/** @param {unknown} value */
function string(value) {
  if (typeof value !== "string") throw new TypeError("Invalid export text");
  return value;
}

/** @template T @param {unknown} value @param {(value: unknown) => T} decode @returns {T[]} */
function list(value, decode) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("Invalid export list");
  /** @type {unknown[]} */
  const items = value;
  return items.map(decode);
}

/** @param {unknown} value @returns {ExportReport} */
function report(value) {
  const source = record(value);
  // `ok: false` means the file carries hard degradations (for example a
  // missing image). It is still delivered, so the panel must name them.
  if (typeof source.ok !== "boolean") throw new TypeError("Invalid export status");
  return {
    slideCount: count(source.slideCount),
    bytes: count(source.bytes),
    degradations: source.degradations === undefined ? undefined : count(source.degradations),
    ...(source.degradationKinds === undefined
      ? {}
      : {
          degradationKinds: list(source.degradationKinds, (item) => ({
            kind: string(record(item).kind),
          })),
        }),
    embeddedFonts: list(source.embeddedFonts, (item) => ({
      typeface: string(record(item).typeface),
    })),
    skippedFonts: list(source.skippedFonts, (item) => ({
      typeface: string(record(item).typeface),
      reason: string(record(item).reason),
    })),
  };
}

/** @param {string} header */
function decodeBase64Url(header) {
  const base = header.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base + "=".repeat((4 - (base.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Read the public `X-Export-Report` header (plain JSON or base64url JSON).
 * A broken report never becomes a partial valid report: it yields null.
 * @param {string | null | undefined} header
 * @returns {ExportReport | null}
 */
export function decodeExportReport(header) {
  if (!header || header.length > 65536) return null;
  try {
    return report(JSON.parse(header));
  } catch {
    // Native reports use base64url to keep non-ASCII font names HTTP-safe.
  }
  try {
    return report(JSON.parse(decodeBase64Url(header)));
  } catch {
    return null;
  }
}

/**
 * Filename from a Content-Disposition header: the RFC 5987 `filename*` value
 * wins over the ASCII `filename` fallback.
 * @param {string | null | undefined} header
 * @param {string} fallback
 */
export function exportFilenameFromDisposition(header, fallback) {
  const value = String(header || "");
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // Malformed percent-encoding: fall back to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;]+)/i.exec(value);
  const name = plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2]?.trim();
  return name || fallback;
}
