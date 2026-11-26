/**
 * The 「配色：按你的要求使用 …」 line of the 「资料使用情况」 card (CAP-18, VAL-DATA-011).
 * Read-only over `design.userColors` of `delivery-provenance.v1.json`: the Agent declared each colour
 * from the user's own words and the Host saved it, so the card repeats the entry and decides nothing.
 */
import { array, record, text } from "./delivery-note-shared.mjs";

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * One line naming every declared colour with the request it answers. No `userColors`, an empty
 * list or entries of an unknown shape write nothing.
 * @param {unknown} userColors `provenance.design.userColors`
 * @returns {string[]}
 */
export function userColorLines(userColors) {
  const entries = array(userColors)
    .map(record)
    .filter((entry) => HEX.test(text(entry.hex)))
    .map((entry) => {
      const hex = text(entry.hex).toUpperCase();
      return text(entry.reason) ? `${hex}（${text(entry.reason)}）` : hex;
    });
  return entries.length ? [`配色：按你的要求使用 ${entries.join("、")}`] : [];
}
