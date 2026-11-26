/**
 * Per-page source lines of the 「资料使用情况」 card: which pages quote material
 * figures, compute them from tables, declare mock or mixed data, or explain
 * nothing. Read-only over `pages` of `delivery-provenance.v1.json`.
 */
import { array, compactPageRanges, countField, record, text } from "./delivery-note-shared.mjs";

/** @type {Record<string, string>} */
const CHART_TYPE_LABELS = {
  area: "面积图",
  bar: "柱状图",
  combination: "组合图",
  doughnut: "环形图",
  line: "折线图",
  percentStacked: "百分比堆积图",
  pie: "饼图",
  radar: "雷达图",
  scatter: "散点图",
  stacked: "堆积图",
};

/** @param {string} type */
function chartTypeLabel(type) {
  return (Object.hasOwn(CHART_TYPE_LABELS, type) && CHART_TYPE_LABELS[type]) || type;
}

/** @param {Record<string, unknown>} detection @returns {string} */
function detectionDetail(detection) {
  /** @type {string[]} */
  const bits = [`${countField(detection.quotedCount)} 个数字`];
  const mismatch = record(detection.periodMismatch);
  const pagePeriod = text(mismatch.page);
  const sourcePeriods = array(mismatch.source).map(text).filter(Boolean);
  if (pagePeriod && sourcePeriods.length) bits.push(`资料期间 ${sourcePeriods.join("、")}`, `本页写的是 ${pagePeriod}`);
  const sourcePages = array(detection.sourcePages)
    .map(countField)
    .filter((page) => page > 0);
  if (sourcePages.length) bits.push(`来自资料第 ${compactPageRanges(sourcePages)} 页`);
  else if (array(detection.sourcePages).includes(0)) bits.push("来自资料正文");
  return bits.join("，");
}

/** @param {Record<string, unknown>} detection @param {number} position @returns {string[]} */
function chartSubstitutionLines(detection, position) {
  return array(detection.chartSubstitutions).flatMap((value) => {
    const item = record(value);
    const sourcePage = countField(item.sourcePage);
    const source = sourcePage > 0 ? `模板第 ${sourcePage} 页的` : "模板中的";
    const from = chartTypeLabel(text(item.sourceType));
    const to = chartTypeLabel(text(item.targetType));
    return from && to ? [`第 ${position} 页：${source}${from}暂以${to}代替`] : [];
  });
}

/**
 * @typedef {{detected: string[], computed: string[], chartSubstitutions: string[], mock: number[], mixed: number[], unexplained: number[]}} PageBuckets
 */

/** @param {PageBuckets} buckets @param {Record<string, unknown>} page @param {number} position */
function classifyPage(buckets, page, position) {
  const detection = record(page.detected);
  const basis = text(record(page.declared).basis);
  if (countField(detection.quotedCount) > 0) {
    buckets.detected.push(`第 ${position} 页（${detectionDetail(detection)}）`);
    buckets.chartSubstitutions.push(...chartSubstitutionLines(detection, position));
  } else if (countField(page.computedFigureCount) > 0) {
    // The figures came from querying the read tables, which document detection does not see.
    buckets.computed.push(`第 ${position} 页（${countField(page.computedFigureCount)} 个）`);
  } else if (page.declared === null || page.declared === undefined) {
    buckets.unexplained.push(position);
  }
  // Declared mock/mixed facts are disclosed independently of figure detection,
  // so a mixed page (or a mock page whose numbers coincide with material) still discloses.
  if (basis === "mock") buckets.mock.push(position);
  if (basis === "mixed") buckets.mixed.push(position);
}

/** @param {unknown} pages @returns {string[]} */
export function provenancePageLines(pages) {
  /** @type {PageBuckets} */
  const buckets = {
    detected: [],
    computed: [],
    chartSubstitutions: [],
    mock: [],
    mixed: [],
    unexplained: [],
  };
  array(pages)
    .map(record)
    .forEach((page, index) => classifyPage(buckets, page, index + 1));
  const { detected, computed, chartSubstitutions, mock, mixed, unexplained } = buckets;
  /** @type {string[]} */
  const lines = [];
  if (detected.length) lines.push(`与资料数字完全一致的页：${detected.join("；")}。`);
  if (computed.length) lines.push(`由表格计算得到数字的页：${computed.join("；")}。`);
  if (chartSubstitutions.length) lines.push(`图表类型替换说明：${chartSubstitutions.join("；")}。`);
  if (mock.length) lines.push(`标为示意数据的页：第 ${compactPageRanges(mock)} 页。`);
  if (mixed.length) lines.push(`标为部分示意的页：第 ${compactPageRanges(mixed)} 页。`);
  if (unexplained.length) lines.push(`没有说明来源，也未检测到资料数字的页：第 ${compactPageRanges(unexplained)} 页。`);
  return lines;
}
