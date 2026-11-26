/**
 * The periods a label names when a number is bound to its metric (CAP-21, VAL-DATA-009). This is the
 * binding's own reading: `extractPeriodLabels` (material-periods.ts) stays what the monthly-update
 * period map and the stale-figure checks read, and every form it returns is returned here unchanged.
 *
 * Supported forms: `YYYY年M月[末]`, `YYYY年M-N月`, `YYYY年上/下半年`, `YY年M月`, `Q1`-`Q4`, `YYYYQn`,
 * `YYYY Qn`, `YYYY年Qn`, `FYYYYY`, `YYYY年` alone, `YYYY年第N季度`, `第N季度` (as `Qn`) and a bare `M月[末]`.
 * Each is a period and never a metric word. A year written next to a quarter or a month belongs to it
 * (`2026年Q3`, `2026年3月`); a year written alone is the annual period `2026年`.
 *
 * Not supported, so they stay metric words as before: 本月, 上月, 去年同期, 同比, 环比, 累计, YTD, weeks
 * and days (a month followed by a day, `9月30日`, is a date and not a month).
 */
const YEAR = String.raw`(?:19|20)\d{2}`;
const NUMERALS: Readonly<Record<string, string>> = { 一: "1", 二: "2", 三: "3", 四: "4" };

const FORMS = new RegExp(
  [
    // 2026年Q3, 2026Q3, 2026 Q3, FY2026 Q3, 2026年第三季度
    String.raw`(?<![\d.])(?:FY)?(${YEAR})\s{0,2}年?\s{0,2}(?:Q([1-4])(?!\d)|第([一二三四1-4])季度)`,
    // the forms extractPeriodLabels reads
    String.raw`(?<!\d)(\d{4}年\d{1,2}(?:-\d{1,2})?月末?|\d{4}年[上下]半年|\d{2}年\d{1,2}月)(?![0-9])`,
    // FY2026
    String.raw`(?<![A-Za-z\d])FY(${YEAR})(?!\d)`,
    // 2026年
    String.raw`(?<!\d)(${YEAR})年`,
    // 第三季度
    String.raw`第([一二三四1-4])季度`,
    // Q3
    String.raw`(?<!\d)(Q[1-4])(?![0-9])`,
    // 3月 (not 1-3月, not 3月15日)
    String.raw`(?<![\d第\-–—~～])(1[0-2]|0?[1-9])月(末?)(?!\d*[日号])`,
  ].join("|"),
  "g",
);

const BARE_YEAR = new RegExp(`^${YEAR}$`);
const YEAR_ONLY = /^\d{4}年$/;
const LEADING_YEAR = /^(\d{2,4})年(.*)$/;

export type SplitLabel = Readonly<{
  /** The label without the words that name a period. */
  rest: string;
  /** The periods, one token each, sorted and without repeats: `2026年3月`, `2026年Q3`, `2026年`, `Q3`, `3月`. */
  periods: readonly string[];
}>;

function quarter(digit: string | undefined, word: string | undefined): string {
  return `Q${digit ?? NUMERALS[word!] ?? word}`;
}

function tokenOf(match: RegExpMatchArray): string {
  const [, yearQuarter, digit, word, listed, fiscal, year, quarterWord, bareQuarter, month, end] = match;
  if (yearQuarter) return `${yearQuarter}年${quarter(digit, word)}`;
  if (listed) return listed;
  if (fiscal ?? year) return `${fiscal ?? year}年`;
  if (quarterWord) return quarter(undefined, quarterWord);
  if (bareQuarter) return bareQuarter;
  return `${Number(month)}月${end ?? ""}`;
}

const hasYear = (token: string): boolean => LEADING_YEAR.test(token);

/** A year written apart from the quarter or month it belongs to (`Q3 FY2026`, `2026年 3月`) joins it. */
function joinYear(tokens: readonly string[], extraYear: string | undefined): readonly string[] {
  const years = new Set([...tokens.filter((token) => YEAR_ONLY.test(token)), extraYear ?? ""]);
  years.delete("");
  const bare = tokens.filter((token) => !hasYear(token));
  const [year] = years;
  if (years.size !== 1 || !bare.length) return tokens;
  return tokens.filter((token) => token !== year).map((t) => (bare.includes(t) ? year + t : t));
}

/** Splits the periods off a label; what is left is its metric. */
export function splitPeriods(label: string): SplitLabel {
  const found: string[] = [];
  let rest = "";
  let from = 0;
  for (const match of label.matchAll(FORMS)) {
    const index = match.index ?? 0;
    found.push(tokenOf(match));
    rest += label.slice(from, index);
    from = index + match[0].length;
  }
  rest += label.slice(from);
  const tokens = [...new Set(found)];
  // A label whose only words besides its periods are a year names no metric: `Q3 2026`.
  const leftover = rest.replace(/[\s\p{P}\p{S}]+/gu, "");
  const year = BARE_YEAR.test(leftover) ? `${leftover}年` : undefined;
  return {
    rest: year ? "" : rest,
    periods: [...joinYear(tokens, year)].sort(),
  };
}

function parse(token: string): { year: string | undefined; part: string } {
  const match = LEADING_YEAR.exec(token);
  return match ? { year: match[1], part: match[2]! } : { year: undefined, part: token };
}

/** What a period token names apart from its year: the month, the quarter, the half-year; `年` for the year itself. */
export function periodPart(token: string): string {
  return parse(token).part || "年";
}

/**
 * Two periods are compatible when they name the same month or quarter (or both name the year alone)
 * and do not name different years. A period without a year fits any year; a year alone is the annual
 * period and is not a month or a quarter of that year.
 */
function tokensCompatible(left: string, right: string): boolean {
  const a = parse(left);
  const b = parse(right);
  if (a.year !== undefined && b.year !== undefined && a.year !== b.year) return false;
  return a.part === b.part;
}

/**
 * Whether two label's periods can be about the same time. Periods are compared only when both labels
 * name one; the label with fewer periods must find a compatible partner for each of them.
 */
export function periodsCompatible(left: readonly string[], right: readonly string[]): boolean {
  const [few, many] = left.length <= right.length ? [left, right] : [right, left];
  return few.every((period) => many.some((other) => tokensCompatible(period, other)));
}

/** The year a period token names; undefined for `Q3` and `3月`. */
export function periodYear(token: string): string | undefined {
  return parse(token).year;
}

const byIndices = (left: readonly number[], right: readonly number[]): number => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
};

/**
 * The largest sets of period lists, as indices, in which every two lists are compatible. Compatibility
 * is not transitive: a list that names no year fits `2025年Q3` and `2026年Q3`, which do not fit each
 * other, so it belongs to one set per year. Each set is ascending and the sets are ordered by their
 * indices. Bron–Kerbosch with a pivot over the distinct lists: lists that name the same periods fit
 * the same lists, and the lists of one metric and quarter hold a handful of years.
 */
export function compatibleGroups(lists: readonly (readonly string[])[]): number[][] {
  if (!lists.length) return [];
  const distinct: (readonly string[])[] = [];
  const kindOf = lists.map((list) => {
    const found = distinct.findIndex(
      (other) => other.length === list.length && other.every((period, at) => period === list[at]),
    );
    if (found >= 0) return found;
    distinct.push(list);
    return distinct.length - 1;
  });
  const fits = distinct.map((left, row) =>
    distinct.map((right, column) => row !== column && periodsCompatible(left, right)),
  );
  const groups: number[][] = [];
  const grow = (group: readonly number[], open: number[], done: number[]): void => {
    if (!open.length) {
      if (!done.length) {
        const kinds = new Set(group);
        groups.push(lists.flatMap((_, index) => (kinds.has(kindOf[index]!) ? [index] : [])));
      }
      return;
    }
    const reach = (node: number): number => open.filter((other) => fits[node]![other]).length;
    const pivot = [...open, ...done].reduce((best, node) => (reach(node) > reach(best) ? node : best));
    let remaining = open;
    let finished = done;
    for (const node of open.filter((other) => !fits[pivot]![other])) {
      const near = (nodes: number[]): number[] => nodes.filter((other) => fits[node]![other]);
      grow([...group, node], near(remaining), near(finished));
      remaining = remaining.filter((other) => other !== node);
      finished = [...finished, node];
    }
  };
  grow(
    [],
    distinct.map((_, index) => index),
    [],
  );
  return groups.sort(byIndices);
}

/**
 * The periods that lists which fit one another name together: for each month or quarter, the forms
 * that name a year when any list names one, else the form as written. The result is the period a page
 * number has to fit to speak to a conflict between those lists.
 */
export function sharedPeriods(lists: readonly (readonly string[])[]): readonly string[] {
  const tokens = [...new Set(lists.flat())];
  const dated = new Set(tokens.filter((token) => periodYear(token) !== undefined).map(periodPart));
  return tokens.filter((token) => periodYear(token) !== undefined || !dated.has(periodPart(token))).sort();
}
