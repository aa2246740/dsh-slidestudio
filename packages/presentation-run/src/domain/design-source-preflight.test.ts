/**
 * Data-purpose preflight over Office materials (CAP-33 / M8-SCR-12): a
 * complete, current-epoch `charts` read receipt qualifies alongside the
 * original document-body / sheet-window paths, while chart-less files keep
 * requiring their ordinary data part.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { materialChunkCount, readMaterialChunk } from "./material-content.js";
import { sha256Hex, verifyMaterial } from "./material-pack.js";
import { ensureRunLedger, recordMaterialChunk } from "./run-ledger.js";
import { planningReferencePreflight } from "./design-source-preflight.js";

const DOCX_CHARTS = [
  {
    chartId: "chart1",
    slide: null,
    box: null,
    type: "bar",
    grouping: "clustered",
    direction: "column",
    combo: [],
    external: false,
    title: "季度营收与毛利",
    series: [
      {
        name: "营业收入（万元）",
        categories: ["第一季度", "第二季度", "第三季度", "第四季度"],
        values: [1204.31, 1387.55, 1502.19, 1675.83],
        numFmt: "General",
      },
    ],
  },
];

/** One chart whose rendered series name alone spans several chunk boundaries. */
const WIDE_CHARTS = [
  {
    ...DOCX_CHARTS[0],
    chartId: "chart-wide",
    series: [
      {
        name: "营业收入（万元）".padEnd(6000, "甲"),
        categories: ["第一季度", "第二季度"],
        values: [1204.31, 1387.55],
        numFmt: "General",
      },
    ],
  },
];

type MaterialSpec = {
  id: string;
  name: string;
  kind: "document" | "table";
  parser: string;
  derivative: Record<string, unknown>;
};

function docxDerivative(charts: unknown[]): Record<string, unknown> {
  return {
    source: {
      detectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    document: {
      blocks: [{ type: "paragraph", text: "正文字数不多，一个分段足够。" }],
      charts,
    },
  };
}

function xlsxDerivative(charts: unknown[]): Record<string, unknown> {
  return {
    source: {
      detectedMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    table: {
      sheets: [{ name: "季度指标", rowCount: 2, rows: [["季度", "营收"]] }],
      charts,
    },
  };
}

const XLSX_CHARTS = [
  {
    chartId: "chart1",
    slide: null,
    box: null,
    sheet: "季度指标",
    type: "line",
    grouping: "clustered",
    combo: [],
    external: false,
    title: "季度营收走势",
    series: [
      {
        name: "营收",
        categories: ["第一季度", "第二季度"],
        values: [1204.31, 1387.55],
        numFmt: "General",
      },
    ],
  },
];

/** An on-disk verified material project (manifest + receipt + derivative). */
function writeMaterialProject(parent: string, spec: MaterialSpec): string {
  const projectRoot = path.join(parent, "project");
  const dir = path.join(projectRoot, "_agent", "materials", spec.id);
  fs.mkdirSync(dir, { recursive: true });
  const original = Buffer.from(`original-bytes-${spec.id}`);
  fs.writeFileSync(path.join(dir, "original.bin"), original);
  const derivative = Buffer.from(
    JSON.stringify({
      schema: "material-derivative/v1",
      materialId: spec.id,
      status: "ok",
      source: { sha256: sha256Hex(original) },
      parser: { id: spec.parser },
      ...(spec.kind === "document" ? { document: spec.derivative.document } : { table: spec.derivative.table }),
    }),
  );
  fs.writeFileSync(path.join(dir, "derivative.json"), derivative);
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    `${JSON.stringify({
      version: 1,
      id: spec.id,
      name: spec.name,
      kind: spec.kind,
      parser: spec.parser,
      originalSha256: sha256Hex(original),
      derivativeSha256: sha256Hex(derivative),
    })}\n`,
  );
  fs.mkdirSync(path.join(projectRoot, "_agent", "materials"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "_agent", "materials", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      materials: [
        {
          id: spec.id,
          name: spec.name,
          kind: spec.kind,
          summaryZh: "测试资料",
          parser: spec.parser,
          sha256: sha256Hex(original),
          parts: [],
        },
      ],
    })}\n`,
  );
  return projectRoot;
}

function initLedger(projectRoot: string): void {
  ensureRunLedger(projectRoot, {
    manifestSha256: "0".repeat(64),
    requirementsId: "preflight-test",
    requirements: [],
  });
}

/** Record a charts/document read exactly as read_material leaves it. */
function recordPartRead(
  projectRoot: string,
  materialId: string,
  part: string | undefined,
  contextEpochId: string,
  overrides: { materialSha256?: string; chunkIndex?: number } = {},
): void {
  const material = verifyMaterial(projectRoot, materialId);
  const chunkIndex = overrides.chunkIndex ?? 0;
  const chunk = readMaterialChunk({
    material,
    ...(part ? { part } : {}),
    offset: chunkIndex,
  });
  recordMaterialChunk(
    projectRoot,
    { commandId: `read-${contextEpochId}-${chunkIndex}`, contextEpochId },
    {
      materialId,
      materialSha256: overrides.materialSha256 ?? material.sha256,
      part: chunk.part,
      chunkIndex: chunk.chunkIndex,
      chunkSha256: chunk.chunkSha256,
    },
  );
}

function dataPreflight(
  repoRoot: string,
  projectRoot: string,
  materialId: string,
): ReturnType<typeof planningReferencePreflight> {
  return planningReferencePreflight(
    repoRoot,
    projectRoot,
    "commit_design",
    [],
    "epoch-1",
    [{ source: `material:${materialId}`, aspects: ["data"] }],
    {},
  );
}

function missingParts(receipt: { payload: { missingMaterialChunks: { part?: string }[] } }): Set<string> {
  return new Set(receipt.payload.missingMaterialChunks.map((chunk) => chunk.part ?? "design"));
}

describe("planningReferencePreflight data aspect over Office materials", () => {
  it("names both document and charts parts as missing when nothing was read", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-docx-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "chart-doc",
      name: "chart-report.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      derivative: docxDerivative(DOCX_CHARTS),
    });
    initLedger(projectRoot);
    const receipt = dataPreflight(parent, projectRoot, "chart-doc");
    assert.equal(receipt?.ok, false);
    assert.deepEqual(
      [...missingParts(receipt as never)].sort(),
      ["charts", "document"],
      "either data path may be taken, so both are announced",
    );
  });

  it("a complete current-epoch charts read satisfies data on a Word file", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-docx-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "chart-doc",
      name: "chart-report.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      derivative: docxDerivative(DOCX_CHARTS),
    });
    initLedger(projectRoot);
    const count = materialChunkCount(verifyMaterial(projectRoot, "chart-doc"), "charts", {});
    for (let index = 0; index < count; index += 1) {
      recordPartRead(projectRoot, "chart-doc", "charts", "epoch-1", { chunkIndex: index });
    }
    assert.equal(dataPreflight(parent, projectRoot, "chart-doc"), undefined);
  });

  it("the original document-body read still satisfies data on a Word file", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-docx-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "chart-doc",
      name: "chart-report.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      derivative: docxDerivative(DOCX_CHARTS),
    });
    initLedger(projectRoot);
    const count = materialChunkCount(verifyMaterial(projectRoot, "chart-doc"), "document", {});
    for (let index = 0; index < count; index += 1) {
      recordPartRead(projectRoot, "chart-doc", "document", "epoch-1", { chunkIndex: index });
    }
    assert.equal(dataPreflight(parent, projectRoot, "chart-doc"), undefined);
  });

  it("a partial charts read still names the remaining charts chunks", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-wide-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "wide-doc",
      name: "wide-chart.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      derivative: docxDerivative(WIDE_CHARTS),
    });
    initLedger(projectRoot);
    const material = verifyMaterial(projectRoot, "wide-doc");
    const count = materialChunkCount(material, "charts", {});
    assert.ok(count >= 2, `fixture renders ${count} charts chunks`);
    recordPartRead(projectRoot, "wide-doc", "charts", "epoch-1", { chunkIndex: 0 });
    const receipt = dataPreflight(parent, projectRoot, "wide-doc");
    assert.equal(receipt?.ok, false);
    const missing = (
      receipt as never as {
        payload: { missingMaterialChunks: { part?: string; chunkIndex: number }[] };
      }
    ).payload.missingMaterialChunks;
    assert.ok(
      missing.some((chunk) => chunk.part === "charts" && chunk.chunkIndex === 1),
      `charts chunk 1 still missing, got ${JSON.stringify(missing)}`,
    );
  });

  it("charts reads from an earlier context epoch do not satisfy data", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-stale-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "chart-doc",
      name: "chart-report.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      derivative: docxDerivative(DOCX_CHARTS),
    });
    initLedger(projectRoot);
    recordPartRead(projectRoot, "chart-doc", "charts", "epoch-0");
    const receipt = dataPreflight(parent, projectRoot, "chart-doc");
    assert.equal(receipt?.ok, false, "a stale-epoch charts read grants nothing");
  });

  it("charts receipts bound to other material bytes do not satisfy data", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-sha-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "chart-doc",
      name: "chart-report.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      derivative: docxDerivative(DOCX_CHARTS),
    });
    initLedger(projectRoot);
    recordPartRead(projectRoot, "chart-doc", "charts", "epoch-1", {
      materialSha256: "c".repeat(64),
    });
    const receipt = dataPreflight(parent, projectRoot, "chart-doc");
    assert.equal(receipt?.ok, false, "a receipt for other material bytes grants nothing");
  });

  it("a charts-note read on a chart-less Word file does not satisfy data", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-plain-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "plain-doc",
      name: "report.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      derivative: docxDerivative([]),
    });
    initLedger(projectRoot);
    recordPartRead(projectRoot, "plain-doc", "charts", "epoch-1");
    const receipt = dataPreflight(parent, projectRoot, "plain-doc");
    assert.equal(receipt?.ok, false, "the 未识别到图表 note is not chart data");
    assert.deepEqual([...missingParts(receipt as never)], ["document"]);
  });

  it("an Excel sheet-window read satisfies data", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-xlsx-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "chart-book",
      name: "chart-book.xlsx",
      kind: "table",
      parser: "xlsx-ooxml-v1",
      derivative: xlsxDerivative(XLSX_CHARTS),
    });
    initLedger(projectRoot);
    recordPartRead(projectRoot, "chart-book", "sheet:季度指标", "epoch-1");
    assert.equal(dataPreflight(parent, projectRoot, "chart-book"), undefined);
  });

  it("an Excel charts read satisfies data without the sheet window", (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-xlsx-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const projectRoot = writeMaterialProject(parent, {
      id: "chart-book",
      name: "chart-book.xlsx",
      kind: "table",
      parser: "xlsx-ooxml-v1",
      derivative: xlsxDerivative(XLSX_CHARTS),
    });
    initLedger(projectRoot);
    const count = materialChunkCount(verifyMaterial(projectRoot, "chart-book"), "charts", {});
    for (let index = 0; index < count; index += 1) {
      recordPartRead(projectRoot, "chart-book", "charts", "epoch-1", { chunkIndex: index });
    }
    assert.equal(dataPreflight(parent, projectRoot, "chart-book"), undefined);
  });
});
