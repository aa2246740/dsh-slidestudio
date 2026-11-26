import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  applyWritePageProvenance,
  detectMaterialFigures,
  extractStrongNumbers,
  missingQuotedValues,
  pageTextForFigures,
  recordMaterialFiguresFact,
  recordPageProvenanceFact,
  type MaterialFigureReading,
} from "./material-figures.js";
import { ensureRunLedger, readRunLedger, recordMaterialChunk, type RunToolContext } from "./run-ledger.js";
import { readMaterialChunk } from "./material-content.js";
import { sha256Hex, verifyMaterial } from "./material-pack.js";

/** Text modelled on the `monthly-feb.pdf` fixture: one source page with the
 * period-labelled figures, placeholder pages elsewhere. */
const SOURCE_PAGE_1 = "2026年1-2月 达标率 89.64% 87.53% 89.56%";
const SOURCE_PAGE_2 = "2026年1-2月 完成率 XX.X%，环比变化 XX.X 个百分点，待本期数据更新。";
const PAGE_MOVED_PERIOD = "2026年1-9月 达标率 89.64% 87.53% 89.56%";

const reading = (pages: Record<number, string>, id = "m-feb"): MaterialFigureReading => ({
  materialId: id,
  materialName: "monthly-feb.pdf",
  pages: Object.entries(pages).map(([page, text]) => ({ page: Number(page), text })),
});

describe("visible rich text extraction", () => {
  it("joins numbers split across spans and ignores numbers inside attributes and hex colours", () => {
    const text = pageTextForFigures({
      elements: [
        {
          elementType: "text",
          content: {
            text: '<p><span style="font-weight:700">89.</span><span>64%</span></p>',
          },
        },
        {
          elementType: "text",
          content: {
            text: '<p><span style="color:#B53333">环比</span><span style="width:12.345%">柱宽</span> 87.53%</p>',
          },
        },
      ],
    });
    assert.equal(text.includes("style="), false);
    const report = detectMaterialFigures({
      pageText: text,
      readings: [reading({ 1: SOURCE_PAGE_1 })],
    });
    assert.deepEqual(
      report.matches.map((match) => match.value),
      ["89.64%", "87.53%"],
    );
    assert.equal(extractStrongNumbers(text).includes("12.345%"), false);
  });
});

describe("page text extraction", () => {
  it("collects notes, text content, chart titles and table cells", () => {
    const text = pageTextForFigures({
      notes: "备注 12.34",
      elements: [
        { elementType: "text", content: { text: "标题 89.64%" } },
        { elementType: "chart", title: { text: "趋势 1,234" } },
        {
          elementType: "table",
          rows: [
            ["指标", "值"],
            ["达标率", "87.53%"],
          ],
        },
      ],
    });
    assert.match(text, /备注 12\.34/);
    assert.match(text, /标题 89\.64%/);
    assert.match(text, /趋势 1,234/);
    assert.match(text, /87\.53%/);
  });
});

describe("quoted declaration check", () => {
  const readings = [reading({ 1: SOURCE_PAGE_1 })];

  it("accepts values present in the read chunks, including bare-number matches", () => {
    assert.deepEqual(
      missingQuotedValues({ basis: "material", quoted: [{ value: "89.64%", sourcePage: 1 }] }, readings),
      [],
    );
    assert.deepEqual(missingQuotedValues({ basis: "material", quoted: [{ value: "89.64" }] }, readings), []);
  });

  it("reports values absent from the read chunks", () => {
    assert.deepEqual(missingQuotedValues({ basis: "mixed", quoted: [{ value: "12.3%" }] }, readings), ["12.3%"]);
  });
});

describe("ledger facts", () => {
  let root = "";
  let context: RunToolContext;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "material-figures-ledger-"));
    ensureRunLedger(root, {
      manifestSha256: "fixture",
      requirementsId: "fixture",
      requirements: [],
      executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
    });
    context = { commandId: "cmd-1", contextEpochId: "figures-epoch" };
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("records provenance and figure facts, deduplicating identical rewrites", () => {
    const declaration = {
      basis: "mock" as const,
      quoted: [{ value: "12.3%", sourcePage: 3 }],
      note: "数字为示意",
    };
    recordPageProvenanceFact(root, context, {
      pageId: "p1",
      revision: 1,
      pageSha256: "a".repeat(64),
      declaration,
    });
    recordPageProvenanceFact(root, context, {
      pageId: "p1",
      revision: 1,
      pageSha256: "a".repeat(64),
      declaration,
    });
    recordMaterialFiguresFact(root, context, {
      pageId: "p1",
      revision: 1,
      matches: [{ value: "89.64%", materialId: "m-feb", sourcePage: 1, sourcePeriods: ["2026年1-2月"] }],
      pagePeriods: ["2026年1-9月"],
      visionValues: [],
    });
    const facts = readRunLedger(root)!.facts;
    const provenance = facts.filter((fact) => fact.type === "page.provenance-declared");
    assert.equal(provenance.length, 1);
    assert.equal(provenance[0]!.pageId, "p1");
    assert.equal(provenance[0]!.revision, 1);
    assert.equal(provenance[0]!.pageSha256, "a".repeat(64));
    assert.deepEqual(provenance[0]!.declaration, declaration);
    const figures = facts.filter((fact) => fact.type === "page.material-figures");
    assert.equal(figures.length, 1);
    assert.deepEqual(figures[0]!.matches, [
      { value: "89.64%", materialId: "m-feb", sourcePage: 1, sourcePeriods: ["2026年1-2月"] },
    ]);
    assert.deepEqual(figures[0]!.pagePeriods, ["2026年1-9月"]);
  });

  it("applies provenance after a write and returns the combined non-blocking hint", () => {
    materializeFixtureMaterial(root, context);
    const hint = applyWritePageProvenance(
      root,
      context,
      {
        pageId: "p2",
        revision: 1,
        pageSha256: "b".repeat(64),
      },
      {
        id: "p2",
        pageType: "content",
        elements: [
          {
            elementId: "t",
            elementType: "text",
            bounds: [80, 80, 800, 60],
            content: { text: PAGE_MOVED_PERIOD, fontSize: 24 },
          },
        ],
      },
      {
        provenance: {
          basis: "mock",
          quoted: [{ value: "12.3%", sourcePage: 9 }],
          note: "页面数字待新数据替换",
        },
      },
    );
    assert.ok(hint);
    assert.match(hint!, /你标为原样引用的 12\.3% 没有出现在已读资料里，请核对或改标为示意。/);
    assert.match(hint!, /这条提示不阻止保存。/);
    assert.match(
      hint!,
      /下一步：先用 read_material.*charts\/slides.*再用 write_page 完整重写同一页.*修正后再调用 render_page\/review_pages/,
    );
    assert.match(hint!, /不得保留模板数值却标为源资料之外的期间/);
    assert.match(hint!, /非模板数据.*已读来源支持的新数字.*期间、单位和实体/);
    assert.match(hint!, /仅在用户允许时.*新的示意数字/);
    assert.match(hint!, /provenance\.basis\/materials\/quoted\/note.*准确说明来源或示意性质/);
    assert.match(hint!, /只改标签、补注原期间或声明 mock 均不能修正原数错期/);
    const facts = readRunLedger(root)!.facts;
    assert.ok(facts.some((fact) => fact.type === "page.provenance-declared"));
    const figures = facts.find((fact) => fact.type === "page.material-figures" && fact.pageId === "p2");
    assert.ok(figures);
  });

  it("returns no hint when provenance is absent and nothing matches", () => {
    const hint = applyWritePageProvenance(
      root,
      context,
      {
        pageId: "p3",
        revision: 1,
        pageSha256: "c".repeat(64),
      },
      {
        id: "p3",
        pageType: "content",
        elements: [
          {
            elementId: "t",
            elementType: "text",
            bounds: [80, 80, 800, 60],
            content: { text: "纯自主内容，没有资料数字。", fontSize: 24 },
          },
        ],
      },
      {},
    );
    assert.equal(hint, undefined);
  });
});

/** Materialize the fixture document under `_agent/materials/m-feb` and record
 * its first read chunk the same way `read_material` does, so the session
 * readings re-derive the deterministic rendered text. */
function materializeFixtureMaterial(root: string, context: RunToolContext): void {
  const materialDir = path.join(root, "_agent", "materials", "m-feb");
  fs.mkdirSync(materialDir, { recursive: true });
  const originalBytes = Buffer.from("%PDF-1.4 fixture");
  const originalSha256 = sha256Hex(originalBytes);
  const derivative = {
    schema: "material-derivative/v1",
    materialId: "m-feb",
    kind: "document",
    source: {
      name: "monthly-feb.pdf",
      bytes: originalBytes.length,
      sha256: originalSha256,
      declaredMime: null,
      detectedMime: "application/pdf",
      extension: ".pdf",
      extensionMismatch: false,
    },
    parser: { id: "pdf-unpdf-v1", engine: "unpdf", durationMs: 1 },
    status: "ok",
    truncated: { applied: false },
    warnings: [],
    summary: { zh: "PDF · 2 页 · 约 40 字" },
    document: {
      pageCount: 2,
      pages: [
        { index: 1, text: SOURCE_PAGE_1 },
        { index: 2, text: SOURCE_PAGE_2 },
      ],
    },
  };
  const derivativeBytes = Buffer.from(`${JSON.stringify(derivative, null, 2)}\n`, "utf8");
  const derivativeSha256 = sha256Hex(derivativeBytes);
  fs.writeFileSync(path.join(materialDir, "original.pdf"), originalBytes);
  fs.writeFileSync(path.join(materialDir, "derivative.json"), derivativeBytes);
  fs.writeFileSync(
    path.join(materialDir, "receipt.json"),
    JSON.stringify({
      id: "m-feb",
      name: "monthly-feb.pdf",
      kind: "document",
      parser: "pdf-unpdf-v1",
      originalSha256,
      derivativeSha256,
    }),
  );
  fs.writeFileSync(
    path.join(root, "_agent", "materials", "manifest.json"),
    JSON.stringify({
      version: 1,
      materials: [
        {
          id: "m-feb",
          name: "monthly-feb.pdf",
          kind: "document",
          summaryZh: "PDF · 2 页 · 约 40 字",
          needsVision: false,
          parser: "pdf-unpdf-v1",
          sha256: originalSha256,
          parts: [],
        },
      ],
    }),
  );
  const material = verifyMaterial(root, "m-feb");
  const chunk = readMaterialChunk({ material });
  recordMaterialChunk(root, context, {
    materialId: chunk.materialId,
    materialSha256: chunk.materialSha256,
    part: chunk.part,
    chunkIndex: chunk.chunkIndex,
    chunkSha256: chunk.chunkSha256,
    chunkCount: chunk.chunkCount,
  });
}
