import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { DELIVERY_PROVENANCE_REL, PROVENANCE_SUMMARY_MAX_BYTES } from "./delivery-provenance.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { ensureRunLedger, readRunLedger, recordStructuralReview, recordTodo } from "./run-ledger.js";

const sha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");

const context = { commandId: "delivery-provenance", contextEpochId: "provenance-epoch" };

const SOURCE_PAGE_1 = "2026年1-2月 达标率 89.64% 87.53% 89.56%";

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

async function readAllChunks(root: string, materialId: string): Promise<void> {
  for (let offset = 0; offset < 3; offset += 1) {
    const result = await runDomainHand("read_material", { materialId, offset, __openSlideStudio: context }, root);
    assert.equal(result.ok, true, result.detail);
  }
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
  it("VAL-PROV-010: 32-page truncation preserves both declaration lists before detection detail", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-declared-size-"));
    try {
      preparedProject(root, "三十二页声明核对", 32);
      writeMaterial(root, {
        id: "report-pdf",
        name: "月报资料.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: { document: { pageCount: 29, pages: reportPages() } },
      });
      recordTodo(
        root,
        context,
        Array.from({ length: 32 }, (_, index) => ({
          pageId: `p${index + 1}`,
          title: `声明核对 ${index + 1}`,
          layoutFamily: "content",
          exhibits: ["none"],
        })),
      );
      await readAllChunks(root, "report-pdf");
      for (let index = 1; index <= 32; index += 1) {
        await writeFixturePage(
          root,
          fixturePage(`p${index}`, "声明核对", "达标率 89.64%，其他指标为示意内容，待真实数据替换。", {
            basis: index % 2 ? "mock" : "mixed",
            note: "含示意内容，即使数字恰好与资料一致也不代表真实引用。",
          }),
        );
      }
      recordStructuralReview(root, true, []);
      const result = await compose(root, "三十二页声明核对");
      const summary = (result.payload as Record<string, unknown>).provenanceSummary as string;
      assert.match(
        summary,
        /^标为示意数据的页：第 1、3、5、7、9、11、13、15、17、19、21、23、25、27、29、31 页；标为部分示意的页：第 2、4、6、8、10、12、14、16、18、20、22、24、26、28、30、32 页；/,
      );
      assert.match(summary, /第 1 页：1 个数字与资料第 1 页一致/);
      assert.match(summary, /等 \d+ 页$/);
      assert.doesNotMatch(summary, /第 32 页：/);
      assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= PROVENANCE_SUMMARY_MAX_BYTES);
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4300);
      const pages = provenanceFile(root).pages as Record<string, unknown>[];
      assert.equal(pages.length, 32);
      assert.ok(pages.every((page) => page.declared !== null && page.detected !== null));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("VAL-PROV-009: compose writes delivery-provenance.v1.json from ledger facts only, and a second compose rewrites it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-"));
    try {
      preparedProject(root, "数字溯源月报", 3);
      writeMaterial(root, {
        id: "report-pdf",
        name: "月报资料.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: { document: { pageCount: 29, pages: reportPages() } },
      });
      writeMaterial(root, {
        id: "hints-pdf",
        name: "风格线索.pdf",
        kind: "document",
        parser: "pdf-unpdf-v1",
        derivative: { document: { styleProfile: styleProfile() } },
      });
      recordTodo(
        root,
        context,
        [
          { pageId: "p1", title: "指标汇总" },
          { pageId: "p2", title: "示意数据" },
          { pageId: "p3", title: "结语" },
        ].map((item) => ({ ...item, layoutFamily: "content", exhibits: ["none"] })),
      );
      await readAllChunks(root, "report-pdf");

      // Quoted figures moved to a different period: detected with a mismatch.
      await writeFixturePage(root, fixturePage("p1", "指标汇总", "2026年1-9月 达标率 89.64% 87.53%"));
      // Declared mock page: recorded, no detection.
      await writeFixturePage(
        root,
        fixturePage("p2", "示意数据", "其余指标均为示意数据，等待替换。", {
          basis: "mock",
          note: "数字为示意，待新数据替换",
        }),
      );
      await writeFixturePage(root, fixturePage("p3", "结语", "本稿结构完整，数据来源已逐页核对完毕。"));
      recordStructuralReview(root, true, []);

      const result = await compose(root, "数字溯源月报");
      const payload = result.payload as Record<string, unknown>;
      const summary = payload.provenanceSummary as string | undefined;
      assert.ok(summary, "a material read must attach the provenance summary");
      assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= PROVENANCE_SUMMARY_MAX_BYTES);
      assert.match(summary, /第 1 页：2 个数字与资料第 1 页一致，期间不同/);
      assert.match(summary, /标为示意数据的页：第 2 页/);
      assert.match(summary, /第 3 页：未说明来源，未检测到资料数字/);

      const file = provenanceFile(root);
      assert.equal(file.schema, "delivery-provenance/v1");
      const fact = readRunLedger(root)
        ?.facts.filter((item) => item.type === "deck.composed")
        .at(-1);
      assert.ok(fact?.type === "deck.composed");
      assert.equal(file.deckSha256, fact.deckSha256);
      assert.equal(file.contextEpochId, "provenance-epoch");

      const materials = file.materials as Record<string, unknown>[];
      assert.equal(materials.length, 2);
      assert.deepEqual(materials[0], {
        id: "report-pdf",
        name: "月报资料.pdf",
        kind: "document",
        chunksRead: 3,
        chunkCount: 3,
        pagesCovered: "1–29",
        pagesTotal: 29,
        lowTextPages: [3, 26],
        use: ["content"],
      });
      assert.deepEqual(materials[1], {
        id: "hints-pdf",
        name: "风格线索.pdf",
        kind: "document",
        chunksRead: 0,
        chunkCount: null,
        pagesCovered: null,
        lowTextPages: [],
        use: ["style-hint"],
      });

      assert.deepEqual(file.design, {
        stylePriority: "agent",
        designSystemId: null,
        adoptedSourceIds: [],
        designAspects: [],
        userColors: [],
        components: [],
        styleHintsUsed: [],
      });
      assert.deepEqual(file.images, []);
      const pages = file.pages as Record<string, unknown>[];
      assert.deepEqual(
        pages.map((page) => page.pageId),
        ["p1", "p2", "p3"],
      );
      assert.deepEqual(
        pages.map((page) => page.title),
        ["指标汇总", "示意数据", "结语"],
      );
      assert.equal(pages[0]!.declared, null);
      assert.deepEqual(pages[0]!.detected, {
        quotedCount: 2,
        sourcePages: [1],
        periodMismatch: { page: "2026年1-9月", source: ["2026年1-2月"] },
      });
      assert.deepEqual(pages[0]!.visionValues, []);
      assert.deepEqual(pages[0]!.queries, []);
      assert.deepEqual(pages[1]!.declared, {
        basis: "mock",
        note: "数字为示意，待新数据替换",
      });
      assert.equal(pages[1]!.detected, null);
      assert.equal(pages[2]!.declared, null);
      assert.equal(pages[2]!.detected, null);
      assert.deepEqual(file.data, {});
      assert.deepEqual(file.conflicts, []);
      assert.deepEqual(file.layouts, []);

      // A second compose after a page rewrite rewrites the file for the new seal.
      recordStructuralReview(root, false, ["p3:需要补充数据来源说明"]);
      await writeFixturePage(root, fixturePage("p3", "结语", "本稿结构完整，数据来源已逐页核对。"));
      recordStructuralReview(root, true, []);
      const second = await compose(root, "数字溯源月报");
      const secondFile = provenanceFile(root);
      const secondFact = readRunLedger(root)
        ?.facts.filter((item) => item.type === "deck.composed")
        .at(-1);
      assert.ok(secondFact?.type === "deck.composed");
      assert.notEqual(secondFact.deckSha256, fact.deckSha256);
      assert.equal(secondFile.deckSha256, secondFact.deckSha256);
      assert.equal((second.payload as Record<string, unknown>).composedFactId, secondFact.factId);
      const rewrittenPage = (secondFile.pages as Record<string, unknown>[]).find((page) => page.pageId === "p3");
      assert.equal(rewrittenPage?.declared, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("VAL-PROV-009: a failed compose writes no provenance file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-failed-"));
    try {
      preparedProject(root, "未完成月报", 3);
      const rejected = await runDomainHand("compose_deck", { title: "未完成月报", __openSlideStudio: context }, root);
      assert.equal(rejected.ok, false);
      assert.equal(fs.existsSync(path.join(root, DELIVERY_PROVENANCE_REL)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
