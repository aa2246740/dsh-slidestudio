/**
 * Number conflicts per period (CAP-21, VAL-DATA-009, M7-SCR-009), over hand-built sources and readings:
 * a metric that two sources state for two years is two conflicts, a source that writes no year is in the
 * conflict of every year it conflicts in, and a page number speaks to the candidates whose period fits it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DOCUMENT_RANK,
  detectNumberConflicts,
  labelKey,
  pageStatesValue,
  proseFigures,
  statedNumbers,
  type ConflictSource,
  type NumberConflictCandidate,
} from "./figure-conflicts.js";
import type { MaterialFigureReading } from "./material-figures.js";
import { pageConflictHint, pageNumberConflicts } from "./page-conflicts.js";

const source = (id: string, text: string): ConflictSource => ({
  source: `${id}.txt`,
  sourceId: id,
  rank: DOCUMENT_RANK,
  figures: proseFigures(text),
});

const reading = (id: string, text: string): MaterialFigureReading => ({
  materialId: id,
  materialName: `${id}.txt`,
  kind: "text",
  pages: [{ page: 1, text }],
});

const shape = (found: readonly NumberConflictCandidate[]) =>
  found.map((candidate) => [
    candidate.label,
    candidate.key,
    candidate.members.map((member) => `${member.sourceId} ${member.token}`),
  ]);

const TWO_YEARS = ["2025年Q3营收 1502.25\n2026年Q3营收 1602.4", "2025年Q3营收 1500\n2026年Q3营收 1600"] as const;

describe("VAL-DATA-009: detection gives each period its own candidate (M7-SCR-009)", () => {
  it("makes one candidate per year when two sources state the quarter for two years", () => {
    const found = detectNumberConflicts([source("a", TWO_YEARS[0]), source("b", TWO_YEARS[1])]);
    assert.deepEqual(shape(found), [
      ["2025年Q3营收", "营收|2025年Q3", ["a 1502.25", "b 1500"]],
      ["2026年Q3营收", "营收|2026年Q3", ["a 1602.4", "b 1600"]],
    ]);
  });

  it("orders the candidates by their first figure, whatever order a source lists its years in", () => {
    const found = detectNumberConflicts([
      source("a", TWO_YEARS[0]),
      source("b", "2026年Q3营收 1600\n2025年Q3营收 1500"),
    ]);
    assert.deepEqual(
      found.map((candidate) => candidate.label),
      ["2025年Q3营收", "2026年Q3营收"],
    );
  });

  it("names the year that conflicts, not the first year the group happens to hold", () => {
    // 2025 agrees (1500 = 1500); only 2026 is 0.125 % apart.
    const found = detectNumberConflicts([
      source("a", "2025年Q3营收 1500\n2026年Q3营收 1600"),
      source("b", "2025年Q3营收 1500\n2026年Q3营收 1602"),
    ]);
    assert.deepEqual(shape(found), [["2026年Q3营收", "营收|2026年Q3", ["a 1600", "b 1602"]]]);
  });

  it("puts a figure that names no year into the candidate of each year it conflicts in", () => {
    const found = detectNumberConflicts([
      source("a", "Q3营收 1502.25"),
      source("b", "2025年Q3营收 1500\n2026年Q3营收 1510"),
    ]);
    assert.deepEqual(shape(found), [
      ["2025年Q3营收", "营收|2025年Q3", ["a 1502.25", "b 1500"]],
      ["2026年Q3营收", "营收|2026年Q3", ["a 1502.25", "b 1510"]],
    ]);
  });

  it("leaves a year-less figure out of a year it has no conflict in", () => {
    const found = detectNumberConflicts([
      source("a", TWO_YEARS[0]),
      source("b", TWO_YEARS[1]),
      source("c", "Q3营收 1610"),
    ]);
    assert.deepEqual(shape(found), [
      ["2025年Q3营收", "营收|2025年Q3", ["a 1502.25", "b 1500"]],
      ["2026年Q3营收", "营收|2026年Q3", ["a 1602.4", "b 1600", "c 1610"]],
    ]);
  });

  it("keeps one candidate, labelled as before, when the years do not split the group", () => {
    const found = detectNumberConflicts([source("a", "Q3营收 1502.25"), source("b", "2026年Q3营收 1500")]);
    assert.deepEqual(shape(found), [["Q3营收", "营收|2026年Q3", ["a 1502.25", "b 1500"]]]);
    const bare = detectNumberConflicts([source("a", "Q3营收 1502.25"), source("b", "Q3营收 1500")]);
    assert.deepEqual(shape(bare), [["Q3营收", "营收|Q3", ["a 1502.25", "b 1500"]]]);
  });

  it("keeps two year-less sources and a dated one that agree with them in one candidate", () => {
    const found = detectNumberConflicts([
      source("a", "Q3营收 1502.25"),
      source("b", "Q3营收 1500"),
      source("c", "2026年Q3营收 1500"),
    ]);
    assert.deepEqual(shape(found), [["Q3营收", "营收|2026年Q3", ["a 1502.25", "b 1500", "c 1500"]]]);
  });

  it("splits months the same way", () => {
    const found = detectNumberConflicts([
      source("a", "2025年3月营收 1502.25\n2026年3月营收 1602.4"),
      source("b", "2025年3月营收 1500\n2026年3月营收 1600"),
    ]);
    assert.deepEqual(
      found.map((candidate) => candidate.key),
      ["营收|2025年3月", "营收|2026年3月"],
    );
  });
});

describe("VAL-DATA-009: a page number speaks to the candidates whose period fits it", () => {
  const sources = [reading("a", TWO_YEARS[0]), reading("b", TWO_YEARS[1])];
  const input = (documents: readonly MaterialFigureReading[], pageText: string) => ({
    brief: "",
    documents,
    tables: [],
    pageText,
  });

  it("reports each year's conflict with only that year's values", () => {
    const found = pageNumberConflicts(input(sources, "2025年Q3营收 1502.25\n2026年Q3营收 1602.4"));
    assert.deepEqual(
      found.map((conflict) => [conflict.label, conflict.used.value, conflict.values.map((value) => value.value)]),
      [
        ["2025年Q3营收", "1502.25", ["1502.25", "1500"]],
        ["2026年Q3营收", "1602.4", ["1602.4", "1600"]],
      ],
    );
    assert.equal((pageConflictHint(found) ?? "").split("数字不一致：").length - 1, 2);
  });

  it("does not count one year's source value as the other side of another year's conflict", () => {
    // 1502.25 is A's 2025 value and 1600 is B's 2026 value: each year shows one side only.
    const found = pageNumberConflicts(input(sources, "2025年Q3营收 1502.25\n2026年Q3营收 1600"));
    assert.deepEqual(
      found.map((conflict) => conflict.used.value),
      ["1502.25", "1600"],
    );
  });

  it("is disclosed by a year whose two values are both on the page, and by that year only", () => {
    const found = pageNumberConflicts(input(sources, "2025年Q3营收 1502.25\n2025年Q3营收 1500\n2026年Q3营收 1602.4"));
    assert.deepEqual(
      found.map((conflict) => conflict.label),
      ["2026年Q3营收"],
    );
  });

  it("reports a candidate once however many numbers of the page speak to it", () => {
    const found = pageNumberConflicts(
      input(sources, "2025年Q3营收 1502.25\n2025年Q3营收 1502.25，2025年Q3 营收 1502.25"),
    );
    assert.equal(found.length, 1);
  });

  it("tells a number that names no year in each year's candidate, once each", () => {
    const withoutYear = [reading("a", "Q3营收 1502.25"), reading("b", "2025年Q3营收 1500\n2026年Q3营收 1500")];
    const found = pageNumberConflicts(input(withoutYear, "Q3营收 1500"));
    assert.deepEqual(
      found.map((conflict) => conflict.label),
      ["2025年Q3营收", "2026年Q3营收"],
    );
    assert.deepEqual(
      pageNumberConflicts(input(withoutYear, "2026年Q3营收 1500")).map((conflict) => conflict.label),
      ["2026年Q3营收"],
    );
  });

  it("takes no side for a year the candidate does not have, even through a member that names none", () => {
    const withoutYear = [reading("a", "Q3营收 1502.25"), reading("b", "2025年Q3营收 1500")];
    assert.deepEqual(pageNumberConflicts(input(withoutYear, "2026年Q3营收 1502.25")), []);
    assert.equal(pageNumberConflicts(input(withoutYear, "2025年Q3营收 1502.25")).length, 1);
    assert.equal(pageNumberConflicts(input(withoutYear, "Q3营收 1502.25")).length, 1);
  });
});

describe("VAL-DATA-009: pageStatesValue with the keys of a member and of its candidate", () => {
  const page = statedNumbers("2026年Q3营收 1500");

  it("needs the stated number to fit every key", () => {
    const quarter = labelKey("Q3营收")!;
    assert.equal(pageStatesValue(page, quarter, 1500), true);
    assert.equal(pageStatesValue(page, [quarter, labelKey("2026年Q3营收")!], 1500), true);
    assert.equal(pageStatesValue(page, [quarter, labelKey("2025年Q3营收")!], 1500), false);
    assert.equal(pageStatesValue(page, [], 1500), true);
  });

  it("still lets a number without any label fit every key", () => {
    const bare = statedNumbers("1500");
    assert.equal(pageStatesValue(bare, [labelKey("2025年Q3营收")!, labelKey("2026年Q3营收")!], 1500), true);
  });
});
