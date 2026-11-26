/**
 * Test-only fixtures for an attached deck-template design source (palette and fonts), and the reads
 * an agent must make through the real run before commit_design or write_todo accepts a plan.
 * The test runner loads only *.test.js files, so this module is compiled and imported by tests.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandContext, PresentationRun } from "../index.js";
import { materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";

export const TEMPLATE_ID = "brand-template.pptx";
export const SOURCE_ID = `material:${TEMPLATE_ID}`;

export const T1_COLORS = {
  dk1: "#1A1A1A",
  lt1: "#FFFFFF",
  dk2: "#2B2B2B",
  lt2: "#F2F2F2",
  accent1: "#C8102E",
  accent2: "#002855",
  accent3: "#F2A900",
  accent4: "#5B6770",
  accent5: "#7A9A01",
  accent6: "#00A3AD",
  hlink: "#0563C1",
  folHlink: "#954F72",
};

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Writes a verified deck-template material whose palette and mapped fonts the adoption copies. */
export function writeTemplate(projectRoot: string): void {
  const dir = path.join(projectRoot, "_agent", "materials", TEMPLATE_ID);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from("verified template source");
  fs.writeFileSync(path.join(dir, "original.pptx"), original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: TEMPLATE_ID,
      status: "ok",
      source: { sha256: sha256(original) },
      parser: { id: "pptx-ooxml-v1" },
      "deck-template": {},
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  const markdown = [
    "【Color Palette】",
    ...Object.entries(T1_COLORS).map(([key, hex]) => `- ${key}: ${hex}`),
    "",
    "【Typography】",
    "- major: Montserrat / 思源黑体 → latin: Arial, ea: 微软雅黑",
    "- minor: Calibri / 等线 → latin: Georgia, ea: 宋体",
    "",
  ].join("\n");
  const sourceJson = `${JSON.stringify(
    {
      version: 1,
      themeColors: T1_COLORS,
      colors: T1_COLORS,
      sourceFonts: {
        major: {
          source: { latin: "Montserrat", ea: "", hans: "思源黑体" },
          mapped: { latin: "Arial", ea: "微软雅黑" },
          note: "Montserrat→Arial、思源黑体→微软雅黑",
        },
        minor: {
          source: { latin: "Calibri", ea: "等线", hans: "" },
          mapped: { latin: "Georgia", ea: "宋体" },
          note: "Calibri→Georgia、等线→宋体",
        },
      },
      fonts: {},
      logos: [],
      layouts: [],
    },
    null,
    2,
  )}\n`;
  const markdownBytes = Buffer.from(markdown);
  const sourceJsonBytes = Buffer.from(sourceJson);
  fs.writeFileSync(path.join(dir, "design-source.md"), markdownBytes);
  fs.writeFileSync(path.join(dir, "design-source.json"), sourceJsonBytes);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    `${JSON.stringify({
      version: 1,
      id: TEMPLATE_ID,
      name: "brand-template.pptx",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalSha256: sha256(original),
      derivativeSha256: sha256(derivative),
      designSourceMdSha256: sha256(markdownBytes),
      designSourceJsonSha256: sha256(sourceJsonBytes),
    })}\n`,
  );
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      materials: [
        {
          id: TEMPLATE_ID,
          name: "brand-template.pptx",
          kind: "deck-template",
          summaryZh: "品牌模板",
          parser: "pptx-ooxml-v1",
          sha256: sha256(original),
          parts: [{ part: "design" }],
        },
      ],
    })}\n`,
  );
}

/** Reads every design chunk of the template through the run, as the agent must before adopting it. */
export async function readTemplateDesign(
  run: PresentationRun,
  context: Omit<CommandContext, "toolCallId">,
  projectRoot: string,
  label: string,
): Promise<void> {
  const chunkCount = materialChunkCount(verifyMaterial(projectRoot, TEMPLATE_ID), "design");
  for (let offset = 0; offset < chunkCount; offset += 1) {
    const read = await run.execute(
      { name: "read_material", args: { materialId: TEMPLATE_ID, part: "design", offset } },
      { ...context, toolCallId: `${label}-material-${offset}` },
    );
    assert.equal(read.ok, true, read.detail);
  }
}

/** Reads every reference chunk that list_references reports missing, so the plan may be written. */
export async function readMissingReferences(
  run: PresentationRun,
  context: Omit<CommandContext, "toolCallId">,
  label: string,
): Promise<void> {
  const references = await run.execute(
    { name: "list_references", args: {} },
    { ...context, toolCallId: `${label}-list-references` },
  );
  const missing = references.payload.missingReferenceChunks as {
    sourceId: string;
    chunkIndex: number;
  }[];
  for (const chunk of missing) {
    const read = await run.execute(
      { name: "read_reference", args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex } },
      { ...context, toolCallId: `${label}-ref-${chunk.sourceId}-${chunk.chunkIndex}` },
    );
    assert.equal(read.ok, true, read.detail);
  }
}
