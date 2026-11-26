/** Shared period labels for source returns and post-write provenance. */
const PERIOD_PATTERN =
  /(?<!\d)(?:\d{4}年\d{1,2}(?:-\d{1,2})?月末?|\d{4}年[上下]半年|Q[1-4]|\d{2}年\d{1,2}月)(?![0-9])/g;

export function extractPeriodLabels(text: string): readonly string[] {
  return [...new Set([...text.matchAll(PERIOD_PATTERN)].map((match) => match[0]))];
}
