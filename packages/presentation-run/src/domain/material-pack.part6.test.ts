import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { persistPresentationRunProvider } from "../capabilities.js";
import { listMaterialsResult, readMaterialResult, viewMaterialResult } from "./material-hands.js";
import type { MaterialPageFact } from "./material-read-progress.js";
import { materialCapabilityEntries } from "./material-pack.js";
import { ensureRunLedger, readRunLedger, type MaterialChunkFact } from "./run-ledger.js";
import { csvMaterial, sha256, tempRoot, writeMaterial } from "./material-pack.support.js";

describe("material-pack", () => {
  it("VAL-RUN-014: re-reading the same part/window writes no duplicate material.chunk-returned fact in one contextEpochId", () => {
    const root = tempRoot();
    const { originalBytes, derivative } = csvMaterial("csv-ledger", "明细.csv", 20000);
    writeMaterial(root, {
      id: "csv-ledger",
      name: "明细.csv",
      kind: "table",
      parser: "csv-v1",
      originalBytes,
      derivative,
      parts: [{ part: "rows", label: "20000 行", rows: 20000, cols: 3 }],
    });
    ensureRunLedger(root, {
      manifestSha256: "e".repeat(64),
      requirementsId: "req-test",
      requirements: [],
    });
    const epoch = "epoch-VAL-RUN-014";
    const args = { materialId: "csv-ledger", part: "rows", offset: 12344, limit: 1 };
    const first = readMaterialResult(root, { commandId: "call-1", contextEpochId: epoch }, args);
    const second = readMaterialResult(root, { commandId: "call-2", contextEpochId: epoch }, args);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const facts = (readRunLedger(root)?.facts ?? []).filter(
      (fact): fact is MaterialChunkFact => fact.type === "material.chunk-returned",
    );
    // The second identical read must not append a duplicate fact id.
    assert.equal(facts.length, 1);
    const fact = facts[0]!;
    assert.equal(fact.materialId, "csv-ledger");
    assert.equal(fact.contextEpochId, epoch);
    assert.equal(fact.part, "rows");
    assert.equal(fact.chunkIndex, 0);
    const returned = first.payload as { chunkSha256: string; materialSha256: string };
    assert.equal(fact.chunkSha256, returned.chunkSha256);
    assert.equal(fact.materialSha256, returned.materialSha256);
    // A different epoch is a different context: a fresh fact id is written.
    const other = readMaterialResult(root, { commandId: "call-3", contextEpochId: "epoch-later" }, args);
    assert.equal(other.ok, true);
    const after = (readRunLedger(root)?.facts ?? []).filter(
      (f): f is MaterialChunkFact => f.type === "material.chunk-returned",
    );
    assert.equal(after.length, 2);
    assert.equal(new Set(after.map((f) => f.factId)).size, 2);
    assert.equal(after.find((f) => f.contextEpochId === "epoch-later") !== undefined, true);
  });
});

it("VAL-PDF-003: view_material returns the receipt-verified PDF page image and records page identity", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const imageSha256 = sha256(image);
  writeMaterial(root, {
    id: "pdf-pages",
    name: "pages.pdf",
    kind: "document",
    parser: "pdf-unpdf-v4",
    originalBytes: Buffer.from("%PDF synthetic"),
    derivative: {
      document: {
        pageCount: 42,
        pages: [{ index: 1, chars: 1, lowText: true, hasImage: true, text: "x" }],
        renderedPages: [
          {
            index: 1,
            file: "page-1.jpg",
            sha256: imageSha256,
            px: { width: 960, height: 1360 },
          },
        ],
      },
    },
  });
  fs.writeFileSync(path.join(root, "_agent", "materials", "pdf-pages", "page-1.jpg"), image);
  ensureRunLedger(root, {
    manifestSha256: "e".repeat(64),
    requirementsId: "pdf-page-view",
    requirements: [],
  });
  const result = viewMaterialResult(
    root,
    { commandId: "view-page", contextEpochId: "epoch-pdf" },
    { materialId: "pdf-pages", page: 1 },
  );
  const payload = result.payload as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(payload.page, 1);
  assert.equal(payload.imageSha256, imageSha256);
  assert.equal(payload.imageBytesBase64, image.toString("base64"));
  const fact = readRunLedger(root)!.facts.find(
    (item): item is MaterialPageFact => item.type === "material.page-viewed",
  );
  assert.equal(fact?.materialId, "pdf-pages");
  assert.equal(fact?.page, 1);
  assert.equal(fact?.pageSha256, imageSha256);
  assert.throws(
    () =>
      viewMaterialResult(
        root,
        { commandId: "view-page-41", contextEpochId: "epoch-pdf" },
        { materialId: "pdf-pages", page: 41 },
      ),
    /只生成前 40 页图片/,
  );
});

it("VAL-PDF-003: list_materials and inspect_capabilities offer PDF page images only to image-input models", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const renderedPage = (index: number) => ({
    index,
    file: `page-${index}.jpg`,
    sha256: sha256(image),
    px: { width: 960, height: 1360 },
  });
  writeMaterial(root, {
    id: "pdf-listed",
    name: "listed.pdf",
    kind: "document",
    parser: "pdf-unpdf-v4",
    originalBytes: Buffer.from("%PDF synthetic"),
    derivative: {
      document: { pageCount: 3, pages: [], renderedPages: [renderedPage(1), renderedPage(3)] },
    },
    pageImages: { pages: [1, 3] },
  });

  const textOnly = listMaterialsResult(root);
  const textPayload = textOnly.payload as { materials: { pageImages?: unknown }[] };
  assert.deepEqual(textPayload.materials[0]!.pageImages, { pages: [1, 3] });
  assert.doesNotMatch(textOnly.detail, /view_material/);
  assert.equal(materialCapabilityEntries(root, false)[0]!.viewable, false);

  // A binding stub makes the selected model's declared image input visible to the tools.
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "presentation-run.v1.json"),
    `${JSON.stringify({ provider: { providerId: "pi-xai", modelId: "test-model" } })}\n`,
  );
  persistPresentationRunProvider(root, {
    providerId: "pi-xai",
    modelId: "test-model",
    ready: true,
    modelInputModalities: ["text", "image"],
  });
  const visionListed = listMaterialsResult(root);
  assert.match(visionListed.detail, /页面图片 第 1、3 页，view_material 可按页查看（最多前 40 页）/);
  assert.equal(materialCapabilityEntries(root, true)[0]!.viewable, true);
});

it("vision list_materials points a PDF's palette at its own page overview and keeps all-images to images", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const profile = {
    schema: "style-profile/v1",
    source: "pdf-vector-ops",
    pagesScanned: 2,
    accentColors: [{ hex: "#C00000", share: 0.8, roles: ["fill"] }],
    neutralColors: [{ hex: "#FFFFFF" }],
    fonts: [{ source: "HYQiHei-EES", share: 1, mapped: { latin: "Arial", ea: "黑体" } }],
  };
  writeMaterial(root, {
    id: "pdf-visual",
    name: "视觉.pdf",
    kind: "document",
    parser: "pdf-unpdf-v4",
    originalBytes: Buffer.from("%PDF synthetic"),
    derivative: {
      document: {
        pageCount: 2,
        pages: [],
        styleProfile: profile,
        renderedPages: [{ index: 1, file: "page-1.jpg", sha256: sha256(image), px: { width: 960, height: 1360 } }],
      },
    },
    pageImages: { pages: [1] },
  });
  // No binding file means a text-only model: the unseen-page note stays and no view_material is named.
  const textOnly = listMaterialsResult(root);
  assert.match(textOnly.detail, /你没有看到页面画面/);
  assert.doesNotMatch(textOnly.detail, /view_material/);

  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "presentation-run.v1.json"),
    `${JSON.stringify({ provider: { providerId: "pi-xai", modelId: "test-model" } })}\n`,
  );
  persistPresentationRunProvider(root, {
    providerId: "pi-xai",
    modelId: "test-model",
    ready: true,
    modelInputModalities: ["text", "image"],
  });
  const visionListed = listMaterialsResult(root);
  assert.match(visionListed.detail, /风格线索（来自 PDF 的矢量图形和文字统计/);
  assert.doesNotMatch(visionListed.detail, /你没有看到页面画面/);
  assert.match(
    visionListed.detail,
    /页面图片 第 1 页，view_material 可按页查看（最多前 40 页）；采用它的配色前，先看页面总览 view_material \{"materialId":"pdf-visual"\}/,
  );
  assert.doesNotMatch(visionListed.detail, /all-images/);

  for (const id of ["photo-a", "photo-b"]) {
    writeMaterial(root, {
      id,
      name: `${id}.png`,
      kind: "image",
      parser: "image-sharp-v1",
      originalBytes: Buffer.from(`synthetic-${id}`),
      needsVision: true,
      derivative: { image: { orientation: "landscape", logoLike: false, screenshotLike: false } },
    });
  }
  const withImages = listMaterialsResult(root);
  assert.match(
    withImages.detail,
    /图片较多时，先用 view_material \{"materialId":"all-images"\} 看一张带编号的图片总览（只含图片资料，不含 PDF 页面）/,
  );
});
