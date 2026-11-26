/**
 * Synthetic project and run helpers shared by the Host command-seam tests of
 * report requirements and design authority. Test-only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "./run.js";
import { materialChunkCount, readMaterialChunk } from "./domain/material-content.js";
import { verifyMaterial } from "./domain/material-pack.js";
import { ensureRunLedger, recordMaterialChunk } from "./domain/run-ledger.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(PKG, "../..");

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function syntheticProject(parent: string, options: { designSystemId?: string } = {}): string {
  const root = path.join(parent, "project");
  createEmptyProject(root, { title: "合成汇报" });
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "runtime.json"),
    `${JSON.stringify({
      brief: "向团队说明合成项目进展和下一步",
      strictExecution: true,
      ...(options.designSystemId ? { designSystemId: options.designSystemId } : {}),
    })}\n`,
  );
  fs.writeFileSync(
    path.join(root, "_agent", "presentation-run.v1.json"),
    `${JSON.stringify({ provider: { providerId: "test", modelId: "fixture" } })}\n`,
  );
  ensureRunLedger(root, {
    manifestSha256: "d".repeat(64),
    requirementsId: "report-authority-run-test",
    requirements: [],
  });
  return root;
}

export function addTemplateMaterial(projectRoot: string, id = "brand"): void {
  const dir = path.join(projectRoot, "_agent", "materials", id);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from(`synthetic-template-${id}`);
  fs.writeFileSync(path.join(dir, "original.pptx"), original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: id,
      status: "ok",
      source: { sha256: sha256(original) },
      parser: { id: "pptx-ooxml-v1" },
      "deck-template": {
        slides: [
          { index: 1, title: "结论", text: "本章结论" },
          { index: 2, title: "证据", text: "关键证据" },
        ],
        masters: [],
        templateDetail: {},
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  const markdown = Buffer.from("【Color Palette】\n- accent1: #C8102E\n");
  const sourceJson = Buffer.from(
    `${JSON.stringify({ version: 1, layouts: [], themeColors: { accent1: "#C8102E" } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, "design-source.md"), markdown);
  fs.writeFileSync(path.join(dir, "design-source.json"), sourceJson);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    `${JSON.stringify({
      version: 1,
      id,
      name: `${id}.pptx`,
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalSha256: sha256(original),
      derivativeSha256: sha256(derivative),
      designSourceMdSha256: sha256(markdown),
      designSourceJsonSha256: sha256(sourceJson),
    })}\n`,
  );
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      materials: [
        {
          id,
          name: `${id}.pptx`,
          kind: "deck-template",
          summaryZh: "合成模板",
          parser: "pptx-ooxml-v1",
          sha256: sha256(original),
          parts: [],
        },
      ],
    })}\n`,
  );
}

export function readWholePart(projectRoot: string, materialId: string, part: string, epoch: string): void {
  const material = verifyMaterial(projectRoot, materialId);
  const count = materialChunkCount(material, part, {});
  for (let index = 0; index < count; index += 1) {
    const chunk = readMaterialChunk({ material, part, offset: index });
    recordMaterialChunk(
      projectRoot,
      { commandId: `read-${part}-${index}`, contextEpochId: epoch },
      {
        materialId,
        materialSha256: material.sha256,
        part: chunk.part,
        chunkIndex: index,
        chunkSha256: chunk.chunkSha256,
      },
    );
  }
}

export function plan(): readonly {
  pageId: string;
  title: string;
  layoutFamily: string;
  exhibits: [];
}[] {
  return [{ pageId: "cover", title: "结论", layoutFamily: "cover", exhibits: [] }];
}

export async function openRun(root: string, sessionId: string, options: { designSystemId?: string } = {}) {
  const run = createPresentationRun({ repoRoot: REPO });
  const handle = await run.open({
    projectRoot: root,
    sessionId,
    brief: "向团队说明合成项目进展和下一步",
    editorBaseUrl: "http://127.0.0.1:55200",
    design: options.designSystemId
      ? { kind: "explicit-style", designSystemId: options.designSystemId }
      : { kind: "self-directed" },
    provider: { providerId: "test", modelId: "fixture" },
  });
  const ctx = (toolCallId: string) => ({
    runId: handle.runId,
    sessionId: handle.sessionId,
    toolCallId,
    projectRoot: root,
    abortSignal: new AbortController().signal,
  });
  return { run, handle, ctx, epoch: run.epochFor(sessionId) };
}

export function runtime(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "_agent", "runtime.json"), "utf8")) as Record<string, unknown>;
}
