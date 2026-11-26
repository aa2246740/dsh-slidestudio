/**
 * 「数字不一致」 and 「配色以…为准」 lines of the 「资料使用情况」 card (CAP-21, VAL-DATA-009/010).
 * Read-only over the `conflicts` section of `delivery-provenance.v1.json`: the Host recorded each
 * conflict with its winner and reason from ledger facts and the saved design choice, so the card
 * repeats them and decides nothing. The wording is the one the compose receipt summary uses
 * (`delivery-conflicts.ts`); `delivery-note.test.mjs` pins the two to the same text.
 */
import { array, record, text } from "./delivery-note-shared.mjs";

const PERMITTED_USES = "Logo / 照片 / 内容 / 数据";
/** More conflict lines than this would bury the rest of the card. */
const MAX_NUMBER_LINES = 6;

/** @param {unknown} value one `{source, value, unit?}` entry */
function withUnit(value) {
  const entry = record(value);
  return text(entry.unit) ? `${text(entry.value)} ${text(entry.unit)}` : text(entry.value);
}

/** @param {Record<string, unknown>} conflict @returns {string} empty when the entry is unusable */
function numberLine(conflict) {
  const label = text(conflict.label);
  const used = record(conflict.used);
  const values = array(conflict.values)
    .map(record)
    .filter((entry) => text(entry.source) && text(entry.value));
  if (!label || values.length < 2 || !text(used.source) || !text(used.value)) return "";
  const stated = values.map((entry) => `${text(entry.source)} 为 ${withUnit(entry)}`).join("，");
  return (
    `数字不一致：『${label}』${stated}；` +
    `本稿采用 ${withUnit(used)}（来自 ${text(used.source)}）。${text(conflict.reason)}`
  );
}

/** @param {Record<string, unknown>} conflict @returns {string[]} */
function styleLines(conflict) {
  const winner = text(conflict.winner);
  if (!winner) return [];
  if (text(conflict.basis) === "style-pack") {
    const attachment = text(conflict.attachment);
    if (!attachment) return [];
    const uses = array(conflict.uses).map(text).filter(Boolean);
    const phrase = uses.length ? `用于 ${uses.join(" / ")}` : `可用于 ${PERMITTED_USES}`;
    return [`配色以风格『${winner}』为准；附件『${attachment}』${phrase}`];
  }
  if (text(conflict.basis) !== "first-adopted") return [];
  return [
    `配色以『${winner}』为准`,
    ...array(conflict.others)
      .map(text)
      .filter(Boolean)
      .map((name) => `『${name}』也提供了配色，没有采用`),
  ];
}

/**
 * Style lines first (they sit beside the 设计 line's story), then one line per number conflict.
 * No `conflicts` section, an empty one or an entry of an unknown shape writes nothing.
 * @param {unknown} conflicts `provenance.conflicts`
 * @returns {string[]}
 */
export function conflictLines(conflicts) {
  const entries = array(conflicts).map(record);
  const style = entries.filter((entry) => entry.kind === "style").flatMap(styleLines);
  const numbers = entries
    .filter((entry) => entry.kind === "number" || entry.kind === "brief")
    .map(numberLine)
    .filter(Boolean);
  const shown = numbers.slice(0, MAX_NUMBER_LINES);
  const hidden = numbers.length - shown.length;
  return [...style, ...shown, ...(hidden > 0 ? [`另有 ${hidden} 处数字不一致，没有逐条列出`] : [])];
}
