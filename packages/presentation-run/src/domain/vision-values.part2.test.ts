import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMaterialChunk } from "./material-content.js";
import { recordMaterialNotesResult } from "./material-notes.js";
import { applyWritePageProvenance, type MaterialFiguresFact } from "./material-figures.js";
import { verifyMaterial } from "./material-pack.js";
import { imageFixture, tempProject, writeMaterialFixture } from "./material-testkit.js";
import { ensureRunLedger, readRunLedger, recordMaterialChunk, type RunToolContext } from "./run-ledger.js";
import type { TemplateChartSource } from "./template-chart-provenance.js";
import { visionValuesFor, type VerifiedReadValue } from "./vision-values.js";

type SpellingCase = Readonly<{
  name: string;
  readValues: readonly unknown[];
  page: unknown;
  file?: string;
  marked: readonly string[];
}>;

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

/**
 * Equivalent spellings of one figure across the read record, the page (text,
 * native chart and table cells), and a read file. Each row runs the real
 * write_page provenance chain: notes are recorded, then the page is checked.
 */
const SPELLINGS: readonly SpellingCase[] = [
  // Trailing zeros: the comparison key drops them; the recorded value keeps them.
  {
    name: "a read 89.60% matches a native chart cell that serialises as 89.6",
    readValues: [{ label: "达标率", value: "89.60%" }],
    page: chartPage("p1", [["1月", 89.6]]),
    marked: ["89.60%"],
  },
  {
    name: "a read 89.60% matches a native chart cell holding the string 89.60",
    readValues: [{ label: "达标率", value: "89.60%" }],
    page: chartPage("p1", [["1月", "89.60"]]),
    marked: ["89.60%"],
  },
  {
    name: "a read 89.60% matches page text 89.6%",
    readValues: [{ label: "达标率", value: "89.60%" }],
    page: page("p1", "达标率 89.6%"),
    marked: ["89.60%"],
  },
  {
    name: "a read 89.6% matches page text 89.60%",
    readValues: [{ label: "达标率", value: "89.6%" }],
    page: page("p1", "达标率 89.60%"),
    marked: ["89.6%"],
  },
  {
    name: "a read -12.00% matches a native chart cell -12 and keeps its minus",
    readValues: [{ label: "同比", value: "-12.00%" }],
    page: chartPage("p1", [["本月", -12]]),
    marked: ["-12.00%"],
  },
  {
    name: "a read -12.00% matches page text -12% and keeps its minus",
    readValues: [{ label: "同比", value: "-12.00%" }],
    page: page("p1", "同比 -12%"),
    marked: ["-12.00%"],
  },
  {
    name: "a read 0.50 matches a native chart cell that serialises as 0.5",
    readValues: [{ label: "系数", value: "0.50" }],
    page: chartPage("p1", [["本月", 0.5]]),
    marked: ["0.50"],
  },
  {
    name: "a read 0.50 matches page text 0.5",
    readValues: [{ label: "系数", value: "0.50" }],
    page: page("p1", "系数 0.5"),
    marked: ["0.50"],
  },
  {
    name: "a read 89.60% matches a native table cell holding 89.6",
    readValues: [{ label: "达标率", value: "89.60%" }],
    page: tablePage("p1", [
      ["指标", "达标率"],
      ["1月", "89.6"],
    ]),
    marked: ["89.60%"],
  },
  {
    name: "a read 1234.50 matches page text 1,234.5 with a thousands separator",
    readValues: [{ label: "销量", value: "1234.50", unit: "件" }],
    page: page("p1", "合计 1,234.5 件"),
    marked: ["1234.50"],
  },
  {
    name: "a read 1,234 matches page text 1234 without a separator",
    readValues: [{ label: "销量", value: "1,234", unit: "件" }],
    page: page("p1", "合计 1234 件"),
    marked: ["1,234"],
  },
  // Leading zeros: `.5` and `05%` are the same numbers as `0.5` and `5%`.
  {
    name: "a read .5 matches page text 0.5",
    readValues: [{ label: "系数", value: ".5" }],
    page: page("p1", "系数 0.5"),
    marked: [".5"],
  },
  {
    name: "a read 0.5 matches page text .5",
    readValues: [{ label: "系数", value: "0.5" }],
    page: page("p1", "系数 .5"),
    marked: ["0.5"],
  },
  {
    name: "a read 05% matches page text 5%",
    readValues: [{ label: "增长率", value: "05%" }],
    page: page("p1", "增长 5%"),
    marked: ["05%"],
  },
  // Full-width digits, percent sign, full stop, minus and plus fold to ASCII for matching only.
  {
    name: "a read in full-width digits, ．and ％ matches a native chart cell 89.6",
    readValues: [{ label: "达标率", value: "８９．６０％" }],
    page: chartPage("p1", [["1月", 89.6]]),
    marked: ["８９．６０％"],
  },
  {
    name: "a read 89.60% matches page text in full-width digits ８９．６％",
    readValues: [{ label: "达标率", value: "89.60%" }],
    page: page("p1", "达标率 ８９．６％"),
    marked: ["89.60%"],
  },
  {
    name: "a read with a full-width minus －12.00% matches page text -12%",
    readValues: [{ label: "同比", value: "－12.00%" }],
    page: page("p1", "同比 -12%"),
    marked: ["－12.00%"],
  },
  {
    name: "a read with a full-width plus ＋7.25％ matches page text 7.25%",
    readValues: [{ label: "增速", value: "＋7.25％" }],
    page: page("p1", "增速 7.25%"),
    marked: ["＋7.25％"],
  },
  {
    name: "a full-width comma between digit groups is punctuation, not a thousands separator",
    readValues: [{ label: "销量", value: "1,234", unit: "件" }],
    page: page("p1", "合计 １，２３４ 件"),
    marked: [],
  },
  // A separate unit field: `%` (or `％`) qualifies like an inline percent sign.
  {
    name: "a separate % unit on a read 5 qualifies and matches page text 5%",
    readValues: [{ label: "增长率", value: "5", unit: "%" }],
    page: page("p1", "增长 5%"),
    marked: ["5%"],
  },
  {
    name: "a separate % unit on a read 0 qualifies and matches page text 0%",
    readValues: [{ label: "缺口", value: "0", unit: "%" }],
    page: page("p1", "缺口 0%"),
    marked: ["0%"],
  },
  {
    name: "a separate full-width percent unit is recorded as 5％ and matches page text 5%",
    readValues: [{ label: "增长率", value: "5", unit: "％" }],
    page: page("p1", "增长 5%"),
    marked: ["5％"],
  },
  {
    name: "a separate % unit on a trailing-zero read matches a native chart cell 89.6",
    readValues: [{ label: "达标率", value: "89.60", unit: "%" }],
    page: chartPage("p1", [["1月", 89.6]]),
    marked: ["89.60%"],
  },
  {
    name: "a separate % unit keeps the minus of a negative read",
    readValues: [{ label: "同比", value: "-5", unit: "%" }],
    page: page("p1", "同比 -5%"),
    marked: ["-5%"],
  },
  {
    name: "a separate % unit on a value that already has a percent sign is not doubled",
    readValues: [{ label: "增长率", value: "5%", unit: "%" }],
    page: page("p1", "增长 5%"),
    marked: ["5%"],
  },
  {
    name: "a separate % unit that a read file also states is vouched like an inline percent",
    readValues: [{ label: "增长率", value: "5", unit: "%" }],
    file: "增长率 5%",
    page: page("p1", "增长 5%"),
    marked: [],
  },
  {
    name: "a separate unit that is not a percent leaves a single digit unmarked (recorded residual)",
    readValues: [{ label: "人数", value: "5", unit: "人" }],
    page: page("p1", "共 5 人"),
    marked: [],
  },
  // A lone unsigned digit in running text is a page number, a step or a count, so it
  // states a percentage only with its % sign. A whole-figure cell (chart value, table
  // number) is data: its bare digit can state the percentage under a % header.
  {
    name: "a separate % unit on a read 5 matches a native chart cell 5",
    readValues: [{ label: "增长率", value: "5", unit: "%" }],
    page: chartPage("p1", [["本月", 5]]),
    marked: ["5%"],
  },
  {
    name: "a separate % unit on a read 5 matches a native table cell 5",
    readValues: [{ label: "增长率", value: "5", unit: "%" }],
    page: tablePage("p1", [
      ["指标", "增长率(%)"],
      ["本月", "5"],
    ]),
    marked: ["5%"],
  },
  {
    name: "a separate % unit on a read 5 does not match a page number or step 5",
    readValues: [{ label: "增长率", value: "5", unit: "%" }],
    page: page("p1", "第 5 页 · 流程说明"),
    marked: [],
  },
  {
    name: "an inline 5% does not match a page number or step 5",
    readValues: [{ label: "增长率", value: "5%" }],
    page: page("p1", "第 5 步 · 收尾"),
    marked: [],
  },
  {
    name: "a chart category 1月 does not match a separate % unit on a read 1",
    readValues: [{ label: "增长率", value: "1", unit: "%" }],
    page: chartPage("p1", [["1月", 89.6]]),
    marked: [],
  },
  {
    name: "a chart year category does not match a read 2026%",
    readValues: [{ label: "增长率", value: "2026%" }],
    page: chartPage("p1", [[2026, 89.6]]),
    marked: [],
  },
  // A plus sign is a positive figure: it matches an unsigned spelling on both sides.
  {
    name: "a read with a plus sign matches page text without it",
    readValues: [{ label: "增速", value: "+7.25%" }],
    page: page("p1", "增速 7.25%"),
    marked: ["+7.25%"],
  },
  {
    name: "a read file's +7.25% is positive and vouches for an unsigned read",
    readValues: [{ label: "增速", value: "7.25%" }],
    file: "增速 +7.25%",
    page: page("p1", "增速 7.25%"),
    marked: [],
  },
  // Read files: the same normalisation applies to file text, with the same sign rule.
  {
    name: "a read file's 89.6% vouches for a read 89.60% on the page",
    readValues: [{ label: "达标率", value: "89.60%" }],
    file: "达标率 89.6%",
    page: page("p1", "达标率 89.60%"),
    marked: [],
  },
  {
    name: "a read file's -12% vouches for a read -12.00% of the same sign",
    readValues: [{ label: "同比", value: "-12.00%" }],
    file: "同比 -12%",
    page: page("p1", "同比 -12.00%"),
    marked: [],
  },
  {
    name: "a read file's unsigned 12.0% does not vouch for a read -12.00%",
    readValues: [{ label: "同比", value: "-12.00%" }],
    file: "同比 12.0%",
    page: page("p1", "同比 -12.00%"),
    marked: ["-12.00%"],
  },
  {
    name: "a read file's .5 vouches for a read 0.50 on the page",
    readValues: [{ label: "系数", value: "0.50" }],
    file: "系数 .5",
    page: page("p1", "系数 0.50"),
    marked: [],
  },
  {
    name: "a read file's full-width ８９．６％ vouches for a read 89.60%",
    readValues: [{ label: "达标率", value: "89.60%" }],
    file: "达标率 ８９．６％",
    page: page("p1", "达标率 89.60%"),
    marked: [],
  },
  {
    name: "a read file's 1,234.5 vouches for a read 1234.50",
    readValues: [{ label: "销量", value: "1234.50", unit: "件" }],
    file: "合计 1,234.5 件",
    page: page("p1", "合计 1234.50 件"),
    marked: [],
  },
];

describe("VAL-IMG-012: every spelling of one read figure is compared the same way", () => {
  for (const spelling of SPELLINGS) {
    it(spelling.name, () => {
      const root = project();
      if (spelling.file !== undefined) materializeReport(root, spelling.file);
      recordReadValues(root, [...spelling.readValues]);
      const hint = applyWritePageProvenance(root, CONTEXT, revisionOf("p1"), spelling.page, {});
      assert.deepEqual(
        (figuresOf(root, "p1").visionValues ?? []).map((item) => item.value),
        [...spelling.marked],
      );
      if (spelling.marked.length) {
        assert.ok(hint?.includes(`本页的 ${spelling.marked.join("、")} 来自资料`), hint);
      } else {
        assert.doesNotMatch(hint ?? "", /看图识别/);
      }
    });
  }

  it("a read deck's chart value 89.6 vouches for a read 89.60% on the page", () => {
    const chart: TemplateChartSource = {
      sourcePage: 1,
      chartId: "chart-1",
      title: "达标率",
      type: "bar",
      categories: ["1月"],
      series: [{ name: "达标率", categories: ["1月"], values: [89.6] }],
      sourcePeriods: [],
    };
    const readValues: VerifiedReadValue[] = [{ materialId: "img-a", value: "89.60%" }];
    const values = visionValuesFor({
      pageText: "达标率 89.60%",
      readValues,
      readings: [{ materialId: "deck-a", materialName: "模板.pptx", pages: [], templateCharts: [chart] }],
    });
    assert.deepEqual(values, []);
  });
});
