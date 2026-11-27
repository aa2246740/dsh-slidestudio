import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writePageSchemaError, writePageSchemaIssues } from "./layout-qa.js";
import {
  REJECTION_DETAIL_MAX_CHARS,
  WRITE_PAGE_DETAIL_MAX_CHARS,
  capRejectionDetail,
  cappedIssueDetail,
  compactPackColorDetail,
  rankAllowedColors,
} from "./rejection-detail.js";
import { PACK_COLOR_ERROR, packColorWriteContextFrom } from "./theme-pack.js";
import type { SkillPageInput } from "./skill-pages.js";

const OFF_PACK = ["#123456", "#654321", "#ABCDEF", "#FEDCBA", "#0F0F0F", "#F0F0F0", "#13579B", "#2468AC"];

function offPackPage(): SkillPageInput {
  return {
    id: "cover",
    pageType: "cover",
    background: { type: "solid", color: "#0A1B2C" },
    elements: OFF_PACK.map((color, index) => ({
      elementId: `box-${index}`,
      elementType: "shape",
      bounds: [40 + index * 100, 60, 90, 90],
      fill: { type: "solid", color },
    })),
  } as unknown as SkillPageInput;
}

describe("capped pack_color refusals", () => {
  it("fits a many-colour refusal in ≤ 1 KiB, keeping every offending field and the palette first", (t) => {
    const pack = packColorWriteContextFrom({ designSystemId: "consulting/pine-green-strategy" });
    const page = offPackPage();
    const issues = writePageSchemaIssues(page, pack).filter((issue) => issue.code === PACK_COLOR_ERROR);
    assert.equal(issues.length, OFF_PACK.length + 1);
    const uncapped = issues.map((issue) => issue.message).join("\n");
    const refused = writePageSchemaError(issues, page, pack);
    assert.equal(refused?.error, PACK_COLOR_ERROR);
    const detail = refused!.detail;
    t.diagnostic(`uncapped ${uncapped.length} chars → capped ${detail.length} chars`);
    assert.ok(uncapped.length > 4 * REJECTION_DETAIL_MAX_CHARS, `uncapped was ${uncapped.length}`);
    assert.ok(detail.length <= WRITE_PAGE_DETAIL_MAX_CHARS, `${detail.length} chars`);
    assert.ok(`${PACK_COLOR_ERROR}: ${detail}`.length <= REJECTION_DETAIL_MAX_CHARS);
    assert.match(detail, /Allowed pack colors:/);
    assert.match(detail, /Host did not snap colors/);
    assert.match(detail, /write_page refused/);
    assert.match(detail, /background\.color/);
    for (const [index] of OFF_PACK.entries()) assert.match(detail, new RegExp(`elements\\[${index}\\]\\.fill\\.color`));
    const allowed = [...pack.adoptedPackHexes!].map((hex) => hex.toUpperCase());
    for (const hex of rankAllowedColors(allowed).slice(0, 3)) assert.match(detail, new RegExp(hex));
  });

  it("leaves a short refusal byte-identical", () => {
    const pack = packColorWriteContextFrom({ designSystemId: "consulting/pine-green-strategy" });
    const page = { ...offPackPage(), elements: [] } as unknown as SkillPageInput;
    const issues = writePageSchemaIssues(page, pack).filter((issue) => issue.code === PACK_COLOR_ERROR);
    assert.equal(issues.length, 1);
    assert.equal(writePageSchemaError(issues, page, pack)?.detail, issues[0]!.message);
  });

  it("ranks base colours ahead of their documented tints and shades", () => {
    assert.deepEqual(rankAllowedColors(["#1A1A1A", "#151515", "#1F4E9A", "#FFFFFF"]), [
      "#1A1A1A",
      "#1F4E9A",
      "#FFFFFF",
      "#151515",
    ]);
  });
});

describe("generic caps", () => {
  it("truncates on line boundaries and names how many lines were dropped", () => {
    const lines = Array.from(
      { length: 60 },
      (_, index) => `issue ${index}: element e${index} overlaps the footer zone`,
    );
    const capped = capRejectionDetail(lines.join("\n"));
    assert.ok(capped.length <= REJECTION_DETAIL_MAX_CHARS);
    assert.match(capped, /^issue 0: element e0/);
    assert.match(capped, /…\(\+\d+ more\)$/);
    assert.equal(capRejectionDetail("short"), "short");
    assert.ok(capRejectionDetail("x".repeat(5000)).length <= REJECTION_DETAIL_MAX_CHARS);
  });

  it("compacts only pack_color messages and keeps the other issues", () => {
    assert.equal(compactPackColorDetail(["overflow at e1"]), undefined);
    const pack = packColorWriteContextFrom({ designSystemId: "consulting/pine-green-strategy" });
    const messages = writePageSchemaIssues(offPackPage(), pack).map((issue) => issue.message);
    const mixed = cappedIssueDetail([...messages, "overflow: element e9 leaves the slide"], pack.adoptedPackHexes);
    assert.ok(mixed.length <= REJECTION_DETAIL_MAX_CHARS);
    assert.match(mixed, /overflow: element e9 leaves the slide/);
    assert.match(mixed, /Allowed pack colors:/);
  });
});
