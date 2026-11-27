/**
 * Deduplicated design-system directory with compact selection cards.
 *
 * The pinned pack ships several design systems twice: a canonical
 * `<family>/<slug>/design.md` and a numbered English guide whose slug (or a
 * documented Hub alias) names the same pack. Each canonical pack is listed
 * once here; its aliases are named on it. A card is a short excerpt taken
 * verbatim-in-order from the source (palette hexes, the style signature and
 * the positioning sentence, clipped), so a model can choose a style without
 * reading several 15–25 KB documents first.
 */
import { createHash } from "node:crypto";
import {
  readOpenKimiSource,
  verifyOpenKimiPack,
  type SourceManifestEntry,
  type VerifiedOpenKimiPack,
} from "./domain/openkimi-source-pack.js";
import { parseThemePackId } from "./domain/theme-pack.js";
import { resolveRepoRoot } from "./catalog.js";

export type DesignSystemCard = Readonly<{
  /** Canonical pack id, e.g. `consulting/pine-green-strategy`. */
  id: string;
  /** The document to read_reference / adopt for this pack. */
  sourceId: string;
  /** Up to five palette hexes, in the order the source declares them. */
  palette: readonly string[];
  tone: string;
  fit: string;
  /** Other ids that resolve to this same pack (numbered guides, Hub slugs). */
  aliases: readonly string[];
  aliasSourceIds: readonly string[];
  /** One compact line: palette · tone · fit. */
  card: string;
}>;

const CANONICAL = /^reference\/design_system\/([a-z0-9-]+)\/([a-z0-9-]+)\/design\.md$/;
const NUMBERED = /^reference\/design_system\/\d{2}_[^/]+\/\d{2}\/en\/([a-z0-9-]+)\.md$/;
const HEX = /#[0-9A-Fa-f]{6}\b/g;
const PALETTE_LIMIT = 5;
const TONE_CHARS = 80;
const FIT_CHARS = 64;

function clip(text: string, max: number): string {
  const clean = text
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?。])(\s|$)/.exec(text.trim());
  return match ? match[1]! : text.trim();
}

/** The body of the first `## ` section whose heading matches, up to the next `## `. */
function h2Section(markdown: string, heading: RegExp): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## ") && heading.test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function paragraphs(text: string | undefined): string[] {
  return (text ?? "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith("#"));
}

/** Prose paragraphs only: no list blocks and no label lines such as "Underlying principles:". */
function prose(blocks: readonly string[]): string[] {
  return blocks.filter((block) => !/^([-*+]|\d+\.)\s/.test(block) && !/:\s*$/.test(block.split("\n")[0]!));
}

function labelled(markdown: string, label: RegExp): string | undefined {
  return new RegExp(`(?:${label.source}):\\s*([^\\n]+)`, "i").exec(markdown)?.[1];
}

function paletteOf(markdown: string): string[] {
  const declared =
    /【Color Palette】([\s\S]*?)(?=【|\n## |$)/.exec(markdown)?.[1] ?? h2Section(markdown, /Color System/i) ?? markdown;
  const seen = new Set<string>();
  for (const hex of declared.match(HEX) ?? []) seen.add(hex.toUpperCase());
  return [...seen].slice(0, PALETTE_LIMIT);
}

function toneOf(markdown: string): string {
  const positioning = prose(paragraphs(h2Section(markdown, /Style Positioning/i)));
  const tone =
    labelled(markdown, /One-(?:line|sentence) style signature|Core (?:design|visuals?)|Primary tone/) ??
    positioning[1] ??
    (positioning[0] ? positioning[0].slice(firstSentence(positioning[0]).length).trim() || undefined : undefined) ??
    labelled(markdown, /Aesthetic/) ??
    "";
  return clip(firstSentence(tone), TONE_CHARS);
}

function fitOf(markdown: string): string {
  const fit =
    labelled(markdown, /Applicable scenarios/) ??
    paragraphs(h2Section(markdown, /Style Positioning/i))[0] ??
    paragraphs(h2Section(markdown, /PART A/i))[0] ??
    "";
  return clip(firstSentence(fit), FIT_CHARS);
}

type DesignFile = { id: string; canonical: boolean; entry: SourceManifestEntry };

function designFiles(pack: VerifiedOpenKimiPack): DesignFile[] {
  const files: DesignFile[] = [];
  for (const entry of pack.manifest.files) {
    const canonical = CANONICAL.exec(entry.relativePath);
    if (canonical) files.push({ id: `${canonical[1]}/${canonical[2]}`, canonical: true, entry });
    const numbered = NUMBERED.exec(entry.relativePath);
    if (numbered) files.push({ id: `extra/${numbered[1]}`, canonical: false, entry });
  }
  return files;
}

/** The canonical pack a numbered guide belongs to: a Hub/theme alias, else the same slug. */
function canonicalFor(file: DesignFile, canonicalIds: ReadonlySet<string>): string {
  if (file.canonical) return file.id;
  const themed = parseThemePackId(file.entry.sourceId);
  if (themed && canonicalIds.has(themed)) return themed;
  const slug = file.id.slice("extra/".length);
  const sameSlug = [...canonicalIds].filter((id) => id.endsWith(`/${slug}`));
  return sameSlug.length === 1 ? sameSlug[0]! : file.id;
}

let cache: { key: string; cards: readonly DesignSystemCard[] } | undefined;

export function buildDesignSystemCards(pack: VerifiedOpenKimiPack): readonly DesignSystemCard[] {
  const files = designFiles(pack);
  const key = createHash("sha256")
    .update(files.map((file) => `${file.entry.relativePath}:${file.entry.sha256}`).join("\n"))
    .digest("hex");
  if (cache?.key === key) return cache.cards;
  const canonicalIds = new Set(files.filter((file) => file.canonical).map((file) => file.id));
  const groups = new Map<string, { primary?: DesignFile; aliases: DesignFile[] }>();
  for (const file of files) {
    const id = canonicalFor(file, canonicalIds);
    const group = groups.get(id) ?? { aliases: [] };
    if (id === file.id) group.primary = file;
    else group.aliases.push(file);
    groups.set(id, group);
  }
  const cards = [...groups.entries()]
    .filter((entry): entry is [string, { primary: DesignFile; aliases: DesignFile[] }] => Boolean(entry[1].primary))
    .map(([id, group]) => {
      const markdown = readOpenKimiSource(pack, group.primary.entry.sourceId);
      const palette = paletteOf(markdown);
      const tone = toneOf(markdown);
      const fit = fitOf(markdown);
      return {
        id,
        sourceId: group.primary.entry.sourceId,
        palette,
        tone,
        fit,
        aliases: group.aliases.map((alias) => alias.id),
        aliasSourceIds: group.aliases.map((alias) => alias.entry.sourceId),
        card: `${palette.join(" ")} · ${tone} · fit: ${fit}`,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  cache = { key, cards };
  return cards;
}

/** Canonical id for any pack id or alias (numbered guide id, Hub slug); undefined when unknown. */
export function canonicalDesignSystemId(cards: readonly DesignSystemCard[], id: string): string | undefined {
  const wanted = id.trim();
  const themed = parseThemePackId(wanted);
  return cards.find(
    (card) =>
      card.id === wanted ||
      card.sourceId === wanted ||
      card.aliases.includes(wanted) ||
      card.aliasSourceIds.includes(wanted) ||
      (themed !== undefined && card.id === themed),
  )?.id;
}

export function loadDesignSystemCards(repoRoot: string): readonly DesignSystemCard[] {
  return buildDesignSystemCards(verifyOpenKimiPack(repoRoot));
}

/**
 * Catalog view of the design systems with aliases folded in: each canonical
 * pack once, with its alias ids and selection card. The Hub tile DTO
 * (`buildCatalogDto`) is unchanged.
 */
export function buildDesignSystemDirectory(repoRoot = resolveRepoRoot()): readonly DesignSystemCard[] {
  return loadDesignSystemCards(repoRoot);
}

/** The compact list_references form: id, sourceId and one card line (aliases only when present). */
export function designSystemSelectionRows(
  cards: readonly DesignSystemCard[],
): { id: string; sourceId: string; card: string; aliases?: readonly string[] }[] {
  return cards.map((card) => ({
    id: card.id,
    sourceId: card.sourceId,
    card: card.card,
    ...(card.aliases.length ? { aliases: card.aliases } : {}),
  }));
}
