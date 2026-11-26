import fs from "node:fs";
import path from "node:path";
import { convertedOriginOf } from "./delivery-converted.js";
import { queriedMaterialIds } from "./delivery-queries.js";
import { provenanceDesignSource } from "./design-authority.js";
import { readMaterialsManifest, verifyMaterial } from "./material-pack.js";
import { PALETTE_PART } from "./palette-source.js";
import { type MaterialChunkFact, type RunLedgerV1 } from "./run-ledger.js";
import { readUserColors } from "./user-colors.js";
import {
  chunkKeyOf,
  pageCoverage,
  type DeliveryMaterialProvenance,
  type DeliveryProvenance,
} from "./delivery-provenance.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function documentOf(derivative: unknown): Record<string, unknown> {
  return isRecord(derivative) && isRecord(derivative.document) ? derivative.document : {};
}

export function materialEntries(
  root: string,
  ledger: RunLedgerV1,
  adoptedSourceIds: readonly string[],
): readonly DeliveryMaterialProvenance[] {
  const factsByMaterial = new Map<string, MaterialChunkFact[]>();
  for (const fact of ledger.facts) {
    // Palette reads measure colours; they are not reading coverage of the material's content.
    if (fact.type !== "material.chunk-returned" || fact.part === PALETTE_PART) continue;
    const list = factsByMaterial.get(fact.materialId) ?? [];
    list.push(fact);
    factsByMaterial.set(fact.materialId, list);
  }
  const queried = queriedMaterialIds(ledger);
  return readMaterialsManifest(root).map((entry) => {
    const facts = factsByMaterial.get(entry.id) ?? [];
    const chunksRead = new Set(facts.map((fact) => chunkKeyOf(fact))).size;
    let chunkCount: number | null = null;
    for (const fact of facts) {
      if (typeof fact.chunkCount === "number") {
        chunkCount = Math.max(chunkCount ?? 0, fact.chunkCount);
      }
    }
    let material: ReturnType<typeof verifyMaterial> | undefined;
    try {
      material = verifyMaterial(root, entry.id);
    } catch {
      material = undefined;
    }
    const document = documentOf(material?.derivative);
    const rawPages = Array.isArray(document.pages) ? document.pages : [];
    const lowTextRecords = rawPages.map((page) => (isRecord(page) ? page : {})).filter((page) => page.lowText === true);
    const lowTextPages = lowTextRecords
      .map((page) => page.index)
      .filter((index): index is number => typeof index === "number");
    const imagePages = lowTextRecords
      .filter((page) => page.hasImage === true)
      .map((page) => page.index)
      .filter((index): index is number => typeof index === "number");
    const blankPages = lowTextRecords
      .filter((page) => page.hasImage === false)
      .map((page) => page.index)
      .filter((index): index is number => typeof index === "number");
    const use: string[] = [];
    if (chunksRead > 0) use.push("content");
    if (document.styleProfile !== undefined) use.push("style-hint");
    if (adoptedSourceIds.includes(`material:${entry.id}`)) use.push("design-source");
    if (queried.has(entry.id)) use.push("computed");
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      chunksRead,
      chunkCount,
      pagesCovered: material ? pageCoverage(material, facts) : null,
      lowTextPages,
      ...(imagePages.length ? { imagePages } : {}),
      ...(blankPages.length ? { blankPages } : {}),
      use,
      ...(typeof document.pageCount === "number" ? { pagesTotal: document.pageCount } : {}),
      ...convertedOriginOf(material?.derivative),
    };
  });
}

export function designSection(root: string): DeliveryProvenance["design"] {
  let runtime: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8")) as unknown;
    if (isRecord(parsed)) runtime = parsed;
  } catch {
    // Legacy or missing runtime: the design section stays empty.
  }
  const { designSystemId, hubDesignSystemId, authority } = provenanceDesignSource(root);
  const adoptedSourceIds = Array.isArray(runtime.adoptedSourceIds)
    ? runtime.adoptedSourceIds.filter((value): value is string => typeof value === "string")
    : [];
  const designAspects = Array.isArray(runtime.designAspects)
    ? runtime.designAspects.flatMap((value) => {
        if (!isRecord(value) || typeof value.source !== "string" || !Array.isArray(value.aspects)) {
          return [];
        }
        return [
          {
            source: value.source,
            aspects: value.aspects.filter((aspect): aspect is string => typeof aspect === "string"),
          },
        ];
      })
    : isRecord(runtime.designAspects)
      ? Object.entries(runtime.designAspects).flatMap(([source, aspects]) =>
          Array.isArray(aspects)
            ? [
                {
                  source,
                  aspects: aspects.filter((aspect): aspect is string => typeof aspect === "string"),
                },
              ]
            : [],
        )
      : [];
  return {
    stylePriority: authority
      ? designSystemId
        ? "hub-pack"
        : "attachments"
      : designSystemId
        ? "hub-pack"
        : adoptedSourceIds.length
          ? "attachments"
          : "agent",
    designSystemId,
    ...(authority ? { designAuthority: authority, hubDesignSystemId } : {}),
    adoptedSourceIds,
    designAspects,
    userColors: readUserColors(root),
    components: [],
    styleHintsUsed: [],
  };
}
