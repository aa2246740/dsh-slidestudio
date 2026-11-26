/**
 * Numbers the vision model read off an image (VAL-IMG-012, CAP-23).
 *
 * `record_material_notes.readValues` hold what the model read from a picture.
 * A page that states one of those numbers gets a `vision-read` value and a
 * non-blocking hint, unless a read document, template chart or table row of the
 * same epoch already states the same number: the file vouches for it instead.
 * Notes count only when their text still hashes to the digest the ledger
 * recorded for this epoch (fail closed).
 */
import { stableSha256 } from "./hashing.js";
import { readMaterialNotes, type MaterialReadValue } from "./material-notes.js";
import { readMaterialsManifest } from "./material-pack.js";
import { readRunLedger } from "./run-ledger.js";
import type { MaterialFigureReading } from "./material-figures.js";

export type VisionValue = Readonly<{
  /** The number as the image reading wrote it, sign included: 89.64%, -12.34% or 2300. */
  value: string;
  materialId: string;
  basis: "vision-read";
}>;

/** A read value whose notes passed the digest check, with the image it came from. */
export type VerifiedReadValue = Readonly<{ materialId: string; value: string }>;

/**
 * A figure as the text writes it. The sign is a minus (`-` or `−` U+2212) or a
 * plus, and it counts only when no digit, Latin letter or `.` comes before it:
 * `2023-2024` and `1-3月` are ranges, not negative figures. A figure ends before
 * a digit or a `.` and a digit, so the full stop in `…为 42.` does not hide the
 * 42. A figure may start with a `.` (`.5`) and may leave a space before its `%`.
 */
const FIGURE_PATTERN =
  /(?:(?<![\p{Script=Latin}\d.])([-\u2212+]))?(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:[ \u00A0]?(%))?(?!\d|\.\d)/gu;

/**
 * Full-width digits, `％`, `＋`, `－` and `．` stand for their ASCII twins. The
 * full-width comma stays punctuation: in running Chinese it does not group digits.
 */
const FULL_WIDTH_FIGURE_CHARS = /[\uFF10-\uFF19\uFF05\uFF0B\uFF0D\uFF0E]/g;

/** Each character folds to one character, so folded and original indexes match. */
function foldFigureText(text: string): string {
  return text.replace(FULL_WIDTH_FIGURE_CHARS, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

/**
 * The comparison spelling of a magnitude: zeros before the integer digits and
 * after the fraction are not part of the number, so `89.60%` is `89.6%`, `05`
 * is `5` and `.5` is `0.5`. Only the key uses this; the recorded text stays.
 */
function comparisonNumber(magnitude: string): string {
  const percent = magnitude.endsWith("%") ? "%" : "";
  const [whole = "", fraction = ""] = magnitude.replace(/%$/, "").split(".");
  const integer = whole.replace(/^0+(?=\d)/, "") || "0";
  const decimals = fraction.replace(/0+$/, "");
  return `${integer}${decimals ? `.${decimals}` : ""}${percent}`;
}

/** One figure in a text, as written and in its parts. */
type FigureToken = Readonly<{
  /** As written, sign and spelling included: `-12.34%`, `－12.00%`, `5 %`. */
  text: string;
  /** Carries a minus sign (ASCII or U+2212). */
  negative: boolean;
  /** Carries any sign character. A bare figure has none. */
  signed: boolean;
  /** The number as typed, without its sign: `12.34%`, `2,300`. */
  number: string;
  /** The number without thousands separators: `12.34%`, `2300`. */
  magnitude: string;
  /** The comparison spelling without its sign: `12.3%` for `12.30%`, `0.5` for `.5`. */
  key: string;
}>;

function figureTokens(text: string): FigureToken[] {
  // Folding keeps every index, so each figure is sliced from the text as recorded.
  const folded = foldFigureText(text);
  return [...folded.matchAll(FIGURE_PATTERN)].map((match) => {
    const sign = match[1] ?? "";
    const number = `${match[2] ?? ""}${match[3] ?? ""}`;
    const magnitude = number.replace(/,/g, "");
    const start = match.index ?? 0;
    return {
      text: text.slice(start, start + match[0].length),
      negative: sign === "-" || sign === "\u2212",
      signed: sign !== "",
      number,
      magnitude,
      key: comparisonNumber(magnitude),
    };
  });
}

/**
 * Comparison forms of a key: a percent sign is a unit, so 89.6% also states 89.6.
 */
function figureForms(key: string): string[] {
  return key.endsWith("%") ? [key, key.slice(0, -1)] : [key];
}

/** Index key of one form: a minus stays in the key, an unsigned or plus figure is positive. */
function signedForm(negative: boolean, form: string): string {
  return negative ? `-${form}` : form;
}

/** An unsigned 19xx or 20xx: a date, never a figure on its own. */
function isBareYear(figure: FigureToken): boolean {
  return !figure.signed && /^(19|20)\d{2}$/.test(figure.number);
}

/**
 * A recorded read value worth marking. "Bare" means unsigned and unitless, so
 * every percentage, decimal and signed figure qualifies (5%, 0%, 100%, 0.5,
 * -12): a sign shows a figure, not a page number, a step or a year. An
 * unsigned integer needs two significant digits, and an unsigned 19xx/20xx is a
 * date, so neither a bare single digit nor a bare year qualifies.
 */
function isCheckableFigure(figure: FigureToken): boolean {
  if (figure.signed || figure.magnitude.endsWith("%") || figure.magnitude.includes(".")) {
    return true;
  }
  if (isBareYear(figure)) return false;
  return figure.magnitude.replace(/^0+/, "").length >= 2;
}

/**
 * Whether a whole cell is one figure (`5`, `-12.00%`, `1,234.5`) rather than
 * running text. A chart value or table number is such a cell.
 */
export function isWholeFigure(text: string): boolean {
  const trimmed = text.trim();
  const figures = figureTokens(trimmed);
  return figures.length === 1 && figures[0]?.text === trimmed;
}

function notesIdentity(identity: { materialId: string; mediaId?: string; page?: number; notesSha256: string }): string {
  return [identity.materialId, identity.mediaId ?? "", identity.page ?? "", identity.notesSha256].join("|");
}

/**
 * Read values of this epoch whose notes still match the ledger. The notes file
 * must hash to the recorded `notesSha256`, and the ledger must hold that same
 * record in this epoch. Anything else contributes nothing.
 */
export function verifiedReadValues(root: string, contextEpochId: string): readonly VerifiedReadValue[] {
  const ledger = readRunLedger(root);
  if (!ledger) return [];
  const recorded = new Set(
    ledger.facts.flatMap((fact) =>
      fact.type === "material.notes-recorded" && fact.contextEpochId === contextEpochId ? [notesIdentity(fact)] : [],
    ),
  );
  return readMaterialNotes(root).flatMap((entry) => {
    const notes = entry.notes;
    if (entry.contextEpochId !== contextEpochId || !notes || typeof notes !== "object") return [];
    if (!recorded.has(notesIdentity(entry))) return [];
    if (stableSha256(notes) !== entry.notesSha256) return [];
    const readValues = Array.isArray(notes.readValues) ? notes.readValues : [];
    return readValues.flatMap((read) =>
      typeof read?.value === "string" ? [{ materialId: entry.materialId, value: readFigureText(read) }] : [],
    );
  });
}

/**
 * The figure a read value states. A `%` (or `％`) in its own `unit` field reads
 * like the inline sign, so `{value:"5", unit:"%"}` is the figure `5%`. Other
 * units do not join the figure, as before.
 */
function readFigureText(read: MaterialReadValue): string {
  const percent = read.unit === "%" || read.unit === "％";
  return percent && !/[%％]$/.test(read.value) ? `${read.value}${read.unit}` : read.value;
}

/**
 * Signed figure forms the read file segments state: document and table text,
 * template chart values. A file figure without a sign is positive.
 */
function fileFigureKeys(readings: readonly MaterialFigureReading[]): ReadonlySet<string> {
  const keys = new Set<string>();
  const addText = (text: string): void => {
    for (const figure of figureTokens(text)) {
      for (const form of figureForms(figure.key)) {
        keys.add(signedForm(figure.negative, form));
      }
    }
  };
  for (const reading of readings) {
    for (const page of reading.pages) addText(page.text);
    for (const chart of reading.templateCharts ?? []) {
      addText(chart.title);
      for (const category of chart.categories) addText(String(category ?? ""));
      for (const series of chart.series) {
        for (const cell of series.values) {
          if (typeof cell === "number" && Number.isFinite(cell)) {
            // A chart stores 89.64 where the page may say 89.64%.
            addText(`${cell} ${cell}%`);
          } else {
            addText(String(cell ?? ""));
          }
        }
      }
    }
  }
  return keys;
}

/**
 * Vision-read values of one page: each verified read figure that the page
 * states and no read file segment states. Read values, pages and files compare
 * through the same comparison keys (trailing and leading zeros do not count).
 * A page matches by magnitude (fail safe), while a file vouches only for the
 * same sign. Running text states a figure only when the figure is checkable, so
 * a lone digit there is a page number, a step or a count. A whole-figure cell
 * (`pageNumbers`) is data and counts as written, except a bare year. Each
 * (image, figure) pair is listed once, as the read value wrote it.
 */
export function visionValuesFor(input: {
  readonly pageText: string;
  /** Page cells that each hold one whole figure (see `isWholeFigure`). */
  readonly pageNumbers?: readonly string[];
  readonly readValues: readonly VerifiedReadValue[];
  readonly readings: readonly MaterialFigureReading[];
}): readonly VisionValue[] {
  if (!input.readValues.length) return [];
  const onPage = new Set([
    ...figureTokens(input.pageText)
      .filter(isCheckableFigure)
      .flatMap((figure) => figureForms(figure.key)),
    ...(input.pageNumbers ?? [])
      .flatMap((cell) => figureTokens(cell))
      .filter((figure) => !isBareYear(figure))
      .flatMap((figure) => figureForms(figure.key)),
  ]);
  const inFiles = fileFigureKeys(input.readings);
  const listed = new Set<string>();
  const values: VisionValue[] = [];
  for (const read of input.readValues) {
    for (const figure of figureTokens(read.value)) {
      if (!isCheckableFigure(figure)) continue;
      const forms = figureForms(figure.key);
      if (!forms.some((form) => onPage.has(form))) continue;
      if (forms.some((form) => inFiles.has(signedForm(figure.negative, form)))) continue;
      const identity = `${read.materialId}|${signedForm(figure.negative, figure.key)}`;
      if (listed.has(identity)) continue;
      listed.add(identity);
      values.push({ value: figure.text, materialId: read.materialId, basis: "vision-read" });
    }
  }
  return values;
}

/**
 * Vision-read values of one page. Read table rows vouch for a number as well as
 * read documents do (`readTableReadings` is called only when a verified read
 * value exists, so a deck without image notes reads no table).
 */
export function pageVisionValues(
  root: string,
  contextEpochId: string,
  input: {
    readonly pageText: string;
    readonly pageNumbers?: readonly string[];
    readonly readings: readonly MaterialFigureReading[];
    readonly readTableReadings: () => readonly MaterialFigureReading[];
  },
): readonly VisionValue[] {
  const readValues = verifiedReadValues(root, contextEpochId);
  if (!readValues.length) return [];
  return visionValuesFor({
    pageText: input.pageText,
    pageNumbers: input.pageNumbers,
    readValues,
    readings: [...input.readings, ...input.readTableReadings()],
  });
}

/** Non-blocking hint naming the vision-read numbers and the image each came from. */
export function visionValueHint(root: string, values: readonly VisionValue[]): string | undefined {
  if (!values.length) return undefined;
  const figures = [...new Set(values.map((item) => item.value))].join("、");
  const names = new Map(readMaterialsManifest(root).map((entry) => [entry.id, entry.name]));
  const sources = [...new Set(values.map((item) => names.get(item.materialId) ?? item.materialId))].join("、");
  return `提示：数字是看图识别的，未经文件校验。本页的 ${figures} 来自资料「${sources}」的看图记录，请对照原图核对。这条提示不阻止保存。`;
}
