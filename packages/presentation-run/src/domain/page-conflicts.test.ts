/**
 * Which side of a number conflict a page takes (CAP-21, VAL-DATA-009), over hand-built readings:
 * the page's value is bound to its metric and period, a source is told apart by its material id
 * and not by its display name, and the detection budget is not spent on metrics the page leaves out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MaterialFigureReading } from "./material-figures.js";
import { pageConflictHint, pageNumberConflicts } from "./page-conflicts.js";

const reading = (materialId: string, materialName: string, text: string): MaterialFigureReading => ({
  materialId,
  materialName,
  kind: "text",
  pages: [{ page: 1, text }],
});

const input = (
  documents: readonly MaterialFigureReading[],
  pageText: string,
  extra: { readonly uploadOrder?: readonly string[] } = {},
) => ({ brief: "", documents, tables: [], pageText, ...extra });

const TWO_SOURCES = [
  reading("source-a", "source-a.txt", "Q3 Revenue 1502.25"),
  reading("source-b", "source-b.txt", "Q3 Revenue 1500"),
];

describe("VAL-DATA-009: the page's value is bound to its metric", () => {
  it("records the conflict when the page states one side under the metric (control)", () => {
    const found = pageNumberConflicts(input(TWO_SOURCES, "Q3 Revenue 1502.25"));
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.used, { source: "source-a.txt", value: "1502.25" });
    assert.ok(pageConflictHint(found)?.includes("Q3 Revenue"));
  });

  it("keeps the conflict, with the right winner, when the other side's value sits under another metric", () => {
    const found = pageNumberConflicts(input(TWO_SOURCES, "Q3 Revenue 1502.25\nQ3 Cost 1500"));
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.used, { source: "source-a.txt", value: "1502.25" });
    assert.deepEqual(
      found[0]!.values.map((value) => value.source),
      ["source-a.txt", "source-b.txt"],
    );
    assert.match(pageConflictHint(found) ?? "", /本稿采用 1502\.25（来自 source-a\.txt）/);
  });

  it("claims no source when the value appears only under another metric", () => {
    const found = pageNumberConflicts(input(TWO_SOURCES, "Q3 Cost 1500"));
    assert.deepEqual(found, []);
    assert.equal(pageConflictHint(found), undefined);
  });

  it("ignores the same value under the same metric of another period", () => {
    assert.deepEqual(pageNumberConflicts(input(TWO_SOURCES, "Q2 Revenue 1500")), []);
    const withPeriod = pageNumberConflicts(input(TWO_SOURCES, "Q3 Revenue 1500"));
    assert.equal(withPeriod.length, 1);
    assert.equal(withPeriod[0]!.used.source, "source-b.txt");
  });

  it("matches a page label that names the metric with extra words in front or no period", () => {
    const sources = [reading("a", "a.txt", "Q3 营收 1502.25 万元"), reading("b", "b.txt", "Q3 营收 1500 万元")];
    for (const page of ["本季度营收 1502.25 万元", "营收 1502.25 万元", "实现营收 1502.25 万元"]) {
      const found = pageNumberConflicts(input(sources, page));
      assert.equal(found.length, 1, page);
      assert.equal(found[0]!.used.value, "1502.25", page);
    }
    // A different quantity that merely contains the metric's word is not the metric.
    assert.deepEqual(pageNumberConflicts(input(sources, "营收目标 1500 万元")), []);
    assert.deepEqual(pageNumberConflicts(input(sources, "营收同比增长 1500 万元")), []);
  });

  it("still counts a number the page gives no metric label to", () => {
    // A figure card keeps the caption in another element, so the number stands alone on its line.
    const found = pageNumberConflicts(input(TWO_SOURCES, "Q3 Revenue\n1502.25"));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.used.value, "1502.25");
  });

  it("stays silent when the page states both values under the metric", () => {
    assert.deepEqual(pageNumberConflicts(input(TWO_SOURCES, "Q3 Revenue 1502.25\nQ3 Revenue 1500")), []);
  });
});

describe("VAL-DATA-009: a source is its material, not its file name", () => {
  const sameName = [
    reading("source-a", "shared.txt", "Q3 Revenue 1502.25"),
    reading("source-b", "shared.txt", "Q3 Revenue 1500"),
  ];

  it("reports a conflict between two materials that share a display name", () => {
    const found = pageNumberConflicts(input(sameName, "Q3 Revenue 1502.25"));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.values.length, 2);
  });

  it("tells the equal names apart by upload order and keeps the card line readable", () => {
    const found = pageNumberConflicts(input(sameName, "Q3 Revenue 1502.25"));
    assert.deepEqual(
      found[0]!.values.map((value) => value.source),
      ["shared.txt（同名第 1 份）", "shared.txt（同名第 2 份）"],
    );
    assert.equal(found[0]!.used.source, "shared.txt（同名第 1 份）");
    assert.match(
      pageConflictHint(found) ?? "",
      /shared\.txt（同名第 1 份） 为 1502\.25，shared\.txt（同名第 2 份） 为 1500；本稿采用 1502\.25（来自 shared\.txt（同名第 1 份））/,
    );
    // The manifest's upload order decides, not the order the run happened to read them in.
    const uploaded = pageNumberConflicts(
      input(sameName, "Q3 Revenue 1502.25", { uploadOrder: ["source-b", "source-a"] }),
    );
    assert.deepEqual(
      uploaded[0]!.values.map((value) => [value.source, value.value]),
      [
        ["shared.txt（同名第 2 份）", "1502.25"],
        ["shared.txt（同名第 1 份）", "1500"],
      ],
    );
  });

  it("leaves names alone when they are already different, or when only one of them is in the conflict", () => {
    const found = pageNumberConflicts(input(TWO_SOURCES, "Q3 Revenue 1502.25"));
    assert.deepEqual(
      found[0]!.values.map((value) => value.source),
      ["source-a.txt", "source-b.txt"],
    );
    const twin = [...TWO_SOURCES, reading("source-c", "source-a.txt", "Q4 Cost 20000")];
    const other = pageNumberConflicts(input(twin, "Q3 Revenue 1502.25"));
    assert.deepEqual(
      other[0]!.values.map((value) => value.source),
      ["source-a.txt", "source-b.txt"],
    );
  });

  it("does not count the same material twice", () => {
    const twice = [
      reading("source-a", "source-a.txt", "Q3 Revenue 1502.25\nQ3 Revenue 1500"),
      reading("source-a", "source-a.txt", "Q3 Revenue 1502.25"),
    ];
    assert.deepEqual(pageNumberConflicts(input(twice, "Q3 Revenue 1502.25")), []);
  });
});

describe("VAL-DATA-009: the detection budget is not spent before the page filter", () => {
  const labels = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India"];
  const values = labels.map((_, index) => 1000 + index * 100);
  const lines = (offset: number) => labels.map((label, index) => `Q3 ${label} ${values[index]! + offset}`);
  const nine = [
    reading("nine-a", "nine-a.txt", lines(2.25).join("\n")),
    reading("nine-b", "nine-b.txt", lines(0).join("\n")),
  ];

  it("records the one conflict the page uses even when it is the ninth in source order", () => {
    const found = pageNumberConflicts(input(nine, lines(2.25)[8]!));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.label, "Q3 India");
    assert.equal(found[0]!.used.value, "1802.25");
  });

  it("gives the same result when the relevant metric comes first (control)", () => {
    const first = (offset: number) => [lines(offset)[8]!, ...lines(offset).slice(0, 8)].join("\n");
    const reordered = [reading("nine-a", "nine-a.txt", first(2.25)), reading("nine-b", "nine-b.txt", first(0))];
    const found = pageNumberConflicts(input(reordered, lines(2.25)[8]!));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.label, "Q3 India");
  });

  it("keeps every conflict a page uses and bounds only the hint", () => {
    const found = pageNumberConflicts(input(nine, lines(2.25).join("\n")));
    assert.equal(found.length, 9);
    const hint = pageConflictHint(found) ?? "";
    assert.equal(hint.split("数字不一致：").length - 1, 8);
    assert.ok(hint.includes("另有 1 处数字不一致，没有逐条列出"), hint);
    assert.match(hint, /这条提示不阻止保存。$/);
    const eight = pageConflictHint(found.slice(0, 8)) ?? "";
    assert.equal(eight.includes("另有"), false);
  });
});
