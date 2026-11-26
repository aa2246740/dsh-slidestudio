import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { DELIVERY_PROVENANCE_REL } from "./delivery-provenance.js";
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
  it("M3-SCR-007: fails closed on unparsed chart conditions through delivery provenance", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conditional-chart-provenance-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    preparedProject(root, "条件格式核对", 5);
    const categories = ["指标"];
    await readTemplateCharts(root, [
      {
        id: "conditional-low",
        slide: 9,
        type: "bar",
        categories,
        series: [{ name: "实测", categories, values: [12.34], numFmt: "[>=100]0;0.00" }],
      },
      {
        id: "conditional-high",
        slide: 10,
        type: "bar",
        categories,
        series: [{ name: "实测", categories, values: [123.4], numFmt: "[>=100]0;0.00" }],
      },
      {
        id: "conditional-unparsed",
        slide: 11,
        type: "radar",
        categories,
        series: [{ name: "实测", categories, values: [12.34], numFmt: "[>=1E+2]0;0.00" }],
      },
      {
        id: "conditional-unparsed-exact",
        slide: 12,
        type: "radar",
        categories,
        series: [{ name: "实测", categories, values: [12.35], numFmt: "[>=1E+2]0;0.00" }],
      },
      {
        id: "conditional-unparsed-later-section",
        slide: 13,
        type: "radar",
        categories,
        series: [{ name: "实测", categories, values: [12.34], numFmt: "0;[>=1E+2]0.00" }],
      },
    ]);
    recordTodo(
      root,
      context,
      ["p1", "p2", "p3", "p4", "p5"].map((pageId) => ({
        pageId,
        title: "指标核对",
        layoutFamily: "chart",
        exhibits: [],
      })),
    );

    const low = await runDomainHand(
      "write_page",
      {
        ...templateChartPage("p1", categories, [12], 9),
        __openSlideStudio: context,
      },
      root,
    );
    assert.equal(low.ok, true, low.detail);
    const high = await runDomainHand(
      "write_page",
      {
        ...templateChartPage("p2", categories, [123], 10),
        __openSlideStudio: context,
      },
      root,
    );
    assert.equal(high.ok, true, high.detail);
    const unparsed = await runDomainHand(
      "write_page",
      {
        ...templateChartPage("p3", categories, [12], 11),
        __openSlideStudio: context,
      },
      root,
    );
    assert.equal(unparsed.ok, true, unparsed.detail);
    const exact = await runDomainHand(
      "write_page",
      {
        ...templateChartPage("p4", categories, [12.35], 12),
        __openSlideStudio: context,
      },
      root,
    );
    assert.equal(exact.ok, true, exact.detail);
    const unparsedLater = await runDomainHand(
      "write_page",
      {
        ...templateChartPage("p5", categories, [12], 13),
        __openSlideStudio: context,
      },
      root,
    );
    assert.equal(unparsedLater.ok, true, unparsedLater.detail);

    const facts = readRunLedger(root)?.facts.flatMap((fact) => {
      if (fact.type !== "page.material-figures") return [];
      return ["p1", "p2", "p3", "p4", "p5"].includes(fact.pageId) ? [fact] : [];
    });
    const lowFact = facts?.find((fact) => fact.pageId === "p1");
    const highFact = facts?.find((fact) => fact.pageId === "p2");
    const unparsedFact = facts?.find((fact) => fact.pageId === "p3");
    const exactFact = facts?.find((fact) => fact.pageId === "p4");
    const unparsedLaterFact = facts?.find((fact) => fact.pageId === "p5");
    assert.ok(lowFact?.type === "page.material-figures");
    assert.ok(highFact?.type === "page.material-figures");
    assert.ok(unparsedFact?.type === "page.material-figures");
    assert.ok(exactFact?.type === "page.material-figures");
    assert.ok(unparsedLaterFact?.type === "page.material-figures");
    assert.equal(
      lowFact.matches.some((match) => match.chart?.sourceChartId === "conditional-low"),
      false,
      "12.34 displays as 12.34 in the lower branch, not 12",
    );
    const highMatch = highFact.matches.find((match) => match.chart?.sourceChartId === "conditional-high");
    assert.equal(highMatch?.chart?.valueMatch, "displayed");
    assert.deepEqual(highMatch?.chart?.substitution, undefined);
    assert.equal(
      unparsedFact.matches.some((match) => match.chart?.sourceChartId === "conditional-unparsed"),
      false,
      "an unparsed condition cannot authorize displayed-precision matching",
    );
    assert.equal(
      unparsedLaterFact.matches.some((match) => match.chart?.sourceChartId === "conditional-unparsed-later-section"),
      false,
      "an unparsed condition in any later section disables displayed-precision matching",
    );
    const exactMatch = exactFact.matches.find((match) => match.chart?.sourceChartId === "conditional-unparsed-exact");
    assert.equal(exactMatch?.chart?.valueMatch, "exact");
    assert.deepEqual(exactMatch?.chart?.substitution, {
      sourceType: "radar",
      targetType: "bar",
    });

    recordStructuralReview(root, true, []);
    const result = await compose(root, "条件格式核对");
    const summary = (result.payload as Record<string, unknown>).provenanceSummary as string;
    const deliveredPages = provenanceFile(root).pages as {
      pageId: string;
      detected: { chartSubstitutions?: unknown[] } | null;
    }[];
    assert.equal(deliveredPages.find((page) => page.pageId === "p3")?.detected, null);
    assert.equal(deliveredPages.find((page) => page.pageId === "p5")?.detected, null);
    assert.deepEqual(deliveredPages.find((page) => page.pageId === "p4")?.detected?.chartSubstitutions, [
      { sourcePage: 12, sourceType: "radar", targetType: "bar" },
    ]);
    assert.doesNotMatch(summary, /模板第 11 页的雷达图暂以柱状图代替/);
    assert.doesNotMatch(summary, /模板第 13 页的雷达图暂以柱状图代替/);
    assert.match(summary, /模板第 12 页的雷达图暂以柱状图代替/);
  });
});
