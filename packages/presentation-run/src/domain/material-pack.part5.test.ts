import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { materialPartText, readMaterialChunk, readMaterialChunkWithFacts } from "./material-content.js";
import { listMaterialsResult, readMaterialResult } from "./material-hands.js";
import {
  materialCapabilityEntries,
  verifyMaterial,
  MATERIAL_CHUNK_BYTES,
  MATERIAL_TABLE_MAX_ROWS,
  type MaterialReadResult,
} from "./material-pack.js";
import { ensureRunLedger } from "./run-ledger.js";
import { csvMaterial, sha256, tempRoot, writeMaterial } from "./material-pack.support.js";

describe("material-pack", () => {
  it("shows the uploaded name once in Chinese material details while preserving legacy ids", () => {
    const root = tempRoot();
    const id = "00000000-0000-4000-8000-000000000001-季度经营.xlsx.xlsx";
    const { originalBytes, derivative } = csvMaterial(id, "季度经营.xlsx", 2);
    writeMaterial(root, {
      id,
      name: "季度经营.xlsx",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
      summaryZh: "季度营收表格 · 2 行",
      parts: [{ part: "rows", label: "2 行", rows: 2, cols: 3 }],
    });
    ensureRunLedger(root, {
      manifestSha256: "e".repeat(64),
      requirementsId: "req-material-name",
      requirements: [],
    });

    const listed = listMaterialsResult(root);
    const listedPayload = listed.payload as {
      materials: { id: string; name: string }[];
    };
    assert.equal(listedPayload.materials[0]!.id, id);
    assert.equal(listedPayload.materials[0]!.name, "季度经营.xlsx");
    assert.equal(listed.detail.includes(id), false);
    assert.equal(listed.detail.match(/季度经营\.xlsx/g)?.length, 1);

    const read = readMaterialResult(
      root,
      { commandId: "material-name-read", contextEpochId: "material-name-epoch" },
      { materialId: id, part: "rows", limit: 1 },
    );
    assert.equal(read.ok, true);
    assert.match(read.detail, /资料「季度经营\.xlsx」/);
    assert.equal(read.detail.includes(id), false);
    const payload = read.payload as { text: string };
    assert.match(payload.text, /# 表「季度经营\.xlsx」/);
    assert.doesNotMatch(read.detail, /# 表「季度经营\.xlsx」/);
    assert.doesNotMatch(read.detail, /季度经营\.xlsx\.xlsx/);
  });

  it("VAL-RUN-010: list_materials reports document parts (blocks/pages) plus name and summaryZh per entry", () => {
    const root = tempRoot();
    writeMaterial(root, {
      id: "doc-blocks",
      name: "年度复盘.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      originalBytes: Buffer.from("docx-bytes"),
      derivative: {
        document: {
          blocks: [
            { type: "heading", level: 1, text: "年度结论" },
            { type: "paragraph", text: "客户续约率达到 87.3%，较去年提升 6.1 个百分点。" },
          ],
          images: [],
          counts: { headings: 1, paragraphs: 1, listItems: 0, tables: 0, images: 0 },
          chars: 30,
        },
      },
      summaryZh: "Word 文档 · 1 个标题 · 约 30 字",
      parts: [{ part: "document", label: "2 个内容块", blocks: 2, chars: 30 }],
    });
    writeMaterial(root, {
      id: "doc-pages",
      name: "报告.pdf",
      kind: "document",
      parser: "pdf-unpdf-v1",
      originalBytes: Buffer.from("pdf-bytes"),
      derivative: {
        document: {
          pageCount: 3,
          chars: 60,
          pages: [
            { index: 1, chars: 20, lowText: false, text: "第一页" },
            { index: 2, chars: 20, lowText: false, text: "第二页" },
            { index: 3, chars: 20, lowText: false, text: "第三页" },
          ],
        },
      },
      summaryZh: "PDF · 3 页 · 约 60 字",
      parts: [{ part: "document", label: "3 页", pages: 3 }],
    });
    const result = listMaterialsResult(root);
    assert.equal(result.ok, true);
    const materials = (result.payload as { materials: Record<string, unknown>[] }).materials;
    assert.equal(materials.length, 2);
    const docx = materials.find((m) => m.id === "doc-blocks")!;
    assert.equal(docx.name, "年度复盘.docx");
    assert.equal(docx.summaryZh, "Word 文档 · 1 个标题 · 约 30 字");
    assert.equal(docx.needsVision, false);
    const docxParts = docx.parts as Record<string, unknown>[];
    assert.equal(docxParts[0]!.part, "document");
    assert.equal(docxParts[0]!.blocks, 2);
    const pdf = materials.find((m) => m.id === "doc-pages")!;
    assert.equal(pdf.name, "报告.pdf");
    const pdfParts = pdf.parts as Record<string, unknown>[];
    assert.equal(pdfParts[0]!.pages, 3);
    // inspect_capabilities exposes the same parts to the model.
    const caps = materialCapabilityEntries(root, false);
    const capsDocx = caps.find((entry) => entry.id === "doc-blocks")!;
    assert.equal(capsDocx.name, "年度复盘.docx");
    const capsDocxParts = capsDocx.parts as Record<string, unknown>[];
    assert.equal(capsDocxParts[0]!.blocks, 2);
    const capsPdf = caps.find((entry) => entry.id === "doc-pages")!;
    assert.equal((capsPdf.parts as Record<string, unknown>[])[0]!.pages, 3);
  });

  it("VAL-RUN-011: read_material at offset 0 returns the header row and a chunk sha256 matching the returned bytes", () => {
    const root = tempRoot();
    const { originalBytes, derivative } = csvMaterial("csv-head", "明细.csv", 20000);
    writeMaterial(root, {
      id: "csv-head",
      name: "明细.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
      parts: [{ part: "rows", label: "20000 行", rows: 20000, cols: 3 }],
    });
    const material = verifyMaterial(root, "csv-head");
    const read = readMaterialChunk({ material, part: "rows", offset: 0, limit: 8 });
    // The header line is part of the returned text window.
    assert.match(read.text, /列：序号 \| 地区 \| 金额/);
    assert.match(read.text, /1\t华东\t1203\.17/);
    assert.deepEqual(read.rows, { startIndex: 1, endIndex: 8, total: 20000 });
    assert.equal(read.hasMore, true);
    // The advertised sha256 equals the sha256 of the returned chunk bytes.
    assert.equal(read.chunkSha256, sha256(Buffer.from(read.text, "utf8")));
  });

  it("table fact text is the header plus the window's cell values, without display metadata", () => {
    const root = tempRoot();
    const { originalBytes, derivative } = csvMaterial("csv-facts", "明细.csv", 500);
    writeMaterial(root, {
      id: "csv-facts",
      name: "明细.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
      parts: [{ part: "rows", label: "500 行", rows: 500, cols: 3 }],
    });
    const material = verifyMaterial(root, "csv-facts");
    const { read, factText } = readMaterialChunkWithFacts({
      material,
      part: "rows",
      offset: 99,
      limit: 2,
    });
    assert.match(read.text, /共 500 行数据 · 本段第 100–101 行/);
    assert.equal(factText, ["序号 | 地区 | 金额", "100\t地区0\t713.00", "101\t地区1\t720.13"].join("\n"));
  });

  it("table fact text keeps only the header bytes the rendered read kept", () => {
    const root = tempRoot();
    const header = `${"指".repeat(2200)}9400`;
    const originalBytes = Buffer.from(`${header},本期\n业务量万元,8800\n`, "utf8");
    writeMaterial(root, {
      id: "csv-long-header",
      name: "长表头.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative: { table: { delimiter: ",", encoding: "UTF-8", rowCount: 1 } },
      parts: [{ part: "rows", label: "1 行", rows: 1, cols: 2 }],
    });
    const material = verifyMaterial(root, "csv-long-header");
    const { read, factText } = readMaterialChunkWithFacts({ material, part: "rows" });
    assert.match(read.text, /表头过长，已截断/);
    assert.ok(!read.text.includes("9400"));
    assert.ok(factText !== undefined && !factText.includes("9400"));
    assert.ok(factText.includes("8800"));
    assert.ok(read.text.includes(factText.split("\n")[0]!));
  });

  it("VAL-RUN-011: a limit above 200 is clamped to 200 rows with absolute indices", () => {
    const root = tempRoot();
    const { originalBytes, derivative } = csvMaterial("csv-clamp", "明细.csv", 20000);
    writeMaterial(root, {
      id: "csv-clamp",
      name: "明细.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
      parts: [{ part: "rows", label: "20000 行", rows: 20000, cols: 3 }],
    });
    const material = verifyMaterial(root, "csv-clamp");
    const clamped = readMaterialChunk({ material, part: "rows", offset: 0, limit: 9999 });
    assert.deepEqual(clamped.rows, {
      startIndex: 1,
      endIndex: MATERIAL_TABLE_MAX_ROWS,
      total: 20000,
    });
    assert.equal(clamped.hasMore, true);
    assert.match(clamped.text, /本段第 1–200 行/);
    assert.equal(clamped.chunkSha256, sha256(Buffer.from(clamped.text, "utf8")));
    // The window still honours absolute indices past the clamped size.
    const tail = readMaterialChunk({ material, part: "rows", offset: 19900, limit: 9999 });
    assert.deepEqual(tail.rows, { startIndex: 19901, endIndex: 20000, total: 20000 });
    assert.equal(tail.hasMore, false);
    assert.equal(tail.chunkSha256, sha256(Buffer.from(tail.text, "utf8")));
  });

  it("VAL-RUN-011: wide CSV windows obey the UTF-8 byte bound and page every row exactly once", () => {
    const root = tempRoot();
    const values = Array.from({ length: 205 }, (_, i) => `${i + 1},${"宽表🙂".repeat(50)}`);
    writeMaterial(root, {
      id: "csv-wide",
      name: "宽表.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes: Buffer.from(["序号,说明", ...values].join("\n")),
      derivative: { table: { encoding: "UTF-8", delimiter: ",", rowCount: 205 } },
    });
    let offset = 0;
    let calls = 0;
    ensureRunLedger(root, {
      manifestSha256: "e".repeat(64),
      requirementsId: "req-wide",
      requirements: [],
    });
    while (offset < 205) {
      const result = readMaterialResult(
        root,
        { commandId: `wide-${calls}`, contextEpochId: "wide-epoch" },
        { materialId: "csv-wide", offset, limit: 200 },
      );
      assert.equal(result.ok, true);
      const read = result.payload as MaterialReadResult;
      assert.ok(Buffer.byteLength(read.text, "utf8") <= MATERIAL_CHUNK_BYTES);
      assert.equal(read.truncated, false);
      assert.match(read.text, /列：序号 \| 说明/);
      assert.equal(read.rows?.startIndex, offset + 1);
      assert.equal(read.rows?.total, 205);
      const lines = read.text.split("\n").slice(3);
      assert.ok(lines.length > 0 && lines.length < 200);
      assert.deepEqual(
        lines,
        values.slice(offset, offset + lines.length).map((value, i) => `${offset + i + 1}\t${value.replace(",", "\t")}`),
      );
      offset += lines.length;
      assert.equal(read.rows?.endIndex, offset);
      assert.equal(read.hasMore, offset < 205);
      assert.equal(read.chunkSha256, sha256(read.text));
      calls += 1;
    }
    assert.ok(calls > 1);
    assert.equal(offset, 205);
  });

  it("VAL-RUN-011: a giant CSV row is explicitly truncated within the byte bound without losing its index", () => {
    const root = tempRoot();
    writeMaterial(root, {
      id: "csv-giant",
      name: "长行.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes: Buffer.from(`序号,说明,备注\n1,${"超长🙂".repeat(6000)},保留\n2,普通,末行`),
      derivative: { table: { encoding: "UTF-8", delimiter: ",", rowCount: 2 } },
    });
    const material = verifyMaterial(root, "csv-giant");
    const first = readMaterialChunk({ material, limit: 200 });
    assert.ok(Buffer.byteLength(first.text, "utf8") <= MATERIAL_CHUNK_BYTES);
    assert.equal(first.truncated, true);
    assert.match(first.text, /列：序号 \| 说明 \| 备注/);
    assert.match(first.text, /1\t1\t.*…（本行过长，已截断）\t保留/u);
    assert.ok(!first.text.includes("\uFFFD"), "UTF-8 truncation must preserve whole characters");
    assert.deepEqual(first.rows, { startIndex: 1, endIndex: 1, total: 2 });
    assert.equal(first.hasMore, true);
    assert.equal(first.chunkSha256, sha256(first.text));
    const last = readMaterialChunk({ material, offset: first.rows!.endIndex, limit: 200 });
    assert.deepEqual(last.rows, { startIndex: 2, endIndex: 2, total: 2 });
    assert.match(last.text, /2\t2\t普通\t末行/);
    assert.equal(last.hasMore, false);
    assert.equal(last.chunkSha256, sha256(last.text));
    ensureRunLedger(root, {
      manifestSha256: "e".repeat(64),
      requirementsId: "req-giant",
      requirements: [],
    });
    const toolRead = readMaterialResult(
      root,
      { commandId: "giant", contextEpochId: "giant-epoch" },
      { materialId: "csv-giant" },
    );
    assert.equal((toolRead.payload as MaterialReadResult).truncated, true);
    assert.equal((toolRead.payload as MaterialReadResult).text, first.text);
  });

  it("VAL-RUN-011: XLSX sheet windows share the byte bound, exact paging and giant-row truncation", () => {
    const root = tempRoot();
    const note = "表格🙂".repeat(75);
    const fullRows = [
      ...Array.from({ length: 205 }, (_, i) => [i + 1, { text: note }]),
      [206, { text: "末行🙂".repeat(6000) }],
    ];
    writeMaterial(root, {
      id: "xlsx-wide",
      name: "宽表.xlsx",
      kind: "table",
      parser: "xlsx-ooxml-v1",
      originalBytes: Buffer.from("xlsx-wide-bytes"),
      derivative: {
        table: {
          sheets: [
            {
              name: "明细",
              headerRow: ["序号", "说明"],
              rowCount: 206,
              rows: fullRows.slice(0, 200),
              fullRows,
            },
          ],
        },
      },
    });
    const material = verifyMaterial(root, "xlsx-wide");
    let offset = 0;
    while (offset < 206) {
      const read = readMaterialChunk({ material, part: "sheet:明细", offset, limit: 200 });
      assert.ok(Buffer.byteLength(read.text, "utf8") <= MATERIAL_CHUNK_BYTES);
      assert.equal(read.rows?.startIndex, offset + 1);
      assert.equal(read.rows?.total, 206);
      assert.match(read.text, /列：序号 \| 说明/);
      const lines = read.text.split("\n").slice(3);
      assert.ok(lines.length > 0 && lines.length < 200);
      assert.equal(read.rows?.endIndex, offset + lines.length);
      if (offset === 205) {
        assert.equal(read.truncated, true);
        assert.equal(lines.length, 1);
        assert.match(read.text, /206\t206\t.*…（本行过长，已截断）/u);
      } else {
        assert.equal(read.truncated, false);
        assert.deepEqual(
          lines,
          Array.from({ length: lines.length }, (_, i) => `${offset + i + 1}\t${offset + i + 1}\t${note}`),
        );
      }
      offset = read.rows!.endIndex;
      assert.equal(read.hasMore, offset < 206);
      assert.equal(read.chunkSha256, sha256(read.text));
    }
    assert.equal(offset, 206);
  });

  it("VAL-RUN-011: oversized headers and thousands of cells still leave a bounded, marked first row", () => {
    const root = tempRoot();
    writeMaterial(root, {
      id: "csv-columns",
      name: "多列.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes: Buffer.from(
        [
          Array.from({ length: 5000 }, () => "列名🙂").join(","),
          Array.from({ length: 5000 }, () => "数值🙂").join(","),
        ].join("\n"),
      ),
      derivative: { table: { encoding: "UTF-8", delimiter: ",", rowCount: 1 } },
    });
    const read = readMaterialChunk({ material: verifyMaterial(root, "csv-columns") });
    assert.ok(Buffer.byteLength(read.text, "utf8") <= MATERIAL_CHUNK_BYTES);
    assert.match(read.text, /列：.*…（表头过长，已截断）/u);
    assert.match(read.text, /\n1\t.*…（本行过长，已截断）/u);
    assert.equal(read.truncated, true);
    assert.deepEqual(read.rows, { startIndex: 1, endIndex: 1, total: 1 });
    assert.equal(read.hasMore, false);
    assert.equal(read.chunkSha256, sha256(read.text));
    assert.ok(!read.text.includes("\uFFFD"));
  });

  it("VAL-RUN-011: every read_material window and document chunk carries a chunkSha256 that matches the returned bytes", () => {
    const root = tempRoot();
    const { originalBytes, derivative } = csvMaterial("csv-hash", "明细.csv", 500);
    writeMaterial(root, {
      id: "csv-hash",
      name: "明细.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
      parts: [{ part: "rows", label: "500 行", rows: 500, cols: 3 }],
    });
    writeMaterial(root, {
      id: "doc-hash",
      name: "复盘.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      originalBytes: Buffer.from("docx-bytes-hash"),
      derivative: {
        document: {
          blocks: [
            { type: "heading", level: 1, text: "年度结论" },
            { type: "paragraph", text: "长段落".repeat(9000) },
          ],
          images: [],
          counts: { headings: 1, paragraphs: 1, listItems: 0, tables: 0, images: 0 },
          chars: 28000,
        },
      },
      parts: [{ part: "document", label: "2 个内容块", blocks: 2 }],
    });
    const csv = verifyMaterial(root, "csv-hash");
    for (const offset of [0, 200, 400]) {
      const read = readMaterialChunk({ material: csv, part: "rows", offset, limit: 200 });
      assert.equal(
        read.chunkSha256,
        sha256(Buffer.from(read.text, "utf8")),
        `chunk sha256 must match returned bytes at offset ${offset}`,
      );
    }
    const doc = verifyMaterial(root, "doc-hash");
    const chunks = Math.ceil(Buffer.from(materialPartText(doc), "utf8").length / (12 * 1024));
    assert.ok(chunks >= 2, "the document fixture must span multiple chunks");
    for (let index = 0; index < chunks; index += 1) {
      const read = readMaterialChunk({ material: doc, part: "document", offset: index });
      assert.equal(read.chunkIndex, index);
      assert.equal(
        read.chunkSha256,
        sha256(Buffer.from(read.text, "utf8")),
        `chunk ${index} sha256 must match returned bytes`,
      );
    }
  });
});
