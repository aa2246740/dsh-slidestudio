/**
 * Sectioned OpenKimi source manifest (v2) for `reference/pptd.md`.
 *
 * The v1 manifest stays the integrity boundary: every byte served here is
 * first verified against it. v2 only partitions the verified file into
 * semantic markdown sections with exact byte ranges and verbatim SHA-256
 * hashes, then groups them into delivery units. Nothing is summarized: the
 * concatenation of all section bytes is the original file, byte for byte.
 *
 * The `core` group is required before planning. Specialized groups (chart,
 * table, image, icon, line, animation) are read on demand, when a page uses
 * the matching element type.
 */
import { bytesSha256 } from "./hashing.js";
import {
  OPENKIMI_SOURCE_CHUNK_BYTES,
  OpenKimiSourcePackError,
  listOpenKimiSourceRequirements,
  readOpenKimiSourceBytes,
  type OpenKimiSourceChunk,
  type ResolveSourceRequirementsInput,
  type SourceRequirement,
  type VerifiedOpenKimiPack,
} from "./openkimi-source-pack.js";

export const OPENKIMI_SECTIONED_MANIFEST_VERSION = "openkimi-source-manifest-v2-sectioned";
/** Stored on new run ledgers; absent on v1 ledgers, which keep whole-file requirements. */
export const OPENKIMI_SECTIONED_REFERENCE_LAYOUT = "openkimi-sectioned-v2";
export const PPTD_RELATIVE_PATH = "reference/pptd.md";
export const PPTD_SOURCE_ID = `openkimi:${PPTD_RELATIVE_PATH}`;
/** Separates the file source id from the section group: `openkimi:reference/pptd.md::chart`. */
export const SECTION_SOURCE_SEPARATOR = "::";
/** The pinned pptd.md bytes this partition was authored against. Other bytes fall back to v1. */
export const PINNED_PPTD_SHA256 = "03068da917aba6ca7c4a7092df61256b7b3424133335adc5b431afa214ba655d";

export const PPTD_SECTION_GROUP_IDS = ["core", "line", "image", "icon", "table", "chart", "animation"] as const;
export type PptdSectionGroupId = (typeof PPTD_SECTION_GROUP_IDS)[number];
export type PptdOnDemandGroupId = Exclude<PptdSectionGroupId, "core">;
export const PPTD_ON_DEMAND_GROUP_IDS: readonly PptdOnDemandGroupId[] = [
  "line",
  "image",
  "icon",
  "table",
  "chart",
  "animation",
];

/** The H3 element heading prefix (under "## 5. Elements") that owns each element group. */
const ELEMENT_GROUP_HEADINGS: Readonly<Record<string, PptdOnDemandGroupId>> = {
  "Line (line)": "line",
  "Image (image)": "image",
  "Icon (icon)": "icon",
  "Table (table)": "table",
  "Chart (charts)": "chart",
};
const ELEMENTS_H2 = "5. Elements";
const ANIMATIONS_H2 = "6. Animations";

export type MarkdownSection = Readonly<{
  /** Stable slug path, e.g. `5-elements/chart-charts`. */
  sectionId: string;
  title: string;
  level: number;
  headingPath: readonly string[];
  byteStart: number;
  byteEndExclusive: number;
  sha256: string;
}>;

export type SectionChunk = Readonly<{
  index: number;
  byteStart: number;
  byteEndExclusive: number;
  sha256: string;
}>;

export type PptdSectionGroup = Readonly<{
  groupId: PptdSectionGroupId;
  sourceId: string;
  /** The headings this group delivers, in file order. */
  titles: readonly string[];
  byteLength: number;
  sections: readonly (MarkdownSection & { groupId: PptdSectionGroupId })[];
  chunks: readonly SectionChunk[];
}>;

export type OpenKimiSectionedFile = Readonly<{
  sourceId: string;
  relativePath: string;
  fileSha256: string;
  byteLength: number;
  sections: readonly (MarkdownSection & { groupId: PptdSectionGroupId })[];
  groups: readonly PptdSectionGroup[];
}>;

export type OpenKimiSectionedManifest = Readonly<{
  version: typeof OPENKIMI_SECTIONED_MANIFEST_VERSION;
  chunkBytes: number;
  files: readonly OpenKimiSectionedFile[];
}>;

const HEADING = /^(#{1,3})[ \t]+(.+?)[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/**
 * Split UTF-8 markdown at H1–H3 headings outside fenced code. Sections are
 * contiguous and cover every byte; a preamble before the first heading is its
 * own section.
 */
export function parseMarkdownSections(bytes: Buffer): MarkdownSection[] {
  const starts: { level: number; title: string; byteStart: number }[] = [];
  let offset = 0;
  let fenced = false;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const lineEnd = newline === -1 ? bytes.length : newline + 1;
    const line = bytes
      .subarray(offset, lineEnd)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const match = HEADING.exec(line);
      if (match) starts.push({ level: match[1]!.length, title: match[2]!, byteStart: offset });
    }
    offset = lineEnd;
  }
  if (!starts.length || starts[0]!.byteStart > 0) starts.unshift({ level: 0, title: "", byteStart: 0 });
  const path: string[] = [];
  const used = new Set<string>();
  return starts.map((start, index) => {
    const byteEndExclusive = index + 1 < starts.length ? starts[index + 1]!.byteStart : bytes.length;
    if (start.level > 0) {
      path.length = Math.max(0, start.level - 1);
      path[start.level - 1] = start.title;
    }
    const headingPath = start.level > 0 ? path.slice(0, start.level) : [];
    let sectionId = headingPath.length ? headingPath.map(slug).join("/") : "preamble";
    for (let n = 2; used.has(sectionId); n += 1) sectionId = `${headingPath.map(slug).join("/")}~${n}`;
    used.add(sectionId);
    return {
      sectionId,
      title: start.title,
      level: start.level,
      headingPath,
      byteStart: start.byteStart,
      byteEndExclusive,
      sha256: bytesSha256(bytes.subarray(start.byteStart, byteEndExclusive)),
    };
  });
}

function groupForSection(section: MarkdownSection): PptdSectionGroupId {
  const [, h2, h3] = section.headingPath;
  if (h2 === ANIMATIONS_H2) return "animation";
  if (h2 === ELEMENTS_H2 && h3) return ELEMENT_GROUP_HEADINGS[h3] ?? "core";
  return "core";
}

function lastNewlineCut(bytes: Buffer, start: number, limit: number): number {
  const window = bytes.subarray(start, limit);
  const newline = window.lastIndexOf(0x0a);
  if (newline > 0) return start + newline + 1;
  let cut = limit;
  while (cut > start && (bytes[cut]! & 0b1100_0000) === 0b1000_0000) cut -= 1;
  if (cut === start) throw new OpenKimiSourcePackError("cannot split section into valid UTF-8 chunks");
  return cut;
}

/** Pack whole sections into ≤ chunkBytes chunks; split only a section that is larger on its own. */
function chunkRanges(
  bytes: Buffer,
  sections: readonly MarkdownSection[],
  chunkBytes: number,
): { byteStart: number; byteEndExclusive: number }[] {
  const ranges: { byteStart: number; byteEndExclusive: number }[] = [];
  let open: { byteStart: number; byteEndExclusive: number } | undefined;
  for (const section of sections) {
    const contiguous = open && open.byteEndExclusive === section.byteStart;
    if (open && contiguous && section.byteEndExclusive - open.byteStart <= chunkBytes) {
      open.byteEndExclusive = section.byteEndExclusive;
      continue;
    }
    if (open) ranges.push(open);
    let start = section.byteStart;
    while (section.byteEndExclusive - start > chunkBytes) {
      const cut = lastNewlineCut(bytes, start, start + chunkBytes);
      ranges.push({ byteStart: start, byteEndExclusive: cut });
      start = cut;
    }
    open = { byteStart: start, byteEndExclusive: section.byteEndExclusive };
  }
  if (open) ranges.push(open);
  return ranges;
}

export function sectionSourceId(groupId: PptdSectionGroupId): string {
  return `${PPTD_SOURCE_ID}${SECTION_SOURCE_SEPARATOR}${groupId}`;
}

export function isSectionSourceId(sourceId: string): boolean {
  return parseSectionSourceId(sourceId) !== undefined;
}

export function parseSectionSourceId(sourceId: string): PptdSectionGroupId | undefined {
  const prefix = `${PPTD_SOURCE_ID}${SECTION_SOURCE_SEPARATOR}`;
  if (!sourceId.startsWith(prefix)) return undefined;
  const groupId = sourceId.slice(prefix.length);
  return (PPTD_SECTION_GROUP_IDS as readonly string[]).includes(groupId) ? (groupId as PptdSectionGroupId) : undefined;
}

/** Build the sectioned view of verified pptd.md bytes. Throws when the pinned headings are absent. */
export function createSectionedPptdFile(
  bytes: Buffer,
  chunkBytes = OPENKIMI_SOURCE_CHUNK_BYTES,
): OpenKimiSectionedFile {
  const sections = parseMarkdownSections(bytes).map((section) => ({ ...section, groupId: groupForSection(section) }));
  const groups = PPTD_SECTION_GROUP_IDS.map((groupId): PptdSectionGroup => {
    const owned = sections.filter((section) => section.groupId === groupId);
    if (!owned.length) throw new OpenKimiSourcePackError(`pptd.md has no ${groupId} section`);
    const chunks = chunkRanges(bytes, owned, chunkBytes).map((range, index) => ({
      index,
      ...range,
      sha256: bytesSha256(bytes.subarray(range.byteStart, range.byteEndExclusive)),
    }));
    return {
      groupId,
      sourceId: sectionSourceId(groupId),
      titles: owned.filter((section) => section.level > 0).map((section) => section.title),
      byteLength: owned.reduce((sum, section) => sum + section.byteEndExclusive - section.byteStart, 0),
      sections: owned,
      chunks,
    };
  });
  return {
    sourceId: PPTD_SOURCE_ID,
    relativePath: PPTD_RELATIVE_PATH,
    fileSha256: bytesSha256(bytes),
    byteLength: bytes.length,
    sections,
    groups,
  };
}

const sectionedCache = new Map<string, OpenKimiSectionedFile>();

/** True when the verified pack holds the exact pptd.md bytes the v2 partition was pinned to. */
export function sectionedReferenceAvailable(pack: VerifiedOpenKimiPack): boolean {
  return pack.entriesById.get(PPTD_SOURCE_ID)?.sha256 === PINNED_PPTD_SHA256;
}

/** The sectioned pptd.md of a verified pack. Bytes are re-verified against the v1 manifest. */
export function sectionedPptd(pack: VerifiedOpenKimiPack): OpenKimiSectionedFile {
  const entry = pack.entriesById.get(PPTD_SOURCE_ID);
  if (!entry) throw new OpenKimiSourcePackError(`required OpenKimi source not found: ${PPTD_RELATIVE_PATH}`);
  const cached = sectionedCache.get(entry.sha256);
  if (cached) return cached;
  const file = createSectionedPptdFile(readOpenKimiSourceBytes(pack, PPTD_SOURCE_ID));
  sectionedCache.set(entry.sha256, file);
  return file;
}

export function createOpenKimiSectionedManifest(pack: VerifiedOpenKimiPack): OpenKimiSectionedManifest {
  return {
    version: OPENKIMI_SECTIONED_MANIFEST_VERSION,
    chunkBytes: OPENKIMI_SOURCE_CHUNK_BYTES,
    files: [sectionedPptd(pack)],
  };
}

export function sectionGroup(pack: VerifiedOpenKimiPack, groupId: PptdSectionGroupId): PptdSectionGroup {
  const group = sectionedPptd(pack).groups.find((candidate) => candidate.groupId === groupId);
  if (!group) throw new OpenKimiSourcePackError(`unknown pptd section group: ${groupId}`);
  return group;
}

/** One verbatim chunk of a section group, with the same shape as a v1 source chunk. */
export function readOpenKimiSectionChunk(
  pack: VerifiedOpenKimiPack,
  sourceId: string,
  index: number,
): OpenKimiSourceChunk & { sectionIds: readonly string[] } {
  const groupId = parseSectionSourceId(sourceId);
  if (!groupId) throw new OpenKimiSourcePackError(`unknown OpenKimi section source id: ${sourceId}`);
  const group = sectionGroup(pack, groupId);
  const chunk = group.chunks[index];
  if (!chunk) throw new OpenKimiSourcePackError(`unknown chunk ${index} for ${sourceId}`);
  const bytes = readOpenKimiSourceBytes(pack, PPTD_SOURCE_ID);
  const raw = bytes.subarray(chunk.byteStart, chunk.byteEndExclusive);
  if (bytesSha256(raw) !== chunk.sha256) throw new OpenKimiSourcePackError(`chunk hash mismatch: ${sourceId}#${index}`);
  return {
    sourceId,
    relativePath: PPTD_RELATIVE_PATH,
    index,
    byteStart: chunk.byteStart,
    byteEndExclusive: chunk.byteEndExclusive,
    sha256: chunk.sha256,
    fileSha256: bytesSha256(bytes),
    bytes: Buffer.from(raw),
    text: new TextDecoder("utf-8", { fatal: true }).decode(raw),
    sectionIds: group.sections
      .filter((section) => section.byteStart < chunk.byteEndExclusive && section.byteEndExclusive > chunk.byteStart)
      .map((section) => section.sectionId),
  };
}

/** Every chunk of the named groups, for callers that read on-demand sections up front. */
export function sectionChunkRefs(
  pack: VerifiedOpenKimiPack,
  groupIds: readonly PptdSectionGroupId[] = PPTD_ON_DEMAND_GROUP_IDS,
): { sourceId: string; chunkIndex: number }[] {
  return groupIds.flatMap((groupId) =>
    sectionGroup(pack, groupId).chunks.map((chunk) => ({
      sourceId: sectionSourceId(groupId),
      chunkIndex: chunk.index,
    })),
  );
}

/**
 * v2 planning requirements: the v1 list with whole-file pptd.md replaced by its
 * core section group. SKILL.md, categories, scenario and preset stay whole.
 */
export function listSectionedSourceRequirements(
  pack: VerifiedOpenKimiPack,
  input: ResolveSourceRequirementsInput,
): readonly SourceRequirement[] {
  const core = sectionGroup(pack, "core");
  return listOpenKimiSourceRequirements(pack, input).map((requirement) =>
    requirement.kind === "pptd"
      ? { ...requirement, sourceId: core.sourceId, requiredChunkIndexes: core.chunks.map((chunk) => chunk.index) }
      : requirement,
  );
}

/** File hash a ledger requirement pins: the whole file for a section source id. */
export function requirementFileSha256(pack: VerifiedOpenKimiPack, sourceId: string): string | undefined {
  if (isSectionSourceId(sourceId)) return pack.entriesById.get(PPTD_SOURCE_ID)?.sha256;
  return pack.entriesById.get(sourceId)?.sha256;
}
