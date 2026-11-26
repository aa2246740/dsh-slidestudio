import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { buildDeliveryProvenance } from "./delivery-provenance.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { recordMaterialFiguresFact, recordPageProvenanceFact } from "./material-figures.js";
import { ensureRunLedger, recordPageRevision, recordTodo, type DeckComposedFact } from "./run-ledger.js";

const sha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");

const context = { commandId: "delivery-provenance", contextEpochId: "provenance-epoch" };

const SOURCE_PAGE_1 = "2026年1-2月 达标率 89.64% 87.53% 89.56%";

/** 29-page synthetic report: 3 chunks, page 1 carries quoted figures, 3 and 26 low-text. */
function reportPages(): Record<string, unknown>[] {
  return Array.from({ length: 29 }, (_, index) => {
    const page = index + 1;
    return {
      index: page,
      chars: page === 1 ? Array.from(SOURCE_PAGE_1).length : 371,
      lowText: page === 3 || page === 26,
      text: page === 1 ? SOURCE_PAGE_1 : "甲".repeat(370) + "😀",
    };
  });
}

function writeMaterial(
  projectRoot: string,
  options: {
    id: string;
    name: string;
    kind: "text" | "table" | "document" | "deck-template" | "image";
    parser: string;
    derivative: Record<string, unknown>;
    originalExtension?: string;
    /** The converted OOXML package of a legacy upload (M8) written beside the original. */
    convertedBytes?: Buffer;
    convertedTo?: string;
  },
): void {
  const dir = path.join(projectRoot, "_agent", "materials", options.id);
  fs.mkdirSync(dir, { recursive: true });
  const originalBytes = Buffer.from("synthetic material");
  fs.writeFileSync(path.join(dir, `original${options.originalExtension ?? ".pdf"}`), originalBytes);
  if (options.convertedBytes) {
    fs.writeFileSync(path.join(dir, `converted${options.convertedTo ?? ".pptx"}`), options.convertedBytes);
  }
  const derivative = {
    schema: "material-derivative/v1",
    materialId: options.id,
    kind: options.kind,
    source: {
      name: options.name,
      bytes: originalBytes.length,
      sha256: sha256(originalBytes),
      extension: ".pdf",
    },
    parser: { id: options.parser, engine: "test" },
    status: "ok",
    truncated: { applied: false },
    warnings: [],
    summary: { zh: `${options.name} 摘要` },
    ...options.derivative,
  };
  const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "derivative.json"), derivativeBytes);
  const receipt = {
    version: 1,
    id: options.id,
    name: options.name,
    kind: options.kind,
    parser: options.parser,
    originalSha256: sha256(originalBytes),
    derivativeSha256: sha256(derivativeBytes),
    originalBytes: originalBytes.length,
    ...(options.convertedBytes ? { convertedSha256: sha256(options.convertedBytes) } : {}),
    materializedAt: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(path.join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  const manifestFile = path.join(projectRoot, "_agent", "materials", "manifest.json");
  const existing = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
        materials?: unknown[];
      };
      return Array.isArray(parsed.materials) ? parsed.materials : [];
    } catch {
      return [];
    }
  })();
  fs.writeFileSync(
    manifestFile,
    `${JSON.stringify(
      {
        version: 1,
        materials: [
          ...existing.filter(
            (item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id !== options.id,
          ),
          {
            id: options.id,
            name: options.name,
            kind: options.kind,
            summaryZh: `${options.name} 摘要`,
            needsVision: false,
            parser: options.parser,
            sha256: sha256(originalBytes),
            parts: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function preparedProject(root: string, title: string, pages: number): void {
  createEmptyProject(root, { title });
  writeDomainRuntime(root, {
    brief: `制作 ${pages} 页测试：${title}。`,
    designDirection: "self-directed",
  });
  persistPresentationRunProvider(root, {
    providerId: "offline",
    modelId: "fixture",
    ready: true,
    modelInputModalities: ["text"],
  });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
}

describe("delivery provenance", () => {
  it("VAL-PROV-009: pages come from ledger, outline and manifest without page YAML bodies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-facts-"));
    try {
      preparedProject(root, "无页面正文", 3);
      writeMaterial(root, {
        id: "report-pdf",
        name: "月报资料.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: { document: { pageCount: 2, pages: reportPages().slice(0, 2) } },
      });
      recordTodo(
        root,
        context,
        [
          { pageId: "p1", title: "大纲标题 1" },
          { pageId: "p2", title: "大纲标题 2" },
        ].map((item) => ({ ...item, layoutFamily: "content", exhibits: ["none"] })),
      );
      const first = recordPageRevision(root, context, "p1", { id: "p1", elements: [] });
      const second = recordPageRevision(root, context, "p2", { id: "p2", elements: [] });
      recordPageProvenanceFact(root, context, {
        pageId: "p1",
        revision: first.revision,
        pageSha256: first.pageSha256,
        declaration: { basis: "mixed", note: "结构沿用资料" },
      });
      recordMaterialFiguresFact(root, context, {
        pageId: "p2",
        revision: second.revision,
        matches: [
          {
            value: "12.34%",
            materialId: "report-pdf",
            sourcePage: 1,
            sourcePeriods: ["2026年1-2月"],
          },
        ],
        pagePeriods: ["2026年2月"],
        visionValues: [],
      });
      const pagesDir = path.join(root, "pages");
      assert.ok(
        !fs.existsSync(pagesDir) || fs.readdirSync(pagesDir).length === 0,
        "fixture must not write page YAML bodies",
      );
      const fact: DeckComposedFact = {
        type: "deck.composed",
        factId: "fixture-seal",
        at: "2026-01-01T00:00:00.000Z",
        contextEpochId: "provenance-epoch",
        title: "无页面正文",
        deckSha256: sha256("fixture"),
        pageRevisions: { p1: first.pageSha256, p2: second.pageSha256 },
      };
      const built = buildDeliveryProvenance(root, fact);
      assert.deepEqual(
        built.file.pages.map((page) => [page.pageId, page.title]),
        [
          ["p1", "大纲标题 1"],
          ["p2", "大纲标题 2"],
        ],
      );
      assert.deepEqual(built.file.pages[0]!.declared, {
        basis: "mixed",
        note: "结构沿用资料",
      });
      assert.deepEqual(built.file.pages[1]!.detected, {
        quotedCount: 1,
        sourcePages: [1],
        periodMismatch: { page: "2026年2月", source: ["2026年1-2月"] },
      });
      // A stale declaration from an earlier revision is not carried forward,
      // while a detection at the current revision still is.
      const rewritten = recordPageRevision(root, context, "p1", {
        id: "p1",
        elements: [{ elementId: "new", elementType: "text", bounds: [0, 0, 10, 10] }],
      });
      const sealedAtNextRevision: DeckComposedFact = {
        ...fact,
        deckSha256: sha256("fixture-2"),
        pageRevisions: { p1: rewritten.pageSha256, p2: second.pageSha256 },
      };
      const rebuilt = buildDeliveryProvenance(root, sealedAtNextRevision);
      assert.equal(rebuilt.file.pages[0]!.declared, null);
      assert.deepEqual(rebuilt.file.pages[1]!.detected, {
        quotedCount: 1,
        sourcePages: [1],
        periodMismatch: { page: "2026年2月", source: ["2026年1-2月"] },
      });
      // No material chunk was read in this fixture: the receipt keeps its
      // pre-M2 shape and carries no summary.
      assert.equal(built.summary, "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records verified template chart pages and type substitutions in delivery provenance", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-chart-"));
    try {
      preparedProject(root, "图表来源核对", 1);
      writeMaterial(root, {
        id: "read-receipt",
        name: "已读文字.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: { document: { pageCount: 1, pages: [{ index: 1, text: "已读取。" }] } },
      });
      const read = await runDomainHand(
        "read_material",
        { materialId: "read-receipt", offset: 0, __openSlideStudio: context },
        root,
      );
      assert.equal(read.ok, true, read.detail);
      recordTodo(root, context, [{ pageId: "p1", title: "运营能力", layoutFamily: "chart", exhibits: [] }]);
      const revision = recordPageRevision(root, context, "p1", {
        id: "p1",
        elements: [],
      });
      recordMaterialFiguresFact(root, context, {
        pageId: "p1",
        revision: revision.revision,
        matches: ["4", "8"].map((value) => ({
          value,
          materialId: "template",
          sourcePage: 16,
          sourcePeriods: ["2026年1-2月"],
          chart: {
            sourceChartId: "chart-16",
            sourceType: "radar",
            outputTypes: ["bar"],
            substitution: { sourceType: "radar", targetType: "bar" },
          },
        })),
        pagePeriods: ["2026年1-2月"],
        visionValues: [],
      });
      const fact: DeckComposedFact = {
        type: "deck.composed",
        factId: "chart-seal",
        at: "2026-01-01T00:00:00.000Z",
        contextEpochId: context.contextEpochId,
        title: "图表来源核对",
        deckSha256: sha256("chart-seal"),
        pageRevisions: { p1: revision.pageSha256 },
      };
      const built = buildDeliveryProvenance(root, fact);
      assert.deepEqual(built.file.pages[0]!.detected, {
        quotedCount: 2,
        sourcePages: [16],
        periodMismatch: null,
        chartSubstitutions: [{ sourcePage: 16, sourceType: "radar", targetType: "bar" }],
      });
      assert.match(built.summary, /资料第 16 页一致；模板第 16 页的雷达图暂以柱状图代替/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
