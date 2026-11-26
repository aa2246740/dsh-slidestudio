import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "../run.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { packColorWriteContext } from "./theme-pack.js";
import { readMaterialChunk } from "./material-content.js";
import { listMaterialsResult, readMaterialResult } from "./material-hands.js";
import { verifiedDesignSource, verifyMaterial, type MaterialReadResult } from "./material-pack.js";
import {
  ensureRunLedger,
  readRunLedger,
  recordMaterialChunk,
  stableSha256,
  type MaterialChunkFact,
} from "./run-ledger.js";
import { csvMaterial, sha256, tempRoot, writeMaterial } from "./material-pack.support.js";

it("VAL-IMG-003: list_materials exposes receipt-verified image metadata without binary or location fields", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const styleProfile = {
    schema: "style-profile/v1",
    source: "image-pixels",
    accentColors: [{ hex: "#C00000", share: 0.3 }],
    neutralColors: [{ hex: "#FFFFFF" }],
    background: "#FFFFFF",
    contrastPairs: [],
  };
  const metadata = {
    orientation: "landscape",
    logoLike: false,
    screenshotLike: true,
    takenAt: "2026:09:23 10:11:12",
  };
  writeMaterial(root, {
    id: "image-style",
    name: "synthetic.png",
    kind: "image",
    parser: "image-sharp-v1",
    originalBytes: Buffer.from("synthetic-image"),
    needsVision: true,
    derivative: {
      image: { ...metadata, version: 2, styleProfile, normalized: { data: "not-public" } },
    },
  });
  const listed = listMaterialsResult(root);
  const entries = (listed.payload as { materials: Record<string, unknown>[] }).materials;
  assert.deepEqual(entries[0]!.imageMetadata, metadata);
  assert.deepEqual(entries[0]!.styleProfile, styleProfile);
  assert.doesNotMatch(JSON.stringify(listed.payload), /not-public|GPS|latitude/);
  const file = path.join(root, "_agent/materials/image-style/derivative.json");
  const before = fs.readFileSync(file);
  listMaterialsResult(root);
  assert.deepEqual(fs.readFileSync(file), before);
  fs.appendFileSync(file, " ");
  assert.throws(() => listMaterialsResult(root), /变化|校验/);
});

it("VAL-TPLR-012: legacy v1 design-source logo is primary without rewriting old files", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { receipt } = writeMaterial(root, {
    id: "v1-template",
    name: "legacy.pptx",
    kind: "deck-template",
    parser: "pptx-ooxml-v1",
    originalBytes: Buffer.from("legacy-template"),
    derivative: { "deck-template": {} },
  });
  const directory = path.join(root, "_agent/materials/v1-template");
  const json = JSON.stringify({ version: 1, logo: { mediaSrc: "media/brand-v1-logo.png" } });
  const markdown = "【Signature Components】\nLogo: media/brand-v1-logo.png";
  fs.writeFileSync(path.join(directory, "design-source.json"), json);
  fs.writeFileSync(path.join(directory, "design-source.md"), markdown);
  fs.writeFileSync(
    path.join(directory, "receipt.json"),
    JSON.stringify({
      ...receipt,
      designSourceJsonSha256: sha256(json),
      designSourceMdSha256: sha256(markdown),
    }),
  );
  const before = fs.readdirSync(directory).map((name) => sha256(fs.readFileSync(path.join(directory, name))));
  const source = verifiedDesignSource(verifyMaterial(root, "v1-template"));
  const logos = source.json.logos as { primary: boolean; mediaSrc: string }[];
  assert.equal(logos?.length, 1);
  assert.equal(logos[0]!.primary, true);
  assert.equal(logos[0]!.mediaSrc, "media/brand-v1-logo.png");
  assert.deepEqual(
    fs.readdirSync(directory).map((name) => sha256(fs.readFileSync(path.join(directory, name)))),
    before,
  );
});

it("VAL-PROV-005: list_materials mirrors verified PDF hints without promoting them to a design source", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = {
    schema: "style-profile/v1",
    source: "pdf-vector-ops",
    pagesScanned: 1,
    accentColors: [{ hex: "#C00000", share: 0.8, roles: ["fill"] }],
    neutralColors: [{ hex: "#FFFFFF" }],
    fonts: [{ source: "HYQiHei-EES", share: 1, mapped: { latin: "Arial", ea: "黑体" } }],
  };
  for (const [id, name, kind, parser, document] of [
    ["pdf-hints", "线索.pdf", "document", "pdf-unpdf-v1", { styleProfile: profile }],
    ["pdf-old", "旧资料.pdf", "document", "pdf-unpdf-v1", {}],
    ["word-hints", "文字.docx", "document", "docx-ooxml-v1", { styleProfile: profile }],
    ["table-hints", "数据.csv", "table", "csv-v1", { styleProfile: profile }],
  ] as const) {
    writeMaterial(root, {
      id,
      name,
      kind,
      parser,
      originalBytes: Buffer.from("synthetic material"),
      derivative: { document },
    });
  }
  const listed = listMaterialsResult(root);
  const materials = (listed.payload as { materials: Record<string, unknown>[] }).materials;
  assert.deepEqual(materials[0]!.styleHints, profile);
  for (const entry of materials.slice(1)) assert.equal("styleHints" in entry, false);
  const lines = listed.detail.split("\n");
  assert.match(
    lines[0]!,
    /风格线索（来自 PDF 的矢量图形和文字统计；不是设计源，只有声明 palette 并通过回执校验后才写入主题）/,
  );
  assert.match(lines[0]!, /#C00000/);
  assert.match(lines[0]!, /HYQiHei-EES.*Arial.*黑体/);
  assert.match(lines[0]!, /你没有看到页面画面/);
  for (const line of lines.slice(1)) assert.doesNotMatch(line, /风格线索/);
  fs.appendFileSync(path.join(root, "_agent/materials/pdf-hints/derivative.json"), " ");
  assert.throws(() => listMaterialsResult(root), /解析结果已变化/);
});

it("VAL-PROV-005: rejected PDF adoption explains hint limits without changing runtime, theme or pack_color", async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "离线风格线索" });
  writeDomainRuntime(root, { brief: "做一页说明", designDirection: "self-directed" });
  writeMaterial(root, {
    id: "pdf-source",
    name: "风格参考.pdf",
    kind: "document",
    parser: "pdf-unpdf-v1",
    originalBytes: Buffer.from("synthetic pdf"),
    derivative: {
      document: {
        styleProfile: {
          schema: "style-profile/v1",
          source: "pdf-vector-ops",
          pagesScanned: 1,
          accentColors: [{ hex: "#C00000", share: 1 }],
          neutralColors: [],
          fonts: [],
        },
      },
    },
  });
  const run = createPresentationRun({
    repoRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
  });
  const handle = await run.open({
    projectRoot: root,
    sessionId: "pdf-reject",
    brief: "做一页说明",
    editorBaseUrl: "http://127.0.0.1:1",
    design: { kind: "self-directed" },
    provider: { providerId: "offline", modelId: "fixture" },
  });
  const runtime = fs.readFileSync(path.join(root, "_agent/runtime.json"));
  const deck = fs.readFileSync(path.join(root, "deck.pptd"));
  const result = await run.execute(
    {
      name: "commit_design",
      args: { adoptedSourceIds: ["material:pdf-source"], slidePlan: [] },
    },
    { ...handle, toolCallId: "pdf-adopt", abortSignal: new AbortController().signal },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.payload, {
    error: "material_design_source_invalid",
    sourceId: "material:pdf-source",
    next: "list_materials",
  });
  assert.match(result.detail, /风格参考\.pdf.*不是 PPTX.*designAspects.*palette/);
  assert.deepEqual(fs.readFileSync(path.join(root, "_agent/runtime.json")), runtime);
  assert.deepEqual(fs.readFileSync(path.join(root, "deck.pptd")), deck);
  assert.equal(deck.includes("#C00000"), false);
  const context = packColorWriteContext(["material:pdf-source"], root);
  assert.equal(context.adoptedPackHexes?.has("#C00000") ?? false, false);
});

it("VAL-PROV-001/003: PDF progress spans pages, sha-checks epochs, and preserves document fact identity", () => {
  const root = tempRoot();
  try {
    writeMaterial(root, {
      id: "progress-pdf",
      name: "离线报告.pdf",
      kind: "document",
      parser: "pdf-unpdf-v1",
      originalBytes: Buffer.from("synthetic pdf"),
      derivative: {
        document: {
          pages: Array.from({ length: 29 }, (_, i) => ({
            index: i + 1,
            text: "甲".repeat(370) + "😀",
          })),
        },
      },
    });
    ensureRunLedger(root, {
      manifestSha256: "e".repeat(64),
      requirementsId: "progress",
      requirements: [],
    });
    const material = verifyMaterial(root, "progress-pdf");
    const first = readMaterialChunk({ material });
    recordMaterialChunk(
      root,
      { commandId: "stale", contextEpochId: "old" },
      {
        materialId: material.id,
        materialSha256: material.sha256,
        part: "document",
        chunkIndex: 1,
        chunkSha256: "0".repeat(64),
      },
    );
    const ranges = [
      { start: 1, end: 11 },
      { start: 11, end: 22 },
      { start: 22, end: 29 },
    ];
    for (let offset = 0; offset < 3; offset++) {
      const result = readMaterialResult(
        root,
        { commandId: `r${offset}`, contextEpochId: "epoch-1" },
        { materialId: material.id, offset },
      );
      const payload = result.payload as Record<string, unknown>;
      const expected = readMaterialChunk({ material, offset });
      assert.equal(payload.chars, Array.from(expected.text).length);
      assert.deepEqual(payload.pageRange, ranges[offset]);
      assert.equal(payload.chunkCount, 3);
      assert.equal(payload.readChunks, offset + 1);
      assert.equal(payload.allRead, offset === 2);
      assert.equal(payload.text, expected.text);
      assert.equal(payload.chunkSha256, sha256(expected.text));
      assert.equal(
        result.detail.split("\n")[2],
        offset === 2 ? "已读完全部 3 段" : `已读 ${offset + 1}/3 段；还有更多内容：offset 取 ${offset + 1} 继续读取`,
      );
      assert.equal(result.detail.includes("甲甲甲"), false);
    }
    const repeat = readMaterialResult(
      root,
      { commandId: "again", contextEpochId: "epoch-2" },
      { materialId: material.id, offset: 0 },
    );
    assert.equal((repeat.payload as Record<string, unknown>).readChunks, 3);
    const fact = readRunLedger(root)!.facts.find(
      (value) => value.type === "material.chunk-returned" && value.contextEpochId === "epoch-1",
    );
    assert.equal(
      fact?.factId,
      `material.chunk-returned:${stableSha256({
        materialId: material.id,
        materialSha256: material.sha256,
        part: "document",
        chunkIndex: 0,
        chunkSha256: first.chunkSha256,
        contextEpochId: "epoch-1",
      })}`,
    );
    assert.equal((fact as unknown as Record<string, unknown>).chunkCount, 3);
    assert.equal("rowStart" in fact!, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("VAL-PROV-001/003: table progress unions overlapping sha-verified windows across epochs", () => {
  const root = tempRoot();
  try {
    writeMaterial(root, {
      id: "coverage-table",
      name: "覆盖.csv",
      kind: "table",
      parser: "csv-v1",
      ...csvMaterial("coverage-table", "覆盖.csv", 8),
    });
    ensureRunLedger(root, {
      manifestSha256: "e".repeat(64),
      requirementsId: "rows",
      requirements: [],
    });
    const material = verifyMaterial(root, "coverage-table");
    recordMaterialChunk(
      root,
      { commandId: "bad-window", contextEpochId: "old" },
      {
        materialId: material.id,
        materialSha256: material.sha256,
        part: "rows",
        chunkIndex: 0,
        chunkSha256: "0".repeat(64),
        rowStart: 5,
        rowEnd: 8,
        rowTotal: 8,
      },
    );
    for (const [index, [offset, limit, expectedRows]] of [
      [0, 3, 3],
      [2, 3, 5],
      [0, 3, 5],
      [5, 3, 8],
    ].entries()) {
      const result = readMaterialResult(
        root,
        { commandId: `rows-${index}`, contextEpochId: `epoch-${index}` },
        { materialId: material.id, offset, limit },
      );
      const payload = result.payload as MaterialReadResult;
      assert.equal(payload.rowsRead, expectedRows);
      assert.equal(payload.readChunks, 1, "row windows keep the existing unique chunkIndex");
      assert.equal(payload.allRead, index === 3);
      assert.equal(payload.chars, Array.from(payload.text).length);
      assert.equal(
        result.detail.split("\n")[2],
        index === 3
          ? "已读完全部 8 行"
          : `已读 ${expectedRows}/8 行；还有更多内容：offset 取 ${index === 0 ? 3 : 5} 继续读取`,
      );
    }
    const facts = readRunLedger(root)!.facts.filter(
      (fact): fact is MaterialChunkFact => fact.type === "material.chunk-returned",
    );
    assert.equal(facts.at(-1)!.rowStart, 6);
    assert.equal(facts.at(-1)!.rowEnd, 8);
    assert.equal(facts.at(-1)!.rowTotal, 8);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("VAL-PROV-001/003: out-of-order reads continue at the first unread chunk, not a false end", () => {
  const root = tempRoot();
  try {
    writeMaterial(root, {
      id: "order-text",
      name: "原文.txt",
      kind: "text",
      parser: "text-utf8-v1",
      originalBytes: Buffer.from("synthetic"),
      derivative: { text: { text: "a".repeat(25000) } },
    });
    ensureRunLedger(root, {
      manifestSha256: "e".repeat(64),
      requirementsId: "order",
      requirements: [],
    });
    const result = readMaterialResult(
      root,
      { commandId: "tail", contextEpochId: "epoch" },
      { materialId: "order-text", offset: 2 },
    );
    assert.equal(result.detail.split("\n")[2], "已读 1/3 段；还有更多内容：offset 取 0 继续读取");
    assert.equal((result.payload as MaterialReadResult).allRead, false);
    assert.equal((result.payload as MaterialReadResult).pageRange, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
