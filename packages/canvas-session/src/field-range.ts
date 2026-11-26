import { PAGE_COUNT_TOKEN, PAGE_NUMBER_TOKEN } from "@open-slidestudio/pptd-v2";

/**
 * Widens a range of a page-number field's stored text so it never cuts a token in two. A style on
 * half of `{page}` would split the token across runs, and the field would stop showing a number.
 */
export function wholeTokenRange(text: string, start: number, end: number): [number, number] {
  let lo = Math.min(start, end);
  let hi = Math.max(start, end);
  if (lo === hi) return [lo, hi];
  for (const token of [PAGE_NUMBER_TOKEN, PAGE_COUNT_TOKEN]) {
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length)) {
      const to = at + token.length;
      if (lo > at && lo < to) lo = at;
      if (hi > at && hi < to) hi = to;
    }
  }
  return [lo, hi];
}
