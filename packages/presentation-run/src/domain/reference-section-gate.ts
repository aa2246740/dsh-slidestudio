/**
 * On-demand PPTD section gate for write_page (sectioned v2 ledgers only).
 *
 * A page that carries chart, table, image, icon, line or animation payload
 * must have the matching pptd.md section read in the current context epoch.
 * v1 ledgers already require the whole file, so the gate is a no-op for them.
 */
import { verifyOpenKimiPack } from "./openkimi-source-pack.js";
import {
  OPENKIMI_SECTIONED_REFERENCE_LAYOUT,
  PPTD_ON_DEMAND_GROUP_IDS,
  sectionGroup,
  type PptdOnDemandGroupId,
} from "./openkimi-pptd-sections.js";
import { isReferenceReadFact } from "./reference-facts.js";
import { readRunLedger, type RunLedgerV1 } from "./run-ledger.js";

export const REFERENCE_SECTION_UNREAD_ERROR = "reference_section_unread";

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

/** Elements may arrive wrapped as `{ item: {...} }`; look through the wrapper. */
function elementRecord(value: unknown, depth = 0): Rec | undefined {
  const rec = asRecord(value);
  if (rec && depth < 6 && Object.keys(rec).length === 1 && "item" in rec) return elementRecord(rec.item, depth + 1);
  return rec;
}

const TYPE_GROUPS: Readonly<Record<string, PptdOnDemandGroupId>> = {
  chart: "chart",
  charts: "chart",
  table: "table",
  image: "image",
  picture: "image",
  photo: "image",
  icon: "icon",
  line: "line",
  connector: "line",
};

function elementGroups(rec: Rec, found: Set<PptdOnDemandGroupId>, depth: number): void {
  if (depth > 8) return;
  const type = String(rec.elementType ?? rec.type ?? "")
    .trim()
    .toLowerCase();
  const byType = TYPE_GROUPS[type];
  if (byType) found.add(byType);
  if (rec.chart != null || rec.chartType != null) found.add("chart");
  if (!type && (rec.rows != null || rec.columnWidths != null || asRecord(rec.table)?.rows != null)) found.add("table");
  if (rec.animation != null || (Array.isArray(rec.animations) && rec.animations.length > 0)) found.add("animation");
  for (const key of ["elements", "children"] as const) {
    const nested = rec[key];
    if (!Array.isArray(nested)) continue;
    for (const child of nested) {
      const childRec = elementRecord(child);
      if (childRec) elementGroups(childRec, found, depth + 1);
    }
  }
}

/** The on-demand pptd.md section groups a write_page payload needs, in a stable order. */
export function pageReferenceSectionGroups(page: unknown): PptdOnDemandGroupId[] {
  const rec = asRecord(page);
  if (!rec) return [];
  const found = new Set<PptdOnDemandGroupId>();
  elementGroups({ elements: rec.elements }, found, 0);
  if (Array.isArray(rec.animations) && rec.animations.length > 0) found.add("animation");
  return PPTD_ON_DEMAND_GROUP_IDS.filter((groupId) => found.has(groupId));
}

export type MissingReferenceSection = Readonly<{
  sectionId: PptdOnDemandGroupId;
  sourceId: string;
  titles: readonly string[];
  byteLength: number;
  chunkIndexes: readonly number[];
}>;

/** Chunks of the named groups not read (or carried) in `contextEpochId` with their current hashes. */
export function missingSectionChunks(
  repoRoot: string,
  ledger: RunLedgerV1,
  groupIds: readonly PptdOnDemandGroupId[],
  contextEpochId: string,
): MissingReferenceSection[] {
  if (!groupIds.length) return [];
  const pack = verifyOpenKimiPack(repoRoot);
  const fileSha256 = pack.entriesById.get("openkimi:reference/pptd.md")?.sha256 ?? "";
  const reads = new Set(
    ledger.facts
      .filter(isReferenceReadFact)
      .filter((fact) => fact.contextEpochId === contextEpochId && fact.fileSha256 === fileSha256)
      .map((fact) => `${fact.sourceId}#${fact.chunkIndex}#${fact.chunkSha256}`),
  );
  return groupIds.flatMap((groupId) => {
    const group = sectionGroup(pack, groupId);
    const chunkIndexes = group.chunks
      .filter((chunk) => !reads.has(`${group.sourceId}#${chunk.index}#${chunk.sha256}`))
      .map((chunk) => chunk.index);
    if (!chunkIndexes.length) return [];
    return [
      {
        sectionId: groupId,
        sourceId: group.sourceId,
        titles: group.titles,
        byteLength: group.byteLength,
        chunkIndexes,
      },
    ];
  });
}

export type ReferenceSectionRefusal = Readonly<{
  ok: false;
  name: string;
  summary: string;
  detail: string;
  payload: Record<string, unknown>;
}>;

/**
 * write_page preflight: refuse a page whose element types need a pptd.md
 * section that is unread in this epoch. Undefined when the page may proceed.
 */
export function writePageReferencePreflight(
  repoRoot: string,
  projectRoot: string,
  page: unknown,
  contextEpochId: string,
  name = "write_page",
): ReferenceSectionRefusal | undefined {
  const ledger = readRunLedger(projectRoot);
  if (ledger?.sourcePack.referenceLayout !== OPENKIMI_SECTIONED_REFERENCE_LAYOUT) return undefined;
  const missing = missingSectionChunks(repoRoot, ledger, pageReferenceSectionGroups(page), contextEpochId);
  if (!missing.length) return undefined;
  const missingReferenceChunks = missing.flatMap((section) =>
    section.chunkIndexes.map((chunkIndex) => ({ sourceId: section.sourceId, chunkIndex })),
  );
  const exact = missingReferenceChunks.map((chunk) => `${chunk.sourceId}#${chunk.chunkIndex}`).join("、");
  return {
    ok: false,
    name,
    summary: "reference sections unread",
    detail:
      `这一页包含 ${missing.map((section) => section.sectionId).join("、")} 元素，` +
      `写入前请先用 read_reference 读完 PPTD 规范对应章节（本轮上下文）：${exact}。页面未保存。`,
    payload: {
      error: REFERENCE_SECTION_UNREAD_ERROR,
      next: "read_reference",
      referencesComplete: false,
      missingReferenceChunks,
      missingReferenceSections: missing.map((section) => ({
        sectionId: section.sectionId,
        sourceId: section.sourceId,
        titles: section.titles,
        byteLength: section.byteLength,
      })),
      painted: false,
    },
  };
}
