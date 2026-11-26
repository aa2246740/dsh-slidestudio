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
import { recordMaterialFiguresFact } from "./material-figures.js";
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
  it("VAL-PROV-009: pagesCovered keeps pages that continue across or fill a whole chunk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-coverage-"));
    try {
      preparedProject(root, "部分阅读覆盖", 2);
      // 29-page report: low-text notes shift bytes, so chunk 1 continues page 12
      // and carries the headings of pages 13–23.
      writeMaterial(root, {
        id: "report-pdf",
        name: "月报资料.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: { document: { pageCount: 29, pages: reportPages() } },
      });
      // One page larger than a chunk: the second chunk lies entirely inside page 1.
      writeMaterial(root, {
        id: "long-pdf",
        name: "长页报告.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: {
          document: {
            pageCount: 1,
            pages: [
              {
                index: 1,
                text: `2026年1-2月 长页。\n\n${"甲".repeat(5200)}\n\n达标率 89.64%`,
              },
            ],
          },
        },
      });
      const half = await runDomainHand(
        "read_material",
        { materialId: "report-pdf", offset: 1, __openSlideStudio: context },
        root,
      );
      assert.equal(half.ok, true, half.detail);
      const tail = await runDomainHand(
        "read_material",
        { materialId: "long-pdf", offset: 1, __openSlideStudio: context },
        root,
      );
      assert.equal(tail.ok, true, tail.detail);
      const fact: DeckComposedFact = {
        type: "deck.composed",
        factId: "coverage-seal",
        at: "2026-01-01T00:00:00.000Z",
        contextEpochId: "provenance-epoch",
        title: "部分阅读覆盖",
        deckSha256: sha256("coverage"),
        pageRevisions: {},
      };
      const built = buildDeliveryProvenance(root, fact);
      const materials = built.file.materials;
      assert.equal(materials[0]!.chunksRead, 1);
      assert.equal(
        materials[0]!.pagesCovered,
        "12–23",
        "the continuation chunk's tail of page 12 must count as covered",
      );
      assert.equal(materials[1]!.chunksRead, 1);
      assert.equal(materials[1]!.pagesCovered, "1", "a chunk that only continues one page still covers that page");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("VAL-PROV-009: quotedCount counts distinct values while sourcePages keep every source page", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-count-"));
    try {
      preparedProject(root, "计数核对", 2);
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
          { pageId: "p1", title: "指标汇总" },
          { pageId: "p2", title: "结语" },
        ].map((item) => ({ ...item, layoutFamily: "content", exhibits: ["none"] })),
      );
      const read = await runDomainHand("read_material", { materialId: "report-pdf", __openSlideStudio: context }, root);
      assert.equal(read.ok, true, read.detail);
      const revision = recordPageRevision(root, context, "p1", { id: "p1", elements: [] });
      // One value (12.34%) matched on two source pages plus one more value: two
      // distinct quoted figures, three source matches.
      recordMaterialFiguresFact(root, context, {
        pageId: "p1",
        revision: revision.revision,
        matches: [
          {
            value: "12.34%",
            materialId: "report-pdf",
            sourcePage: 1,
            sourcePeriods: ["2026年1-2月"],
          },
          {
            value: "12.34%",
            materialId: "report-pdf",
            sourcePage: 2,
            sourcePeriods: ["2026年2月"],
          },
          {
            value: "56.78%",
            materialId: "report-pdf",
            sourcePage: 2,
            sourcePeriods: ["2026年2月"],
          },
        ],
        pagePeriods: ["2026年9月"],
        visionValues: [],
      });
      const fact: DeckComposedFact = {
        type: "deck.composed",
        factId: "count-seal",
        at: "2026-01-01T00:00:00.000Z",
        contextEpochId: "provenance-epoch",
        title: "计数核对",
        deckSha256: sha256("count"),
        pageRevisions: { p1: revision.pageSha256 },
      };
      const built = buildDeliveryProvenance(root, fact);
      assert.deepEqual(built.file.pages[0]!.detected, {
        quotedCount: 2,
        sourcePages: [1, 2],
        periodMismatch: { page: "2026年9月", source: ["2026年1-2月", "2026年2月"] },
      });
      assert.match(built.summary, /第 1 页：2 个数字与资料第 1、2 页一致/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
