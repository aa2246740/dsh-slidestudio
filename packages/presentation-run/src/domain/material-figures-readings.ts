/**
 * Rebuild the current epoch's receipt-checked material reads for figure detection.
 */
import { readMaterialChunkWithFacts } from "./material-content.js";
import { extractPeriodLabels } from "./material-periods.js";
import { verifyMaterial, type MaterialKind, type MaterialReadResult } from "./material-pack.js";
import { PALETTE_PART } from "./palette-source.js";
import { readRunLedger, type MaterialChunkFact } from "./run-ledger.js";
import { readTemplateChartSources } from "./template-chart-provenance.js";
import { splitChunkPages, type MaterialFigureReading } from "./material-figures.js";

// Session reads: re-derive this epoch's read chunk texts from the ledger.
// ---------------------------------------------------------------------------

/** Material kinds whose reads feed figure detection; table rows join it with M7. */
export const FIGURE_KINDS: readonly MaterialKind[] = ["document", "text", "deck-template"];

/**
 * Rebuild material reads in the current context epoch. Every relevant chunk
 * is re-read from the receipt-verified material and sha-checked against its
 * `material.chunk-returned` fact; template charts require every charts chunk
 * to be present. A mismatched or unreadable material contributes nothing
 * (fail closed, and never a write blocker).
 */
function absorbVerifiedChunk(
  material: ReturnType<typeof verifyMaterial>,
  fact: MaterialChunkFact,
  options: Readonly<{ tableCellsOnly?: boolean }>,
  seenChunks: Set<string>,
  pageTexts: Map<number, string>,
): void {
  const chunkKey =
    fact.rowStart !== undefined && fact.rowEnd !== undefined
      ? `${fact.part}:${fact.rowStart}-${fact.rowEnd}`
      : `${fact.part}:${fact.chunkIndex}`;
  if (seenChunks.has(chunkKey)) return;
  seenChunks.add(chunkKey);
  let read: MaterialReadResult;
  let factText: string | undefined;
  try {
    ({ read, factText } = readMaterialChunkWithFacts({
      material,
      part: fact.part,
      ...(fact.rowStart !== undefined && fact.rowEnd !== undefined
        ? { offset: fact.rowStart - 1, limit: fact.rowEnd - fact.rowStart + 1 }
        : { offset: fact.chunkIndex }),
    }));
  } catch {
    return;
  }
  if (read.chunkSha256 !== fact.chunkSha256) return;
  // Table windows render a title, a count line and row numbers around the cells. Report
  // facts take the parsed cells of the receipt-verified window instead of the rendering.
  const chunkText = options.tableCellsOnly && factText !== undefined ? factText : read.text;
  // Document chunks cut at byte boundaries: text before the first page
  // heading continues `pageRange.start` — it is that page's body, not
  // unpaged content (VAL-PROV-007).
  const continuationPage = read.pageRange?.start;
  for (const page of splitChunkPages(chunkText)) {
    const target = page.page === 0 && continuationPage !== undefined ? continuationPage : page.page;
    const existing = pageTexts.get(target);
    pageTexts.set(target, existing ? `${existing}\n${page.text}` : page.text);
  }
}

export function sessionMaterialReadings(
  root: string,
  contextEpochId: string,
  kinds: readonly MaterialKind[] = FIGURE_KINDS,
  options: Readonly<{ templateTables?: boolean; tableCellsOnly?: boolean }> = {},
): readonly MaterialFigureReading[] {
  const ledger = readRunLedger(root);
  if (!ledger) return [];
  const factsByMaterial = new Map<string, MaterialChunkFact[]>();
  for (const fact of ledger.facts) {
    if (fact.type !== "material.chunk-returned") continue;
    if (fact.contextEpochId !== contextEpochId) continue;
    const list = factsByMaterial.get(fact.materialId) ?? [];
    list.push(fact);
    factsByMaterial.set(fact.materialId, list);
  }
  const readings: MaterialFigureReading[] = [];
  for (const [materialId, facts] of factsByMaterial) {
    let material: ReturnType<typeof verifyMaterial>;
    try {
      material = verifyMaterial(root, materialId);
    } catch {
      continue;
    }
    if (!kinds.includes(material.kind)) continue;
    // The palette part carries measured colours, not document figures. A template's table cells
    // join its slide text only for a monthly update, which has to see last month's tables.
    const pageFacts =
      material.kind === "deck-template"
        ? facts.filter((fact) => fact.part === "slides" || (options.templateTables === true && fact.part === "tables"))
        : facts.filter((fact) => fact.part !== PALETTE_PART);
    const seenChunks = new Set<string>();
    const pageTexts = new Map<number, string>();
    for (const fact of pageFacts) absorbVerifiedChunk(material, fact, options, seenChunks, pageTexts);
    const pages = [...pageTexts.entries()]
      .map(([page, text]) => ({ page, text }))
      .sort((left, right) => left.page - right.page);
    const templateCharts =
      material.kind === "deck-template" ? readTemplateChartSources(material, facts, pages, extractPeriodLabels) : [];
    if (!pages.length && !templateCharts.length) continue;
    readings.push({
      materialId,
      materialName: material.name,
      kind: material.kind,
      pages,
      ...(templateCharts.length ? { templateCharts } : {}),
    });
  }
  return readings;
}
