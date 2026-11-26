/**
 * The charts and tables of the attached PPT templates, as a plan may name them. An item is
 * `verified` only after every chunk of its part (charts, tables) was read in the current epoch and
 * still re-hashes to its receipt; the item's page, title and id come from the sha-verified
 * derivative, never from the agent's words.
 */
import { readMaterialsManifest, verifyMaterial, type VerifiedMaterial } from "./material-pack.js";
import { partChunkReceiptsValid } from "./template-part-receipts.js";
import { readRunLedger, type MaterialChunkFact } from "./run-ledger.js";

export type TemplateItemKind = "chart" | "table";

export type TemplateItem = Readonly<{
  materialId: string;
  materialName: string;
  kind: TemplateItemKind;
  sourcePage: number;
  itemId: string;
  /** What the card and the receipts call the item: its own title, else its slide's title, else its id. */
  title: string;
  /** Every spelling an agent may use for it, as listed in the charts and tables parts. */
  names: readonly string[];
  verified: boolean;
  /** The text of a table's cells, one cell per line; absent for a chart. */
  cellText?: string;
}>;

type RecordValue = Record<string, unknown>;

function records(value: unknown): RecordValue[] {
  return Array.isArray(value)
    ? value.filter((item): item is RecordValue => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Case, width and spacing never decide whether two titles are the same. */
export function normalizeItemName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function tableCellText(record: RecordValue): string {
  const cells = (Array.isArray(record.rows) ? record.rows : []).flatMap((row: unknown) =>
    Array.isArray(row) ? row : [],
  );
  return cells
    .map((cell: unknown) => (typeof cell === "string" ? cell : text(records([cell])[0]?.text)))
    .filter(Boolean)
    .join("\n");
}

function slideOf(record: RecordValue): number {
  return Number(record.slide ?? record.page ?? record.index);
}

function itemsOf(material: VerifiedMaterial, facts: readonly MaterialChunkFact[]): TemplateItem[] {
  const template = records([material.derivative["deck-template"]])[0] ?? {};
  const detail = records([template.templateDetail])[0] ?? {};
  const slides = records(detail.slides).length ? records(detail.slides) : records(template.slides);
  const slideTitle = (page: number): string =>
    text(slides.find((slide) => Number(slide.index ?? slide.slide) === page)?.title);
  const chartsRead = partChunkReceiptsValid(material, facts, "charts");
  const tablesRead = partChunkReceiptsValid(material, facts, "tables");
  const build = (kind: TemplateItemKind, record: RecordValue, index: number, verified: boolean): TemplateItem[] => {
    const sourcePage = slideOf(record);
    if (!Number.isSafeInteger(sourcePage) || sourcePage <= 0) return [];
    const itemId = text(record.id) || `${kind}-${index + 1}`;
    const own = kind === "chart" ? text(record.title) || text(record.name) : "";
    const onSlide = slideTitle(sourcePage);
    const title = own || onSlide || itemId;
    return [
      {
        materialId: material.id,
        materialName: material.name,
        kind,
        sourcePage,
        itemId,
        title,
        names: [...new Set([own, onSlide, itemId].filter(Boolean))],
        verified,
        ...(kind === "table" ? { cellText: tableCellText(record) } : {}),
      },
    ];
  };
  return [
    ...records(detail.charts).flatMap((chart, index) => build("chart", chart, index, chartsRead)),
    ...records(detail.tables).flatMap((table, index) => build("table", table, index, tablesRead)),
  ];
}

/** Every chart and table of every attached deck template, with whether this epoch has read it. */
export function readTemplateItems(root: string, contextEpochId: string): readonly TemplateItem[] {
  const facts = new Map<string, MaterialChunkFact[]>();
  for (const fact of readRunLedger(root)?.facts ?? []) {
    if (fact.type !== "material.chunk-returned" || fact.contextEpochId !== contextEpochId) continue;
    const list = facts.get(fact.materialId) ?? [];
    list.push(fact);
    facts.set(fact.materialId, list);
  }
  return readMaterialsManifest(root).flatMap((entry) => {
    if (entry.kind !== "deck-template") return [];
    try {
      return itemsOf(verifyMaterial(root, entry.id), facts.get(entry.id) ?? []);
    } catch {
      return [];
    }
  });
}
