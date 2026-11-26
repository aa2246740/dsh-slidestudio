/**
 * Shared readers for the delivery note modules. Every reader is total: a value
 * of an unexpected shape becomes the empty value, so a malformed record file
 * writes no line instead of throwing.
 */
import fs from "node:fs";

/** @param {unknown} value @returns {Record<string, unknown>} */
export function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {unknown[]} */
export function array(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
export function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** @param {unknown} value @param {number} limit */
export function boundedText(value, limit) {
  return Array.from(text(value)).slice(0, limit).join("");
}

/** A positive safe integer, otherwise 0. @param {unknown} value @returns {number} */
export function countField(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Positive page numbers, ascending. @param {unknown} value @returns {number[]} */
export function sortedPages(value) {
  return array(value)
    .map(countField)
    .filter((page) => page > 0)
    .sort((left, right) => left - right);
}

/** `openkimi:material:<id>` / `material:<id>` → `<id>`. @param {string} sourceId */
export function canonicalMaterialId(sourceId) {
  return sourceId.replace(/^(?:(?:openkimi|openkimi-preview):)?material:/, "");
}

/** @param {string} file @returns {Record<string, unknown>} */
export function readJson(file) {
  try {
    return record(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

/** Deck position (1-based) of each page id. @param {unknown} pages @returns {Map<string, number>} */
export function pagePositions(pages) {
  return new Map(array(pages).map((page, index) => [text(record(page).pageId), index + 1]));
}

/** Records by trimmed `id`. @param {unknown} items @returns {Map<string, Record<string, unknown>>} */
export function recordsById(items) {
  return new Map(
    array(items).map((item) => {
      const entry = record(item);
      return [text(entry.id), entry];
    }),
  );
}

/** Compact ascending page numbers into ranges like `1–11、13`. @param {number[]} pages */
export function compactPageRanges(pages) {
  const sorted = [...new Set(pages)].filter((page) => page > 0).sort((left, right) => left - right);
  /** @type {string[]} */
  const parts = [];
  let start = 0;
  let end = 0;
  for (const page of sorted) {
    if (end && page === end + 1) {
      end = page;
      continue;
    }
    if (end) parts.push(start === end ? `${start}` : `${start}–${end}`);
    start = page;
    end = page;
  }
  if (end) parts.push(start === end ? `${start}` : `${start}–${end}`);
  return parts.join("、");
}

/** @type {ReadonlyArray<readonly [string, string]>} design aspect key → label */
export const ASPECT_LABELS = Object.freeze([
  ["palette", "配色"],
  ["fonts", "字体"],
  ["logo", "Logo"],
  ["layouts", "版式"],
  ["decorations", "装饰"],
  ["photos", "照片"],
  ["content", "内容"],
  ["data", "数据"],
]);

/** Labels of the given aspect keys, in the canonical order. @param {{has: (key: string) => boolean}} aspects */
export function aspectLabels(aspects) {
  return ASPECT_LABELS.filter(([key]) => aspects.has(key)).map(([, label]) => label);
}
