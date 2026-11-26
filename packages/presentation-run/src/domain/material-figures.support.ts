import fs from "node:fs";
import path from "node:path";
import { sha256Hex, verifyMaterial } from "./material-pack.js";

export function materializeSplitMaterial(root: string): ReturnType<typeof verifyMaterial> {
  const materialDir = path.join(root, "_agent", "materials", "split-pdf");
  fs.mkdirSync(materialDir, { recursive: true });
  const originalBytes = Buffer.from("%PDF-1.4 split fixture");
  const originalSha256 = sha256Hex(originalBytes);
  const derivative = {
    schema: "material-derivative/v1",
    materialId: "split-pdf",
    kind: "document",
    source: {
      name: "跨页月报.pdf",
      bytes: originalBytes.length,
      sha256: originalSha256,
      declaredMime: null,
      detectedMime: "application/pdf",
      extension: ".pdf",
      extensionMismatch: false,
    },
    parser: { id: "pdf-unpdf-v1", engine: "unpdf", durationMs: 1 },
    status: "ok",
    truncated: { applied: false },
    warnings: [],
    summary: { zh: "PDF · 2 页 · 约 5200 字" },
    document: {
      pageCount: 2,
      pages: [
        {
          index: 1,
          text: `2026年1-2月 集团整体达标率保持高位。\n\n${"甲".repeat(5200)}\n\n其中达标率 89.64%、87.53%。`,
        },
        { index: 2, text: "2026年1-2月 完成率 XX.X%，环比变化 XX.X 个百分点，待本期数据更新。" },
      ],
    },
  };
  const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
  const derivativeSha256 = sha256Hex(derivativeBytes);
  fs.writeFileSync(path.join(materialDir, "original.pdf"), originalBytes);
  fs.writeFileSync(path.join(materialDir, "derivative.json"), derivativeBytes);
  fs.writeFileSync(
    path.join(materialDir, "receipt.json"),
    JSON.stringify({
      id: "split-pdf",
      name: "跨页月报.pdf",
      kind: "document",
      parser: "pdf-unpdf-v1",
      originalSha256,
      derivativeSha256,
    }),
  );
  fs.writeFileSync(
    path.join(root, "_agent", "materials", "manifest.json"),
    JSON.stringify({
      version: 1,
      materials: [
        {
          id: "split-pdf",
          name: "跨页月报.pdf",
          kind: "document",
          summaryZh: "PDF · 2 页 · 约 5200 字",
          needsVision: false,
          parser: "pdf-unpdf-v1",
          sha256: originalSha256,
          parts: [],
        },
      ],
    }),
  );
  return verifyMaterial(root, "split-pdf");
}

export function materializeTemplateMaterial(root: string): ReturnType<typeof verifyMaterial> {
  const id = "template";
  const materialDir = path.join(root, "_agent", "materials", id);
  fs.mkdirSync(materialDir, { recursive: true });
  const originalBytes = Buffer.from("synthetic pptx fixture");
  const originalSha256 = sha256Hex(originalBytes);
  const derivative = {
    schema: "material-derivative/v1",
    materialId: id,
    kind: "deck-template",
    source: {
      name: "运营模板.pptx",
      bytes: originalBytes.length,
      sha256: originalSha256,
      declaredMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      detectedMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
      extensionMismatch: false,
    },
    parser: { id: "pptx-template-v2", engine: "fixture", durationMs: 1 },
    status: "ok",
    truncated: { applied: false },
    warnings: [],
    summary: { zh: "PPTX · 1 张图表" },
    "deck-template": {
      templateDetail: {
        slides: [{ index: 16, title: "运营能力", text: "2026年1-2月" }],
        charts: [
          {
            slide: 16,
            id: "chart-16",
            title: "运营能力",
            type: "radar",
            series: [{ name: "实际", categories: ["获客", "转化"], values: [4, 8] }],
          },
        ],
      },
    },
  };
  const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
  const derivativeSha256 = sha256Hex(derivativeBytes);
  const designMarkdown = Buffer.from("# Fixture design source\n", "utf8");
  const designJson = Buffer.from('{"schema":"design-source/v1","layouts":[]}\n', "utf8");
  fs.writeFileSync(path.join(materialDir, "original.pptx"), originalBytes);
  fs.writeFileSync(path.join(materialDir, "derivative.json"), derivativeBytes);
  fs.writeFileSync(path.join(materialDir, "design-source.md"), designMarkdown);
  fs.writeFileSync(path.join(materialDir, "design-source.json"), designJson);
  fs.writeFileSync(
    path.join(materialDir, "receipt.json"),
    JSON.stringify({
      id,
      name: "运营模板.pptx",
      kind: "deck-template",
      parser: "pptx-template-v2",
      originalSha256,
      derivativeSha256,
      designSourceMdSha256: sha256Hex(designMarkdown),
      designSourceJsonSha256: sha256Hex(designJson),
    }),
  );
  fs.writeFileSync(
    path.join(root, "_agent", "materials", "manifest.json"),
    JSON.stringify({
      version: 1,
      materials: [
        {
          id,
          name: "运营模板.pptx",
          kind: "deck-template",
          summaryZh: "PPTX · 1 张图表",
          needsVision: false,
          parser: "pptx-template-v2",
          sha256: originalSha256,
          parts: [{ part: "slides" }, { part: "charts" }],
        },
      ],
    }),
  );
  return verifyMaterial(root, id);
}
