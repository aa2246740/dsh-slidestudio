/**
 * Test-only fixture: last month's deck as a verified deck-template material with three charts and
 * one table, each on its own source slide and labelled 2026年8月, plus the reads an agent makes of it.
 * Chart values are cached the way a real PPTX caches them (many decimals) while `numFmt` declares
 * the two decimals the slide shows. Production code never imports this module.
 */
import fs from "node:fs";
import path from "node:path";
import { materialChunkCount, readMaterialChunk } from "./material-content.js";
import { sha256Hex, verifyMaterial, type VerifiedMaterial } from "./material-pack.js";
import { recordMaterialChunk, type RunToolContext } from "./run-ledger.js";

export const MONTHLY_TEMPLATE_ID = "monthly-template";
export const MONTHLY_TEMPLATE_NAME = "上月月报.pptx";
export const MONTHLY_PARTS = ["slides", "charts", "tables"] as const;

/** Cached as the file stores it; the slide displays 89.64. */
export const MONTHLY_CACHED_RATE = 89.6400000000001;

export const MONTHLY_CHARTS = [
  {
    slide: 5,
    id: "chart-5",
    title: "经营概览",
    values: [MONTHLY_CACHED_RATE, 87.5300000000002, 91.2],
  },
  { slide: 7, id: "chart-7", title: "专题汇报", values: [34.51, 28.46, 41.07] },
  { slide: 9, id: "chart-9", title: "区域对比", values: [52.18, 61.33, 47.9] },
] as const;

/**
 * Writes the verified template material and its manifest into a project root. `chartOverrides`
 * replaces fields of one chart by its id (for example `type`, `grouping` or `series`); without it
 * the derivative is byte-identical to the one every other monthly test pins.
 */
export function writeMonthlyTemplate(
  root: string,
  chartOverrides: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): VerifiedMaterial {
  const dir = path.join(root, "_agent", "materials", MONTHLY_TEMPLATE_ID);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from("synthetic monthly template");
  const derivative = {
    schema: "material-derivative/v1",
    materialId: MONTHLY_TEMPLATE_ID,
    kind: "deck-template",
    source: {
      name: MONTHLY_TEMPLATE_NAME,
      bytes: original.length,
      sha256: sha256Hex(original),
      declaredMime: null,
      detectedMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: ".pptx",
      extensionMismatch: false,
    },
    parser: { id: "pptx-template-v2", engine: "fixture", durationMs: 1 },
    status: "ok",
    truncated: { applied: false },
    warnings: [],
    summary: { zh: "PPTX · 3 张图表 · 1 张表格" },
    "deck-template": {
      templateDetail: {
        slides: MONTHLY_CHARTS.map((chart) => ({
          index: chart.slide,
          title: chart.title,
          text: `${chart.title} 2026年8月`,
        })),
        charts: MONTHLY_CHARTS.map((chart) => ({
          slide: chart.slide,
          id: chart.id,
          title: chart.title,
          type: "bar",
          series: [
            {
              name: "本月值",
              categories: ["华北", "华东", "华南"],
              values: chart.values,
              numFmt: "0.00",
            },
          ],
          ...(chartOverrides[chart.id] ?? {}),
        })),
        tables: [
          {
            id: "s9-table1",
            slide: 9,
            rows: [
              [{ text: "区域" }, { text: "收入" }],
              [{ text: "华北" }, { text: "1,250.50" }],
              [{ text: "华东" }, { text: "980.25" }],
            ],
          },
        ],
      },
    },
  };
  const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
  const designMarkdown = Buffer.from("# Fixture design source\n", "utf8");
  const designJson = Buffer.from('{"schema":"design-source/v1","layouts":[]}\n', "utf8");
  fs.writeFileSync(path.join(dir, "original.pptx"), original);
  fs.writeFileSync(path.join(dir, "derivative.json"), derivativeBytes);
  fs.writeFileSync(path.join(dir, "design-source.md"), designMarkdown);
  fs.writeFileSync(path.join(dir, "design-source.json"), designJson);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    JSON.stringify({
      id: MONTHLY_TEMPLATE_ID,
      name: MONTHLY_TEMPLATE_NAME,
      kind: "deck-template",
      parser: "pptx-template-v2",
      originalSha256: sha256Hex(original),
      derivativeSha256: sha256Hex(derivativeBytes),
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
          id: MONTHLY_TEMPLATE_ID,
          name: MONTHLY_TEMPLATE_NAME,
          kind: "deck-template",
          summaryZh: "PPTX · 3 张图表 · 1 张表格",
          needsVision: false,
          parser: "pptx-template-v2",
          sha256: sha256Hex(original),
          parts: MONTHLY_PARTS.map((part) => ({ part })),
        },
      ],
    }),
  );
  return verifyMaterial(root, MONTHLY_TEMPLATE_ID);
}

/** Records every chunk of the given template parts the way `read_material` does. */
export function recordMonthlyReads(
  root: string,
  context: RunToolContext,
  parts: readonly string[] = MONTHLY_PARTS,
): void {
  const material = verifyMaterial(root, MONTHLY_TEMPLATE_ID);
  for (const part of parts) {
    const chunkCount = materialChunkCount(material, part);
    for (let offset = 0; offset < chunkCount; offset += 1) {
      const chunk = readMaterialChunk({ material, part, offset });
      recordMaterialChunk(root, context, {
        materialId: chunk.materialId,
        materialSha256: chunk.materialSha256,
        part: chunk.part,
        chunkIndex: chunk.chunkIndex,
        chunkSha256: chunk.chunkSha256,
        chunkCount: chunk.chunkCount,
      });
    }
  }
}
