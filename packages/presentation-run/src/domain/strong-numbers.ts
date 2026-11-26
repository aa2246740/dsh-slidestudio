/**
 * The "strong numbers" of a text (M2 gap 7): decimals or percentages with at least three
 * significant digits, never a year, `100%` or `0%`. Figure detection compares pages with sources
 * through them. This leaf module holds no state and imports nothing, so every detector shares one
 * definition without an import cycle.
 */

const NUMBER_BODY = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|\d+(?:\.\d+)?%?`;

/** Strong numbers: decimals or `%` values; plain integers (and years) never qualify. */
const STRONG_NUMBER_PATTERN = new RegExp(String.raw`(?<![\d.])(${NUMBER_BODY})(?![\d.])`, "g");

/**
 * The same numbers with the minus sign written before them, an ASCII hyphen or U+2212. A hyphen
 * between two numbers (`98.76-123.45`), after a letter or after a `%` joins or separates; it is
 * not a sign.
 */
const SIGNED_NUMBER_PATTERN = new RegExp(
  String.raw`(?<![\d.])(?:(?<![\dA-Za-z%.])([-−]))?(${NUMBER_BODY})(?![\d.])`,
  "g",
);

/** Significant digits of a figure token: digits after dropping separators and leading zeros. */
export function significantDigits(token: string): number {
  const digits = token.replace(/[,%]/g, "").replace(/\./g, "");
  return digits.replace(/^0+/, "").length;
}

export function extractStrongNumbers(text: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(STRONG_NUMBER_PATTERN)) {
    const token = match[1];
    if (!token) continue;
    // Years and other plain integers are never strong figures.
    if (!token.includes(".") && !token.includes("%")) continue;
    const numeric = Number(token.replace(/,/g, "").replace(/%$/, ""));
    if (!Number.isFinite(numeric)) continue;
    // Totals carry no evidence value: 100% and 0% never match.
    if (token.endsWith("%") && (numeric === 100 || numeric === 0)) continue;
    if (significantDigits(token) < 3) continue;
    if (!seen.has(token)) {
      seen.add(token);
      found.push(token);
    }
  }
  return found;
}

/**
 * The given strong numbers of `text` as the text spells them: `-123.45` when it is written with a
 * minus sign (either character, normalized to the ASCII one), `123.45` when it is not. A number
 * written both ways yields both. `-123.45` and `123.45` are different values to compare.
 */
export function signedFigureTokens(text: string, strong: readonly string[]): readonly string[] {
  const wanted = new Set(strong);
  const spelled = new Set<string>();
  for (const match of text.matchAll(SIGNED_NUMBER_PATTERN)) {
    const body = match[2];
    if (body && wanted.has(body)) spelled.add(match[1] ? `-${body}` : body);
  }
  return [...spelled];
}
