import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSkillDeck } from "./deck-page-count.js";
import { composeBodyRules, requestedPageCountFromBrief } from "./compose-ir.js";
import { minimumPageCount, pageCountFits, pageCountRequirementFromBrief } from "./page-count-requirement.js";
import type { SkillDeckInput } from "./skill-pages.js";

function deck(pageCount: number): SkillDeckInput {
  return {
    title: "合成页数检查",
    pages: Array.from({ length: pageCount }, (_, index) => ({
      id: `p${String(index + 1).padStart(2, "0")}`,
      elements: [
        {
          elementId: "title",
          elementType: "text" as const,
          bounds: [80, 40, 800, 60] as const,
          content: { text: `第 ${index + 1} 页`, fontSize: 28 },
        },
      ],
    })),
  };
}

describe("shared page-count acceptance", () => {
  it("accepts exact equality only and rejects both fewer and extra pages", () => {
    const exact = pageCountRequirementFromBrief("固定 7 页");
    assert.deepEqual(exact, { kind: "exact", count: 7 });
    assert.equal(pageCountFits(exact, 7), true);
    assert.equal(pageCountFits(exact, 6), false);
    assert.equal(pageCountFits(exact, 8), false);
    assert.throws(() => assertSkillDeck(deck(6), { minPages: 7, pageCount: exact }), /固定 7 页/);
    assert.throws(() => assertSkillDeck(deck(8), { minPages: 7, pageCount: exact }), /固定 7 页/);
    assert.doesNotThrow(() => assertSkillDeck(deck(7), { minPages: 7, pageCount: exact }));
  });

  it("checks both bounds of an explicit range", () => {
    const range = pageCountRequirementFromBrief("6–8 页");
    assert.deepEqual(range, { kind: "range", min: 6, max: 8 });
    for (const count of [6, 7, 8]) assert.equal(pageCountFits(range, count), true, `${count}`);
    for (const count of [5, 9]) assert.equal(pageCountFits(range, count), false, `${count}`);
    assert.throws(() => assertSkillDeck(deck(5), { minPages: 6, pageCount: range }), /6–8 页/);
    assert.throws(() => assertSkillDeck(deck(9), { minPages: 6, pageCount: range }), /6–8 页/);
  });

  it("does not turn an approximate target into a fixed or minimum count", () => {
    const approximate = pageCountRequirementFromBrief("约 7 页");
    assert.deepEqual(approximate, { kind: "approximate", count: 7 });
    assert.equal(minimumPageCount(approximate), undefined);
    assert.equal(requestedPageCountFromBrief("约 7 页"), undefined);
    for (const count of [5, 6, 8, 9]) assert.equal(pageCountFits(approximate, count), true);
    for (const count of [6, 8]) {
      assert.doesNotThrow(() => assertSkillDeck(deck(count), { minPages: 1, pageCount: approximate }));
    }
  });

  it("keeps unspecified free of any implied total", () => {
    const unspecified = pageCountRequirementFromBrief("参考稿 12 页，做一份协作流程介绍");
    assert.deepEqual(unspecified, { kind: "unspecified" });
    assert.equal(pageCountFits(unspecified, 1), true);
    assert.equal(minimumPageCount(unspecified), undefined);
    assert.doesNotThrow(() => assertSkillDeck(deck(2), { minPages: 1, pageCount: unspecified }));
  });
});

describe("compose body rules carry the user requirement", () => {
  it("passes exact equality and range bounds through to compose", () => {
    const exact = composeBodyRules("固定 7 页协作流程介绍");
    assert.deepEqual(exact.pageCount, { kind: "exact", count: 7 });
    assert.equal(exact.minPages, 7);
    const range = composeBodyRules("6 到 8 页协作流程介绍");
    assert.deepEqual(range.pageCount, { kind: "range", min: 6, max: 8 });
    assert.equal(range.minPages, 6);
  });

  it("does not use an approximate or unspecified target as the body minimum", () => {
    const approximate = composeBodyRules("约 7 页教学课件");
    assert.deepEqual(approximate.pageCount, { kind: "approximate", count: 7 });
    assert.notEqual(approximate.minPages, 7);
    const unspecified = composeBodyRules("教学课件");
    assert.deepEqual(unspecified.pageCount, { kind: "unspecified" });
    assert.notEqual(unspecified.minPages, 6);
  });
});
