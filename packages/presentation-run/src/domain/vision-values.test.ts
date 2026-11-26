import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildDeliveryProvenance } from "./delivery-provenance.js";
import { readMaterialChunk } from "./material-content.js";
import { recordMaterialNotesResult } from "./material-notes.js";
import { applyWritePageProvenance, type MaterialFiguresFact } from "./material-figures.js";
import { verifyMaterial } from "./material-pack.js";
import { imageFixture, tempProject, writeMaterialFixture } from "./material-testkit.js";
import {
  ensureRunLedger,
  readRunLedger,
  recordMaterialChunk,
  recordPageRevision,
  type DeckComposedFact,
  type RunToolContext,
} from "./run-ledger.js";

const CONTEXT: RunToolContext = { commandId: "vision-cmd", contextEpochId: "vision-epoch" };

function project(): string {
  const root = tempProject();
  writeMaterialFixture(root, imageFixture("img-a", "现场截图.png", 1200, 800));
  ensureRunLedger(root, {
    manifestSha256: "f".repeat(64),
    requirementsId: "vision-values",
    requirements: [],
  });
  return root;
}

/** A PDF-like document whose first page carries the figure the file itself states. */
function materializeReport(root: string, firstPage = "2026年1-2月 达标率 89.64% 87.53%"): void {
  writeMaterialFixture(root, {
    id: "doc-a",
    name: "月报.pdf",
    kind: "document",
    parser: "pdf-unpdf-v1",
    originalBytes: Buffer.from("%PDF-1.4 vision fixture"),
    derivative: {
      document: {
        pageCount: 2,
        pages: [
          { index: 1, text: firstPage },
          { index: 2, text: "其余内容没有数字。" },
        ],
      },
    },
  });
  const material = verifyMaterial(root, "doc-a");
  const chunk = readMaterialChunk({ material });
  recordMaterialChunk(root, CONTEXT, {
    materialId: chunk.materialId,
    materialSha256: chunk.materialSha256,
    part: chunk.part,
    chunkIndex: chunk.chunkIndex,
    chunkSha256: chunk.chunkSha256,
    chunkCount: chunk.chunkCount,
  });
}

/** A table whose only data row carries the figure, read as one row window. */
function materializeTable(root: string, body = "指标,数值\n达标率,89.64%\n"): void {
  writeMaterialFixture(root, {
    id: "csv-a",
    name: "达标.csv",
    kind: "table",
    parser: "csv-v1",
    originalBytes: Buffer.from(body),
  });
  const material = verifyMaterial(root, "csv-a");
  const chunk = readMaterialChunk({ material });
  recordMaterialChunk(root, CONTEXT, {
    materialId: chunk.materialId,
    materialSha256: chunk.materialSha256,
    part: chunk.part,
    chunkIndex: chunk.chunkIndex,
    chunkSha256: chunk.chunkSha256,
    rowStart: 1,
    rowEnd: chunk.rowsRead,
    rowTotal: chunk.rowsRead,
  });
}

function page(id: string, body: string) {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: `${id}-body`,
        elementType: "text",
        bounds: [80, 160, 800, 60],
        content: { text: body, fontSize: 16 },
      },
    ],
  };
}

/** A page whose only element is a native chart with the given data rows. */
function chartPage(id: string, rows: (string | number)[][]) {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: `${id}-chart`,
        elementType: "chart",
        bounds: [80, 160, 800, 360],
        data: { cols: ["月份", "达标率"], rows },
        series: [{ type: "bar", encode: { x: "月份", y: "达标率" } }],
      },
    ],
  };
}

/** A native table whose rows hold plain text cells, as the editor writes them. */
function tablePage(id: string, rows: string[][]) {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: `${id}-table`,
        elementType: "table",
        bounds: [80, 160, 800, 300],
        rows,
      },
    ],
  };
}

function revisionOf(pageId: string) {
  return { pageId, revision: 1, pageSha256: "a".repeat(64) };
}

function figuresOf(root: string, pageId: string): MaterialFiguresFact {
  const fact = (readRunLedger(root)?.facts ?? []).find(
    (entry): entry is MaterialFiguresFact => entry.type === "page.material-figures" && entry.pageId === pageId,
  );
  assert.ok(fact, `page.material-figures must be recorded for ${pageId}`);
  return fact;
}

function recordReadValues(root: string, readValues: unknown[]): void {
  recordMaterialNotesResult(root, CONTEXT, {
    materialId: "img-a",
    caption: "柱状图给出各月达标率",
    suggestedUse: "page",
    readValues,
  });
}

describe("VAL-IMG-012: numbers read from an image are marked 请核对", () => {
  it("records a page number read from an image as a vision-read value with a non-blocking hint", () => {
    const root = project();
    recordReadValues(root, [{ label: "达标率", value: "89.64%", period: "2026年1-2月" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "达标率 89.64%，较上月提升"), {});
    assert.match(hint ?? "", /数字是看图识别的，未经文件校验/);
    assert.match(hint ?? "", /这条提示不阻止保存/);
    const fact = figuresOf(root, "p1");
    assert.deepEqual(fact.visionValues, [{ value: "89.64%", materialId: "img-a", basis: "vision-read" }]);
    assert.deepEqual(fact.matches, []);
  });

  it("reports a value that also appears in a read document chunk as a file match instead", () => {
    const root = project();
    materializeReport(root);
    recordReadValues(root, [{ label: "达标率", value: "89.64%" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "达标率 89.64%"), {});
    assert.doesNotMatch(hint ?? "", /看图识别/);
    const fact = figuresOf(root, "p1");
    assert.deepEqual(fact.visionValues, []);
    assert.deepEqual(
      fact.matches.map((match) => [match.value, match.materialId, match.sourcePage]),
      [["89.64%", "doc-a", 1]],
    );
  });

  it("does not mark a value that a read table row also states", () => {
    const root = project();
    materializeTable(root);
    recordReadValues(root, [{ label: "达标率", value: "89.64%" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "达标率 89.64%"), {});
    assert.doesNotMatch(hint ?? "", /看图识别/);
    assert.deepEqual(figuresOf(root, "p1").visionValues, []);
  });

  it("treats a percentage and its bare number as the same figure", () => {
    const root = project();
    recordReadValues(root, [{ label: "达标率", value: "89.64" }]);
    applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "达标率 89.64%"), {});
    assert.deepEqual(figuresOf(root, "p1").visionValues, [
      { value: "89.64", materialId: "img-a", basis: "vision-read" },
    ]);
  });

  it("ignores stored notes whose text no longer matches the ledger digest (fail closed)", () => {
    const root = project();
    recordReadValues(root, [{ label: "达标率", value: "89.64%" }]);
    const file = path.join(root, "_agent", "material-notes.v1.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      notes: { notes: { readValues: { value: string }[] } }[];
    };
    stored.notes[0]!.notes.readValues[0]!.value = "12.00%";
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "达标率 12.00%"), {});
    assert.equal(hint, undefined);
    assert.deepEqual(figuresOf(root, "p1").visionValues, []);
  });

  it("does not mark a single digit that only appears as a page number or step", () => {
    const root = project();
    recordReadValues(root, [{ label: "人数", value: "3" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "第 3 页 · 流程说明"), {});
    assert.equal(hint, undefined);
    assert.deepEqual(figuresOf(root, "p1").visionValues, []);
  });

  it("matches a read value written without thousands separators", () => {
    const root = project();
    recordReadValues(root, [{ label: "人数", value: "2300", unit: "人" }]);
    applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "累计 2,300 人"), {});
    assert.deepEqual(figuresOf(root, "p1").visionValues, [
      { value: "2300", materialId: "img-a", basis: "vision-read" },
    ]);
  });

  it("carries the vision-read value onto the delivery provenance page for the card", () => {
    const root = project();
    recordReadValues(root, [{ label: "达标率", value: "89.64%" }]);
    const revision = recordPageRevision(root, CONTEXT, "p1", page("p1", "达标率 89.64%"));
    applyWritePageProvenance(
      root,
      CONTEXT,
      { pageId: "p1", revision: revision.revision, pageSha256: revision.pageSha256 },
      page("p1", "达标率 89.64%"),
      {},
    );
    const seal: DeckComposedFact = {
      type: "deck.composed",
      factId: "vision-seal",
      at: "2026-01-01T00:00:00.000Z",
      contextEpochId: CONTEXT.contextEpochId,
      title: "看图数字",
      deckSha256: "c".repeat(64),
      pageRevisions: { p1: revision.pageSha256 },
    };
    const built = buildDeliveryProvenance(root, seal);
    assert.deepEqual(built.file.pages[0]!.visionValues, [
      { value: "89.64%", materialId: "img-a", basis: "vision-read" },
    ]);
  });

  it("marks a recorded count of two or more digits, such as 42 起", () => {
    const root = project();
    recordReadValues(root, [{ label: "投诉量", value: "42", unit: "起" }]);
    const hint = applyWritePageProvenance(
      root,
      CONTEXT,
      revisionOf("p1"),
      page("p1", "本月投诉 42 起，较上月下降"),
      {},
    );
    assert.match(hint ?? "", /数字是看图识别的，未经文件校验/);
    assert.deepEqual(figuresOf(root, "p1").visionValues, [{ value: "42", materialId: "img-a", basis: "vision-read" }]);
  });

  it("marks recorded percentages and decimals, including 5%, 0%, 100% and 0.5", () => {
    const root = project();
    recordReadValues(root, [
      { label: "增长", value: "5%" },
      { label: "缺口", value: "0%" },
      { label: "完成", value: "100%" },
      { label: "系数", value: "0.5" },
    ]);
    applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "增长 5%，缺口 0%，完成 100%，系数 0.5"), {});
    assert.deepEqual(
      (figuresOf(root, "p1").visionValues ?? []).map((item) => item.value),
      ["5%", "0%", "100%", "0.5"],
    );
  });

  it("matches a recorded 89.64% against a native chart cell that holds 89.64", () => {
    const root = project();
    recordReadValues(root, [{ label: "达标率", value: "89.64%" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), chartPage("p1", [["1月", 89.64]]), {});
    assert.match(hint ?? "", /数字是看图识别的/);
    assert.deepEqual(figuresOf(root, "p1").visionValues, [
      { value: "89.64%", materialId: "img-a", basis: "vision-read" },
    ]);
  });

  it("lets a read table's bare 89.64 under a percent header vouch for the page's 89.64%", () => {
    const root = project();
    materializeTable(root, "指标,达标率(%)\n达标率,89.64\n");
    recordReadValues(root, [{ label: "达标率", value: "89.64%" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "达标率 89.64%"), {});
    assert.doesNotMatch(hint ?? "", /看图识别/);
    assert.deepEqual(figuresOf(root, "p1").visionValues, []);
  });

  it("keeps the minus sign of a recorded -12.34%, and a file's unsigned 12.34% does not vouch for it", () => {
    const root = project();
    materializeReport(root, "2026年1-2月 达标率 12.34%");
    recordReadValues(root, [{ label: "同比", value: "-12.34%" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "同比下降 -12.34%"), {});
    assert.match(hint ?? "", /本页的 -12\.34% 来自资料/);
    assert.deepEqual(figuresOf(root, "p1").visionValues, [
      { value: "-12.34%", materialId: "img-a", basis: "vision-read" },
    ]);
  });

  it("still marks a read -12.34% when the page states the magnitude as 下降 12.34%", () => {
    const root = project();
    recordReadValues(root, [{ label: "同比", value: "-12.34%" }]);
    applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "同比下降 12.34%"), {});
    assert.deepEqual(figuresOf(root, "p1").visionValues, [
      { value: "-12.34%", materialId: "img-a", basis: "vision-read" },
    ]);
  });

  it("vouches for a read negative figure only with a file that states the same negative figure", () => {
    const root = project();
    materializeReport(root, "2026年1-2月 同比 -12.34%");
    recordReadValues(root, [{ label: "同比", value: "\u221212.34%" }]);
    applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "同比下降 12.34%"), {});
    assert.deepEqual(figuresOf(root, "p1").visionValues, []);
  });

  it("keeps the sign character as recorded for U+2212, U+FF0D and plus", () => {
    const root = project();
    recordReadValues(root, [
      { label: "同比", value: "\u221212.34%" },
      { label: "环比", value: "\uFF0D3.5%" },
      { label: "增速", value: "+7.25%" },
    ]);
    applyWritePageProvenance(
      root,
      CONTEXT,
      revisionOf("p1"),
      page("p1", "同比 \u221212.34%，环比 \uFF0D3.5%，增速 +7.25%"),
      {},
    );
    assert.deepEqual(
      (figuresOf(root, "p1").visionValues ?? []).map((item) => item.value),
      ["\u221212.34%", "\uFF0D3.5%", "+7.25%"],
    );
  });

  it("marks a signed single digit, because a sign marks a figure rather than a page number", () => {
    const root = project();
    recordReadValues(root, [{ label: "环比", value: "-5" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "环比 -5，较上月下降"), {});
    assert.match(hint ?? "", /数字是看图识别的/);
    assert.deepEqual(figuresOf(root, "p1").visionValues, [{ value: "-5", materialId: "img-a", basis: "vision-read" }]);
  });

  it("reads a figure that ends a sentence with a full stop", () => {
    const root = project();
    recordReadValues(root, [
      { label: "投诉量", value: "42" },
      { label: "增速", value: "89.64" },
    ]);
    applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "本月投诉量为 42. 增速 89.64."), {});
    assert.deepEqual(
      (figuresOf(root, "p1").visionValues ?? []).map((item) => item.value),
      ["42", "89.64"],
    );
  });

  it("does not read a range hyphen in 2023-2024 or 2023-12月 as a minus sign that vouches for -2024 or -12", () => {
    const root = project();
    materializeReport(root, "统计期 2023-2024，1-3月，2023-12月 达标率 87.53%");
    recordReadValues(root, [
      { label: "环比", value: "-12" },
      { label: "区间", value: "-2024" },
    ]);
    applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "环比 -12，-2024"), {});
    assert.deepEqual(figuresOf(root, "p1").visionValues, [
      { value: "-12", materialId: "img-a", basis: "vision-read" },
      { value: "-2024", materialId: "img-a", basis: "vision-read" },
    ]);
  });

  it("keeps bare years and single digits unmarked", () => {
    const root = project();
    recordReadValues(root, [
      { label: "年份", value: "2026" },
      { label: "页码", value: "3" },
    ]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "2026 年 第 3 页"), {});
    assert.equal(hint, undefined);
    assert.deepEqual(figuresOf(root, "p1").visionValues, []);
  });

  it("keeps a recorded 2023-2024 range, read as a range, out of the vision values", () => {
    const root = project();
    recordReadValues(root, [{ label: "统计期", value: "2023-2024" }]);
    const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), page("p1", "统计期 2023-2024"), {});
    assert.equal(hint, undefined);
    assert.deepEqual(figuresOf(root, "p1").visionValues, []);
  });
});

/** One read figure as a model may spell it, and the vision values the page must list for it. */
type SpellingCase = Readonly<{
  name: string;
  readValues: readonly unknown[];
  page: unknown;
  /** Text of a read document page, when a read file states the figure. */
  file?: string;
  /** Values listed for the page, as recorded; empty when nothing is marked. */
  marked: readonly string[];
}>;
