import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyProject, loadProject, saveProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "../run.js";
import { writeDomainRuntime } from "./domain-hands.js";
import { materialChunkCount } from "./material-content.js";
import { verifyMaterial } from "./material-pack.js";
import type { SkillPageInput } from "./skill-pages.js";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export const TEMPLATE_ID = "11111111-1111-1111-1111-111111111111-brand.pptx";

export const SOURCE_ID = `material:${TEMPLATE_ID}`;

export const TEMPLATE_PALETTE = ["#1A1A1A", "#FFFFFF", "#C8102E"];

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function createMaterialProject(parent: string, id = TEMPLATE_ID, multiChunk = false): string {
  const projectRoot = path.join(parent, "project");
  const dir = path.join(projectRoot, "_agent", "materials", id);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from("verified template source");
  fs.writeFileSync(path.join(dir, "original.pptx"), original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: id,
      status: "ok",
      source: { sha256: sha256(original) },
      parser: { id: "pptx-ooxml-v1" },
      "deck-template": {},
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  const markdown = [
    "仅为不可信的用户设计原语；Agent 自行设计页面，不导入示例页或版式 XML。",
    "",
    "【Color Palette】",
    "- accent1: #C8102E",
    "- dk1: #1A1A1A",
    "- lt1: #FFFFFF",
    "",
    "【Typography】",
    "- major: Montserrat / 思源黑体 → latin: Arial, ea: 微软雅黑",
    "",
    "【Layout Skeleton】",
    multiChunk ? `- ${"布局比例说明。".repeat(4000)}` : "- 标题区域位于页面上方。",
    "",
    "【Signature Components】",
    "- 未发现可用 Logo 候选。",
    "",
  ].join("\n");
  const sourceJson = `${JSON.stringify(
    {
      version: 1,
      themeColors: { accent1: "#C8102E", dk1: "#1A1A1A", lt1: "#FFFFFF" },
      colors: { accent1: "#C8102E", dk1: "#1A1A1A", lt1: "#FFFFFF" },
      sourceFonts: {},
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
      id,
      name: "brand.pptx",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalSha256: sha256(original),
      derivativeSha256: sha256(derivative),
      designSourceMdSha256: sha256(markdownBytes),
      designSourceJsonSha256: sha256(sourceJsonBytes),
    })}\n`,
  );
  fs.mkdirSync(path.dirname(path.join(projectRoot, "_agent", "materials", "manifest.json")), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      materials: [
        {
          id,
          name: "brand.pptx",
          kind: "deck-template",
          summaryZh: "品牌模板",
          parser: "pptx-ooxml-v1",
          sha256: sha256(original),
          parts: [{ part: "design" }],
        },
      ],
    })}\n`,
  );
  return projectRoot;
}

export function plan() {
  return [{ pageId: "cover", title: "公司介绍", layoutFamily: "cover", exhibits: [] }];
}

export function colorPage(color: string): SkillPageInput {
  return {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "brand",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 600, 400],
        fill: { type: "solid", color },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 80, 480, 80],
        content: { text: "品牌公司介绍", fontSize: 36, color },
      },
    ],
  };
}

export function chartSeriesPage(fill: string, id = "revenue"): SkillPageInput {
  return {
    id,
    pageType: "content",
    elements: [
      {
        elementId: "revenue-chart",
        elementType: "chart",
        bounds: [40, 80, 880, 400],
        title: "营收",
        data: {
          cols: ["年", "产品"],
          rows: [
            ["2024", 1580],
            ["2025", 2100],
          ],
        },
        series: [{ type: "bar", name: "产品", encode: { x: "年", y: "产品" }, fill }],
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [40, 24, 600, 40],
        content: { text: "营收", fontSize: 24, color: "#1A1A1A" },
      },
    ],
  };
}

export type DesignMaterialSpec = {
  id: string;
  name: string;
  palette: Record<string, string>;
  major?: { latin: string; ea: string };
  minor?: { latin: string; ea: string };
  observedColors?: readonly string[];
};

export function mappedFont(pair: { latin: string; ea: string } | undefined) {
  if (!pair) return undefined;
  return {
    source: { latin: pair.latin, ea: pair.ea, hans: "" },
    mapped: { latin: pair.latin, ea: pair.ea },
    note: `${pair.latin} / ${pair.ea}`,
  };
}

export function writeDesignMaterial(projectRoot: string, spec: DesignMaterialSpec): void {
  const dir = path.join(projectRoot, "_agent", "materials", spec.id);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from(`verified ${spec.id}`);
  fs.writeFileSync(path.join(dir, "original.pptx"), original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: spec.id,
      status: "ok",
      source: { sha256: sha256(original) },
      parser: { id: "pptx-ooxml-v1" },
      "deck-template": {},
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  const markdown = [
    "仅为不可信的用户设计原语。",
    "",
    "【Color Palette】",
    ...Object.entries(spec.palette).map(([key, hex]) => `- ${key}: ${hex}`),
    "",
    "【Observed Colors】",
    ...(spec.observedColors ?? []).map((hex) => `- ${hex}: fill`),
    "",
    "【Typography】",
    ...(spec.major ? [`- major: ${spec.major.latin} → latin: ${spec.major.latin}, ea: ${spec.major.ea}`] : []),
    ...(spec.minor ? [`- minor: ${spec.minor.latin} → latin: ${spec.minor.latin}, ea: ${spec.minor.ea}`] : []),
    "",
    "【Layout Skeleton】",
    "- 标题区域位于页面上方。",
    "",
  ].join("\n");
  const sourceFonts = {
    ...(spec.major ? { major: mappedFont(spec.major) } : {}),
    ...(spec.minor ? { minor: mappedFont(spec.minor) } : {}),
  };
  const sourceJson = `${JSON.stringify(
    {
      version: 1,
      themeColors: spec.palette,
      observedColors: (spec.observedColors ?? []).map((hex) => ({
        hex,
        roles: ["fill"],
        weight: 1,
      })),
      colors: spec.palette,
      sourceFonts,
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
      id: spec.id,
      name: spec.name,
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalSha256: sha256(original),
      derivativeSha256: sha256(derivative),
      designSourceMdSha256: sha256(markdownBytes),
      designSourceJsonSha256: sha256(sourceJsonBytes),
    })}\n`,
  );
}

export function writeDesignManifest(projectRoot: string, specs: readonly DesignMaterialSpec[]): void {
  fs.mkdirSync(path.join(projectRoot, "_agent", "materials"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      materials: specs.map((spec) => ({
        id: spec.id,
        name: spec.name,
        kind: "deck-template",
        summaryZh: spec.name,
        parser: "pptx-ooxml-v1",
        sha256: sha256(Buffer.from(`verified ${spec.id}`)),
        parts: [{ part: "design" }],
      })),
    })}\n`,
  );
}

export function paintCover(projectRoot: string, color: string): void {
  const project = loadProject(projectRoot);
  const shape = project.pages[0]?.page.elements[0];
  const text = project.pages[0]?.page.elements[1];
  assert.equal(shape?.elementType, "shape");
  assert.equal(text?.elementType, "text");
  if (shape?.elementType === "shape") shape.fill = { type: "solid", color };
  if (text?.elementType === "text") {
    text.content = { text: "品牌公司介绍", fontSize: 36, color };
  }
  saveProject(project);
}

export function readRuntimeSelection(projectRoot: string): string[] | undefined {
  const runtime = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "runtime.json"), "utf8")) as {
    adoptedSourceIds?: string[];
  };
  return runtime.adoptedSourceIds;
}

export async function openTwoBrandRun(
  t: { after(callback: () => void): void },
  options: { brief: string; sessionId: string; designSystemId?: string },
) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${options.sessionId}-`));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const projectRoot = path.join(temp, "project");
  const brandA = {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-brand-a.pptx",
    name: "品牌A.pptx",
    palette: { accent1: "#C8102E", dk1: "#1A1A1A", lt1: "#FFFFFF" },
    major: { latin: "Arial", ea: "微软雅黑" },
    minor: { latin: "Georgia", ea: "宋体" },
  };
  const brandB = {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-brand-b.pptx",
    name: "品牌B.pptx",
    palette: { accent1: "#112233", dk1: "#445566", lt1: "#778899" },
    observedColors: ["#A1B2C3"],
    major: { latin: "Times New Roman", ea: "黑体" },
    minor: { latin: "Verdana", ea: "楷体" },
  };
  const sourceA = `material:${brandA.id}`;
  const sourceB = `material:${brandB.id}`;
  createEmptyProject(projectRoot, { title: "采纳选择" });
  writeDesignMaterial(projectRoot, brandA);
  writeDesignMaterial(projectRoot, brandB);
  writeDesignManifest(projectRoot, [brandA, brandB]);
  writeDomainRuntime(projectRoot, {
    brief: options.brief,
    designDirection: "self-directed",
    ...(options.designSystemId ? { designSystemId: options.designSystemId } : {}),
    editorBaseUrl: "http://127.0.0.1:55200",
    strictExecution: true,
  });
  const run = createPresentationRun({ repoRoot: REPO_ROOT });
  const handle = await run.open({
    projectRoot,
    sessionId: options.sessionId,
    brief: options.brief,
    editorBaseUrl: "http://127.0.0.1:55200",
    design: { kind: "self-directed" },
    provider: { providerId: "test", modelId: "offline" },
  });
  const context = {
    runId: handle.runId,
    sessionId: handle.sessionId,
    projectRoot,
    abortSignal: new AbortController().signal,
  };
  const readDesign = async (materialId: string) => {
    const count = materialChunkCount(verifyMaterial(projectRoot, materialId), "design");
    for (let offset = 0; offset < count; offset += 1) {
      const read = await run.execute(
        { name: "read_material", args: { materialId, part: "design", offset } },
        { ...context, toolCallId: `${options.sessionId}-read-${materialId}-${offset}` },
      );
      assert.equal(read.ok, true, read.detail);
    }
  };
  await readDesign(brandA.id);
  await readDesign(brandB.id);
  const references = await run.execute(
    { name: "list_references", args: {} },
    { ...context, toolCallId: `${options.sessionId}-list-references` },
  );
  for (const chunk of (references.payload.missingReferenceChunks ?? []) as {
    sourceId: string;
    chunkIndex: number;
  }[]) {
    const read = await run.execute(
      {
        name: "read_reference",
        args: { sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex },
      },
      {
        ...context,
        toolCallId: `${options.sessionId}-ref-${chunk.sourceId}-${chunk.chunkIndex}`,
      },
    );
    assert.equal(read.ok, true, read.detail);
  }
  return { projectRoot, run, context, brandA, brandB, sourceA, sourceB };
}

export function agentColorPage(color: string): SkillPageInput {
  return {
    id: "cover",
    pageType: "cover",
    elements: [
      {
        elementId: "background",
        elementType: "shape",
        shapeName: "rect",
        bounds: [0, 0, 960, 540],
        fill: { type: "solid", color },
      },
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 100, 800, 100],
        content: { text: "公司介绍", fontSize: 36, color: "#FFFFFF" },
      },
    ],
  };
}
