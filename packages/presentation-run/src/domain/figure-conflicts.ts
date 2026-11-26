/**
 * Near-match number conflicts between sources (CAP-21, VAL-DATA-009). Pure functions over text:
 * a "labelled figure" is a number with the words right before it (or, in a table, its row label
 * and column header). Two figures from different sources conflict when their labels name the same
 * metric in the same period and their values differ by 0.1 %–5 %. Nothing here blocks anything;
 * callers only turn the result into a hint and a provenance entry.
 */
import {
  compatibleGroups,
  periodPart,
  periodsCompatible,
  periodYear,
  sharedPeriods,
  splitPeriods,
  type SplitLabel,
} from "./conflict-periods.js";

/** A difference below this is rounding, not a conflict. Fixed by the contract. */
export const CONFLICT_MIN_RELATIVE = 0.001;
/** A difference above this is a different quantity, not a near-match. Fixed by the contract. */
export const CONFLICT_MAX_RELATIVE = 0.05;
/** Absorbs float error so a difference of exactly 0.1 % or 5 % stays inside the range. */
const EDGE_EPSILON = 1e-9;

/** Lower rank wins when a conflict is explained by source kind. */
export type SourceRank = 0 | 1 | 2;
export const BRIEF_RANK: SourceRank = 0;
export const TABLE_RANK: SourceRank = 1;
export const DOCUMENT_RANK: SourceRank = 2;

export type LabelledFigure = Readonly<{
  /**
   * Metric and periods, normalized. Figures are compared when their metric and the month or quarter of
   * their periods are equal and their periods name no different years.
   */
  key: string;
  /** The words before the number, as written, for display. */
  label: string;
  /** The number as written, thousand separators kept. */
  token: string;
  value: number;
  /** Normalized unit (`万`, `亿`, `%`); empty when the source names none. */
  unit: string;
}>;

/**
 * Identity of the brief as a conflict source. A material id never holds a `/`, so no material can
 * be mistaken for it.
 */
export const BRIEF_SOURCE_ID = "/brief";

export type ConflictSource = Readonly<{
  /** File name, or the brief's own name. A label only: two sources are the same by `sourceId`. */
  source: string;
  /** The material id, or `BRIEF_SOURCE_ID`; a hand-built source without one is told apart by `source`. */
  sourceId?: string;
  rank: SourceRank;
  figures: readonly LabelledFigure[];
}>;

export type ConflictMember = Readonly<{
  source: string;
  sourceId: string;
  /** The key of the figure this member stated, for the period the page's number is compared with. */
  key: string;
  rank: SourceRank;
  token: string;
  value: number;
  unit: string;
}>;

/** The conflict of one metric in one period; every member states that period and no other. */
export type NumberConflictCandidate = Readonly<{
  /**
   * The metric and the period the members share. Where any member names a year, the period names it,
   * so a page number about another year does not speak to this candidate through a member that wrote none.
   */
  key: string;
  label: string;
  members: readonly ConflictMember[];
}>;

const NUMBER_PATTERN = /(?<![\w.\-/])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(%?)(?![\d.]|[A-Za-z\-/])/g;
/** A number followed by one of these is a date, count of pages or similar, never a figure. */
const NOT_A_FIGURE_SUFFIX = /^\s{0,2}[年月日号页周天岁]/;
const UNIT_PATTERN = /^\s{0,2}(亿元|万元|千元|亿|万|千|元|%)/;
const TRAILING_CONNECTORS = /(?:写成|写为|写|为|是|达到|达|约|共|合计|累计|计|至|仅|有|:|：|=|＝|≈|\s)+$/;
const TRAILING_PARENTHESIS = /[（(][^）)]{0,8}[）)]\s*$/;
const LABEL_BOUNDARY = /[，。；;、,:：！!？?|\t()（）【】[\]<>《》“”"'‘’]/;
/** Words that name no metric of their own; a figure under only these cannot be matched. */
const GENERIC_WORDS = /同比|环比|增长|增速|占比|比例|合计|总计|小计|其中|金额|数量|数值|总额|总数/g;
const MAX_LABEL_CHARS = 20;
/** A caption is a few words, not a sentence: a longer line is never taken for the label of a value. */
const MAX_CAPTION_CHARS = 24;
const UNIT_WORDS = /亿元|万元|千元|亿|万|千|元/g;

/** Significant digits: digits after dropping separators and leading zeros. */
function significantDigits(token: string): number {
  return token.replace(/[,.]/g, "").replace(/^0+/, "").length;
}

export function normalizeUnit(raw: string): string {
  if (raw === "%") return "%";
  if (raw === "元") return "";
  return raw.endsWith("元") ? raw.slice(0, -1) : raw;
}

/** Units are compatible when equal or when either side names none. */
export function unitsCompatible(left: string, right: string): boolean {
  return !left || !right || left === right;
}

/** Difference ÷ the smaller magnitude; symmetric in its arguments. */
export function relativeDifference(left: number, right: number): number {
  const base = Math.min(Math.abs(left), Math.abs(right));
  return base === 0 ? Number.POSITIVE_INFINITY : Math.abs(left - right) / base;
}

/** True when two values differ by 0.1 %–5 % (both ends inclusive). */
export function isNearMatchConflict(left: number, right: number): boolean {
  if (left === right) return false;
  const relative = relativeDifference(left, right);
  return relative >= CONFLICT_MIN_RELATIVE - EDGE_EPSILON && relative <= CONFLICT_MAX_RELATIVE + EDGE_EPSILON;
}

/** The metric words left of a label once its periods are taken out; undefined when it names none. */
function metricOf(rest: string): string | undefined {
  const metric = rest.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  return metric.replace(GENERIC_WORDS, "").length < 2 ? undefined : metric;
}

function keyOf({ rest, periods }: SplitLabel): string | undefined {
  const metric = metricOf(rest);
  return metric === undefined ? undefined : `${metric}|${periods.join(",")}`;
}

/** Metric plus periods of a label; undefined when it names no metric. */
export function labelKey(label: string): string | undefined {
  return keyOf(splitPeriods(label));
}

function toValue(token: string): number {
  return Number(token.replace(/,/g, ""));
}

function proseLabel(before: string): string {
  let text = before.replace(TRAILING_CONNECTORS, "");
  text = text.replace(TRAILING_PARENTHESIS, "").replace(TRAILING_CONNECTORS, "");
  let start = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (LABEL_BOUNDARY.test(text[index]!)) {
      start = index + 1;
      break;
    }
  }
  const label = text.slice(start).trim();
  return Array.from(label).slice(-MAX_LABEL_CHARS).join("");
}

/** Labelled figures of running text (documents, text files, the brief), one pass per line. */
export function proseFigures(text: string): readonly LabelledFigure[] {
  const found: LabelledFigure[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*#{1,6}\s/.test(line) || line.includes("\t")) continue;
    for (const match of line.matchAll(NUMBER_PATTERN)) {
      const token = match[1]!;
      const percent = match[2] === "%";
      const index = match.index ?? 0;
      const after = line.slice(index + match[0].length);
      if (!percent && NOT_A_FIGURE_SUFFIX.test(after)) continue;
      if (significantDigits(token) < 3) continue;
      const label = proseLabel(line.slice(0, index));
      const key = labelKey(label);
      if (!key) continue;
      const unit = percent ? "%" : normalizeUnit(UNIT_PATTERN.exec(after)?.[1] ?? "");
      found.push({ key, label, token, value: toValue(token), unit });
    }
  }
  return found;
}

export function headerMetric(header: string): { metric: string; unit: string } {
  const paren = /[（(\[]([^）)\]]{0,8})[）)\]]\s*$/.exec(header);
  const unitWord = paren ? (UNIT_PATTERN.exec(paren[1]!)?.[1] ?? "") : "";
  return {
    metric: paren ? header.slice(0, paren.index).trim() : header.trim(),
    unit: normalizeUnit(unitWord),
  };
}

/**
 * Labelled figures of rendered table windows (`列：` header line, then `index<TAB>cells` rows).
 * A figure needs a row label (the first cell, not a number) and a column header.
 */
export function tableFigures(text: string): readonly LabelledFigure[] {
  const found: LabelledFigure[] = [];
  let header: readonly string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("列：")) {
      header = line.slice("列：".length).split(" | ");
      continue;
    }
    const row = /^\d+\t(.*)$/.exec(line);
    if (!row || !header.length) continue;
    const cells = row[1]!.split("\t").map((cell) => cell.trim());
    const rowLabel = cells[0] ?? "";
    if (!rowLabel || /^[\d.,%\s]+$/.test(rowLabel)) continue;
    cells.forEach((cell, column) => {
      if (column === 0) return;
      const match = /^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(%?)$/.exec(cell);
      const head = header[column];
      if (!match || !head || significantDigits(match[1]!) < 3) return;
      const { metric, unit } = headerMetric(head);
      const label = `${rowLabel} ${metric}`.trim();
      const key = labelKey(label);
      if (!key) return;
      found.push({
        key,
        label,
        token: match[1]!,
        value: toValue(match[1]!),
        unit: match[2] === "%" ? "%" : unit,
      });
    });
  }
  return found;
}

/**
 * Sources are grouped by metric and by the month, quarter or half-year their periods name. The year
 * only decides which figures of a group can conflict and share a candidate, so `3月营收` and
 * `2026年3月营收` meet and `2025年3月营收` and `2026年3月营收` do not.
 */
function groupKey(key: string): string {
  const { metric, periods } = splitKey(key);
  return `${metric}|${[...new Set(periods.map(periodPart))].sort().join(",")}`;
}

/** A figure of one group: who stated it, how it was written, and the periods its key names. */
type GroupFigure = Readonly<{ label: string; member: ConflictMember; periods: readonly string[] }>;

/**
 * The conflicts of one metric and quarter or month. Two figures conflict when they come from different
 * sources, their units fit, their values are 0.1 %–5 % apart and their periods are compatible. A group
 * can hold several years of that quarter, and those years do not conflict with each other, so the
 * figures that conflict are split into the largest sets whose periods are all compatible and each set
 * is its own candidate: a figure that names no year is in the candidate of every year it conflicts in.
 */
function groupCandidates(figures: readonly GroupFigure[]): NumberConflictCandidate[] {
  const conflicting = (left: number, right: number): boolean => {
    const a = figures[left]!;
    const b = figures[right]!;
    return (
      left !== right &&
      a.member.sourceId !== b.member.sourceId &&
      unitsCompatible(a.member.unit, b.member.unit) &&
      isNearMatchConflict(a.member.value, b.member.value) &&
      periodsCompatible(a.periods, b.periods)
    );
  };
  const involved = figures
    .map((_, index) => index)
    .filter((index) => figures.some((_, other) => conflicting(index, other)));
  const sets = compatibleGroups(involved.map((index) => figures[index]!.periods))
    .map((set) => set.map((position) => involved[position]!))
    // A year-less figure fits several years but conflicts in some of them only.
    .map((set) => set.filter((index) => set.some((other) => conflicting(index, other))))
    .filter((set) => set.length >= 2);
  const kept = sets
    .filter(
      (set, position) =>
        !sets.some(
          (other, otherPosition) =>
            otherPosition !== position &&
            set.every((index) => other.includes(index)) &&
            (other.length > set.length || otherPosition < position),
        ),
    )
    .sort((left, right) => left[0]! - right[0]!);
  return kept.map((set) => {
    const periods = set.map((index) => figures[index]!.periods);
    const fits = figures.filter((figure) => periods.every((own) => periodsCompatible(figure.periods, own)));
    // Several years in one group: name the candidate's year when a figure of it was written with one.
    const dated =
      kept.length > 1
        ? fits.find((figure) => figure.periods.some((period) => periodYear(period) !== undefined))
        : undefined;
    const seen = new Set<string>();
    const members = set
      .map((index) => figures[index]!.member)
      .filter((member) => {
        const id = `${member.sourceId}\u0000${member.value}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    return {
      key: `${splitKey(members[0]!.key).metric}|${sharedPeriods(periods).join(",")}`,
      label: (dated ?? fits[0]!).label,
      members,
    };
  });
}

/**
 * Metrics two different sources state with values 0.1 %–5 % apart, one candidate per metric and
 * period. A source that states the metric twice with different values contributes each of them;
 * members are listed in source order. Every conflict is returned: which of them matter is for the
 * page to say, and how many are shown is for the hint, the receipt and the card.
 */
export function detectNumberConflicts(sources: readonly ConflictSource[]): readonly NumberConflictCandidate[] {
  const groups = new Map<string, GroupFigure[]>();
  for (const source of sources) {
    for (const figure of source.figures) {
      const group = groups.get(groupKey(figure.key)) ?? [];
      group.push({
        label: figure.label,
        periods: splitKey(figure.key).periods,
        member: {
          source: source.source,
          sourceId: source.sourceId ?? source.source,
          key: figure.key,
          rank: source.rank,
          token: figure.token,
          value: figure.value,
          unit: figure.unit,
        },
      });
      groups.set(groupKey(figure.key), group);
    }
  }
  return [...groups.values()].flatMap(groupCandidates);
}

/** A number a page states, with the metric its own words give it (undefined when they give none). */
export type StatedNumber = Readonly<{ value: number; key: string | undefined }>;

/**
 * A stated number with the periods its own clause names, sorted. The key is undefined for a clause
 * that names a period but no metric (`Q2 1500`); the periods are what the number keeps then.
 */
export type ClausedNumber = StatedNumber & Readonly<{ periods: readonly string[] }>;

/** Every number a page states: thousand separators dropped, `%` kept apart, each with its clause. */
export function clausedNumbers(text: string): readonly ClausedNumber[] {
  const found: ClausedNumber[] = [];
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(NUMBER_PATTERN)) {
      const label = splitPeriods(proseLabel(line.slice(0, match.index ?? 0)));
      found.push({ value: toValue(match[1]!), key: keyOf(label), periods: label.periods });
    }
  }
  return found;
}

/** Every number a page states, each with the metric of its clause label. */
export function statedNumbers(text: string): readonly StatedNumber[] {
  return clausedNumbers(text).map(({ value, key }) => ({ value, key }));
}

/** Whether a line states a figure: a number of three significant digits or more that is not a date or a page count. */
function statesFigure(line: string): boolean {
  return [...line.matchAll(NUMBER_PATTERN)].some((match) => {
    const after = line.slice((match.index ?? 0) + match[0].length);
    return (match[2] === "%" || !NOT_A_FIGURE_SUFFIX.test(after)) && significantDigits(match[1]!) >= 3;
  });
}

/**
 * Whether the text names no metric once its numbers and units are taken out: the value half of a
 * figure card (`1,502.25 万元`, `Q3 1502.25`, `同比 8.2%`).
 */
export function namesNoMetric(text: string): boolean {
  // Periods first: their digits are numbers too, and `2026年3月` must not leave `年月` behind as a metric.
  const { rest } = splitPeriods(text);
  return metricOf(rest.replace(NUMBER_PATTERN, " ").replace(UNIT_WORDS, " ")) === undefined;
}

/**
 * The metric a text names when it is a caption: its last line is a short label that names a metric,
 * and no line states a figure. Undefined for anything else (a value, a unit, a sentence).
 */
export function captionKey(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last || Array.from(last).length > MAX_CAPTION_CHARS || lines.some(statesFigure)) {
    return undefined;
  }
  const label = proseLabel(last);
  return namesNoMetric(label) ? undefined : labelKey(label);
}

function splitKey(key: string): { metric: string; periods: readonly string[] } {
  const cut = key.lastIndexOf("|");
  return {
    metric: key.slice(0, cut),
    periods: key
      .slice(cut + 1)
      .split(",")
      .filter(Boolean),
  };
}

/**
 * The key of a number whose own clause names `periods` but no metric. It borrows the metric of a label
 * (`labelled`, the label's key) and keeps its own period: the number sits closest to what it counts, so
 * its period replaces the label's, and a number that names none takes the label's. With no label to
 * borrow from, the key names the period alone, which `sameMetric` reads as that period of every metric.
 * `periods` is sorted, as `clausedNumbers` returns it.
 */
export function periodBoundKey(labelled: string | undefined, periods: readonly string[]): string | undefined {
  if (!periods.length) return labelled;
  const metric = labelled === undefined ? "" : splitKey(labelled).metric;
  return `${metric}|${periods.join(",")}`;
}

/**
 * Whether a page label is about the metric a source states. A metric's head word comes last, so a
 * label may carry extra words in front (本季度营收 for 营收) but not after it (营收目标). Periods are
 * compared only when both name one, and then by month or quarter and year (see `periodsCompatible`).
 */
function sameMetric(key: string, pageKey: string): boolean {
  const left = splitKey(key);
  const right = splitKey(pageKey);
  if (!periodsCompatible(left.periods, right.periods)) return false;
  return left.metric.endsWith(right.metric) || right.metric.endsWith(left.metric);
}

/**
 * Whether the page states `value` for the metric `key` names: under a label of that metric, or
 * under no metric label at all (a figure card keeps its caption in another element, and table and
 * chart cells arrive one per line). A value the page labels with another metric or period does not.
 * With several keys one stated number has to fit all of them.
 */
export function pageStatesValue(
  stated: readonly StatedNumber[],
  key: string | readonly string[],
  value: number,
): boolean {
  const keys = typeof key === "string" ? [key] : key;
  const fitsAll = (pageKey: string): boolean => keys.every((own) => sameMetric(own, pageKey));
  return stated.some((number) => number.value === value && (number.key === undefined || fitsAll(number.key)));
}
