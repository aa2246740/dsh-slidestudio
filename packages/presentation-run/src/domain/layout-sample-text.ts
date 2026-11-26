/**
 * Sample wording in Agent-written masters and layouts (VAL-TPL-017). A master or layout is shared
 * chrome: a header line, a logo, a page number or a generic footer. Text that an attached PPT
 * template shows on its own slides (titles, report names, dates, table and chart text) never
 * belongs there, even when `content` is declared for the pages. Page content is not checked here.
 */
import { readMaterialsManifest, verifyMaterial } from "./material-pack.js";

type RecordValue = Record<string, unknown>;

/** Sample wording prepared for the layout check. Both tables hold normalized text only. */
export type SampleTextIndex = Readonly<{
  /** Every run of four consecutive letters or digits that occurs in the sample wording. */
  fourGrams: ReadonlySet<string>;
  /** Slide titles that contain a letter; digit or punctuation numbering is generic and excluded. */
  titles: readonly string[];
}>;

const MIN_RUN = 4;
const MIN_TITLE = 2;
// Paragraph, cell and line breaks: a run never spans two paragraphs of the sample.
const BREAKS = /[\r\n\t\u000b\f]+/;
// Page and total fields are generated numbering, never sample wording.
const FIELD_TOKEN = /\{[^{}]*\}/g;

const EMPTY_INDEX: SampleTextIndex = { fourGrams: new Set(), titles: [] };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Paragraph strings of a text value; a number counts as its printed form. */
function paragraphs(value: unknown): string[] {
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  return typeof value === "string" ? value.split(BREAKS) : [];
}

function nodeTexts(nodes: unknown): string[] {
  return records(nodes).flatMap((node) => [...paragraphs(node.text), ...nodeTexts(node.children)]);
}

/** Letters and digits only, NFKC and lower case: spacing and separators cannot hide a copied phrase. */
export function sampleNormalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Every text paragraph and every slide title that the derivative of one PPTX template holds. */
function derivativeText(derivative: RecordValue): { lines: string[]; titles: string[] } {
  const template = isRecord(derivative["deck-template"]) ? derivative["deck-template"] : {};
  const detail = isRecord(template.templateDetail) ? template.templateDetail : {};
  const slides = records(detail.slides).length ? records(detail.slides) : records(template.slides);
  const lines: string[] = [];
  const titles: string[] = [];
  for (const slide of slides) {
    if (typeof slide.title === "string") titles.push(slide.title);
    lines.push(
      ...paragraphs(slide.title),
      ...paragraphs(slide.text),
      ...paragraphs(slide.tableText),
      ...paragraphs(slide.notes),
      ...records(slide.shapes).flatMap((shape) => paragraphs(shape.text)),
    );
  }
  for (const layout of records(detail.layouts)) {
    lines.push(...records(layout.shapes).flatMap((shape) => paragraphs(shape.text)));
  }
  for (const table of records(detail.tables)) {
    for (const row of Array.isArray(table.rows) ? table.rows : []) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) lines.push(...paragraphs(isRecord(cell) ? cell.text : cell));
    }
  }
  for (const chart of records(detail.charts)) {
    lines.push(...paragraphs(chart.title));
    for (const series of records(chart.series)) {
      const cells = [
        series.name,
        ...(Array.isArray(series.categories) ? series.categories : []),
        ...(Array.isArray(series.values) ? series.values : []),
      ];
      lines.push(...cells.flatMap((cell) => paragraphs(cell)));
    }
  }
  for (const diagram of records(detail.smartArts)) lines.push(...nodeTexts(diagram.nodes));
  return { lines, titles };
}

/**
 * The sample wording of one verified template: its text paragraphs, its slide titles and the file
 * name the user gave it (a report name is often the file name).
 */
export function sampleTextIndex(material: { derivative: RecordValue; name: string }): SampleTextIndex {
  const { lines, titles } = derivativeText(material.derivative);
  const baseName = material.name.replace(/\.[^./\\]+$/, "");
  const fourGrams = new Set<string>();
  for (const line of [...lines, baseName]) {
    const chars = Array.from(sampleNormalize(line));
    for (let at = 0; at + MIN_RUN <= chars.length; at += 1) {
      fourGrams.add(chars.slice(at, at + MIN_RUN).join(""));
    }
  }
  const titleTexts = titles
    .filter((title) => /\p{L}/u.test(title))
    .map(sampleNormalize)
    .filter((title) => Array.from(title).length >= MIN_TITLE);
  return { fourGrams, titles: [...new Set(titleTexts)] };
}

function mergeIndexes(indexes: readonly SampleTextIndex[]): SampleTextIndex {
  if (!indexes.length) return EMPTY_INDEX;
  return {
    fourGrams: new Set(indexes.flatMap((index) => [...index.fourGrams])),
    titles: [...new Set(indexes.flatMap((index) => [...index.titles]))],
  };
}

/**
 * The sample wording of every PPTX template in the project. A template that fails verification
 * throws its MaterialPackError, so the caller refuses the layout instead of skipping the check.
 */
export function sampleTextIndexForRoot(root: string): SampleTextIndex {
  const indexes: SampleTextIndex[] = [];
  for (const entry of readMaterialsManifest(root)) {
    if (entry.kind !== "deck-template") continue;
    indexes.push(sampleTextIndex(verifyMaterial(root, entry.id)));
  }
  return mergeIndexes(indexes);
}

function sharesRun(normalized: string, fourGrams: ReadonlySet<string>): boolean {
  const chars = Array.from(normalized);
  for (let at = 0; at + MIN_RUN <= chars.length; at += 1) {
    if (fourGrams.has(chars.slice(at, at + MIN_RUN).join(""))) return true;
  }
  return false;
}

/**
 * Ids of the master or layout elements whose text repeats sample wording. A text repeats the sample
 * when it contains a slide title or shares four consecutive letters or digits with the sample.
 * Returns ids only, so the refusal never echoes the sample text.
 */
export function sampleTextElementIds(elements: readonly unknown[], index: SampleTextIndex): string[] {
  if (!index.fourGrams.size && !index.titles.length) return [];
  const hits: string[] = [];
  for (const element of elements) {
    if (!isRecord(element) || !isRecord(element.content)) continue;
    const text = element.content.text;
    if (typeof text !== "string") continue;
    const normalized = sampleNormalize(text.replace(FIELD_TOKEN, ""));
    if (!normalized) continue;
    const repeatsTitle = index.titles.some((title) => normalized.includes(title));
    if (repeatsTitle || sharesRun(normalized, index.fourGrams)) {
      hits.push(typeof element.elementId === "string" ? element.elementId : "未命名元素");
    }
  }
  return hits;
}
