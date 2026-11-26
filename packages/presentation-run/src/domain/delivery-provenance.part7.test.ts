import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { slimComposeResult } from "./compose-receipt.js";
import { DELIVERY_PROVENANCE_REL, PROVENANCE_SUMMARY_MAX_BYTES } from "./delivery-provenance.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import {
  ensureRunLedger,
  readRunLedger,
  recordStructuralReview,
  recordTodo,
  type DeckComposedFact,
  type PageRevisionFact,
} from "./run-ledger.js";

const sha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");

const context = { commandId: "delivery-provenance", contextEpochId: "provenance-epoch" };

function styleProfile(): Record<string, unknown> {
  return {
    schema: "style-profile/v1",
    source: "pdf-vector-ops",
    pagesScanned: 1,
    accentColors: [{ hex: "#C00000", share: 0.8, roles: ["fill"] }],
    neutralColors: [],
    fonts: [],
  };
}

/** 29-page synthetic report: 3 chunks, page 1 carries quoted figures, 3 and 26 low-text. */

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

function fixturePage(id: string, title: string, body: string, provenance?: unknown) {
  return {
    id,
    pageType: "content",
    ...(provenance === undefined ? {} : { provenance }),
    elements: (
      [
        [80, 80, 800, 60, title, 24],
        [80, 160, 800, 40, body, 16],
      ] as const
    ).map(([x, y, w, h, text, fontSize], index) => ({
      elementId: `${id}-t${index}`,
      elementType: "text",
      bounds: [x, y, w, h] as [number, number, number, number],
      content: { text, fontSize },
    })),
  };
}

async function writeFixturePage(root: string, args: Record<string, unknown>): Promise<void> {
  const result = await runDomainHand("write_page", { ...args, __openSlideStudio: context }, root);
  assert.equal(result.ok, true, result.detail);
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

function provenanceFile(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, DELIVERY_PROVENANCE_REL), "utf8")) as Record<string, unknown>;
}

async function compose(root: string, title: string) {
  const result = await runDomainHand("compose_deck", { title, __openSlideStudio: context }, root);
  assert.equal(result.ok, true, result.detail);
  return result;
}

describe("delivery provenance", () => {
  it("VAL-PROV-010: 24-page receipt with 3 materials and per-page detections stays within 4.2 KiB", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-size-"));
    try {
      preparedProject(root, "二十四页月报", 24);
      const pageText = (page: number) => `2026年1-2月 指标 ${page}0.25%\n${"甲".repeat(350)}`;
      writeMaterial(root, {
        id: "report-pdf",
        name: "月报资料.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: {
          document: {
            pageCount: 24,
            pages: Array.from({ length: 24 }, (_, index) => ({
              index: index + 1,
              chars: 380,
              lowText: false,
              text: pageText(index + 1),
            })),
          },
        },
      });
      writeMaterial(root, {
        id: "notes-doc",
        name: "备注.docx",
        kind: "document",
        parser: "docx-ooxml-v1",
        derivative: {
          document: {
            blocks: [{ type: "paragraph", text: "乙".repeat(300) }],
            counts: { paragraphs: 1 },
            chars: 300,
          },
        },
      });
      writeMaterial(root, {
        id: "hints-pdf",
        name: "风格线索.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: {
          document: {
            styleProfile: styleProfile(),
            pageCount: 1,
            pages: [{ index: 1, chars: 12, lowText: false, text: "辅色 #0070C0" }],
          },
        },
      });
      const count = 24;
      recordTodo(
        root,
        context,
        Array.from({ length: count }, (_, index) => ({
          pageId: `p${index + 1}`,
          title: `第 ${index + 1} 页指标`,
          layoutFamily: "content",
          exhibits: ["none"],
        })),
      );
      for (let offset = 0; offset < 3; offset += 1) {
        const result = await runDomainHand(
          "read_material",
          { materialId: "report-pdf", offset, __openSlideStudio: context },
          root,
        );
        assert.equal(result.ok, true, result.detail);
      }
      for (const materialId of ["notes-doc", "hints-pdf"]) {
        const result = await runDomainHand("read_material", { materialId, __openSlideStudio: context }, root);
        assert.equal(result.ok, true, result.detail);
      }
      for (let index = 1; index <= count; index += 1) {
        await writeFixturePage(root, fixturePage(`p${index}`, `第 ${index} 页指标`, `2026年1-3月 指标 ${index}0.25%`));
      }
      recordStructuralReview(root, true, []);
      const result = await compose(root, "二十四页月报");
      const payload = result.payload as Record<string, unknown>;
      const summary = payload.provenanceSummary as string;
      assert.ok(summary.length > 0);
      assert.ok(
        Buffer.byteLength(JSON.stringify(summary), "utf8") <= PROVENANCE_SUMMARY_MAX_BYTES,
        `summary must stay within 1.5 KiB, got ${Buffer.byteLength(JSON.stringify(summary))}`,
      );
      assert.match(summary, /期间不同/);
      const receiptBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      assert.ok(receiptBytes <= 4300, `whole receipt must stay within 4.2 KiB, got ${receiptBytes}`);
      const file = provenanceFile(root);
      const materials = file.materials as Record<string, unknown>[];
      assert.equal(materials.length, 3);
      assert.equal(materials[0]!.chunksRead, 3);
      assert.equal(materials[0]!.chunkCount, 3);
      assert.equal(materials[0]!.pagesCovered, "1–24");
      assert.equal(materials[1]!.chunksRead, 1);
      assert.equal((materials[1]!.use as string[]).includes("content"), true);
      const detections = (file.pages as Record<string, unknown>[]).filter((page) => page.detected !== null);
      assert.equal(detections.length, count);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("VAL-PROV-010: a 32-page deck with detections on every page truncates the summary with 等 N 页", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-trunc-"));
    try {
      preparedProject(root, "三十二页月报", 32);
      const pageText = (page: number) => `2026年1-2月 指标 ${page}0.25%\n${"甲".repeat(350)}`;
      writeMaterial(root, {
        id: "report-pdf",
        name: "月报资料.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: {
          document: {
            pageCount: 32,
            pages: Array.from({ length: 32 }, (_, index) => ({
              index: index + 1,
              chars: 380,
              lowText: false,
              text: pageText(index + 1),
            })),
          },
        },
      });
      const count = 32;
      recordTodo(
        root,
        context,
        Array.from({ length: count }, (_, index) => ({
          pageId: `p${index + 1}`,
          title: `第 ${index + 1} 页指标`,
          layoutFamily: "content",
          exhibits: ["none"],
        })),
      );
      for (let offset = 0; offset < 3; offset += 1) {
        const result = await runDomainHand(
          "read_material",
          { materialId: "report-pdf", offset, __openSlideStudio: context },
          root,
        );
        assert.equal(result.ok, true, result.detail);
      }
      for (let index = 1; index <= count; index += 1) {
        await writeFixturePage(root, fixturePage(`p${index}`, `第 ${index} 页指标`, `2026年1-3月 指标 ${index}0.25%`));
      }
      recordStructuralReview(root, true, []);
      const result = await compose(root, "三十二页月报");
      const summary = (result.payload as Record<string, unknown>).provenanceSummary as string;
      assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= PROVENANCE_SUMMARY_MAX_BYTES);
      assert.match(summary, /等 \d+ 页$/);
      assert.doesNotMatch(summary, /第 32 页：/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("VAL-PROV-010: slimComposeResult widens its budget only when a summary is attached", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-budget-"));
    try {
      preparedProject(root, "预算边界", 3);
      recordTodo(root, context, [{ pageId: "p1", title: "第一页", layoutFamily: "content", exhibits: ["none"] }]);
      const result = await runDomainHand(
        "write_page",
        {
          ...fixturePage("p1", "第一页", "正文内容足够长，可以直接交付。"),
          __openSlideStudio: context,
        },
        root,
      );
      assert.equal(result.ok, true, result.detail);
      const revision = readRunLedger(root)?.facts.find(
        (fact): fact is PageRevisionFact => fact.type === "page.revision-committed",
      );
      assert.ok(revision);
      const fact: DeckComposedFact = {
        type: "deck.composed",
        factId: "budget-seal",
        at: "2026-01-01T00:00:00.000Z",
        contextEpochId: "provenance-epoch",
        title: "预算边界",
        deckSha256: sha256("budget"),
        pageRevisions: { p1: revision.pageSha256 },
      };
      const sealed = slimComposeResult(root, result, fact);
      assert.equal("provenanceSummary" in (sealed.payload as Record<string, unknown>), false);
      assert.ok(Buffer.byteLength(JSON.stringify(sealed), "utf8") <= 4096);
      const withSummary = slimComposeResult(root, result, fact, {
        summary: "第 1 页：未说明来源，未检测到资料数字",
      });
      assert.equal(
        (withSummary.payload as Record<string, unknown>).provenanceSummary,
        "第 1 页：未说明来源，未检测到资料数字",
      );
      assert.ok(Buffer.byteLength(JSON.stringify(withSummary), "utf8") <= 4300);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
