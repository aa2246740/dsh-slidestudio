/**
 * The `conflicts` section of `delivery-provenance.v1.json` (CAP-21, VAL-DATA-009/010) and the
 * Chinese lines the receipt summary and the 「资料使用情况」 card print for it.
 *
 * Number conflicts come from `page.number-conflicts` ledger facts the page write recorded; style
 * conflicts are deterministic over the saved design choice (Hub style pack, adopted sources and
 * their declared aspects). Recording a conflict never blocks a write, a commit or a compose.
 */
import { DEFAULT_TEMPLATE_ASPECTS, sourceDesignAspects, type DesignAspect } from "./design-aspects.js";
import { BRIEF_RANK, type ConflictMember, type SourceRank } from "./figure-conflicts.js";
import { readMaterialsManifest } from "./material-pack.js";
import type { PageConflictsFact } from "./page-conflicts.js";
import type { RunLedgerV1 } from "./run-ledger.js";
import { stylePackDisplayName } from "./style-pack-priority.js";
import { canonicalDesignSourceId } from "./theme-pack.js";

/** What the brief is called wherever a conflict names its sources. */
export const BRIEF_SOURCE_NAME = "你的要求";

export type ConflictValue = Readonly<{ source: string; value: string; unit?: string }>;

/** A number two sources (or the brief and a source) state differently. */
export type PageNumberConflict = Readonly<{
  kind: "number" | "brief";
  label: string;
  values: readonly ConflictValue[];
  used: ConflictValue;
  reason: string;
}>;

export type DeliveryNumberConflict = PageNumberConflict &
  Readonly<{
    /** Deck positions (1-based) of the pages that state the used value. */
    pages: readonly number[];
  }>;

export type DeliveryStyleConflict = Readonly<{
  kind: "style";
  /** `style-pack`: the Hub pack beats an attachment; `first-adopted`: the first palette source wins. */
  basis: "style-pack" | "first-adopted";
  detail: string;
  winner: string;
  /** `style-pack` only: the attachment and what it is still used for. */
  attachment?: string;
  uses?: readonly string[];
  /** `first-adopted` only: the palette sources that lost, in adoption order. */
  others?: readonly string[];
}>;

export type DeliveryConflict = DeliveryNumberConflict | DeliveryStyleConflict;

const USE_LABELS: Readonly<Partial<Record<DesignAspect, string>>> = {
  logo: "Logo",
  photos: "照片",
  content: "内容",
  data: "数据",
  layouts: "版式（仅参考）",
};
const USE_ORDER: readonly DesignAspect[] = ["logo", "photos", "content", "data", "layouts"];
const PERMITTED_USES = "Logo / 照片 / 内容 / 数据";

function withUnit(value: ConflictValue): string {
  return value.unit ? `${value.value} ${value.unit}` : value.value;
}

/** Why the used value is the one that counts, from the kinds of sources that disagree. */
export function numberConflictReason(members: readonly ConflictMember[], used: ConflictMember): string {
  if (members.some((member) => member.rank === BRIEF_RANK)) {
    return used.rank === BRIEF_RANK ? "按你的要求写入，资料里的数不同" : "写的是资料里的数，与你的要求不同，请核对";
  }
  const best: SourceRank = Math.min(...members.map((member) => member.rank)) as SourceRank;
  const top = new Set(members.filter((member) => member.rank === best).map((member) => member.sourceId));
  if (top.size > 1) return "几份资料类型相同，系统无法判断哪个更准，请核对";
  return used.rank === best ? "表格数据优先于文档文字" : "写的是文档里的数，与表格数据不同，请核对";
}

/**
 * Members as the user will read them. Two different materials can share a file name (a revised
 * file uploaded again), and 「a.xlsx 为 1，a.xlsx 为 2」 says nothing, so the names that collide within
 * this conflict get their place among the same-named uploads: upload order, the order the card
 * lists materials in, then the order the sources were handed in. Identity stays `sourceId`.
 */
export function distinctSourceNames(
  members: readonly ConflictMember[],
  uploadOrder: readonly string[],
): readonly ConflictMember[] {
  const idsByName = new Map<string, string[]>();
  for (const member of members) {
    const ids = idsByName.get(member.source) ?? [];
    if (!ids.includes(member.sourceId)) ids.push(member.sourceId);
    idsByName.set(member.source, ids);
  }
  const place = (id: string): number => {
    const index = uploadOrder.indexOf(id);
    return index < 0 ? uploadOrder.length : index;
  };
  return members.map((member) => {
    const ids = idsByName.get(member.source)!;
    if (ids.length < 2) return member;
    const ordinal = [...ids].sort((left, right) => place(left) - place(right)).indexOf(member.sourceId);
    return { ...member, source: `${member.source}（同名第 ${ordinal + 1} 份）` };
  });
}

export function conflictValue(member: ConflictMember): ConflictValue {
  return {
    source: member.rank === BRIEF_RANK ? BRIEF_SOURCE_NAME : member.source,
    value: member.token,
    ...(member.unit ? { unit: member.unit } : {}),
  };
}

/** The card line for a number conflict, also the receipt summary entry. */
export function numberConflictLine(conflict: PageNumberConflict): string {
  const values = conflict.values.map((value) => `${value.source} 为 ${withUnit(value)}`).join("，");
  return (
    `数字不一致：『${conflict.label}』${values}；` +
    `本稿采用 ${withUnit(conflict.used)}（来自 ${conflict.used.source}）。${conflict.reason}`
  );
}

/** One or two card lines for a style conflict. */
export function styleConflictLines(conflict: DeliveryStyleConflict): readonly string[] {
  if (conflict.basis === "style-pack") {
    const uses = conflict.uses?.length ? `用于 ${conflict.uses.join(" / ")}` : `可用于 ${PERMITTED_USES}`;
    return [`配色以风格『${conflict.winner}』为准；附件『${conflict.attachment ?? ""}』${uses}`];
  }
  return [
    `配色以『${conflict.winner}』为准`,
    ...(conflict.others ?? []).map((name) => `『${name}』也提供了配色，没有采用`),
  ];
}

export function conflictLines(conflicts: readonly DeliveryConflict[]): readonly string[] {
  return conflicts.flatMap((conflict) =>
    conflict.kind === "style" ? styleConflictLines(conflict) : [numberConflictLine(conflict)],
  );
}

/** The model-facing receipt entries: one per conflict, a style conflict's lines joined. */
export function conflictSummaryTexts(conflicts: readonly DeliveryConflict[]): readonly string[] {
  return conflicts.map((conflict) =>
    conflict.kind === "style" ? styleConflictLines(conflict).join("；") : numberConflictLine(conflict),
  );
}

// ---------------------------------------------------------------------------
// Number conflicts: merge the facts of the sealed pages' current revisions.
// ---------------------------------------------------------------------------

type Merged = { conflict: PageNumberConflict; uses: { position: number; value: string }[] };

function conflictKey(conflict: PageNumberConflict): string {
  const values = conflict.values.map((value) => `${value.source}=${value.value}`).sort();
  return `${conflict.kind}|${conflict.label}|${values.join(",")}`;
}

/**
 * Number conflicts of the sealed deck, in deck order. A page contributes only the fact written for
 * its current revision. When pages disagree on which value to use, the first page's choice is
 * reported and the reason says the deck is inconsistent.
 */
export function numberConflicts(
  ledger: RunLedgerV1,
  orderedPageIds: readonly string[],
): readonly DeliveryNumberConflict[] {
  const revisions = new Map<string, number>();
  const facts = new Map<string, PageConflictsFact>();
  for (const fact of ledger.facts) {
    if (fact.type === "page.revision-committed") revisions.set(fact.pageId, fact.revision);
    if (fact.type === "page.number-conflicts") facts.set(fact.pageId, fact);
  }
  const merged = new Map<string, Merged>();
  orderedPageIds.forEach((pageId, index) => {
    const fact = facts.get(pageId);
    if (!fact || fact.revision !== revisions.get(pageId)) return;
    for (const conflict of fact.conflicts) {
      const key = conflictKey(conflict);
      const entry = merged.get(key) ?? { conflict, uses: [] };
      entry.uses.push({ position: index + 1, value: conflict.used.value });
      merged.set(key, entry);
    }
  });
  return [...merged.values()].map(({ conflict, uses }) => {
    const primary = uses[0]!;
    const same = uses.filter((use) => use.value === primary.value);
    const other = uses.filter((use) => use.value !== primary.value);
    const reason = other.length
      ? `${conflict.reason}；但第 ${other.map((use) => use.position).join("、")} 页写的是另一个数，前后不一致，请核对`
      : conflict.reason;
    return {
      ...conflict,
      reason,
      pages: same.map((use) => use.position),
    };
  });
}

// ---------------------------------------------------------------------------
// Style conflicts: deterministic over the saved design choice.
// ---------------------------------------------------------------------------

export type DesignChoice = Readonly<{
  designSystemId: string | null;
  adoptedSourceIds: readonly string[];
  designAspects: readonly Readonly<{ source: string; aspects: readonly string[] }>[];
}>;

function materialSourceId(id: string): string | undefined {
  const canonical = canonicalDesignSourceId(id);
  return canonical?.startsWith("material:") ? canonical : undefined;
}

/**
 * With a Hub style pack, every attached deck template loses its palette to the pack. Without one,
 * several adopted palette sources lose to the first adopted (the rule `commitAdoptedDesignSources`
 * seeds the theme by). No attachment and no second palette source means no entry.
 */
export function styleConflicts(root: string, design: DesignChoice): readonly DeliveryStyleConflict[] {
  const manifest = readMaterialsManifest(root);
  if (design.designSystemId) {
    const pack = stylePackDisplayName(design.designSystemId);
    return manifest
      .filter((entry) => entry.kind === "deck-template")
      .map((entry) => {
        const declared = sourceDesignAspects(design.designAspects, `material:${entry.id}`);
        const uses = USE_ORDER.filter((aspect) => declared.includes(aspect)).map((aspect) => USE_LABELS[aspect]!);
        return {
          kind: "style" as const,
          basis: "style-pack" as const,
          detail: `首页选了风格「${pack}」，附件「${entry.name}」的配色没有采用`,
          winner: pack,
          attachment: entry.name,
          uses,
        };
      });
  }
  const byId = new Map(manifest.map((entry) => [`material:${entry.id}`, entry]));
  const palette = [...new Set(design.adoptedSourceIds.map(materialSourceId).filter((id) => id !== undefined))].flatMap(
    (id) => {
      const entry = byId.get(id);
      if (!entry) return [];
      const fallback = entry.kind === "deck-template" ? DEFAULT_TEMPLATE_ASPECTS : [];
      return sourceDesignAspects(design.designAspects, id, fallback).includes("palette") ? [entry.name] : [];
    },
  );
  if (palette.length < 2) return [];
  const [winner, ...others] = palette as [string, ...string[]];
  return [
    {
      kind: "style",
      basis: "first-adopted",
      detail: `配色来源有 ${palette.length} 个：${palette.join("、")}；以最先采用的「${winner}」为准`,
      winner,
      others,
    },
  ];
}
