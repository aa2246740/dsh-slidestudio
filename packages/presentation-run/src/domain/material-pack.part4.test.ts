import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { materialPartText, parseDelimitedText, readMaterialChunk } from "./material-content.js";
import { listMaterialsResult, readMaterialResult } from "./material-hands.js";
import {
  MaterialPackError,
  materialCapabilityEntries,
  packageBytesOf,
  readMaterialsManifest,
  verifiedMaterialImage,
  verifyMaterial,
  MATERIAL_MAX_ORIGINAL_BYTES,
  type MaterialReadResult,
} from "./material-pack.js";
import { ensureRunLedger, readRunLedger, type MaterialChunkFact } from "./run-ledger.js";
import { csvMaterial, sha256, tempRoot, writeMaterial } from "./material-pack.support.js";

describe("material-pack", () => {
  it("returns ordered markdown chunks for a docx material with byte-exact text", () => {
    const root = tempRoot();
    const long = "客户续约率达到 87.3%，较去年提升 6.1 个百分点。";
    const blocks = [
      { type: "heading", level: 1, text: "年度结论" },
      { type: "paragraph", text: long },
      { type: "listItem", text: "第一条" },
      {
        type: "table",
        rows: [
          [{ text: "a1" }, { text: "b1" }],
          [{ text: "a2" }, { text: "b2" }],
        ],
      },
      { type: "paragraph", text: "尾段".repeat(3000) },
    ];
    writeMaterial(root, {
      id: "d1",
      name: "复盘.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      originalBytes: Buffer.from("docx-bytes"),
      derivative: {
        document: {
          blocks,
          images: [],
          counts: { headings: 1, paragraphs: 2, listItems: 1, tables: 1, images: 0 },
          chars: 100,
        },
      },
      parts: [{ part: "document", label: "5 个内容块", blocks: 5 }],
    });
    const material = verifyMaterial(root, "d1");
    const chunks = [
      readMaterialChunk({ material, part: "document", offset: 0 }),
      readMaterialChunk({ material, part: "document", offset: 1 }),
    ];
    assert.equal(chunks[0]!.chunkCount >= 2, true);
    const joined = chunks.map((chunk) => chunk.text).join("");
    assert.match(joined, /# 年度结论/);
    assert.match(joined, /客户续约率达到 87\.3%，较去年提升 6\.1 个百分点。/);
    assert.match(joined, /- 第一条/);
    assert.match(joined, /\| a1 \| b1 \|/);
    // Reassembly reproduces the rendering with no gaps or overlap.
    assert.equal(joined, materialPartText(material));
    for (const chunk of chunks) {
      assert.equal(chunk.chunkSha256, sha256(Buffer.from(chunk.text, "utf8")));
    }
    assert.throws(() => readMaterialChunk({ material, part: "document", offset: 99 }), MaterialPackError);
  });

  it("renders a pdf document page-by-page including a scanned-page note", () => {
    const root = tempRoot();
    writeMaterial(root, {
      id: "p1",
      name: "报告.pdf",
      kind: "document",
      parser: "pdf-unpdf-v1",
      originalBytes: Buffer.from("pdf-bytes"),
      derivative: {
        document: {
          pageCount: 3,
          chars: 60,
          pages: [
            { index: 1, chars: 40, lowText: false, text: "第一页文字" },
            { index: 2, chars: 2, lowText: true, hasImage: true, text: "谢谢" },
            { index: 3, chars: 16, lowText: false, text: "第三页文字" },
          ],
        },
      },
      parts: [{ part: "document", label: "3 页", pages: 3 }],
    });
    const material = verifyMaterial(root, "p1");
    const text = materialPartText(material);
    assert.match(text, /## 第 1 页\n\n第一页文字/);
    assert.match(text, /## 第 2 页\n\n谢谢\n\n（本页主要是图片，未识别文字（不做 OCR）；内容未知，不要猜测）/);
    assert.doesNotMatch(text, /扫描图片/);
    assert.match(text, /## 第 3 页\n\n第三页文字/);
  });

  it("VAL-TPL-003: reads only receipt-verified design source and rejects missing or tampered files", () => {
    const root = tempRoot();
    const { receipt } = writeMaterial(root, {
      id: "t1",
      name: "模板.pptx",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalBytes: Buffer.from("pptx-bytes"),
      derivative: {
        "deck-template": {
          slideSize: { cx: 12192000, cy: 6858000, aspect: "16:9" },
          theme: {
            name: "T1",
            colors: { dk1: "#1A1A1A", lt1: "#FFFFFF", accent1: "#C8102E" },
            fonts: {
              major: { latin: "Montserrat", ea: "思源黑体", hans: "思源黑体" },
              minor: { latin: "Calibri", ea: "等线" },
            },
          },
          masters: [
            {
              part: "ppt/slideMasters/slideMaster1.xml",
              placeholders: [],
              layouts: [
                {
                  part: "ppt/slideLayouts/l1.xml",
                  name: "T1-标题与内容",
                  type: "content",
                  placeholders: [{ type: "title", idx: 0, box: { x: 0.05, y: 0.05, w: 0.9, h: 0.15 } }],
                },
              ],
            },
          ],
          slides: [{ index: 1, part: "ppt/slides/slide1.xml", title: "样例页", text: "T1-SAMPLE" }],
          media: [
            {
              id: "m1",
              part: "ppt/media/logo.png",
              bytes: 100,
              format: "png",
              width: 200,
              height: 80,
              roles: ["master"],
              logoCandidate: true,
            },
          ],
          logoCandidates: 1,
        },
      },
      parts: [{ part: "design", label: "PPT 模板 · 1 页 · 1 个版式", slides: 1, layouts: 1 }],
    });
    const material = verifyMaterial(root, "t1");
    assert.throws(() => materialPartText(material), /设计源.*重新上传/);
    const dir = path.join(root, "_agent", "materials", "t1");
    const markdown = "【Color Palette】\n#C8102E\n";
    const json = '{"colors":{"accent1":"#C8102E"}}\n';
    fs.writeFileSync(path.join(dir, "design-source.md"), markdown);
    fs.writeFileSync(path.join(dir, "design-source.json"), json);
    fs.writeFileSync(
      path.join(dir, "receipt.json"),
      JSON.stringify({
        ...receipt,
        designSourceMdSha256: sha256(markdown),
        designSourceJsonSha256: sha256(json),
      }),
    );
    assert.equal(materialPartText(verifyMaterial(root, "t1")), markdown);
    assert.doesNotMatch(materialPartText(verifyMaterial(root, "t1")), /T1-SAMPLE/);
    ensureRunLedger(root, {
      manifestSha256: "e".repeat(64),
      requirementsId: "template-read",
      requirements: [],
    });
    const read = readMaterialResult(
      root,
      { commandId: "template-read", contextEpochId: "template-epoch" },
      { materialId: "t1", part: "design" },
    );
    assert.equal(read.ok, true);
    assert.equal((read.payload as MaterialReadResult).text, markdown);
    const facts = (readRunLedger(root)?.facts ?? []).filter(
      (fact): fact is MaterialChunkFact => fact.type === "material.chunk-returned",
    );
    assert.equal(facts[0]!.chunkSha256, sha256(markdown));
    assert.equal(facts[0]!.contextEpochId, "template-epoch");
    for (const file of ["design-source.md", "design-source.json"]) {
      const original = fs.readFileSync(path.join(dir, file));
      fs.appendFileSync(path.join(dir, file), "tampered");
      assert.throws(() => materialPartText(verifyMaterial(root, "t1")), /设计源.*重新上传/);
      fs.writeFileSync(path.join(dir, file), original);
    }
  });

  it("rejects unknown ids and tampered derivatives in Chinese without content", () => {
    const root = tempRoot();
    assert.throws(() => verifyMaterial(root, "does-not-exist"), /资料不存在/);
    const { originalBytes, derivative } = csvMaterial("csv2", "数据.csv", 10);
    writeMaterial(root, {
      id: "csv2",
      name: "数据.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
    });
    // Tamper the derivative on disk → hash mismatch.
    fs.writeFileSync(
      path.join(root, "_agent", "materials", "csv2", "derivative.json"),
      '{"schema":"material-derivative/v1","tampered":true}',
    );
    assert.throws(() => verifyMaterial(root, "csv2"), /解析结果已变化/);
  });

  it("refuses a derivative over the shared byte cap in Chinese instead of claiming it changed", () => {
    const root = tempRoot();
    writeMaterial(root, {
      id: "huge",
      name: "大模板.pptx",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalBytes: Buffer.from("pptx"),
      derivative: { "deck-template": { media: [] } },
    });
    const file = path.join(root, "_agent", "materials", "huge", "derivative.json");
    const fd = fs.openSync(file, "r+");
    try {
      fs.ftruncateSync(fd, MATERIAL_MAX_ORIGINAL_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }
    assert.throws(() => verifyMaterial(root, "huge"), /解析结果过大，无法作为设计源使用/);
  });

  it("rejects a tampered original file in Chinese", () => {
    const root = tempRoot();
    const { originalBytes, derivative } = csvMaterial("csv3", "数据.csv", 10);
    writeMaterial(root, {
      id: "csv3",
      name: "数据.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
    });
    fs.writeFileSync(path.join(root, "_agent", "materials", "csv3", "original.csv"), "forged");
    assert.throws(() => verifyMaterial(root, "csv3"), /原文件已变化/);
  });

  /** A converted legacy project material exactly like material-store writes it (CAP-37). */
  function writeConvertedMaterial(root: string, id: string, converted: Buffer): { originalBytes: Buffer } {
    const originalBytes = Buffer.from("legacy-ppt-original-bytes");
    writeMaterial(root, {
      id,
      name: "旧版.ppt",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalBytes,
      derivative: {
        "deck-template": { slides: [{ index: 1 }], masters: [] },
        conversion: {
          from: ".ppt",
          to: ".pptx",
          engine: "libreoffice",
          rule: "legacy-convert-v1",
          durationMs: 12,
          convertedSha256: sha256(converted),
          convertedBytes: converted.length,
          isolation: "profile-only",
        },
      },
      convertedBytes: converted,
    });
    return { originalBytes };
  }

  it("VAL-LEGACY-007: verifies a converted material as one pair and serves the converted package", () => {
    const root = tempRoot();
    const converted = Buffer.from("converted-pptx-package-bytes");
    const { originalBytes } = writeConvertedMaterial(root, "legacy1", converted);
    const material = verifyMaterial(root, "legacy1");
    assert.equal(material.convertedBytes?.toString("utf8"), "converted-pptx-package-bytes");
    assert.equal(material.sha256, sha256(originalBytes));
    assert.equal(
      material.originalBytes.toString("utf8"),
      "legacy-ppt-original-bytes",
      "the verified original stays the uploaded bytes",
    );
    assert.equal(packageBytesOf(material), material.convertedBytes);
    // A non-converted material keeps serving its original as the package.
    const { originalBytes: csvBytes } = csvMaterial("csv4", "数据.csv", 10);
    writeMaterial(root, {
      id: "csv4",
      name: "数据.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes: csvBytes,
      derivative: {
        table: { encoding: "utf-8", delimiter: ",", rowCount: 10, colCount: 3 },
      },
    });
    const plain = verifyMaterial(root, "csv4");
    assert.equal(packageBytesOf(plain), plain.originalBytes);
  });

  it("VAL-LEGACY-007: tampering either file of the pair fails the whole material in Chinese", () => {
    const root = tempRoot();
    writeConvertedMaterial(root, "legacy2", Buffer.from("converted-pptx-package-bytes"));
    const dir = path.join(root, "_agent", "materials", "legacy2");
    const forged = fs.readFileSync(path.join(dir, "converted.pptx"));
    forged[0] = forged[0]! ^ 0xff;
    fs.writeFileSync(path.join(dir, "converted.pptx"), forged);
    assert.throws(() => verifyMaterial(root, "legacy2"), /转换结果已变化/);

    const root2 = tempRoot();
    writeConvertedMaterial(root2, "legacy3", Buffer.from("converted-pptx-package-bytes"));
    fs.writeFileSync(path.join(root2, "_agent", "materials", "legacy3", "original.ppt"), "forged-original");
    assert.throws(() => verifyMaterial(root2, "legacy3"), /原文件已变化/);
  });

  it("VAL-LEGACY-007: a missing converted package fails the pair closed", () => {
    const root = tempRoot();
    writeConvertedMaterial(root, "legacy4", Buffer.from("converted-pptx-package-bytes"));
    fs.rmSync(path.join(root, "_agent", "materials", "legacy4", "converted.pptx"));
    assert.throws(() => verifyMaterial(root, "legacy4"), /转换结果已变化/);
  });

  it("VAL-LEGACY-007: a receipt and derivative that disagree about the conversion fail closed", () => {
    const root = tempRoot();
    writeConvertedMaterial(root, "legacy5", Buffer.from("converted-pptx-package-bytes"));
    const dir = path.join(root, "_agent", "materials", "legacy5");
    // A forged receipt that matches a forged package still disagrees with the
    // derivative's own hash-pinned conversion receipt.
    const forged = Buffer.from("other-package");
    fs.writeFileSync(path.join(dir, "converted.pptx"), forged);
    const receiptPath = path.join(dir, "receipt.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, convertedSha256: sha256(forged) }));
    assert.throws(() => verifyMaterial(root, "legacy5"), /解析凭据无效/);
  });

  it("serves the verified normalized image and reports viewable flags", () => {
    const root = tempRoot();
    const normalized = Buffer.from("normalized-jpeg");
    writeMaterial(root, {
      id: "img1",
      name: "合影.png",
      kind: "image",
      parser: "image-sharp-v1",
      originalBytes: Buffer.from("png-bytes"),
      derivative: {
        image: {
          format: "png",
          width: 1600,
          height: 1000,
          dominant: "#1E6FD9",
          normalized: {
            format: "jpeg",
            width: 1568,
            height: 980,
            bytes: normalized.length,
            sha256: sha256(normalized),
            data: normalized.toString("base64"),
          },
        },
      },
      summaryZh: "PNG 图片 · 1600×1000 · 主色 #1E6FD9",
      needsVision: true,
      mediaSrc: "media/material-img1.png",
      normalizedBytes: normalized,
      parts: [{ part: "image", label: "PNG 1600×1000", width: 1600, height: 1000, format: "PNG" }],
    });
    const { bytes } = verifiedMaterialImage(root, "img1");
    assert.equal(bytes.toString(), "normalized-jpeg");
    const materials = readMaterialsManifest(root);
    assert.equal(materials.length, 1);
    const caps = materialCapabilityEntries(root, true);
    assert.deepEqual(
      caps.map((entry) => [entry.id, entry.viewable, entry.needsVision]),
      [["img1", true, true]],
    );
    const noVision = materialCapabilityEntries(root, false);
    assert.equal(noVision[0]!.viewable, false);
    const image = materialPartText(verifyMaterial(root, "img1"));
    assert.match(image, /主色：#1E6FD9/);
    assert.match(image, /media\/material-img1\.png/);
  });

  it("rejects view_material on a non-image material with a Chinese error", () => {
    const root = tempRoot();
    writeMaterial(root, {
      id: "t2",
      name: "文档.txt",
      kind: "text",
      parser: "text-utf8-v1",
      originalBytes: Buffer.from("文字"),
      derivative: { text: { chars: 2, text: "文字" } },
    });
    assert.throws(() => verifiedMaterialImage(root, "t2"), /不是图片/);
  });

  it("parses RFC 4180 delimited text with quoted fields and embedded newlines", () => {
    const rows = parseDelimitedText('a,"b,b","c""q"\n1,2,3\n', ",");
    assert.deepEqual(rows, [
      ["a", "b,b", 'c"q'],
      ["1", "2", "3"],
    ]);
    const tsv = parseDelimitedText("h1\th2\n1\t2\n", "\t");
    assert.deepEqual(tsv, [
      ["h1", "h2"],
      ["1", "2"],
    ]);
  });

  it("VAL-RUN-010: list_materials on a project with no materials returns an empty list, not an error", () => {
    const root = tempRoot();
    const result = listMaterialsResult(root);
    assert.equal(result.ok, true);
    const payload = result.payload as { materials?: unknown[] };
    assert.ok(Array.isArray(payload.materials));
    assert.equal(payload.materials.length, 0);
    assert.match(result.detail, /没有可用的上传资料/);
    // The inspect path agrees: no manifest → no capability entries.
    assert.deepEqual(materialCapabilityEntries(root, true), []);
    assert.deepEqual(readMaterialsManifest(root), []);
  });
});
