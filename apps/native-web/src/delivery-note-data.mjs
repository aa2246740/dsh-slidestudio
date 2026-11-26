/**
 * 「期间」 and 「没有本期数据」 lines of the 「资料使用情况」 card (CAP-17, VAL-DATA-008). Read-only
 * over the `data` section of `delivery-provenance.v1.json`: the Host wrote the period map and each
 * missing item from verified ledger facts, so the card repeats them and adds nothing.
 */
import { array, record, text } from "./delivery-note-shared.mjs";

const REASON_SUFFIX = "：未提供本期数据";
// A monthly update of a 50-chart deck within 12 pages can lack data for a few dozen items; the card
// names each of them, and only a list longer than any realistic template is cut.
const MAX_LISTED_ITEMS = 60;

/**
 * One 期间 line when the plan declared a period map, one 没有本期数据 line when it declared items.
 * An empty list writes no second line.
 * @param {unknown} data `provenance.data`
 * @returns {string[]}
 */
export function dataLines(data) {
  const section = record(data);
  const map = record(section.periodMap);
  const items = array(section.missingItems)
    .map(text)
    .filter(Boolean)
    .map((entry) => (entry.endsWith(REASON_SUFFIX) ? entry.slice(0, -REASON_SUFFIX.length) : entry));
  /** @type {string[]} */
  const lines = [];
  if (text(map.from) && text(map.to)) lines.push(`期间：${text(map.from)} → ${text(map.to)}`);
  if (items.length) {
    const shown = items.slice(0, MAX_LISTED_ITEMS).join("、");
    lines.push(`没有本期数据的项目：${shown}${items.length > MAX_LISTED_ITEMS ? `等 ${items.length} 项` : ""}`);
  }
  return lines;
}
