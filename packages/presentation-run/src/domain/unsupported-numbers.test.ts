import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRODUCE_GATE_REL_FILES } from "../produce-gate-files.js";
import { applyWritePageProvenance } from "./material-figures.js";
import { queryMaterialResult } from "./material-query-hand.js";
import { writeMonthlyQueryMaterial } from "./material-query.testkit.js";
import { tempProject } from "./material-testkit.js";
import { ensureRunLedger, recordPageRevision, type RunToolContext } from "./run-ledger.js";

const CONTEXT: RunToolContext = {
  commandId: "unsupported-cmd",
  contextEpochId: "unsupported-epoch",
};

const MONTHLY_QUERY = {
  materialId: "xlsx-1",
  part: "sheet:经营指标",
  groupBy: ["类别"],
  measures: [
    { op: "sum", column: "2026-09", as: "本月" },
    { op: "sum", column: "2025-09", as: "去年同月" },
  ],
  derive: [{ as: "同比", op: "yoy", of: "本月", base: "去年同月" }],
};

function project(options: { queried: boolean }): string {
  const root = tempProject("oss-unsupported-numbers-");
  writeMonthlyQueryMaterial(root, "xlsx-1");
  ensureRunLedger(root, {
    manifestSha256: "f".repeat(64),
    requirementsId: "unsupported-numbers",
    requirements: [],
  });
  if (options.queried) {
    const result = queryMaterialResult(root, CONTEXT, MONTHLY_QUERY);
    assert.equal(result.ok, true, result.detail);
  }
  return root;
}

function chartPage(rows: (string | number)[][]) {
  return {
    id: "p1",
    pageType: "content",
    elements: [
      {
        elementId: "p1-chart",
        elementType: "chart",
        bounds: [80, 160, 800, 300],
        data: { cols: ["类别", "本月"], rows },
        series: [{ name: "本月", type: "bar", encode: { x: "类别", y: "本月" } }],
      },
    ],
  };
}

function tablePage(rows: string[][]) {
  return {
    id: "p1",
    pageType: "content",
    elements: [{ elementId: "p1-table", elementType: "table", bounds: [80, 160, 800, 200], rows }],
  };
}

function write(root: string, content: unknown, basis: string | undefined) {
  const revision = recordPageRevision(root, CONTEXT, "p1", content);
  return applyWritePageProvenance(
    root,
    CONTEXT,
    { pageId: "p1", revision: revision.revision, pageSha256: revision.pageSha256 },
    content,
    basis ? { provenance: { basis } } : {},
  );
}

describe("write_page hint: chart and table numbers no read file or computed result holds", () => {
  it("is part of the produce-path fingerprint", () => {
    assert.ok(PRODUCE_GATE_REL_FILES.includes("packages/presentation-run/dist/domain/unsupported-numbers.js"));
  });

  it("names the chart values that are in neither, and not the ones a query computed", () => {
    const root = project({ queried: true });
    const hint = write(
      root,
      chartPage([
        ["指标A", 1250.5],
        ["指标C", 555.55],
      ]),
      "material",
    );
    assert.match(hint ?? "", /图表和表格里有 1 个数值没有出现在已读资料或计算结果里/);
    assert.match(hint ?? "", /555\.55/);
    assert.doesNotMatch(hint ?? "", /1250\.5/);
    assert.match(hint ?? "", /query_material/);
    assert.match(hint ?? "", /暂无本期数据/);
    assert.match(hint ?? "", /这条提示不阻止保存/);
  });

  it("stays silent when every number is a computed cell, also a percentage shown without its sign", () => {
    const root = project({ queried: true });
    const hint = write(
      root,
      chartPage([
        ["指标A", 1250.5],
        ["指标C", 560.75],
        ["同比", 25.05],
      ]),
      "material",
    );
    assert.doesNotMatch(hint ?? "", /没有出现在已读资料或计算结果里/);
  });

  it("checks table cells too, and skips years, small counts and thousands-separated spellings of a computed cell", () => {
    const root = project({ queried: true });
    const hint = write(
      root,
      tablePage([
        ["类别", "本月", "排名", "年份"],
        ["指标A", "1,250.5", "12", "2026"],
        ["指标D", "777.77", "3", "2025"],
      ]),
      "material",
    );
    assert.match(hint ?? "", /图表和表格里有 1 个数值没有出现在已读资料或计算结果里/);
    assert.match(hint ?? "", /777\.77/);
    assert.doesNotMatch(hint ?? "", /1,250\.5|2026|2025/);
  });

  it("lists at most five examples and still counts all of them", () => {
    const root = project({ queried: true });
    const rows = Array.from({ length: 8 }, (_, index) => [`类别${index}`, 900.11 + index]);
    const hint = write(root, chartPage(rows), "material");
    assert.match(hint ?? "", /图表和表格里有 8 个数值/);
    assert.match(hint ?? "", /900\.11/);
    assert.doesNotMatch(hint ?? "", /907\.11/);
  });

  it("is silent for pages declared as mock or mixed, for undeclared pages, and when nothing was read or computed", () => {
    const made = chartPage([["指标C", 555.55]]);
    const queried = project({ queried: true });
    for (const basis of ["mock", "mixed", undefined]) {
      assert.doesNotMatch(write(queried, made, basis) ?? "", /没有出现在已读资料或计算结果里/, String(basis));
    }
    const unread = project({ queried: false });
    assert.doesNotMatch(write(unread, made, "material") ?? "", /没有出现在已读资料或计算结果里/);
  });
});
