/**
 * Number conflicts (CAP-21, VAL-DATA-009) through the real domain hands: `read_material` for a
 * workbook and a document, `write_page` carrying the non-blocking hint, the `page.number-conflicts`
 * fact, and `compose_deck` writing `conflicts[]` into the delivery provenance.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROVENANCE_SUMMARY_MAX_BYTES } from "./delivery-provenance.js";
import { writeMaterialFixture } from "./material-testkit.js";
import {
  call,
  composeFile,
  conflictFacts,
  emptyProject,
  hintOf,
  readIds,
  write,
  writeDocument,
  type Cleanup,
} from "./number-conflicts-testkit.js";

const TABLE_ID = "xlsx-quarter";
const DOCUMENT_ID = "pdf-brief";
const SPEC_LINE =
  "数字不一致：『Q3 营收』季度经营.xlsx 为 1502.25 万，运营简报.pdf 为 1500 万；本稿采用 1502.25 万（来自 季度经营.xlsx）";

function writeWorkbook(root: string, id: string, name: string, q3: number): void {
  const rows = [
    ["Q1", 1234.5, 410.2],
    ["Q2", 1388, 455.7],
    ["Q3", q3, 498.1],
    ["Q4", 1675.8, 560.35],
  ];
  writeMaterialFixture(root, {
    id,
    name,
    kind: "table",
    parser: "xlsx-ooxml-v1",
    originalBytes: Buffer.from(`workbook ${id}`),
    derivative: {
      table: {
        sheetCount: 1,
        rowCount: rows.length,
        sheets: [
          {
            name: "季度营收",
            hidden: false,
            rowCount: rows.length,
            colCount: 3,
            headerRow: ["季度", "营收(万元)", "毛利(万元)"],
            headerRowIndex: 1,
            columns: [],
            rows,
          },
        ],
      },
    },
    parts: [{ part: "sheet:季度营收", label: "工作表「季度营收」", rows: rows.length, cols: 3 }],
  });
}

function project(t: Cleanup, options: { q3Table?: number; q3Document?: number; brief?: string } = {}): string {
  const root = emptyProject(t, options.brief);
  writeWorkbook(root, TABLE_ID, "季度经营.xlsx", options.q3Table ?? 1502.25);
  writeDocument(root, DOCUMENT_ID, "运营简报.pdf", `Q3 营收 ${options.q3Document ?? 1500} 万元，同比增长 8.2%。`);
  return root;
}

const readBoth = (root: string) => readIds(root, [TABLE_ID, DOCUMENT_ID]);

function page(id: string, body: string, provenance?: unknown) {
  return {
    id,
    pageType: "content",
    ...(provenance === undefined ? {} : { provenance }),
    elements: [`汇报 ${id}`, body].map((text, index) => ({
      elementId: `${id}-t${index}`,
      elementType: "text",
      bounds: [80, 80 + index * 80, 800, 60] as [number, number, number, number],
      content: { text, fontSize: index === 0 ? 28 : 20 },
    })),
  };
}

describe("VAL-DATA-009: cross-material number conflicts", () => {
  it("records the conflict with both sources and the winner, hints without blocking, and composes", async (t) => {
    const root = project(t);
    await readBoth(root);
    const payload = await write(root, page("p1", "Q3 营收 1502.25 万元，经营整体平稳，毛利保持稳定。"));
    assert.match(hintOf(payload), /^提示：数字不一致：/);
    assert.ok(hintOf(payload).includes(SPEC_LINE), hintOf(payload));
    assert.match(hintOf(payload), /这条提示不阻止保存。$/);

    const facts = conflictFacts(root);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.pageId, "p1");
    assert.equal(facts[0]!.revision, 1);

    await write(root, page("p2", "全年经营目标按季度分解，继续保持稳健节奏。"));
    await write(root, page("p3", "本稿结构完整，数据来源已逐页核对，可以直接汇报使用。"));
    const { composed, file } = await composeFile(root);
    assert.deepEqual(file.conflicts, [
      {
        kind: "number",
        label: "Q3 营收",
        values: [
          { source: "季度经营.xlsx", value: "1502.25", unit: "万" },
          { source: "运营简报.pdf", value: "1500", unit: "万" },
        ],
        used: { source: "季度经营.xlsx", value: "1502.25", unit: "万" },
        reason: "表格数据优先于文档文字",
        pages: [1],
      },
    ]);
    const summary = String((composed.payload as Record<string, unknown>).provenanceSummary ?? "");
    assert.ok(summary.includes(SPEC_LINE), summary);
  });

  it("names the document as the winner when the page states the document's number", async (t) => {
    const root = project(t);
    await readBoth(root);
    const payload = await write(root, page("p1", "Q3 营收 1500 万元，经营整体平稳，毛利保持稳定。"));
    assert.match(hintOf(payload), /本稿采用 1500 万（来自 运营简报\.pdf）。写的是文档里的数，与表格数据不同，请核对/);
    assert.deepEqual(conflictFacts(root)[0]!.conflicts[0]!.used, {
      source: "运营简报.pdf",
      value: "1500",
      unit: "万",
    });
  });

  it("stays silent when the page states neither value or both of them", async (t) => {
    const root = project(t);
    await readBoth(root);
    assert.equal(hintOf(await write(root, page("p1", "经营整体平稳，毛利保持稳定增长。"))), "");
    const both = await write(root, page("p2", "Q3 营收 表格 1502.25 万元，简报 1500 万元，差异已说明。"));
    assert.doesNotMatch(hintOf(both), /数字不一致/);
    assert.equal(conflictFacts(root).length, 0);
  });

  it("reads the range at both ends through write_page", async (t) => {
    const cases: readonly [number, number, boolean][] = [
      [1502.25, 1500, true],
      [1000, 1001, true],
      [100, 105, true],
      [100000, 100099.9, false],
      [100, 105.1, false],
      [1502.25, 1502, false],
      [1502.25, 1600, false],
    ];
    for (const [table, document, reported] of cases) {
      const root = project(t, { q3Table: table, q3Document: document });
      await readBoth(root);
      const payload = await write(root, page("p1", `Q3 营收 ${table} 万元，经营整体平稳，毛利保持稳定。`));
      assert.equal(
        /数字不一致/.test(hintOf(payload)),
        reported,
        `${table} against ${document} must ${reported ? "" : "not "}be reported`,
      );
      assert.equal(conflictFacts(root).length, reported ? 1 : 0);
    }
  });

  it("does not compare a source that was never read this epoch", async (t) => {
    const root = project(t);
    const read = await call(root, "read_material", { materialId: TABLE_ID }, "read-table-only");
    assert.equal(read.ok, true, read.detail);
    const payload = await write(root, page("p1", "Q3 营收 1502.25 万元，经营整体平稳，毛利保持稳定。"));
    assert.equal(hintOf(payload), "");
    assert.equal(conflictFacts(root).length, 0);
  });

  it("drops a conflict when the page is rewritten without either number", async (t) => {
    const root = project(t);
    await readBoth(root);
    await write(root, page("p1", "Q3 营收 1502.25 万元，经营整体平稳，毛利保持稳定。"));
    await write(root, page("p1", "经营整体平稳，毛利保持稳定，继续推进下一阶段的重点工作。"));
    await write(root, page("p2", "全年经营目标按季度分解，继续保持稳健节奏。"));
    await write(root, page("p3", "本稿结构完整，数据来源已逐页核对，可以直接汇报使用。"));
    const { file } = await composeFile(root);
    assert.deepEqual(file.conflicts, []);
  });

  it("reports one entry for a conflict two pages both state, and flags inconsistent choices", async (t) => {
    const root = project(t);
    await readBoth(root);
    await write(root, page("p1", "Q3 营收 1502.25 万元，经营整体平稳，毛利保持稳定。"));
    await write(root, page("p2", "Q3 营收 1502.25 万元，与上页一致，继续保持稳健节奏。"));
    await write(root, page("p3", "Q3 营收 1500 万元，本页引用简报口径，请对照上页。"));
    const { file } = await composeFile(root);
    assert.equal(file.conflicts.length, 1);
    const entry = file.conflicts[0]!;
    assert.deepEqual(entry.used, { source: "季度经营.xlsx", value: "1502.25", unit: "万" });
    assert.deepEqual(entry.pages, [1, 2]);
    assert.match(String(entry.reason), /但第 3 页写的是另一个数，前后不一致，请核对/);
  });
});

describe("VAL-DATA-009: brief against material", () => {
  it("records kind brief with the brief value, the material value and the one used", async (t) => {
    const root = project(t, { brief: "制作 3 页测试：Q3 营收写 1500 万。", q3Document: 2400 });
    await readBoth(root);
    const payload = await write(root, page("p1", "Q3 营收 1500 万元，按要求写入，毛利保持稳定。"));
    assert.ok(
      hintOf(payload).includes(
        "数字不一致：『Q3 营收』你的要求 为 1500 万，季度经营.xlsx 为 1502.25 万；本稿采用 1500 万（来自 你的要求）。按你的要求写入，资料里的数不同",
      ),
      hintOf(payload),
    );
    await write(root, page("p2", "全年经营目标按季度分解，继续保持稳健节奏。"));
    await write(root, page("p3", "本稿结构完整，数据来源已逐页核对，可以直接汇报使用。"));
    const { composed, file } = await composeFile(root);
    assert.deepEqual(file.conflicts, [
      {
        kind: "brief",
        label: "Q3 营收",
        values: [
          { source: "你的要求", value: "1500", unit: "万" },
          { source: "季度经营.xlsx", value: "1502.25", unit: "万" },
        ],
        used: { source: "你的要求", value: "1500", unit: "万" },
        reason: "按你的要求写入，资料里的数不同",
        pages: [1],
      },
    ]);
    assert.ok(String((composed.payload as Record<string, unknown>).provenanceSummary).includes("你的要求"));
  });

  it("says so when the page takes the material's number against the brief", async (t) => {
    const root = project(t, { brief: "制作 3 页测试：Q3 营收写 1500 万。", q3Document: 2400 });
    await readBoth(root);
    const payload = await write(root, page("p1", "Q3 营收 1502.25 万元，按资料写入，毛利保持稳定。"));
    assert.match(
      hintOf(payload),
      /本稿采用 1502\.25 万（来自 季度经营\.xlsx）。写的是资料里的数，与你的要求不同，请核对/,
    );
    assert.equal(conflictFacts(root)[0]!.conflicts[0]!.kind, "brief");
  });

  it("lists every source when two of them agree and the page takes their side", async (t) => {
    // The brief and the document both say 1500; only the workbook says 1502.25.
    const root = project(t, { brief: "制作 3 页测试：Q3 营收写 1500 万。" });
    await readBoth(root);
    await write(root, page("p1", "Q3 营收 1500 万元，按要求写入，毛利保持稳定。"));
    const conflict = conflictFacts(root)[0]!.conflicts[0]!;
    assert.equal(conflict.kind, "brief");
    assert.deepEqual(
      conflict.values.map((value) => [value.source, value.value]),
      [
        ["你的要求", "1500"],
        ["季度经营.xlsx", "1502.25"],
        ["运营简报.pdf", "1500"],
      ],
    );
    assert.equal(conflict.used.source, "你的要求", "the best-ranked source with the used value");
  });

  it("finds nothing when the brief and the materials agree or the brief has no figure", async (t) => {
    const agree = project(t, { brief: "制作 3 页测试：Q3 营收写 1502.25 万。", q3Document: 2400 });
    await readBoth(agree);
    await write(agree, page("p1", "Q3 营收 1502.25 万元，经营整体平稳，毛利保持稳定。"));
    assert.equal(conflictFacts(agree).length, 0);
    const none = project(t, { q3Document: 2400 });
    await readBoth(none);
    await write(none, page("p1", "Q3 营收 1502.25 万元，经营整体平稳，毛利保持稳定。"));
    assert.equal(conflictFacts(none).length, 0);
  });
});

const SHARED_NAME = "季度经营.xlsx";
const SAME_KIND_REASON = "几份资料类型相同，系统无法判断哪个更准，请核对";

describe("VAL-DATA-009: the page's value is bound to its metric", () => {
  it("keeps the conflict and its winner when the other source's value sits under another metric", async (t) => {
    const root = project(t);
    await readBoth(root);
    const payload = await write(root, page("p1", "Q3 营收 1502.25 万元，Q3 成本 1500 万元，经营整体平稳。"));
    assert.ok(hintOf(payload).includes(SPEC_LINE), hintOf(payload));
    const facts = conflictFacts(root);
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0]!.conflicts[0]!.used, {
      source: "季度经营.xlsx",
      value: "1502.25",
      unit: "万",
    });
    await write(root, page("p2", "全年经营目标按季度分解，继续保持稳健节奏。"));
    await write(root, page("p3", "本稿结构完整，数据来源已逐页核对，可以直接汇报使用。"));
    const { file } = await composeFile(root);
    assert.equal(file.conflicts.length, 1);
    assert.deepEqual(file.conflicts[0]!.used, {
      source: "季度经营.xlsx",
      value: "1502.25",
      unit: "万",
    });
  });

  it("claims no source when the other source's value appears only under another metric", async (t) => {
    // Control: the same number under the metric the sources conflict on names the document.
    const control = project(t);
    await readBoth(control);
    const stated = await write(control, page("p1", "Q3 营收 1500 万元，经营整体平稳。"));
    assert.match(hintOf(stated), /本稿采用 1500 万（来自 运营简报\.pdf）/);

    const root = project(t);
    await readBoth(root);
    const payload = await write(root, page("p1", "Q3 成本 1500 万元，经营整体平稳，毛利保持稳定。"));
    assert.equal(hintOf(payload), "");
    assert.equal(conflictFacts(root).length, 0);
    await write(root, page("p2", "全年经营目标按季度分解，继续保持稳健节奏。"));
    await write(root, page("p3", "本稿结构完整，数据来源已逐页核对，可以直接汇报使用。"));
    const { file } = await composeFile(root);
    assert.deepEqual(file.conflicts, []);
  });
});

describe("VAL-DATA-009: a source is its material, not its file name", () => {
  const first = `${SHARED_NAME}（同名第 1 份）`;
  const second = `${SHARED_NAME}（同名第 2 份）`;

  it("reports a conflict between two materials that share a file name and names each side", async (t) => {
    const root = emptyProject(t);
    writeWorkbook(root, "xlsx-quarter", SHARED_NAME, 1502.25);
    writeWorkbook(root, "xlsx-quarter-revised", SHARED_NAME, 1500);
    await readIds(root, ["xlsx-quarter", "xlsx-quarter-revised"]);
    const payload = await write(root, page("p1", "Q3 营收 1502.25 万元，经营整体平稳，毛利保持稳定。"));
    const line = `数字不一致：『Q3 营收』${first} 为 1502.25 万，${second} 为 1500 万；本稿采用 1502.25 万（来自 ${first}）。${SAME_KIND_REASON}`;
    assert.ok(hintOf(payload).includes(line), hintOf(payload));
    await write(root, page("p2", "全年经营目标按季度分解，继续保持稳健节奏。"));
    await write(root, page("p3", "本稿结构完整，数据来源已逐页核对，可以直接汇报使用。"));
    const { composed, file } = await composeFile(root);
    assert.deepEqual(file.conflicts, [
      {
        kind: "number",
        label: "Q3 营收",
        values: [
          { source: first, value: "1502.25", unit: "万" },
          { source: second, value: "1500", unit: "万" },
        ],
        used: { source: first, value: "1502.25", unit: "万" },
        reason: SAME_KIND_REASON,
        pages: [1],
      },
    ]);
    const summary = String((composed.payload as Record<string, unknown>).provenanceSummary ?? "");
    assert.ok(summary.includes(line), summary);
  });

  it("reports the same pair under different names with those names (control)", async (t) => {
    const root = emptyProject(t);
    writeWorkbook(root, "xlsx-quarter", SHARED_NAME, 1502.25);
    writeWorkbook(root, "xlsx-quarter-revised", "季度经营（修订）.xlsx", 1500);
    await readIds(root, ["xlsx-quarter", "xlsx-quarter-revised"]);
    const payload = await write(root, page("p1", "Q3 营收 1502.25 万元，经营整体平稳，毛利保持稳定。"));
    assert.ok(
      hintOf(payload).includes(
        `数字不一致：『Q3 营收』季度经营.xlsx 为 1502.25 万，季度经营（修订）.xlsx 为 1500 万；本稿采用 1502.25 万（来自 季度经营.xlsx）。${SAME_KIND_REASON}`,
      ),
      hintOf(payload),
    );
  });
});

describe("VAL-DATA-009: the detection budget is not spent before the page filter", () => {
  const labels = [
    "华东收入",
    "华南收入",
    "华北收入",
    "西南收入",
    "西北收入",
    "东北收入",
    "华中收入",
    "海外收入",
    "线上收入",
  ];
  const lines = (offset: number) => labels.map((label, index) => `Q3 ${label} ${1000 + index * 100 + offset} 万元`);
  const ninth = (offset: number) => lines(offset)[8]!;

  async function nineMetricProject(t: Cleanup, order: (all: readonly string[]) => readonly string[]): Promise<string> {
    const root = emptyProject(t);
    writeDocument(root, "doc-a", "甲方简报.pdf", order(lines(2.25)).join("\n"));
    writeDocument(root, "doc-b", "乙方简报.pdf", order(lines(0)).join("\n"));
    await readIds(root, ["doc-a", "doc-b"]);
    return root;
  }

  it("records the one conflict the page uses even when it is the ninth in source order", async (t) => {
    const root = await nineMetricProject(t, (all) => all);
    const payload = await write(root, page("p1", `${ninth(2.25)}，其余指标略。`));
    assert.ok(
      hintOf(payload).includes(
        "数字不一致：『Q3 线上收入』甲方简报.pdf 为 1802.25 万，乙方简报.pdf 为 1800 万；本稿采用 1802.25 万（来自 甲方简报.pdf）",
      ),
      hintOf(payload),
    );
    const facts = conflictFacts(root);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.conflicts.length, 1);
    await write(root, page("p2", "全年经营目标按季度分解，继续保持稳健节奏。"));
    await write(root, page("p3", "本稿结构完整，数据来源已逐页核对，可以直接汇报使用。"));
    const { file } = await composeFile(root);
    assert.equal(file.conflicts.length, 1);
    assert.equal(file.conflicts[0]!.label, "Q3 线上收入");
  });

  it("records the same conflict when the relevant metric comes first in both sources (control)", async (t) => {
    const root = await nineMetricProject(t, (all) => [all[8]!, ...all.slice(0, 8)]);
    const payload = await write(root, page("p1", `${ninth(2.25)}，其余指标略。`));
    assert.match(hintOf(payload), /数字不一致：『Q3 线上收入』/);
    assert.equal(conflictFacts(root)[0]!.conflicts.length, 1);
  });

  it("keeps every conflict a page uses while the hint, the receipt and the card stay bounded", async (t) => {
    const root = await nineMetricProject(t, (all) => all);
    const statements = lines(2.25).map((text, index) => ({
      elementId: `p1-s${index}`,
      elementType: "text",
      bounds: [80, 70 + index * 40, 800, 36] as [number, number, number, number],
      content: { text, fontSize: 16 },
    }));
    const payload = await write(root, {
      id: "p1",
      pageType: "content",
      elements: [
        {
          elementId: "p1-title",
          elementType: "text",
          bounds: [80, 20, 800, 40] as [number, number, number, number],
          content: { text: "汇报 p1", fontSize: 24 },
        },
        ...statements,
      ],
    });
    assert.equal(conflictFacts(root)[0]!.conflicts.length, 9);
    const hint = hintOf(payload);
    assert.equal(hint.split("数字不一致：").length - 1, 8, hint);
    assert.ok(hint.includes("另有 1 处数字不一致，没有逐条列出"), hint);
    assert.match(hint, /这条提示不阻止保存。$/);
    await write(root, page("p2", "全年经营目标按季度分解，继续保持稳健节奏。"));
    await write(root, page("p3", "本稿结构完整，数据来源已逐页核对，可以直接汇报使用。"));
    const { composed, file } = await composeFile(root);
    assert.equal(file.conflicts.length, 9);
    const summary = (composed.payload as Record<string, unknown>).provenanceSummary;
    assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= PROVENANCE_SUMMARY_MAX_BYTES);
  });
});
