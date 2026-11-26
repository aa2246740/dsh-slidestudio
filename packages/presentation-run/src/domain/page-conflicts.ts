/**
 * Number conflicts at page-write time (CAP-21, VAL-DATA-009). After a strict `write_page`, the
 * figures the run's sources state (documents and text files read this epoch, tables read this
 * epoch, and the brief) are compared with each other. A conflict that matters to the page is one
 * where the page states exactly one of the differing values for that metric (and period, where
 * both name one): the page then records which source's value it used. A page that states both
 * values shows the user the difference itself, and a page that states neither, or states one only
 * under another metric, is not affected. The result is a ledger fact and a non-blocking hint.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BRIEF_SOURCE_NAME,
  conflictValue,
  distinctSourceNames,
  numberConflictLine,
  numberConflictReason,
  type PageNumberConflict,
} from "./delivery-conflicts.js";
import {
  BRIEF_RANK,
  BRIEF_SOURCE_ID,
  DOCUMENT_RANK,
  TABLE_RANK,
  detectNumberConflicts,
  pageStatesValue,
  proseFigures,
  statedNumbers,
  tableFigures,
  type ConflictSource,
  type StatedNumber,
} from "./figure-conflicts.js";
import { readMaterialsManifest } from "./material-pack.js";
import type { MaterialFigureReading } from "./material-figures.js";
import { appendFact, factId, type RunToolContext } from "./run-ledger.js";

/** Most conflicts one hint lists; the recorded fact, the receipt and the card keep their own bounds. */
const MAX_HINT_CONFLICTS = 8;

/** The conflicts the current revision of a page states one side of. */
export type PageConflictsFact = Readonly<{
  type: "page.number-conflicts";
  factId: string;
  at: string;
  contextEpochId: string;
  pageId: string;
  revision: number;
  conflicts: readonly PageNumberConflict[];
}>;

/** The brief the run was started with; absent or unreadable runtime means no brief source. */
function runtimeBrief(root: string): string {
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8")) as {
      brief?: unknown;
    };
    return typeof runtime.brief === "string" ? runtime.brief : "";
  } catch {
    return "";
  }
}

function readingText(reading: MaterialFigureReading): string {
  return reading.pages.map((page) => page.text).join("\n");
}

function conflictSources(
  brief: string,
  documents: readonly MaterialFigureReading[],
  tables: readonly MaterialFigureReading[],
): readonly ConflictSource[] {
  const sources: ConflictSource[] = [];
  const briefFigures = proseFigures(brief);
  if (briefFigures.length) {
    sources.push({
      source: BRIEF_SOURCE_NAME,
      sourceId: BRIEF_SOURCE_ID,
      rank: BRIEF_RANK,
      figures: briefFigures,
    });
  }
  for (const reading of tables) {
    sources.push({
      source: reading.materialName,
      sourceId: reading.materialId,
      rank: TABLE_RANK,
      figures: tableFigures(readingText(reading)),
    });
  }
  for (const reading of documents) {
    sources.push({
      source: reading.materialName,
      sourceId: reading.materialId,
      rank: DOCUMENT_RANK,
      figures: proseFigures(readingText(reading)),
    });
  }
  return sources.filter((source) => source.figures.length);
}

/**
 * Conflicts between the sources that this page takes a side in. Pure: no ledger access.
 * A candidate whose values the page does not state for that metric, or states more than one
 * distinct value of, is left out. Every such conflict is returned; the hint bounds how many it lists.
 * `uploadOrder` is the material ids in upload order, which numbers sources that share a file name.
 * `pageNumbers` are the page's numbers with the labels it keeps outside the clause (table headers,
 * a caption element; see page-stated-numbers.ts); without them the flat `pageText` is read.
 */
export function pageNumberConflicts(input: {
  readonly pageText: string;
  readonly pageNumbers?: readonly StatedNumber[];
  readonly brief: string;
  readonly documents: readonly MaterialFigureReading[];
  readonly tables: readonly MaterialFigureReading[];
  readonly uploadOrder?: readonly string[];
}): readonly PageNumberConflict[] {
  const sources = conflictSources(input.brief, input.documents, input.tables);
  if (sources.length < 2) return [];
  const stated = input.pageNumbers ?? statedNumbers(input.pageText);
  return detectNumberConflicts(sources).flatMap((candidate) => {
    const members = distinctSourceNames(candidate.members, input.uploadOrder ?? []);
    // Two sources can agree with each other; the page then takes the side of the best-ranked one.
    // A number speaks to this candidate when its period fits the member's own (one may state the year,
    // `2025年3月营收`, another not) and the candidate's, so the sides taken and the sides shown are
    // those of this period alone. A candidate is one period of one metric, so it is told at most once.
    const takenSides = members.filter((member) => pageStatesValue(stated, [member.key, candidate.key], member.value));
    if (new Set(takenSides.map((member) => member.value)).size !== 1) return [];
    const used = [...takenSides].sort((left, right) => left.rank - right.rank)[0]!;
    return [
      {
        kind: members.some((member) => member.rank === BRIEF_RANK) ? ("brief" as const) : ("number" as const),
        label: candidate.label,
        values: members.map(conflictValue),
        used: conflictValue(used),
        reason: numberConflictReason(members, used),
      },
    ];
  });
}

/** The non-blocking hint a write carries for the conflicts it takes a side in. */
export function pageConflictHint(conflicts: readonly PageNumberConflict[]): string | undefined {
  if (!conflicts.length) return undefined;
  const lines = conflicts.slice(0, MAX_HINT_CONFLICTS).map(numberConflictLine);
  const hidden = conflicts.length - lines.length;
  if (hidden > 0) lines.push(`另有 ${hidden} 处数字不一致，没有逐条列出`);
  return `提示：${lines.join("；")}。请在交付说明里告诉用户这个差异和用了哪一个。这条提示不阻止保存。`;
}

export function recordPageConflictsFact(
  root: string,
  context: RunToolContext,
  input: { pageId: string; revision: number; conflicts: readonly PageNumberConflict[] },
): void {
  const payload = { ...input, contextEpochId: context.contextEpochId };
  appendFact(root, {
    type: "page.number-conflicts",
    factId: factId("page.number-conflicts", payload),
    at: new Date().toISOString(),
    ...payload,
  });
}

/**
 * Post-write step: find the conflicts this page takes a side in, record them against the page's
 * current revision and return the hint. Silent (undefined) when nothing conflicts.
 */
export function applyPageConflicts(
  root: string,
  context: RunToolContext,
  revision: Readonly<{ pageId: string; revision: number }>,
  input: {
    readonly pageText: string;
    readonly pageNumbers: readonly StatedNumber[];
    readonly documents: readonly MaterialFigureReading[];
    readonly tables: () => readonly MaterialFigureReading[];
  },
): string | undefined {
  const conflicts = pageNumberConflicts({
    pageText: input.pageText,
    pageNumbers: input.pageNumbers,
    brief: runtimeBrief(root),
    documents: input.documents,
    tables: input.tables(),
    uploadOrder: readMaterialsManifest(root).map((entry) => entry.id),
  });
  if (!conflicts.length) return undefined;
  recordPageConflictsFact(root, context, {
    pageId: revision.pageId,
    revision: revision.revision,
    conflicts,
  });
  return pageConflictHint(conflicts);
}
