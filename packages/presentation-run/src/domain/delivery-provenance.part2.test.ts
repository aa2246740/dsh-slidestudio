import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { buildDeliveryProvenance, DELIVERY_PROVENANCE_REL } from "./delivery-provenance.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { ensureRunLedger, readRunLedger, recordStructuralReview, recordTodo } from "./run-ledger.js";

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

async function readAllChunks(root: string, materialId: string): Promise<void> {
  for (let offset = 0; offset < 3; offset += 1) {
    const result = await runDomainHand("read_material", { materialId, offset, __openSlideStudio: context }, root);
    assert.equal(result.ok, true, result.detail);
  }
}

async function readTemplateCharts(root: string, charts: readonly Record<string, unknown>[]): Promise<void> {
  writeMaterial(root, {
    id: "synthetic-template",
    name: "synthetic.pptx",
    kind: "deck-template",
    parser: "pptx-ooxml-v2",
    derivative: {
      "deck-template": {
        templateDetail: {
          slides: [],
          charts,
        },
      },
    },
  });
  const materialDir = path.join(root, "_agent/materials/synthetic-template");
  const receiptPath = path.join(materialDir, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  const markdown = "# Synthetic design\n";
  const designJson = '{"schema":"design-source/v1","layouts":[]}';
  fs.writeFileSync(path.join(materialDir, "design-source.md"), markdown);
  fs.writeFileSync(path.join(materialDir, "design-source.json"), designJson);
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      ...receipt,
      designSourceMdSha256: sha256(markdown),
      designSourceJsonSha256: sha256(designJson),
    }),
  );
  const read = await runDomainHand(
    "read_material",
    { materialId: "synthetic-template", part: "charts", __openSlideStudio: context },
    root,
  );
  assert.equal(read.ok, true, read.detail);
}

function templateChartPage(id: string, categories: readonly string[], values: readonly number[], sourcePage: number) {
  const page = fixturePage(id, "指标核对", "核对指标并保留原始数据含义。", {
    basis: "material",
    materials: [{ materialId: "synthetic-template", pages: String(sourcePage) }],
  });
  return {
    ...page,
    elements: [
      ...page.elements,
      {
        elementId: `${id}-chart`,
        elementType: "chart",
        bounds: [80, 250, 800, 240],
        data: {
          cols: ["类别", "实测"],
          rows: categories.map((category, index) => [category, values[index]]),
        },
        series: [{ type: "bar", encode: { x: "类别", y: "实测" } }],
      },
    ],
  };
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
  it("M3-SCR-014: records decimal ties, negatives and percent values through write_page receipts", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "decimal-chart-provenance-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    preparedProject(root, "十进制精度核对", 3);
    const categories = ["甲", "乙", "丙"];
    const cases = [
      {
        chartId: "positive-ties",
        sourcePage: 9,
        values: [1.005, 2.675, 3.335],
        numFmt: "0.00",
        written: [1.01, 2.68, 3.34],
      },
      {
        chartId: "negative-ties",
        sourcePage: 10,
        values: [-1.005, -2.675, -3.335],
        numFmt: "0.00",
        written: [-1.01, -2.68, -3.34],
      },
      {
        chartId: "percent-ties",
        sourcePage: 11,
        values: [0.1205, 0.1245, 0.3355],
        numFmt: "0.0%",
        written: [12.1, 12.5, 33.6],
      },
    ] as const;
    await readTemplateCharts(
      root,
      cases.map(({ chartId, sourcePage, values, numFmt }) => ({
        id: chartId,
        slide: sourcePage,
        type: "radar",
        categories,
        series: [{ name: "实测", categories, values, numFmt }],
      })),
    );
    recordTodo(
      root,
      context,
      cases.map((item, index) => ({
        pageId: `p${index + 1}`,
        title: "指标核对",
        layoutFamily: "chart",
        exhibits: [],
      })),
    );

    for (const [index, item] of cases.entries()) {
      const pageId = `p${index + 1}`;
      const written = await runDomainHand(
        "write_page",
        {
          ...templateChartPage(pageId, categories, item.written, item.sourcePage),
          __openSlideStudio: context,
        },
        root,
      );
      assert.equal(written.ok, true, written.detail);
      const figureFact = readRunLedger(root)?.facts.find(
        (fact) => fact.type === "page.material-figures" && fact.pageId === pageId,
      );
      assert.ok(figureFact?.type === "page.material-figures");
      const chartMatches = figureFact.matches.filter((match) => match.chart);
      assert.equal(chartMatches.length, 3, `${item.chartId} value attribution`);
      assert.ok(chartMatches.every((match) => match.chart?.valueMatch === "displayed"));
      assert.ok(chartMatches.every((match) => match.chart?.sourceChartId === item.chartId));
      assert.match(
        String((written.payload as { hint?: string }).hint ?? ""),
        new RegExp(`本页图表沿用模板第 ${item.sourcePage} 页雷达图数据`),
      );
    }
  });

  it("carries per-source design aspects from runtime into delivery provenance", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aspect-provenance-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const designAspects = [
      {
        source: "material:brand.pptx",
        aspects: ["palette", "fonts", "logo"],
      },
    ];
    writeDomainRuntime(root, {
      brief: "设计来源",
      strictExecution: true,
      designDirection: "self-directed",
      adoptedSourceIds: ["material:brand.pptx"],
      designAspects,
    });
    const result = buildDeliveryProvenance(root, {
      type: "deck.composed",
      factId: "aspect-seal",
      at: "2026-01-01T00:00:00.000Z",
      contextEpochId: "aspect-epoch",
      title: "设计来源",
      deckSha256: sha256("synthetic"),
      pageRevisions: {},
    });
    assert.deepEqual(result.file.design.designAspects, designAspects);
  });

  it("VAL-LEGACY-007: provenance materials carry the legacy conversion origin", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "converted-provenance-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeDomainRuntime(root, {
      brief: "旧版资料",
      strictExecution: true,
      designDirection: "self-directed",
      adoptedSourceIds: [],
      designAspects: [],
    });
    const conversion = (from: string, converted: Buffer): Record<string, unknown> => ({
      from,
      to: ".pptx",
      engine: "libreoffice",
      rule: "legacy-convert-v1",
      durationMs: 12,
      convertedSha256: sha256(converted),
      convertedBytes: converted.length,
      isolation: "profile-only",
    });
    writeMaterial(root, {
      id: "legacy-ppt",
      name: "旧版.ppt",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalExtension: ".ppt",
      derivative: {
        "deck-template": { templateDetail: { slides: [] } },
        conversion: conversion(".ppt", Buffer.from("package-a")),
      },
      convertedBytes: Buffer.from("package-a"),
    });
    writeMaterial(root, {
      id: "legacy-wps",
      name: "旧版.dps",
      kind: "deck-template",
      parser: "pptx-ooxml-v1",
      originalExtension: ".dps",
      derivative: {
        "deck-template": { templateDetail: { slides: [] } },
        conversion: conversion(".dps", Buffer.from("package-b")),
      },
      convertedBytes: Buffer.from("package-b"),
    });
    const result = buildDeliveryProvenance(root, {
      type: "deck.composed",
      factId: "converted-seal",
      at: "2026-01-01T00:00:00.000Z",
      contextEpochId: "converted-epoch",
      title: "旧版资料",
      deckSha256: sha256("synthetic"),
      pageRevisions: {},
    });
    const byId = new Map(result.file.materials.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("legacy-ppt")?.convertedFrom, ".ppt");
    assert.equal(byId.get("legacy-ppt")?.convertedFromWps, undefined);
    assert.equal(byId.get("legacy-wps")?.convertedFrom, ".dps");
    assert.equal(byId.get("legacy-wps")?.convertedFromWps, true);
  });

  for (const scenario of [
    { basis: "mixed", detected: false, label: "部分示意" },
    { basis: "mock", detected: true, label: "示意数据" },
    { basis: "mixed", detected: true, label: "部分示意" },
  ] as const) {
    it(`compose summary independently discloses ${scenario.basis} with ${scenario.detected ? "coincidental" : "no"} detected figures`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-provenance-declared-"));
      try {
        preparedProject(root, "声明独立披露", 3);
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
          [1, 2, 3].map((index) => ({
            pageId: `p${index}`,
            title: `声明核对 ${index}`,
            layoutFamily: "content",
            exhibits: ["none"],
          })),
        );
        await readAllChunks(root, "report-pdf");
        await writeFixturePage(
          root,
          fixturePage(
            "p1",
            "声明核对",
            scenario.detected
              ? "达标率 89.64%，其他指标为示意内容，待真实数据替换。"
              : "本页含示意内容，待真实数据替换。",
            { basis: scenario.basis, note: "含示意内容，不能当作全部来自资料。" },
          ),
        );
        for (const index of [2, 3]) {
          await writeFixturePage(root, fixturePage(`p${index}`, "结语", "本稿结构完整，数据来源已逐页核对完毕。"));
        }
        recordStructuralReview(root, true, []);
        const result = await compose(root, "声明独立披露");
        const summary = (result.payload as Record<string, unknown>).provenanceSummary as string;
        assert.match(summary, new RegExp(`标为${scenario.label}的页：第 1 页`));
        if (scenario.detected) assert.match(summary, /第 1 页：1 个数字与资料第 1 页一致/);
        else assert.doesNotMatch(summary, /第 1 页：.*个数字与资料/);
        const page = (provenanceFile(root).pages as Record<string, unknown>[])[0]!;
        assert.equal((page.declared as Record<string, unknown>).basis, scenario.basis);
        assert.equal(page.detected !== null, scenario.detected);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
