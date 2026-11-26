/**
 * Deterministic material-figure detection for `write_page` provenance (M2 gap 7).
 *
 * After every successful strict `write_page` the Host extracts "strong
 * numbers" (decimals or percentages with ≥3 significant digits, excluding
 * years, 100% and 0%) and period labels from the written page and the current
 * epoch's verified material reads. Template chart series use exact or displayed precision
 * against their receipt-verified values and source slides. A period mismatch
 * carries a non-blocking Chinese hint; writes are never blocked and provenance
 * never enters page files.
 */
import { parseProvenanceDeclaration, type ProvenanceDeclaration } from "@open-slidestudio/pptd-v2";
import { FIGURE_KINDS, sessionMaterialReadings } from "./material-figures-readings.js";
import { extractPeriodLabels } from "./material-periods.js";
import type { MaterialKind } from "./material-pack.js";
import { checkComputedFigures, recordPageComputedFigures } from "./material-query-figures.js";
import { appendFact, factId, readRunLedger, type RunToolContext } from "./run-ledger.js";
import {
  chartSubstitutionReceipt,
  matchTemplateChartFigures,
  numericToken,
  pageChartsForFigures,
  type ChartTypeSubstitution,
  type PageChartFigure,
  type TemplateChartSource,
} from "./template-chart-provenance.js";
import { chartKindDriftHint, chartKindDrifts } from "./chart-kind-drift.js";
import { materialFiguresHint } from "./material-figures-hint.js";
import { applyPageConflicts } from "./page-conflicts.js";
import { matchTemplateChartTokens } from "./period-figures.js";
import { declaredMissingMatcher } from "./missing-item-scope.js";
import { latestMissingItems } from "./missing-items.js";
import { latestPeriodMap, type PeriodMap } from "./period-map.js";
import { pageNumberCellsForFigures } from "./page-figure-cells.js";
import { pageNumbersSha256, pageTextForFigures } from "./page-figure-text.js";
import { pageStatedNumbers } from "./page-stated-numbers.js";
import { extractStrongNumbers, significantDigits, signedFigureTokens } from "./strong-numbers.js";
import { unsupportedNumbersHint, unsupportedPageNumbers } from "./unsupported-numbers.js";
import { pageVisionValues, visionValueHint, type VisionValue } from "./vision-values.js";

export { sessionMaterialReadings };

export {
  pageChartsForFigures,
  extractPeriodLabels,
  pageTextForFigures,
  materialFiguresHint,
  extractStrongNumbers,
  significantDigits,
};

export type MaterialFigureMatch = Readonly<{
  value: string;
  materialId: string;
  sourcePage: number;
  sourcePeriods: readonly string[];
  chart?: Readonly<{
    sourceChartId: string;
    sourceType: string;
    outputTypes: readonly string[];
    valueMatch?: "exact" | "displayed";
    categoriesMatch?: false;
    substitution?: ChartTypeSubstitution;
  }>;
}>;

export type PageProvenanceFact = Readonly<{
  type: "page.provenance-declared";
  factId: string;
  at: string;
  contextEpochId: string;
  pageId: string;
  revision: number;
  pageSha256: string;
  declaration: ProvenanceDeclaration;
  /** Set when an editor edit kept the declaration of this earlier revision instead of the agent writing one. */
  carriedFromRevision?: number;
  /** Digest of the revision's number multiset; absent on facts recorded before editor edits compared against it. */
  numbersSha256?: string;
}>;

export type MaterialFiguresFact = Readonly<{
  type: "page.material-figures";
  factId: string;
  at: string;
  contextEpochId: string;
  pageId: string;
  revision: number;
  matches: readonly MaterialFigureMatch[];
  pagePeriods: readonly string[];
  /** Numbers read from an image that no read file segment states. Absent on older facts. */
  visionValues?: readonly VisionValue[];
  /** The plan's period map this page was checked against; absent when the plan declared none. */
  periodMap?: PeriodMap;
}>;

/** One read material with its chunk text grouped by source page (0 = unpaged). */
export type MaterialFigureReading = Readonly<{
  materialId: string;
  materialName: string;
  /** Absent on hand-built readings; conflict detection reads only documents, text files and tables. */
  kind?: MaterialKind;
  pages: readonly Readonly<{ page: number; text: string }>[];
  templateCharts?: readonly TemplateChartSource[];
}>;

export type MaterialFiguresReport = Readonly<{
  matches: readonly MaterialFigureMatch[];
  pagePeriods: readonly string[];
}>;

/** Identity of the current page revision; a full revision fact satisfies it structurally. */
export type PageRevisionRef = Readonly<{
  pageId: string;
  revision: number;
  pageSha256: string;
}>;

// ---------------------------------------------------------------------------
// Extraction.
// ---------------------------------------------------------------------------

const PAGE_HEADING_PATTERN = /^## 第 (\d+) 页\s*$/gm;

/** Split a rendered chunk into source pages by `## 第 N 页` headings; text before the first heading is page 0. */
export function splitChunkPages(text: string): readonly Readonly<{ page: number; text: string }>[] {
  const headings = [...text.matchAll(PAGE_HEADING_PATTERN)];
  if (!headings.length) return [{ page: 0, text }];
  const pages: { page: number; text: string }[] = [];
  const before = text.slice(0, headings[0]!.index ?? 0);
  if (before.trim()) pages.push({ page: 0, text: before });
  headings.forEach((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? (headings[index + 1]!.index ?? text.length) : text.length;
    const page = Number(heading[1]);
    if (!Number.isSafeInteger(page) || page <= 0) return;
    pages.push({ page, text: text.slice(start, end) });
  });
  return pages;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Detection.
// ---------------------------------------------------------------------------

/** Match the page's strong numbers against read source pages; quote per the ≥2-hits / ≥4-digit rules. */
export function detectMaterialFigures(input: {
  readonly pageText: string;
  readonly readings: readonly MaterialFigureReading[];
  readonly pageCharts?: readonly PageChartFigure[];
  /** Under a monthly update, page numbers are also matched against each cached chart value. */
  readonly periodMap?: PeriodMap;
}): MaterialFiguresReport {
  const pagePeriods = extractPeriodLabels(input.pageText);
  const pageValues = extractStrongNumbers(input.pageText);
  const hitsByTarget = new Map<string, { materialId: string; page: number; periods: string[]; values: string[] }>();
  if (pageValues.length) {
    for (const reading of input.readings) {
      for (const source of reading.pages) {
        const sourceValues = new Set(extractStrongNumbers(source.text));
        for (const value of pageValues) {
          if (!sourceValues.has(value)) continue;
          const key = `${reading.materialId}#${source.page}`;
          const entry = hitsByTarget.get(key) ?? {
            materialId: reading.materialId,
            page: source.page,
            periods: [...extractPeriodLabels(source.text)],
            values: [],
          };
          if (!entry.values.includes(value)) entry.values.push(value);
          hitsByTarget.set(key, entry);
        }
      }
    }
  }
  const matches: MaterialFigureMatch[] = [];
  for (const entry of hitsByTarget.values()) {
    for (const value of entry.values) {
      // Quoted when ≥2 distinct numbers hit one source page, or one number has ≥4 significant digits.
      if (entry.values.length < 2 && significantDigits(value) < 4) continue;
      matches.push({
        value,
        materialId: entry.materialId,
        sourcePage: entry.page,
        sourcePeriods: entry.periods,
      });
    }
  }
  for (const reading of input.readings) {
    if (!reading.templateCharts?.length) continue;
    const byChart = matchTemplateChartFigures(input.pageCharts ?? [], reading.templateCharts);
    // A vector match already attributed these values; the per-value pass adds only what it missed.
    const keyOf = (chartId: string, value: string) => `${chartId}|${numericToken(value.replace(/%$/, ""))}`;
    const attributed = new Set(byChart.flatMap((chart) => chart.values.map((value) => keyOf(chart.chartId, value))));
    // A cached -123.45 is not the 123.45 a page writes: the sign stays with the value.
    const perValue = input.periodMap
      ? matchTemplateChartTokens(signedFigureTokens(input.pageText, pageValues), reading.templateCharts).flatMap(
          (chart) => {
            const values = chart.values.filter((value) => !attributed.has(keyOf(chart.chartId, value)));
            return values.length ? [{ ...chart, values }] : [];
          },
        )
      : [];
    for (const chart of [...byChart, ...perValue]) {
      for (const value of chart.values) {
        matches.push({
          value,
          materialId: reading.materialId,
          sourcePage: chart.sourcePage,
          sourcePeriods: chart.sourcePeriods,
          chart: {
            sourceChartId: chart.chartId,
            sourceType: chart.sourceType,
            outputTypes: chart.outputTypes,
            valueMatch: chart.valueMatch,
            ...(chart.categoriesMatch === false ? { categoriesMatch: false as const } : {}),
            ...(chart.substitution ? { substitution: chart.substitution } : {}),
          },
        });
      }
    }
  }
  return { matches, pagePeriods };
}

// ---------------------------------------------------------------------------
// Provenance declaration check and ledger recording.
// ---------------------------------------------------------------------------

/** Declared quoted values that appear in no chunk text read this epoch and no query result. */
export function missingQuotedValues(
  declaration: ProvenanceDeclaration,
  readings: readonly MaterialFigureReading[],
  isComputed: (value: string) => boolean = () => false,
): readonly string[] {
  const quoted = declaration.quoted ?? [];
  if (!quoted.length) return [];
  const corpus = readings
    .map((reading) =>
      [
        reading.pages.map((page) => page.text).join("\n"),
        ...(reading.templateCharts ?? []).flatMap((chart) => [
          chart.title,
          ...chart.categories.map((value) => String(value ?? "")),
          ...chart.series.flatMap((series) => series.values.map((value) => String(value ?? ""))),
        ]),
      ].join("\n"),
    )
    .join("\n");
  const missing: string[] = [];
  for (const item of quoted) {
    const value = item.value.trim();
    if (!value) continue;
    if (corpus.includes(value)) continue;
    const bare = value.endsWith("%") ? value.slice(0, -1) : "";
    if (bare && corpus.includes(bare)) continue;
    if (isComputed(value)) continue;
    missing.push(value);
  }
  return missing;
}

export function recordPageProvenanceFact(
  root: string,
  context: RunToolContext,
  input: {
    pageId: string;
    revision: number;
    pageSha256: string;
    declaration: ProvenanceDeclaration;
    carriedFromRevision?: number;
    numbersSha256?: string;
  },
): void {
  const payload = { ...input, contextEpochId: context.contextEpochId };
  appendFact(root, {
    type: "page.provenance-declared",
    // New calls may restore an earlier declaration on the same revision;
    // only replaying the same command should dedupe that declaration.
    factId: factId("page.provenance-declared", { ...payload, commandId: context.commandId }),
    at: new Date().toISOString(),
    ...payload,
  });
}

export function recordMaterialFiguresFact(
  root: string,
  context: RunToolContext,
  input: {
    pageId: string;
    revision: number;
    matches: readonly MaterialFigureMatch[];
    pagePeriods: readonly string[];
    visionValues: readonly VisionValue[];
    periodMap?: PeriodMap;
  },
): void {
  const payload = { ...input, contextEpochId: context.contextEpochId };
  appendFact(root, {
    type: "page.material-figures",
    factId: factId("page.material-figures", payload),
    at: new Date().toISOString(),
    ...payload,
  });
}

/**
 * Post-write provenance step for a successful strict `write_page`: record the
 * optional declaration, run the figure/period detection, record the fact, and
 * return the combined non-blocking Chinese hint (undefined when silent).
 */
export function applyWritePageProvenance(
  root: string,
  context: RunToolContext,
  revision: PageRevisionRef,
  page: unknown,
  args: Record<string, unknown>,
): string | undefined {
  const declaration = parseProvenanceDeclaration(args.provenance);
  if (declaration) {
    recordPageProvenanceFact(root, context, {
      pageId: revision.pageId,
      revision: revision.revision,
      pageSha256: revision.pageSha256,
      declaration,
      numbersSha256: pageNumbersSha256(page),
    });
  }
  const ledger = readRunLedger(root);
  const periodMap = latestPeriodMap(ledger);
  const readings = sessionMaterialReadings(root, context.contextEpochId, FIGURE_KINDS, {
    templateTables: periodMap !== undefined,
  });
  const pageText = pageTextForFigures(page);
  const report = detectMaterialFigures({
    pageText,
    pageCharts: pageChartsForFigures(page),
    readings,
    ...(periodMap ? { periodMap } : {}),
  });
  // Figure detection stays on documents; table rows only vouch for vision-read values.
  const visionValues = pageVisionValues(root, context.contextEpochId, {
    pageText,
    pageNumbers: pageNumberCellsForFigures(page),
    readings,
    readTableReadings: () => sessionMaterialReadings(root, context.contextEpochId, ["table"]),
  });
  recordMaterialFiguresFact(root, context, {
    pageId: revision.pageId,
    revision: revision.revision,
    matches: report.matches,
    pagePeriods: report.pagePeriods,
    visionValues,
    ...(periodMap ? { periodMap } : {}),
  });
  const computed = checkComputedFigures(root, context, {
    pageText,
    ...(declaration ? { declaration } : {}),
  });
  if (computed.matches.length) {
    recordPageComputedFigures(root, context, {
      pageId: revision.pageId,
      revision: revision.revision,
      matches: computed.matches,
    });
  }
  const hints: string[] = [];
  if (declaration) {
    // Query results join the corpus only once the run has computed something.
    const sources = computed.cells.length ? "已读资料或计算结果" : "已读资料";
    for (const value of missingQuotedValues(declaration, readings, computed.covers)) {
      hints.push(`你标为原样引用的 ${value} 没有出现在${sources}里，请核对或改标为示意。`);
    }
  }
  if (declaration?.basis === "material") {
    const unsupported = unsupportedNumbersHint(
      unsupportedPageNumbers({
        pageNumbers: pageNumberCellsForFigures(page),
        readings: [...readings, ...sessionMaterialReadings(root, context.contextEpochId, ["table"])],
        computedCells: computed.cells.length,
        isComputed: computed.covers,
      }),
    );
    if (unsupported) hints.push(unsupported);
  }
  const figuresHint = materialFiguresHint(
    report,
    readings,
    periodMap
      ? {
          periodMap,
          acknowledged: declaredMissingMatcher(root, context.contextEpochId, latestMissingItems(ledger)),
        }
      : undefined,
  );
  if (figuresHint) hints.push(figuresHint);
  const visionHint = visionValueHint(root, visionValues);
  if (visionHint) hints.push(visionHint);
  const substitutionReceipt = chartSubstitutionReceipt(report.matches);
  if (substitutionReceipt) hints.push(substitutionReceipt);
  if (periodMap) {
    const driftHint = chartKindDriftHint(chartKindDrifts(pageChartsForFigures(page), readings));
    if (driftHint) hints.push(driftHint);
  }
  // A deck template's old figures differ from new data by design, so only files and the brief count.
  const conflictHint = applyPageConflicts(root, context, revision, {
    pageText,
    pageNumbers: pageStatedNumbers(page),
    documents: readings.filter((item) => item.kind === "document" || item.kind === "text"),
    tables: () => sessionMaterialReadings(root, context.contextEpochId, ["table"]),
  });
  if (conflictHint) hints.push(conflictHint);
  return hints.length ? hints.join("\n") : undefined;
}

/**
 * Provenance for a skipped-identical `write_page` (VAL-PROV-008): the page
 * bytes are unchanged, so no new revision exists, but a NEW declaration must
 * still be checked against this epoch's readings and recorded against the
 * CURRENT revision and its page sha256 — never rewriting the page YAML and
 * never minting a revision. An identical retry without a declaration stays
 * silent, so unchanged retries keep today's exact output.
 */
export function applySkippedWritePageProvenance(
  root: string,
  context: RunToolContext,
  revision: PageRevisionRef,
  page: unknown,
  args: Record<string, unknown>,
): string | undefined {
  const declaration = parseProvenanceDeclaration(args.provenance);
  if (!declaration) return undefined;
  const hints = applyWritePageProvenance(root, context, revision, page, args);
  const confirmed = `已记录本页的来源声明（${declaration.basis}）；页面内容未变，仍为第 ${revision.revision} 版。`;
  return hints ? `${confirmed}\n${hints}` : confirmed;
}
