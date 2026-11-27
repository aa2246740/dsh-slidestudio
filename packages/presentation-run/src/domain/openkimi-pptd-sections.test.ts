import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveRepoRoot } from "../catalog.js";
import {
  OPENKIMI_SOURCE_CHUNK_BYTES,
  listOpenKimiSourceRequirements,
  readOpenKimiSourceBytes,
  verifyOpenKimiPack,
} from "./openkimi-source-pack.js";
import {
  OPENKIMI_SECTIONED_MANIFEST_VERSION,
  PINNED_PPTD_SHA256,
  PPTD_ON_DEMAND_GROUP_IDS,
  PPTD_SOURCE_ID,
  createOpenKimiSectionedManifest,
  createSectionedPptdFile,
  isSectionSourceId,
  listSectionedSourceRequirements,
  parseMarkdownSections,
  parseSectionSourceId,
  readOpenKimiSectionChunk,
  sectionChunkRefs,
  sectionGroup,
  sectionSourceId,
  sectionedPptd,
  sectionedReferenceAvailable,
} from "./openkimi-pptd-sections.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pack = verifyOpenKimiPack(resolveRepoRoot());
const pptdBytes = readOpenKimiSourceBytes(pack, PPTD_SOURCE_ID);

function entryBytes(sourceId: string): number {
  return pack.entriesById.get(sourceId)!.byteLength;
}

describe("sectioned pptd.md manifest v2", () => {
  it("covers every byte with contiguous sections whose hashes are verbatim slices", () => {
    const file = sectionedPptd(pack);
    assert.equal(file.fileSha256, PINNED_PPTD_SHA256);
    assert.equal(file.byteLength, pptdBytes.length);
    let next = 0;
    for (const section of file.sections) {
      assert.equal(section.byteStart, next, section.sectionId);
      assert.ok(section.byteEndExclusive > section.byteStart, section.sectionId);
      assert.equal(section.sha256, sha(pptdBytes.subarray(section.byteStart, section.byteEndExclusive)));
      next = section.byteEndExclusive;
    }
    assert.equal(next, pptdBytes.length);
    const rebuilt = Buffer.concat(file.sections.map((s) => pptdBytes.subarray(s.byteStart, s.byteEndExclusive)));
    assert.equal(sha(rebuilt), file.fileSha256);
    assert.equal(new Set(file.sections.map((s) => s.sectionId)).size, file.sections.length);
  });

  it("starts each section exactly at its heading line in the vendor file", () => {
    const vendor = fs.readFileSync(path.join(pack.sourceRoot, "reference", "pptd.md"));
    assert.equal(sha(vendor), PINNED_PPTD_SHA256);
    for (const heading of ["### Chart (charts)", "### Table (table)", "### Image (image)", "## 6. Animations"]) {
      const offset = vendor.indexOf(Buffer.from(`\n${heading}\n`)) + 1;
      assert.ok(offset > 0, heading);
      const section = sectionedPptd(pack).sections.find((s) => s.byteStart === offset);
      assert.ok(section, `no section starts at ${heading}`);
      assert.equal(`${"#".repeat(section.level)} ${section.title}`, heading);
    }
  });

  it("puts global conventions, shared types, page structure, text and shape in core", () => {
    const core = sectionGroup(pack, "core");
    for (const title of [
      "1. Global Conventions",
      "2. Shared Types",
      "3. Main Entry File (.pptd)",
      "4. Page Files (.page)",
      "ElementBase",
      "Text (text box)",
      "Shape (shape)",
    ]) {
      assert.ok(core.titles.includes(title), title);
    }
    for (const title of ["Chart (charts)", "Table (table)", "Image (image)", "6. Animations"]) {
      assert.equal(core.titles.includes(title), false, title);
    }
    assert.deepEqual(sectionGroup(pack, "chart").titles, ["Chart (charts)"]);
    assert.deepEqual(sectionGroup(pack, "table").titles, ["Table (table)"]);
    assert.deepEqual(sectionGroup(pack, "image").titles, ["Image (image)"]);
    assert.equal(sectionGroup(pack, "animation").titles[0], "6. Animations");
    assert.equal(sectionGroup(pack, "chart").byteLength, 40_604);
  });

  it("cuts the required baseline below 65 KB against the 110.7 KB whole-file baseline", (t) => {
    const input = { designDirection: { kind: "self-directed" as const } };
    const bytesOf = (sourceId: string) =>
      isSectionSourceId(sourceId)
        ? sectionGroup(pack, parseSectionSourceId(sourceId)!).byteLength
        : entryBytes(sourceId);
    const v1 = listOpenKimiSourceRequirements(pack, input).reduce((sum, r) => sum + bytesOf(r.sourceId), 0);
    const v2 = listSectionedSourceRequirements(pack, input).reduce((sum, r) => sum + bytesOf(r.sourceId), 0);
    t.diagnostic(
      `v1 baseline ${v1} bytes; v2 core ${v2} bytes; saved ${v1 - v2} (${((1 - v2 / v1) * 100).toFixed(1)}%)`,
    );
    assert.equal(v1, 110_655);
    assert.ok(v2 < 65_000, `v2 core baseline is ${v2} bytes`);
    assert.equal(v2, 53_647);
    const kinds = listSectionedSourceRequirements(pack, input).map((r) => [r.kind, r.sourceId]);
    assert.deepEqual(kinds, [
      ["skill", "openkimi:SKILL.md"],
      ["pptd", sectionSourceId("core")],
      ["categories", "openkimi:reference/slides_categories.md"],
    ]);
  });

  it("serves ≤ 12 KiB chunks that reassemble each group and the whole file byte for byte", () => {
    const parts: { start: number; bytes: Buffer }[] = [];
    for (const group of sectionedPptd(pack).groups) {
      for (const chunk of group.chunks) {
        const read = readOpenKimiSectionChunk(pack, group.sourceId, chunk.index);
        assert.ok(read.bytes.length <= OPENKIMI_SOURCE_CHUNK_BYTES, `${group.sourceId}#${chunk.index}`);
        assert.equal(read.sha256, sha(read.bytes));
        assert.equal(read.fileSha256, PINNED_PPTD_SHA256);
        assert.equal(read.text, read.bytes.toString("utf8"));
        assert.deepEqual(read.bytes, pptdBytes.subarray(chunk.byteStart, chunk.byteEndExclusive));
        assert.ok(read.sectionIds.length > 0);
        parts.push({ start: chunk.byteStart, bytes: read.bytes });
      }
    }
    parts.sort((a, b) => a.start - b.start);
    assert.deepEqual(Buffer.concat(parts.map((p) => p.bytes)), pptdBytes);
    assert.equal(
      sectionChunkRefs(pack).length,
      PPTD_ON_DEMAND_GROUP_IDS.reduce((n, id) => n + sectionGroup(pack, id).chunks.length, 0),
    );
  });

  it("names section sources by group and refuses unknown ones", () => {
    assert.equal(sectionSourceId("chart"), "openkimi:reference/pptd.md::chart");
    assert.equal(parseSectionSourceId("openkimi:reference/pptd.md::chart"), "chart");
    assert.equal(parseSectionSourceId("openkimi:reference/pptd.md::nope"), undefined);
    assert.equal(isSectionSourceId(PPTD_SOURCE_ID), false);
    assert.throws(() => readOpenKimiSectionChunk(pack, "openkimi:reference/pptd.md::nope", 0));
    assert.throws(() => readOpenKimiSectionChunk(pack, sectionSourceId("chart"), 99));
    const manifest = createOpenKimiSectionedManifest(pack);
    assert.equal(manifest.version, OPENKIMI_SECTIONED_MANIFEST_VERSION);
    assert.equal(manifest.files[0]!.sourceId, PPTD_SOURCE_ID);
    assert.equal(sectionedReferenceAvailable(pack), true);
  });
});

describe("parseMarkdownSections", () => {
  it("ignores fenced headings, keeps a preamble and measures UTF-8 bytes", () => {
    const text = "前言 intro\n# Title\n```yaml\n# not a heading\n```\n## 中文 Part\nbody ✓\n### Leaf\nend\n";
    const bytes = Buffer.from(text, "utf8");
    const sections = parseMarkdownSections(bytes);
    assert.deepEqual(
      sections.map((s) => [s.sectionId, s.level]),
      [
        ["preamble", 0],
        ["title", 1],
        ["title/part", 2],
        ["title/part/leaf", 3],
      ],
    );
    assert.equal(sections[2]!.byteStart, bytes.indexOf(Buffer.from("## 中文")));
    assert.deepEqual(sections[2]!.headingPath, ["Title", "中文 Part"]);
    assert.equal(Buffer.concat(sections.map((s) => bytes.subarray(s.byteStart, s.byteEndExclusive))).toString(), text);
  });

  it("refuses a pptd.md without the pinned specialized headings", () => {
    assert.throws(
      () => createSectionedPptdFile(Buffer.from("# Spec\n## 1. Global Conventions\ntext\n")),
      /no line section/,
    );
  });
});
