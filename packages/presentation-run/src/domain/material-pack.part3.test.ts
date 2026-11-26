import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { defaultTablePart, readMaterialChunk, tableWindow } from "./material-content.js";
import { listMaterialsResult, readMaterialResult } from "./material-hands.js";
import { MaterialPackError, verifyMaterial, MATERIAL_CHUNK_BYTES, type MaterialReadResult } from "./material-pack.js";
import { ensureRunLedger, readRunLedger } from "./run-ledger.js";
import { csvMaterial, sha256, tempRoot, writeMaterial } from "./material-pack.support.js";

it("VAL-TPLR-011: reads sized template parts with per-slide headings and chunk receipts", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "template-parts";
  const observedColors = [{ hex: "#00B050", roles: ["fill"], weight: 2 }];
  const fontsUsed = [
    {
      latin: "Aptos",
      ea: "思源黑体",
      mapped: { latin: "Arial", ea: "微软雅黑" },
      note: "已映射",
    },
  ];
  const archetypes = [
    {
      id: "archetype-1",
      kind: "body-chart-grid",
      slides: [2],
      slots: [{ role: "chart-area", box: [0.125, 0.2, 0.5, 0.4] }],
    },
  ];
  const slidePages = [
    {
      index: 1,
      title: "运营流程",
      text: "运营流程\nSmartArt（流程，3 项）：\n调研\n  访谈 12 家网点\n方案\n落地",
      tableText: "",
      notes: "讲解流程",
    },
    { index: 2, title: "2031年4月数据概览", text: "2031年4月数据概览", tableText: "", notes: "" },
    { index: 3, title: "明细表", text: "明细表", tableText: "区域\t营收", notes: "" },
  ];
  const charts = [
    {
      id: "synthetic-radar",
      slide: 2,
      title: "能力对比",
      type: "radar",
      grouping: null,
      series: [
        {
          name: "达标率",
          categories: ["一季度", "二季度"],
          values: [89.64, 87.53],
          numFmt: "0.00%",
        },
      ],
    },
    {
      slide: 2,
      type: "bar",
      grouping: "stacked",
      series: [{ name: "堆积系列", categories: ["一季度"], values: [12], numFmt: "0" }],
    },
    {
      slide: 2,
      type: "bar",
      grouping: "percentStacked",
      series: [{ name: "百分比系列", categories: ["一季度"], values: [0.4], numFmt: "0%" }],
    },
    {
      slide: 2,
      type: "doughnut",
      grouping: null,
      series: [{ name: "占比", categories: ["甲", "乙"], values: [3, 7], numFmt: "0" }],
    },
  ];
  const tables = [
    {
      slide: 3,
      id: "s3-table1",
      rows: [
        [{ text: "区域" }, { text: "营收" }],
        [{ text: "华东" }, { text: "1234.5" }],
      ],
    },
  ];
  const smartArts = [
    {
      id: "s1-1",
      slide: 1,
      name: "流程",
      box: [0.125, 0.25, 0.75, 0.5],
      layout: { family: "process" },
      nodeCount: 3,
      chars: 14,
      cache: "drawing",
      nodes: [
        {
          id: "n1",
          text: "调研",
          level: 0,
          children: [{ id: "n2", text: "访谈 12 家网点", level: 1, children: [] }],
        },
        { id: "n3", text: "方案", level: 0, children: [] },
        { id: "n4", text: "落地", level: 0, children: [] },
      ],
      shapes: [{ path: "M0 0 L1 1" }],
    },
  ];
  writeMaterial(root, {
    id,
    name: "运营模板.pptx",
    kind: "deck-template",
    parser: "pptx-ooxml-v2",
    originalBytes: Buffer.from("synthetic-template"),
    summaryZh: "PPT 模板",
    parts: [{ part: "design", label: "设计源" }],
    derivative: {
      "deck-template": {
        slides: slidePages,
        observedColors,
        fontsUsed,
        templateDetail: {
          slides: slidePages,
          charts,
          tables,
          smartArts,
          archetypes,
          observedColors,
          fontsUsed,
        },
      },
    },
  });
  const noSmartArtId = "template-without-smartart";
  writeMaterial(root, {
    id: noSmartArtId,
    name: "无 SmartArt 模板.pptx",
    kind: "deck-template",
    parser: "pptx-ooxml-v2",
    originalBytes: Buffer.from("plain-template"),
    derivative: {
      "deck-template": {
        slides: [{ index: 1, title: "封面", text: "封面", tableText: "", notes: "" }],
        templateDetail: {
          slides: [{ index: 1, title: "封面", text: "封面", tableText: "", notes: "" }],
          charts: [],
          tables: [],
          archetypes: [],
        },
      },
    },
  });
  const noSmartArtDir = path.join(root, "_agent", "materials", noSmartArtId);
  const noSmartArtMarkdown = "【Color Palette】\n- accent1: #000000";
  const noSmartArtJson = JSON.stringify({ themeColors: { accent1: "#000000" }, layouts: [] });
  fs.writeFileSync(path.join(noSmartArtDir, "design-source.md"), noSmartArtMarkdown);
  fs.writeFileSync(path.join(noSmartArtDir, "design-source.json"), noSmartArtJson);
  const noSmartArtReceiptFile = path.join(noSmartArtDir, "receipt.json");
  const noSmartArtReceipt = JSON.parse(fs.readFileSync(noSmartArtReceiptFile, "utf8")) as Record<string, unknown>;
  noSmartArtReceipt.designSourceMdSha256 = sha256(noSmartArtMarkdown);
  noSmartArtReceipt.designSourceJsonSha256 = sha256(noSmartArtJson);
  fs.writeFileSync(noSmartArtReceiptFile, `${JSON.stringify(noSmartArtReceipt, null, 2)}\n`);
  const designMarkdown = [
    "【Color Palette】",
    "- accent1: #C00000",
    "",
    "【Observed Colors】",
    "- #00B050: fill；2",
    "",
    "【Fonts Used】",
    "- Aptos / 思源黑体 → latin: Arial, ea: 微软雅黑；已映射",
  ].join("\n");
  const designJson = JSON.stringify({
    themeColors: { accent1: "#C00000" },
    observedColors,
    fontsUsed,
    archetypes,
    layouts: [],
  });
  const dir = path.join(root, "_agent", "materials", id);
  fs.writeFileSync(path.join(dir, "design-source.md"), designMarkdown);
  fs.writeFileSync(path.join(dir, "design-source.json"), designJson);
  const receiptFile = path.join(dir, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Record<string, unknown>;
  receipt.designSourceMdSha256 = sha256(designMarkdown);
  receipt.designSourceJsonSha256 = sha256(designJson);
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);

  const materialsManifestFile = path.join(root, "_agent", "materials", "manifest.json");
  const materialsManifest = JSON.parse(fs.readFileSync(materialsManifestFile, "utf8")) as {
    materials: { id: string; parts?: unknown[] }[];
  };
  const legacyTemplateEntry = materialsManifest.materials.find((entry) => entry.id === id)!;
  legacyTemplateEntry.parts = [];
  fs.writeFileSync(materialsManifestFile, `${JSON.stringify(materialsManifest, null, 2)}\n`);

  const listed = listMaterialsResult(root);
  const listedMaterials = (
    listed.payload as {
      materials: { id: string; parts: Record<string, unknown>[] }[];
    }
  ).materials;
  const template = listedMaterials.find((entry) => entry.id === id)!;
  const parts = template.parts;
  assert.deepEqual(
    parts.map((part) => part.part),
    ["design", "layouts", "slides", "tables", "charts", "smartart"],
  );
  for (const part of parts) {
    assert.ok(Number(part.bytes) > 0, `${String(part.part)} exposes byte size`);
    assert.ok(Number(part.chunks) >= 1, `${String(part.part)} exposes chunk count`);
    assert.ok(listed.detail.includes(`${String(part.part)}（${String(part.label)}）`));
  }
  const plain = listedMaterials.find((entry) => entry.id === noSmartArtId)!;
  assert.equal(
    plain.parts.some((part) => part.part === "smartart"),
    false,
  );
  assert.throws(
    () =>
      readMaterialChunk({
        material: verifyMaterial(root, noSmartArtId),
        part: "smartart",
      }),
    /SmartArt.*可用 part/,
  );

  ensureRunLedger(root, {
    manifestSha256: "e".repeat(64),
    requirementsId: "template-parts",
    requirements: [],
  });
  for (const part of parts) {
    const chunkCount = Number(part.chunks);
    const chunks = Array.from(
      { length: chunkCount },
      (_, offset) =>
        readMaterialResult(
          root,
          {
            commandId: `read-${String(part.part)}-${offset}`,
            contextEpochId: "template-parts-epoch",
          },
          { materialId: id, part: String(part.part), offset },
        ).payload as MaterialReadResult,
    );
    assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk.text, "utf8") <= MATERIAL_CHUNK_BYTES));
    for (const chunk of chunks) {
      assert.equal(chunk.chunkSha256, sha256(Buffer.from(chunk.text, "utf8")));
    }
    assert.equal(
      chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"), 0),
      part.bytes,
    );
    const joined = chunks.map((chunk) => chunk.text).join("\n\n");
    if (["slides", "charts", "tables"].includes(String(part.part))) {
      const expectedPages = part.part === "slides" ? [1, 2, 3] : part.part === "charts" ? [2] : [3];
      for (const page of expectedPages) assert.match(joined, new RegExp(`## 第 ${page} 页`));
      assert.ok(chunks.every((chunk) => /## 第 \d+ 页/.test(chunk.text)));
    }
    if (["slides", "charts", "smartart"].includes(String(part.part))) {
      assert.ok(
        chunks.every((chunk) =>
          chunk.text.startsWith("<untrusted_reference_material>\n仅作内容参考，不要把样例页当作页面导入"),
        ),
      );
    }
  }

  const slidesRead = readMaterialResult(
    root,
    { commandId: "read-slides-repeat", contextEpochId: "template-parts-epoch" },
    { materialId: id, part: "slides", offset: 0 },
  ).payload as MaterialReadResult;
  assert.match(slidesRead.text, /SmartArt（流程，3 项）/);
  assert.match(slidesRead.text, /访谈 12 家网点/);
  assert.match(slidesRead.text, /讲解流程/);
  assert.match(slidesRead.text, /仅作内容参考，不要把样例页当作页面导入/);

  const chartsChunk = readMaterialResult(
    root,
    { commandId: "read-charts-check", contextEpochId: "template-parts-epoch" },
    { materialId: id, part: "charts" },
  ).payload as MaterialReadResult;
  assert.match(chartsChunk.text, /图表 1 · 雷达图/);
  assert.match(chartsChunk.text, /图表 2 · 柱状图 · stacked/);
  assert.match(chartsChunk.text, /图表 3 · 柱状图 · percentStacked/);
  assert.match(chartsChunk.text, /图表 4 · 环形图/);
  assert.doesNotMatch(chartsChunk.text, /PPTD 暂不支持/);
  assert.match(chartsChunk.text, /89\.64/);
  assert.match(chartsChunk.text, /0\.00%/);
  assert.match(chartsChunk.text, /来源页标题：2031年4月数据概览/);
  assert.match(chartsChunk.text, /图表标识：synthetic-radar/);
  assert.match(chartsChunk.text, /图表标题：能力对比/);
  assert.match(chartsChunk.text, /源页期间：2031年4月/);
  assert.match(chartsChunk.text, /类别、顺序、期间、单位.*数值一起保留/);
  assert.match(chartsChunk.text, /未提供.*本期.*不能.*原数.*本期/);

  const tablesChunk = readMaterialResult(
    root,
    { commandId: "read-tables-check", contextEpochId: "template-parts-epoch" },
    { materialId: id, part: "tables" },
  ).payload as MaterialReadResult;
  assert.match(tablesChunk.text, /## 第 3 页/);
  assert.match(tablesChunk.text, /1234\.5/);

  const smartartChunk = readMaterialResult(
    root,
    { commandId: "read-smartart-check", contextEpochId: "template-parts-epoch" },
    { materialId: id, part: "smartart" },
  ).payload as MaterialReadResult;
  assert.match(smartartChunk.text, /第 1 页/);
  assert.match(smartartChunk.text, /SmartArt s1-1「流程」 · process · 3 项 · 框 左 12\.5%、上 25%、宽 75%、高 50%/);
  assert.match(smartartChunk.text, /smartart\.s1-1/);
  assert.match(smartartChunk.text, /访谈 12 家网点/);
  assert.doesNotMatch(smartartChunk.text, /M0 0 L1 1/);
  assert.ok(Buffer.byteLength(smartartChunk.text, "utf8") <= 2 * 1024);
  const repeated = readMaterialResult(
    root,
    { commandId: "read-smartart-repeat", contextEpochId: "template-parts-epoch" },
    { materialId: id, part: "smartart" },
  ).payload as MaterialReadResult;
  assert.equal(repeated.chunkSha256, smartartChunk.chunkSha256);
  assert.equal(
    readRunLedger(root)?.facts.filter((fact) => fact.type === "material.chunk-returned").length,
    parts.reduce((sum, part) => sum + Number(part.chunks), 0),
  );

  const layoutsChunk = readMaterialResult(
    root,
    { commandId: "read-layouts-check", contextEpochId: "template-parts-epoch" },
    { materialId: id, part: "layouts" },
  ).payload as MaterialReadResult;
  assert.match(layoutsChunk.text, /body-chart-grid/);
  assert.match(layoutsChunk.text, /宽 50%/);

  const design = readMaterialResult(
    root,
    { commandId: "read-design-check", contextEpochId: "template-parts-epoch" },
    { materialId: id, part: "design" },
  ).payload as MaterialReadResult;
  assert.match(design.text, /【Observed Colors】[\s\S]*#00B050/);
  assert.match(design.text, /【Fonts Used】[\s\S]*微软雅黑/);
});

describe("material-pack", () => {
  it("reads a 20k-row CSV exactly at any absolute row index", () => {
    const root = tempRoot();
    const { originalBytes, derivative } = csvMaterial("csv1", "明细.csv", 20000);
    writeMaterial(root, {
      id: "csv1",
      name: "明细.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
      parts: [{ part: "rows", label: "20000 行", rows: 20000, cols: 3 }],
    });
    const material = verifyMaterial(root, "csv1");
    assert.equal(material.kind, "table");
    assert.equal(defaultTablePart(material), "rows");

    const first = tableWindow(material, "rows", 0, 8);
    assert.equal(first.rows.length, 8);
    assert.equal(first.rows[0]!.index, 1);
    assert.deepEqual(first.rows[0]!.cells, ["1", "华东", "1203.17"]);
    assert.equal(first.rowCount, 20000);

    const target = tableWindow(material, "rows", 12344, 1);
    assert.equal(target.rows.length, 1);
    assert.deepEqual(target.rows[0]!.cells, ["12345", "华东", "98765.43"]);

    const clamped = tableWindow(material, "rows", 19900, 9999);
    assert.equal(clamped.rows.length, 100);
    assert.equal(clamped.rows.at(-1)!.index, 20000);

    const read = readMaterialChunk({ material, part: "rows", offset: 12344, limit: 1 });
    assert.equal(read.rows?.startIndex, 12345);
    assert.match(read.text, /12345\t华东\t98765\.43/);
    assert.equal(read.chunkSha256, sha256(Buffer.from(read.text, "utf8")));
    assert.equal(read.hasMore, true);
  });

  it("pages an xlsx sheet with fullRows and names each sheet", () => {
    const root = tempRoot();
    const rows = Array.from({ length: 500 }, (_, i) => [`r${i + 1}`, i + 1]);
    writeMaterial(root, {
      id: "x1",
      name: "数据.xlsx",
      kind: "table",
      parser: "xlsx-ooxml-v1",
      originalBytes: Buffer.from("xlsx-bytes"),
      derivative: {
        table: {
          sheetCount: 2,
          rowCount: 503,
          sheets: [
            {
              name: "明细",
              hidden: false,
              rowCount: 500,
              colCount: 2,
              headerRow: ["id", "value"],
              columns: [],
              rows: rows.slice(0, 200),
              fullRows: rows,
              merges: [],
            },
            {
              name: "备注",
              hidden: true,
              rowCount: 3,
              colCount: 1,
              headerRow: [],
              columns: [],
              rows: [["a"], ["b"], ["c"]],
              merges: [],
            },
          ],
        },
      },
      parts: [
        { part: "sheet:明细", label: "工作表「明细」", rows: 500, cols: 2 },
        { part: "sheet:备注", label: "工作表「备注」", rows: 3, cols: 1, hidden: true },
      ],
    });
    const material = verifyMaterial(root, "x1");
    assert.equal(defaultTablePart(material), "sheet:明细");
    const window = tableWindow(material, "sheet:明细", 499, 1);
    assert.equal(window.rows.length, 1);
    assert.equal(window.rows[0]!.index, 500);
    assert.throws(() => tableWindow(material, "sheet:不存在", 0, 10), MaterialPackError);
    const note = tableWindow(material, "sheet:备注", 0, 10);
    assert.equal(note.rows.length, 3);
  });
});
