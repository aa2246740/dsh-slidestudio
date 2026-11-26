/**
 * Delivery provenance (plan §4.9, VAL-PROV-009/010).
 *
 * After a successful strict `compose_deck` the Host writes
 * `_agent/delivery-provenance.v1.json` — the source of record the system
 * 「资料使用情况」 card renders. Every value is derived from recorded facts
 * only: the run ledger (chunk reads, page revisions, provenance declarations,
 * figure detections, compose seal), `_agent/runtime.json` (design system and
 * adopted sources), `_agent/outline.json` or the committed todo fact (page
 * titles and order), and the materialized materials manifest with
 * sha-verified derivatives. Nothing is inferred from page bodies, and the
 * file is never replayed into the assistant conversation. The compose
 * receipt carries only a ≤1.5 KiB Chinese summary.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProvenanceDeclaration } from "@open-slidestudio/pptd-v2";
import { imageDispositions, unusedImageWarnings, type DeliveryImage } from "./image-placement.js";
import { deliveryComponents, withComponentRefs, type DeliveryComponent } from "./delivery-components.js";
import { dataSummaryTexts, deliveryData, type DeliveryData } from "./delivery-data.js";
import { conflictSummaryTexts, numberConflicts, styleConflicts, type DeliveryConflict } from "./delivery-conflicts.js";
import { deliveryLayouts, type DeliveryLayout } from "./delivery-layouts.js";
import { type ConvertedOrigin } from "./delivery-converted.js";
import { type DesignAuthority } from "./design-authority.js";
import { effectivePeriods } from "./period-map.js";
import { computedFiguresByPage, pageQueryProvenance } from "./delivery-queries.js";
import { readMaterialChunk } from "./material-content.js";
import { splitChunkPages } from "./material-figures.js";
import { verifyMaterial, type MaterialKind } from "./material-pack.js";
import { parseCanonicalPagePlan, type CanonicalPlanPage } from "./page-plan.js";
import {
  chartSubstitutionNote,
  chartSubstitutionsForPage,
  type ChartSubstitutionDetail,
} from "./template-chart-provenance.js";
import {
  readRunLedger,
  type DeckComposedFact,
  type MaterialChunkFact,
  type MaterialFiguresFact,
  type PageProvenanceFact,
  type RunLedgerV1,
} from "./run-ledger.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { type UserColor } from "./user-colors.js";
import type { VisionValue } from "./vision-values.js";
import { designSection, materialEntries } from "./delivery-provenance-sections.js";

export const DELIVERY_PROVENANCE_REL = path.join("_agent", "delivery-provenance.v1.json");

/** The compose receipt may spend at most 1.5 KiB on the provenance summary. */
export const PROVENANCE_SUMMARY_MAX_BYTES = 1536;

export type DeliveryMaterialProvenance = Readonly<{
  id: string;
  name: string;
  kind: MaterialKind;
  chunksRead: number;
  chunkCount: number | null;
  pagesCovered: string | null;
  lowTextPages: readonly number[];
  /** Subset of lowTextPages whose embedded images cover the page (「主要是图片」). */
  imagePages?: readonly number[];
  /** Subset of lowTextPages measured without page images (「几乎没有文字」). */
  blankPages?: readonly number[];
  use: readonly string[];
  pagesTotal?: number;
}> &
  Partial<ConvertedOrigin>;

export type DeliveryPageDetection = Readonly<{
  quotedCount: number;
  sourcePages: readonly number[];
  /** `sourcePages` names the template pages behind the mismatch; written only under a period map. */
  periodMismatch: Readonly<{
    page: string;
    source: readonly string[];
    sourcePages?: readonly number[];
  }> | null;
  chartSubstitutions?: readonly ChartSubstitutionDetail[];
}>;

export type DeliveryPageProvenance = Readonly<{
  pageId: string;
  title: string;
  declared: ProvenanceDeclaration | null;
  detected: DeliveryPageDetection | null;
  /** Numbers the page states that came from an image and no read file (「请核对」). */
  visionValues: readonly VisionValue[];
  queries: readonly string[];
  /** Numbers on the page that equal cells of a query result; omitted when none. */
  computedFigureCount?: number;
}>;

export type DeliveryProvenance = Readonly<{
  schema: "delivery-provenance/v1";
  contextEpochId: string;
  deckSha256: string;
  materials: readonly DeliveryMaterialProvenance[];
  design: Readonly<{
    stylePriority: "hub-pack" | "attachments" | "agent";
    designSystemId: string | null;
    /** Present only when a later decision replaced the Hub choice. */
    designAuthority?: DesignAuthority;
    /** The original Hub pack, kept as history beside the effective decision. */
    hubDesignSystemId?: string | null;
    adoptedSourceIds: readonly string[];
    designAspects: readonly Readonly<{ source: string; aspects: readonly string[] }>[];
    /** Colours the user stated, as the Agent declared them; they add to every palette restriction. */
    userColors: readonly UserColor[];
    /** Template components the sealed deck reuses, from `template.component-used` facts only. */
    components: readonly DeliveryComponent[];
    styleHintsUsed: readonly string[];
  }>;
  images: readonly DeliveryImage[];
  pages: readonly DeliveryPageProvenance[];
  data: DeliveryData;
  conflicts: readonly DeliveryConflict[];
  layouts: readonly DeliveryLayout[];
}>;

export function chunkKeyOf(fact: MaterialChunkFact): string {
  const part = fact.part ?? "";
  return fact.rowStart !== undefined && fact.rowEnd !== undefined
    ? `${part}:${fact.rowStart}-${fact.rowEnd}`
    : `${part}:${fact.chunkIndex}`;
}

function plannedPages(root: string): readonly CanonicalPlanPage[] {
  try {
    const outline = JSON.parse(fs.readFileSync(path.join(root, "_agent", "outline.json"), "utf8")) as {
      items?: unknown;
    };
    return parseCanonicalPagePlan(outline.items);
  } catch {
    // Fall through to the committed todo fact.
  }
  try {
    const todo = readRunLedger(root)
      ?.facts.filter((fact) => fact.type === "todo.committed")
      .at(-1);
    return parseCanonicalPagePlan((todo as { pagePlan?: unknown } | undefined)?.pagePlan);
  } catch {
    return [];
  }
}

/** Compact page ranges, e.g. `1–11、13–29`; empty input yields null. */
function compactRanges(pages: readonly number[]): string | null {
  const sorted = [...new Set(pages)]
    .filter((page) => Number.isSafeInteger(page) && page > 0)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const parts: string[] = [];
  let start = sorted[0]!;
  let end = start;
  for (const page of sorted.slice(1)) {
    if (page === end + 1) {
      end = page;
      continue;
    }
    parts.push(start === end ? `${start}` : `${start}–${end}`);
    start = page;
    end = page;
  }
  parts.push(start === end ? `${start}` : `${start}–${end}`);
  return parts.join("、");
}

/**
 * Re-read the sha-verified chunks recorded for a material and report which
 * source pages they covered. A chunk whose bytes no longer hash to its
 * `material.chunk-returned` fact contributes nothing (fail closed).
 */
export function pageCoverage(
  material: ReturnType<typeof verifyMaterial>,
  facts: readonly MaterialChunkFact[],
): string | null {
  if (material.kind !== "document" && material.kind !== "text") return null;
  const pages = new Set<number>();
  const seen = new Set<string>();
  for (const fact of facts) {
    const key = chunkKeyOf(fact);
    if (seen.has(key)) continue;
    if (fact.rowStart !== undefined) continue; // Table windows never carry pages.
    seen.add(key);
    let read: ReturnType<typeof readMaterialChunk>;
    try {
      read = readMaterialChunk({
        material,
        part: fact.part,
        offset: fact.chunkIndex,
      });
    } catch {
      continue;
    }
    if (read.chunkSha256 !== fact.chunkSha256) continue;
    const range = read.pageRange;
    if (range) {
      // PDF chunks cut at byte boundaries: the chunk's recorded page range is
      // its sha-verified coverage, including the page it continues (SCR-005);
      // heading-only splitting would drop that page or null the whole range.
      for (let page = range.start; page <= range.end; page += 1) pages.add(page);
      continue;
    }
    for (const page of splitChunkPages(read.text)) {
      if (page.page > 0) pages.add(page.page);
    }
  }
  return compactRanges([...pages]);
}

function periodMismatchOf(fact: MaterialFiguresFact): DeliveryPageDetection["periodMismatch"] {
  // A fact written under a period map reads unlabelled text as the map's period, as the hint did.
  const pagePeriods = effectivePeriods(fact.pagePeriods, fact.periodMap, "page");
  if (!pagePeriods.length) return null;
  const targets = new Map<string, { page: number; periods: Set<string> }>();
  for (const match of fact.matches) {
    const key = `${match.materialId}#${match.sourcePage}`;
    const target = targets.get(key) ?? { page: match.sourcePage, periods: new Set<string>() };
    for (const period of match.sourcePeriods) target.periods.add(period);
    targets.set(key, target);
  }
  const source: string[] = [];
  const sourcePages: number[] = [];
  for (const target of targets.values()) {
    const periods = effectivePeriods([...target.periods], fact.periodMap, "source");
    if (!periods.length) continue;
    if (periods.some((period) => pagePeriods.includes(period))) continue;
    for (const period of periods) {
      if (!source.includes(period)) source.push(period);
    }
    if (!sourcePages.includes(target.page)) sourcePages.push(target.page);
  }
  if (!source.length) return null;
  return {
    page: pagePeriods.join("、"),
    source,
    ...(fact.periodMap ? { sourcePages: sourcePages.sort((left, right) => left - right) } : {}),
  };
}

function pageEntries(root: string, fact: DeckComposedFact, ledger: RunLedgerV1): readonly DeliveryPageProvenance[] {
  const planned = plannedPages(root);
  const titles = new Map(planned.map((page) => [page.pageId, page.title]));
  const plannedIds = new Set(planned.map((page) => page.pageId));
  const sealed = fact.pageRevisions;
  const ordered = [
    ...planned.map((page) => page.pageId).filter((pageId) => pageId in sealed),
    ...Object.keys(sealed).filter((pageId) => !plannedIds.has(pageId)),
  ];
  const revisions = new Map<string, number>();
  const declarations = new Map<string, PageProvenanceFact>();
  const detections = new Map<string, MaterialFiguresFact>();
  const computed = computedFiguresByPage(ledger);
  for (const entry of ledger.facts) {
    if (entry.type === "page.revision-committed") revisions.set(entry.pageId, entry.revision);
    if (entry.type === "page.provenance-declared") declarations.set(entry.pageId, entry);
    if (entry.type === "page.material-figures") detections.set(entry.pageId, entry);
  }
  return ordered.map((pageId) => {
    const revision = revisions.get(pageId);
    const declaredFact = declarations.get(pageId);
    const detectedFact = detections.get(pageId);
    const declared =
      declaredFact && revision !== undefined && declaredFact.revision === revision ? declaredFact.declaration : null;
    const figures =
      detectedFact && revision !== undefined && detectedFact.revision === revision ? detectedFact : undefined;
    const chartSubstitutions = figures ? chartSubstitutionsForPage(figures.matches) : [];
    const detected: DeliveryPageDetection | null =
      figures && figures.matches.length
        ? {
            // One value matching several source pages is still ONE quoted figure
            // (SCR-008); every real source page stays listed.
            quotedCount: new Set(figures.matches.map((match) => match.value)).size,
            sourcePages: [...new Set(figures.matches.map((match) => match.sourcePage))].sort(
              (left, right) => left - right,
            ),
            periodMismatch: periodMismatchOf(figures),
            ...(chartSubstitutions.length ? { chartSubstitutions } : {}),
          }
        : null;
    const traced = pageQueryProvenance(computed.get(pageId), revision);
    return {
      pageId,
      title: titles.get(pageId) ?? pageId,
      declared,
      detected,
      visionValues: figures?.visionValues ?? [],
      queries: traced.queries,
      ...(traced.computedFigureCount ? { computedFigureCount: traced.computedFigureCount } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Model-facing summary (≤1.5 KiB, Chinese, per page).
// ---------------------------------------------------------------------------

type SummaryEntry = Readonly<{ text: string; pages: readonly number[] }>;

function summaryEntries(provenance: DeliveryProvenance): readonly SummaryEntry[] {
  const entries: SummaryEntry[] = [];
  const mock: number[] = [];
  const mixed: number[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const range = compactRanges(run) ?? `${run[0]}`;
    entries.push({ text: `第 ${range} 页：未说明来源，未检测到资料数字`, pages: run });
    run = [];
  };
  provenance.pages.forEach((page, index) => {
    const position = index + 1;
    if (page.declared?.basis === "mock") mock.push(position);
    if (page.declared?.basis === "mixed") mixed.push(position);
    const computedNote = page.computedFigureCount
      ? `${page.computedFigureCount} 个数字来自表格计算（查询资料数据）`
      : "";
    if (page.detected) {
      flush();
      const mismatch = page.detected.periodMismatch ? "，期间不同" : "";
      const zeroSource = page.detected.sourcePages.includes(0);
      const source = zeroSource ? "资料正文" : `第 ${page.detected.sourcePages.join("、")} 页`;
      const substitutionNote = chartSubstitutionNote(page.detected.chartSubstitutions ?? []);
      entries.push({
        text: `第 ${position} 页：${page.detected.quotedCount} 个数字与资料${source}一致${mismatch}${
          substitutionNote ? `；${substitutionNote}` : ""
        }${computedNote ? `；${computedNote}` : ""}`,
        pages: [position],
      });
    } else if (computedNote) {
      flush();
      entries.push({ text: `第 ${position} 页：${computedNote}`, pages: [position] });
    } else if (!page.declared) {
      run.push(position);
    } else {
      flush();
    }
  });
  flush();
  const declarations: SummaryEntry[] = [];
  if (mock.length) declarations.push({ text: `标为示意数据的页：第 ${compactRanges(mock)} 页`, pages: mock });
  if (mixed.length) declarations.push({ text: `标为部分示意的页：第 ${compactRanges(mixed)} 页`, pages: mixed });
  for (const text of dataSummaryTexts(provenance.data)) declarations.push({ text, pages: [] });
  for (const text of conflictSummaryTexts(provenance.conflicts)) declarations.push({ text, pages: [] });
  // Declarations survive before detection detail when the receipt is bounded.
  return [...declarations, ...entries];
}

/** Greedily keep entries; pages dropped from the tail become `等 N 页`. */
function boundSummary(entries: readonly SummaryEntry[]): string {
  const render = (kept: readonly SummaryEntry[]) => {
    // A retained declaration does not mean its omitted detection detail was shown.
    const omitted = new Set(entries.slice(kept.length).flatMap((entry) => [...entry.pages])).size;
    const body = kept.map((entry) => entry.text).join("；");
    return omitted > 0 ? (body ? `${body}；等 ${omitted} 页` : `等 ${omitted} 页`) : body;
  };
  let kept = [...entries];
  while (kept.length && Buffer.byteLength(JSON.stringify(render(kept)), "utf8") > PROVENANCE_SUMMARY_MAX_BYTES) {
    kept = kept.slice(0, -1);
  }
  return render(kept);
}

// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------

/** Build the provenance document and its receipt summary from recorded facts only. */
export function buildDeliveryProvenance(
  root: string,
  fact: DeckComposedFact,
): {
  file: DeliveryProvenance;
  summary: string;
  warnings: readonly string[];
} {
  const ledger = readRunLedger(root);
  if (!ledger) throw new Error("run ledger is not initialized");
  const design = designSection(root);
  const materials = materialEntries(root, ledger, design.adoptedSourceIds);
  const images = imageDispositions(root, ledger, design);
  const pages = pageEntries(root, fact, ledger);
  const layouts = deliveryLayouts(root);
  const components = deliveryComponents(
    ledger,
    pages.map((page) => page.pageId),
    layouts.map((layout) => layout.id),
  );
  const file: DeliveryProvenance = {
    schema: "delivery-provenance/v1",
    contextEpochId: fact.contextEpochId,
    deckSha256: fact.deckSha256,
    materials,
    design: { ...design, components },
    images,
    pages,
    data: deliveryData(ledger),
    conflicts: [
      ...styleConflicts(root, design),
      ...numberConflicts(
        ledger,
        pages.map((page) => page.pageId),
      ),
    ],
    layouts: withComponentRefs(layouts, components),
  };
  // The receipt summary only exists when materials were actually read this
  // run; otherwise the receipt keeps its exact pre-M2 shape.
  const summary =
    materials.some((material) => material.chunksRead > 0) || pages.some((page) => page.computedFigureCount)
      ? boundSummary(summaryEntries(file))
      : "";
  return { file, summary, warnings: unusedImageWarnings(images) };
}

/**
 * Write `_agent/delivery-provenance.v1.json` after a successful compose and
 * return the ≤1.5 KiB receipt summary. Provenance is metadata: any failure
 * here leaves the sealed compose untouched and returns undefined, so the
 * card falls back to the ledger-only delivery summary.
 */
export function writeDeliveryProvenance(
  root: string,
  fact: DeckComposedFact,
): { summary: string; warnings: readonly string[] } | undefined {
  try {
    const built = buildDeliveryProvenance(root, fact);
    writeJsonAtomic(path.join(root, DELIVERY_PROVENANCE_REL), built.file);
    return { summary: built.summary, warnings: built.warnings };
  } catch {
    return undefined;
  }
}
