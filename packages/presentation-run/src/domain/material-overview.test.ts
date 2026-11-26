import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { viewMaterialResult } from "./material-hands.js";
import {
  OVERVIEW_MAX_TILES,
  OVERVIEW_PDF_MAX_PAGES,
  overviewDetail,
  planAllImagesOverview,
  planPdfPagesOverview,
  recordMaterialOverviewResult,
  type OverviewPlan,
} from "./material-overview.js";
import {
  fakeJpeg,
  fixtureSha256,
  imageFixture,
  pngHeader,
  tempProject,
  writeMaterialFixture,
} from "./material-testkit.js";
import type { MaterialOverviewFact } from "./material-view-facts.js";
import { ensureRunLedger, readRunLedger } from "./run-ledger.js";

const CONTEXT = { commandId: "overview-call", contextEpochId: "epoch-overview" };

function initLedger(root: string): void {
  ensureRunLedger(root, {
    manifestSha256: "e".repeat(64),
    requirementsId: "overview-test",
    requirements: [],
  });
}

function templateWithPhoto(id: string, name: string) {
  const photo = pngHeader(800, 600);
  const gray = Buffer.concat([pngHeader(800, 600), Buffer.from("gray")]);
  const logo = pngHeader(120, 120);
  const media = (mediaId: string, role: string, variant: string, file: string, bytes: Buffer) => ({
    mediaId,
    role,
    variant,
    file,
    sha256: fixtureSha256(bytes),
    mediaSrc: `media/${mediaId.replace(/[^a-z0-9-]/gi, "-")}.png`,
  });
  const entries = [
    media(`template-${id}-0`, "template-photo", "original", "photos/p0.png", photo),
    media(`template-${id}-0:grayscale`, "template-photo", "grayscale", "photos/p0-gray.png", gray),
    media(`brand-${id}-logo`, "template-logo", "original", "photos/logo.png", logo),
  ];
  return {
    id,
    name,
    kind: "deck-template" as const,
    parser: "pptx-ooxml-v2",
    originalBytes: Buffer.from(`pptx-${id}`),
    derivative: { "deck-template": {} },
    needsVision: true,
    media: entries,
    files: {
      "photos/p0.png": photo,
      "photos/p0-gray.png": gray,
      "photos/logo.png": logo,
    },
    projectFiles: Object.fromEntries(entries.map((entry, index) => [entry.mediaSrc, [photo, gray, logo][index]!])),
  };
}

function pdfFixture(id: string, pageCount: number, rendered: number[], name = "报告.pdf") {
  const pages = rendered.map((index) => fakeJpeg(`${id}-page-${index}`));
  return {
    id,
    name,
    kind: "document" as const,
    parser: "pdf-unpdf-v4",
    originalBytes: Buffer.from(`%PDF ${id}`),
    derivative: {
      document: {
        pageCount,
        pages: [],
        renderedPages: rendered.map((index, position) => ({
          index,
          file: `page-${index}.jpg`,
          sha256: fixtureSha256(pages[position]!),
          px: { width: 960, height: 1360 },
        })),
      },
    },
    pageImages: rendered.length ? { pages: rendered } : undefined,
    files: Object.fromEntries(rendered.map((index, position) => [`page-${index}.jpg`, pages[position]!])),
  };
}

describe("VAL-IMG-004: all-images overview plan", () => {
  it("lists images and template photos in manifest order and skips grayscale copies and logos", () => {
    const root = tempProject();
    writeMaterialFixture(root, imageFixture("img-a", "网点外观.jpg", 1200, 800));
    writeMaterialFixture(root, pdfFixture("pdf-x", 3, [1, 2, 3]));
    writeMaterialFixture(root, templateWithPhoto("tpl", "品牌模板.pptx"));
    writeMaterialFixture(root, imageFixture("img-b", "柜台.png", 900, 1200));
    const plan = planAllImagesOverview(root);
    assert.equal(plan.kind, "all-images");
    assert.equal(plan.total, 3);
    assert.equal(plan.truncated, false);
    assert.deepEqual(
      plan.tiles.map((tile) => [tile.number, tile.materialId, tile.mediaId]),
      [
        [1, "img-a", undefined],
        [2, "tpl", "template-tpl-0"],
        [3, "img-b", undefined],
      ],
    );
    const [first, second, third] = plan.tiles;
    assert.equal(first!.sha256, fixtureSha256(fakeJpeg("img-a")));
    assert.equal(first!.file, path.join("_agent", "materials", "img-a", "normalized.jpg"));
    assert.deepEqual([first!.width, first!.height, first!.orientation], [1200, 800, "landscape"]);
    assert.deepEqual([third!.width, third!.height, third!.orientation], [900, 1200, "portrait"]);
    // Template photos report the size read from their own bytes.
    assert.deepEqual([second!.width, second!.height, second!.orientation], [800, 600, "landscape"]);
    assert.equal(second!.file, path.join("_agent", "materials", "tpl", "photos", "p0.png"));
  });

  it("renders the numbered table with material id, size and orientation", () => {
    const root = tempProject();
    writeMaterialFixture(root, imageFixture("img-a", "网点外观.jpg", 1200, 800));
    writeMaterialFixture(root, templateWithPhoto("tpl", "品牌模板.pptx"));
    writeMaterialFixture(root, imageFixture("img-b", "柜台.png", 900, 1200));
    const detail = overviewDetail(planAllImagesOverview(root));
    assert.match(detail, /共 3 张图片/);
    assert.match(detail, /编号 \| 资料名 \| materialId \| 尺寸 \| 朝向/);
    assert.match(detail, /1 \| 网点外观\.jpg \| img-a \| 1200×800 \| 横图/);
    assert.match(detail, /2 \| 品牌模板\.pptx（模板照片） \| tpl（mediaId template-tpl-0） \| 800×600 \| 横图/);
    assert.match(detail, /3 \| 柜台\.png \| img-b \| 900×1200 \| 竖图/);
    assert.match(detail, /左上角/);
  });

  it("fails with a Chinese error when the session has no images", () => {
    const root = tempProject();
    writeMaterialFixture(root, pdfFixture("pdf-only", 2, [1]));
    assert.throws(() => planAllImagesOverview(root), /没有可查看的图片资料/);
    const empty = tempProject();
    assert.throws(() => planAllImagesOverview(empty), /没有可查看的图片资料/);
  });

  it("shows the first 36 images and says how many were left out", () => {
    const root = tempProject();
    for (let index = 1; index <= OVERVIEW_MAX_TILES + 4; index += 1) {
      writeMaterialFixture(root, imageFixture(`img-${index}`, `图${index}.jpg`, 800, 600));
    }
    const plan = planAllImagesOverview(root);
    assert.equal(plan.total, OVERVIEW_MAX_TILES + 4);
    assert.equal(plan.tiles.length, OVERVIEW_MAX_TILES);
    assert.equal(plan.truncated, true);
    assert.equal(plan.tiles.at(-1)!.materialId, `img-${OVERVIEW_MAX_TILES}`);
    assert.match(overviewDetail(plan), /只显示前 36 张，其余 4 张/);
  });

  it("fails closed when an image's normalized bytes changed after materialization", () => {
    const root = tempProject();
    writeMaterialFixture(root, imageFixture("img-a", "a.jpg", 100, 100));
    fs.appendFileSync(path.join(root, "_agent", "materials", "img-a", "normalized.jpg"), "x");
    assert.throws(() => planAllImagesOverview(root), /规范化图片已变化/);
  });

  it("view_material all-images returns the plan without writing a ledger fact", () => {
    const root = tempProject();
    writeMaterialFixture(root, imageFixture("img-a", "a.jpg", 100, 100));
    initLedger(root);
    const result = viewMaterialResult(root, CONTEXT, { materialId: "all-images" });
    assert.equal(result.ok, true);
    const payload = result.payload as { materialId: string; overviewPlan: OverviewPlan };
    assert.equal(payload.materialId, "all-images");
    assert.equal(payload.overviewPlan.tiles.length, 1);
    assert.equal(
      (readRunLedger(root)?.facts ?? []).some((fact) => fact.type === "material.overview-viewed"),
      false,
    );
    assert.match(result.detail, /1 \| a\.jpg \| img-a/);
  });

  it("writes one material.overview-viewed fact with the mosaic sha256 and the material ids", () => {
    const root = tempProject();
    writeMaterialFixture(root, imageFixture("img-a", "a.jpg", 100, 100));
    writeMaterialFixture(root, imageFixture("img-b", "b.jpg", 100, 200));
    initLedger(root);
    const plan = planAllImagesOverview(root);
    const args = {
      kind: "all-images",
      materialId: "all-images",
      overviewSha256: "ab".repeat(32),
      width: 1568,
      height: 786,
      tiles: plan.tiles.map(({ number, materialId, mediaId, page, sha256 }) => ({
        number,
        materialId,
        ...(mediaId ? { mediaId } : {}),
        ...(page ? { page } : {}),
        sha256,
      })),
    };
    const first = recordMaterialOverviewResult(root, CONTEXT, args);
    const second = recordMaterialOverviewResult(root, CONTEXT, args);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const facts = (readRunLedger(root)?.facts ?? []).filter(
      (fact): fact is MaterialOverviewFact => fact.type === "material.overview-viewed",
    );
    assert.equal(facts.length, 1, "the same overview in one epoch is one fact");
    assert.equal(facts[0]!.overviewSha256, "ab".repeat(32));
    assert.deepEqual(facts[0]!.materialIds, ["img-a", "img-b"]);
    assert.equal(facts[0]!.contextEpochId, CONTEXT.contextEpochId);
    assert.equal(facts[0]!.overviewKind, "all-images");
  });

  it("refuses to record an overview whose tiles no longer match the project", () => {
    const root = tempProject();
    writeMaterialFixture(root, imageFixture("img-a", "a.jpg", 100, 100));
    initLedger(root);
    const plan = planAllImagesOverview(root);
    const tile = plan.tiles[0]!;
    assert.throws(
      () =>
        recordMaterialOverviewResult(root, CONTEXT, {
          kind: "all-images",
          materialId: "all-images",
          overviewSha256: "cd".repeat(32),
          width: 100,
          height: 100,
          tiles: [{ number: 1, materialId: tile.materialId, sha256: "f".repeat(64) }],
        }),
      /已变化|不一致/,
    );
    assert.throws(
      () =>
        recordMaterialOverviewResult(root, CONTEXT, {
          kind: "all-images",
          materialId: "all-images",
          overviewSha256: "not-a-hash",
          width: 100,
          height: 100,
          tiles: [],
        }),
      /总览/,
    );
  });
});

describe("VAL-PDF-003: PDF page overview plan", () => {
  it("returns the first 12 rendered pages numbered by page number", () => {
    const root = tempProject();
    const rendered = Array.from({ length: 15 }, (_, index) => index + 1);
    writeMaterialFixture(root, pdfFixture("pdf-long", 20, rendered));
    const plan = planPdfPagesOverview(root, "pdf-long");
    assert.equal(plan.kind, "pdf-pages");
    assert.equal(plan.materialId, "pdf-long");
    assert.equal(plan.tiles.length, OVERVIEW_PDF_MAX_PAGES);
    assert.deepEqual(
      plan.tiles.map((tile) => tile.number),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      plan.tiles.map((tile) => tile.page),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    assert.equal(plan.total, 15);
    assert.equal(plan.truncated, true);
    const detail = overviewDetail(plan);
    assert.match(detail, /页码 \| 尺寸 \| 朝向/);
    assert.match(detail, /1 \| 960×1360 \| 竖图/);
    assert.match(detail, /只显示前 12 页/);
    assert.match(detail, /page/);
  });

  it("numbers sparse rendered pages by their own page number", () => {
    const root = tempProject();
    writeMaterialFixture(root, pdfFixture("pdf-sparse", 9, [2, 5, 9]));
    const plan = planPdfPagesOverview(root, "pdf-sparse");
    assert.deepEqual(
      plan.tiles.map((tile) => tile.number),
      [2, 5, 9],
    );
    assert.equal(plan.truncated, false);
  });

  it("view_material on a PDF without page returns the page overview plan", () => {
    const root = tempProject();
    writeMaterialFixture(root, pdfFixture("pdf-a", 3, [1, 2, 3]));
    initLedger(root);
    const result = viewMaterialResult(root, CONTEXT, { materialId: "pdf-a" });
    assert.equal(result.ok, true);
    const payload = result.payload as { overviewPlan: OverviewPlan };
    assert.equal(payload.overviewPlan.kind, "pdf-pages");
    assert.equal(payload.overviewPlan.tiles.length, 3);
  });

  it("explains why a PDF without page images has no overview", () => {
    const root = tempProject();
    writeMaterialFixture(root, {
      ...pdfFixture("pdf-none", 3, []),
      derivative: { document: { pageCount: 3, pages: [], renderMessage: "渲染超时" } },
    });
    assert.throws(() => planPdfPagesOverview(root, "pdf-none"), /没有页面图片：渲染超时/);
  });

  it("rejects a Word document, a table and a text file with Chinese errors", () => {
    const root = tempProject();
    writeMaterialFixture(root, {
      id: "docx-a",
      name: "总结.docx",
      kind: "document",
      parser: "docx-ooxml-v1",
      originalBytes: Buffer.from("docx"),
    });
    writeMaterialFixture(root, {
      id: "csv-a",
      name: "数据.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes: Buffer.from("a,b"),
    });
    initLedger(root);
    assert.throws(() => viewMaterialResult(root, CONTEXT, { materialId: "docx-a" }), /不是 PDF|不是图片/);
    assert.throws(() => viewMaterialResult(root, CONTEXT, { materialId: "csv-a" }), /不是图片/);
  });
});
