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
import {
  ensureRunLedger,
  readRunLedger,
  recordStructuralReview,
  recordTodo,
  type PageRevisionFact,
} from "./run-ledger.js";

const sha256 = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");

const context = { commandId: "delivery-provenance", contextEpochId: "provenance-epoch" };

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
  for (const displayed of [false, true]) {
    it(`read/write/compose preserves ${displayed ? "displayed-precision" : "exact"} attribution through category repair and only seals real substitutions`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-chart-repair-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      preparedProject(root, "离线图表核对", 3);
      const categories = ["触达", "留存", "响应"];
      writeMaterial(root, {
        id: "synthetic-template",
        name: "synthetic.pptx",
        kind: "deck-template",
        parser: "pptx-ooxml-v2",
        derivative: {
          "deck-template": {
            templateDetail: {
              slides: [9, 12].map((index) => ({ index, title: "能力指标", text: "2031年4月" })),
              charts: [
                {
                  id: "volume",
                  slide: 9,
                  type: "bar",
                  series: [{ name: "实测", categories, values: [17, 23, 31] }],
                },
                {
                  id: "capacity",
                  slide: 12,
                  type: "radar",
                  series: [
                    {
                      name: "实测",
                      categories,
                      values: displayed ? [41.1234567891234, 47.2345678912345, 53.3456789123456] : [41, 47, 53],
                      ...(displayed ? { numFmt: "0.00" } : {}),
                    },
                  ],
                },
              ],
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
        {
          materialId: "synthetic-template",
          part: "charts",
          __openSlideStudio: context,
        },
        root,
      );
      assert.equal(read.ok, true, read.detail);
      assert.match((read.payload as { text: string }).text, /源页期间：2031年4月/);
      recordTodo(
        root,
        context,
        ["p1", "p2", "p3"].map((pageId) => ({
          pageId,
          title: pageId === "p3" ? "结束页" : "能力指标",
          layoutFamily: "chart",
          exhibits: [],
        })),
      );
      const chartPage = (id: string, period: string, labels: string[], values: number[], provenance?: unknown) => {
        const page = fixturePage(
          id,
          id === "p3" ? "结束页" : "能力指标",
          `${period}：核对指标，按结果持续改进。`,
          provenance,
        );
        return {
          ...page,
          elements: [
            ...page.elements,
            {
              elementId: `${id}-chart`,
              elementType: "chart",
              bounds: [80, 250, 800, 250],
              data: { cols: ["指标", "实测"], rows: labels.map((label, i) => [label, values[i]]) },
              series: [{ type: "bar", encode: { x: "指标", y: "实测" } }],
            },
          ],
        };
      };
      const moved = await runDomainHand(
        "write_page",
        {
          ...chartPage("p1", "2031年5月", ["区域甲", "区域乙", "区域丙"], [17, 23, 31]),
          __openSlideStudio: context,
        },
        root,
      );
      assert.equal(moved.ok, true, moved.detail);
      const hint = (moved.payload as { hint?: string }).hint ?? "";
      assert.match(hint, /类别.*不同.*恢复/);
      assert.match(hint, /2031年4月.*2031年5月/);
      const revision = readRunLedger(root)?.facts.find(
        (fact): fact is PageRevisionFact => fact.type === "page.revision-committed" && fact.pageId === "p1",
      );
      assert.ok(revision);
      const before = buildDeliveryProvenance(root, {
        type: "deck.composed",
        factId: "before-repair",
        at: "2031-05-01T00:00:00.000Z",
        contextEpochId: context.contextEpochId,
        title: "离线图表核对",
        deckSha256: sha256("before"),
        pageRevisions: { p1: revision.pageSha256 },
      });
      assert.deepEqual(before.file.pages[0]?.detected, {
        quotedCount: 3,
        sourcePages: [9],
        periodMismatch: { page: "2031年5月", source: ["2031年4月"] },
      });
      assert.match(before.summary, /资料第 9 页一致，期间不同/);
      const declared = (sourcePage: number) => ({
        basis: "material",
        materials: [{ materialId: "synthetic-template", pages: String(sourcePage) }],
      });
      await writeFixturePage(root, chartPage("p1", "2031年4月", categories, [17, 23, 31], declared(9)));
      const substituted = await runDomainHand(
        "write_page",
        {
          ...chartPage("p2", "2031年4月", categories, displayed ? [41.12, 47.23, 53.35] : [41, 47, 53], declared(12)),
          __openSlideStudio: context,
        },
        root,
      );
      assert.equal(substituted.ok, true, substituted.detail);
      const substitutionReceipt = (substituted.payload as { hint?: string }).hint ?? "";
      assert.equal(substitutionReceipt, "已记录：本页图表沿用模板第 12 页雷达图数据，交付卡片将注明以柱状图代替");
      const chartFact = readRunLedger(root)?.facts.find(
        (fact) => fact.type === "page.material-figures" && fact.pageId === "p2",
      );
      assert.ok(chartFact?.type === "page.material-figures");
      assert.ok(chartFact.matches.every((match) => match.chart?.valueMatch === (displayed ? "displayed" : "exact")));
      await writeFixturePage(
        root,
        chartPage("p3", "2031年5月", categories, [61, 67, 71], {
          basis: "mock",
          note: "离线示意数据，不来自模板。",
        }),
      );
      recordStructuralReview(root, true, []);
      const result = await compose(root, "离线图表核对");
      const delivered = provenanceFile(root) as unknown as {
        pages: {
          detected: {
            sourcePages: number[];
            periodMismatch: unknown;
            chartSubstitutions?: unknown[];
          } | null;
        }[];
      };
      assert.deepEqual(delivered.pages[0]?.detected?.sourcePages, [9]);
      assert.equal(delivered.pages[0]?.detected?.periodMismatch, null);
      assert.equal(delivered.pages[0]?.detected?.chartSubstitutions, undefined);
      assert.deepEqual(delivered.pages[1]?.detected?.chartSubstitutions, [
        { sourcePage: 12, sourceType: "radar", targetType: "bar" },
      ]);
      assert.equal(delivered.pages[2]?.detected, null);
      const summary = (result.payload as { provenanceSummary: string }).provenanceSummary;
      assert.match(summary, /模板第 12 页的雷达图暂以柱状图代替/);
      assert.doesNotMatch(summary, /模板第 9 页的.*代替|期间不同/);
    });
  }
});
