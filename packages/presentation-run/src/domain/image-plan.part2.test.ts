/**
 * Image plan placement (VAL-IMG-007/008): `write_todo` carries per-page
 * `materials` and the declared `materialUse`; `review_pages`, `compose_deck`
 * and the delivery provenance account for every uploaded image. Everything
 * runs through `runDomainHand`, the same hop the kernel tools use.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { persistPresentationRunProvider } from "../capabilities.js";
import { DELIVERY_PROVENANCE_REL } from "./delivery-provenance.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { imageDispositions, unusedImageWarnings } from "./image-placement.js";
import { viewMaterialResult } from "./material-hands.js";
import { recordMaterialNotesResult } from "./material-notes.js";
import { fakeJpeg, imageFixture, writeMaterialFixture } from "./material-testkit.js";
import type { MaterialOverviewFact } from "./material-view-facts.js";
import { appendFact, ensureRunLedger, factId, readRunLedger } from "./run-ledger.js";

const CTX = { commandId: "image-plan", contextEpochId: "image-plan-epoch" };

const IMAGES = [
  { id: "img-site", name: "网点外观.jpg", src: "media/material-site.jpg" },
  { id: "img-counter", name: "柜台.jpg", src: "media/material-counter.jpg" },
  { id: "img-atm", name: "ATM.jpg", src: "media/material-atm.jpg" },
  { id: "img-train", name: "培训.jpg", src: "media/material-train.jpg" },
  { id: "img-chart", name: "数据截图.png", src: "media/material-chart.png" },
  { id: "img-scenery", name: "风景.jpg", src: "media/material-scenery.jpg" },
] as const;
const [SITE, COUNTER, ATM, TRAIN, CHART, SCENERY] = IMAGES;

const sceneRoots: string[] = [];
after(() => {
  for (const root of sceneRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sceneRoot(pageCount: number, images: readonly (typeof IMAGES)[number][] = IMAGES): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-plan-"));
  sceneRoots.push(root);
  createEmptyProject(root, { title: "网点检查汇报" });
  writeDomainRuntime(root, {
    brief: `制作 ${pageCount} 页测试：网点检查情况汇报。`,
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
  for (const image of images) {
    writeMaterialFixture(
      root,
      imageFixture(image.id, image.name, 800, 600, {
        mediaSrc: image.src,
        projectFiles: { [image.src]: fakeJpeg(image.id) },
      }),
    );
  }
  return root;
}

type PlanPage = { pageId: string; title: string; materials?: string[] };
const planOf = (pages: readonly PlanPage[]) =>
  pages.map((page) => ({ layoutFamily: "content", exhibits: ["none"], ...page }));

async function writeTodo(root: string, pages: readonly PlanPage[], materialUse?: unknown) {
  return runDomainHand(
    "write_todo",
    {
      items: planOf(pages),
      ...(materialUse === undefined ? {} : { materialUse }),
      __openSlideStudio: CTX,
    },
    root,
  );
}

type Rect = [number, number, number, number];
function pageArgs(id: string, options: { src?: string; background?: string } = {}) {
  return {
    id,
    pageType: "content",
    ...(options.background ? { background: { type: "image", src: options.background } } : {}),
    elements: [
      {
        elementId: `${id}-title`,
        elementType: "text",
        bounds: [80, 80, 800, 60] as Rect,
        content: { text: `检查情况 ${id}`, fontSize: 24 },
      },
      {
        elementId: `${id}-body`,
        elementType: "text",
        bounds: [80, 160, 800, 40] as Rect,
        content: { text: "逐项核对现场情况并记录结论。", fontSize: 16 },
      },
      ...(options.src
        ? [
            {
              elementId: `${id}-photo`,
              elementType: "image",
              bounds: [80, 260, 360, 220] as Rect,
              src: options.src,
              fit: { mode: "cover" },
            },
          ]
        : []),
    ],
  };
}

async function writePage(root: string, args: ReturnType<typeof pageArgs>) {
  const result = await runDomainHand("write_page", { ...args, __openSlideStudio: CTX }, root);
  assert.equal(result.ok, true, result.detail);
}

async function composeScene(root: string) {
  const review = await runDomainHand("review_pages", { __openSlideStudio: CTX }, root);
  assert.equal(review.ok, true, review.detail);
  const composed = await runDomainHand("compose_deck", { title: "网点检查汇报", __openSlideStudio: CTX }, root);
  assert.equal(composed.ok, true, composed.detail);
  return composed;
}

function provenanceImages(root: string): Record<string, unknown>[] {
  const file = JSON.parse(fs.readFileSync(path.join(root, DELIVERY_PROVENANCE_REL), "utf8")) as {
    images: Record<string, unknown>[];
  };
  return file.images;
}

const payloadOf = (result: { payload: unknown }) => result.payload as Record<string, unknown>;

describe("compose_deck image accounting", () => {
  async function sixImageDeck(): Promise<string> {
    const root = sceneRoot(4);
    await writeTodo(
      root,
      [
        { pageId: "p1", title: "封面", materials: [SITE.id] },
        { pageId: "p2", title: "柜台", materials: [COUNTER.id] },
        { pageId: "p3", title: "设备", materials: [ATM.id] },
        { pageId: "p4", title: "培训", materials: [TRAIN.id] },
      ],
      [{ materialId: CHART.id, use: "excluded", reason: "截图里的数字与本次检查无关" }],
    );
    await writePage(root, pageArgs("p1", { src: SITE.src }));
    await writePage(root, pageArgs("p2", { src: COUNTER.src }));
    await writePage(root, pageArgs("p3", { src: ATM.src }));
    await writePage(root, pageArgs("p4", { background: TRAIN.src }));
    return root;
  }

  it("VAL-IMG-008: one hint for the unexplained image, none for the excluded one, and six provenance entries", async () => {
    const root = await sixImageDeck();
    const composed = await composeScene(root);

    const warnings = payloadOf(composed).warnings as string[];
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0] ?? "", /^图片『风景\.jpg』没有用在任何页面，也没有说明原因/);
    assert.match(warnings[0] ?? "", /这条提示不阻止交付/);
    assert.equal((warnings[0] ?? "").includes(CHART.name), false, "the excluded image is not hinted");

    const images = provenanceImages(root);
    assert.equal(images.length, 6);
    assert.deepEqual(
      images.map(({ materialId, placed, use, basis, reason }) => ({
        materialId,
        placed,
        use,
        basis,
        reason,
      })),
      [
        {
          materialId: SITE.id,
          placed: ["p1"],
          use: "placed",
          basis: "filename",
          reason: undefined,
        },
        {
          materialId: COUNTER.id,
          placed: ["p2"],
          use: "placed",
          basis: "filename",
          reason: undefined,
        },
        { materialId: ATM.id, placed: ["p3"], use: "placed", basis: "filename", reason: undefined },
        {
          materialId: TRAIN.id,
          placed: ["p4"],
          use: "background",
          basis: "filename",
          reason: undefined,
        },
        {
          materialId: CHART.id,
          placed: [],
          use: "excluded",
          basis: "filename",
          reason: "截图里的数字与本次检查无关",
        },
        {
          materialId: SCENERY.id,
          placed: [],
          use: "unused",
          basis: "filename",
          reason: undefined,
        },
      ],
    );
    assert.deepEqual(
      images.map((image) => image.name),
      IMAGES.map((image) => image.name),
    );
  });

  it("a style-reference declaration is neither hinted nor listed as unused", async () => {
    const root = await sixImageDeck();
    await writeTodo(
      root,
      [
        { pageId: "p1", title: "封面", materials: [SITE.id] },
        { pageId: "p2", title: "柜台", materials: [COUNTER.id] },
        { pageId: "p3", title: "设备", materials: [ATM.id] },
        { pageId: "p4", title: "培训", materials: [TRAIN.id] },
      ],
      [
        { materialId: CHART.id, use: "excluded", reason: "无关" },
        { materialId: SCENERY.id, use: "style-reference" },
      ],
    );
    const composed = await composeScene(root);
    assert.equal("warnings" in payloadOf(composed), false);
    const scenery = provenanceImages(root).find((image) => image.materialId === SCENERY.id);
    assert.deepEqual({ placed: scenery?.placed, use: scenery?.use }, { placed: [], use: "style-reference" });
  });

  it("lists several unexplained images in one hint and keeps declared logo and placed uses", async () => {
    const root = sceneRoot(2);
    await writeTodo(
      root,
      [
        { pageId: "p1", title: "封面", materials: [SITE.id] },
        { pageId: "p2", title: "总结", materials: [COUNTER.id] },
      ],
      [
        { materialId: SITE.id, use: "logo" },
        { materialId: COUNTER.id, use: "placed" },
      ],
    );
    await writePage(root, pageArgs("p1", { src: SITE.src }));
    await writePage(root, pageArgs("p2"));
    const composed = await composeScene(root);

    const warnings = payloadOf(composed).warnings as string[];
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0] ?? "", /^图片/);
    for (const image of [COUNTER, ATM, TRAIN, CHART, SCENERY]) {
      assert.ok((warnings[0] ?? "").includes(`『${image.name}』`), image.name);
    }
    assert.equal((warnings[0] ?? "").includes(SITE.name), false);

    const byId = new Map(provenanceImages(root).map((image) => [image.materialId, image]));
    assert.deepEqual(
      { placed: byId.get(SITE.id)?.placed, use: byId.get(SITE.id)?.use },
      { placed: ["p1"], use: "logo" },
    );
    assert.deepEqual(
      { placed: byId.get(COUNTER.id)?.placed, use: byId.get(COUNTER.id)?.use },
      { placed: [], use: "unused" },
      "declared as placed but on no page is unused",
    );
  });

  it("an image adopted for its look counts as a style reference, one adopted only for its logo does not", () => {
    const root = sceneRoot(1, [SITE, SCENERY, ATM]);
    const ledger = readRunLedger(root);
    assert.ok(ledger);
    const design = {
      adoptedSourceIds: [`material:${SCENERY.id}`, `material:${ATM.id}`],
      designAspects: [
        { source: `material:${SCENERY.id}`, aspects: ["palette"] },
        { source: `material:${ATM.id}`, aspects: ["logo"] },
      ],
    };
    const uses = imageDispositions(root, ledger, design).map(({ materialId, use }) => ({
      materialId,
      use,
    }));
    assert.deepEqual(uses, [
      { materialId: SITE.id, use: "unused" },
      { materialId: SCENERY.id, use: "style-reference" },
      { materialId: ATM.id, use: "unused" },
    ]);
    assert.deepEqual(
      unusedImageWarnings(imageDispositions(root, ledger, design)).length,
      1,
      "the unplaced, unadopted images are still hinted together",
    );
  });

  it("basis is vision only for images the model looked at", async () => {
    const root = sceneRoot(3, [SITE, COUNTER, ATM]);
    await writeTodo(root, [
      { pageId: "p1", title: "封面", materials: [SITE.id] },
      { pageId: "p2", title: "柜台", materials: [COUNTER.id] },
      { pageId: "p3", title: "设备", materials: [ATM.id] },
    ]);
    await writePage(root, pageArgs("p1", { src: SITE.src }));
    await writePage(root, pageArgs("p2", { src: COUNTER.src }));
    await writePage(root, pageArgs("p3", { src: ATM.src }));

    // A single-image view, an overview tile and recorded notes are the three ways to see an image.
    viewMaterialResult(root, CTX, { materialId: SITE.id });
    const overview = {
      contextEpochId: CTX.contextEpochId,
      overviewKind: "all-images" as const,
      overviewSha256: "a".repeat(64),
      width: 1568,
      height: 1568,
      materialIds: [COUNTER.id],
      tiles: [{ number: 1, materialId: COUNTER.id, sha256: "b".repeat(64) }],
      truncated: false,
    };
    const overviewFact: MaterialOverviewFact = {
      type: "material.overview-viewed",
      factId: factId("material.overview-viewed", overview),
      at: new Date().toISOString(),
      ...overview,
    };
    appendFact(root, overviewFact);
    const notes = recordMaterialNotesResult(root, CTX, {
      materialId: ATM.id,
      caption: "自助设备区，画面明亮",
      suggestedUse: "page",
    });
    assert.equal(notes.ok, true, notes.detail);

    await composeScene(root);
    assert.deepEqual(
      provenanceImages(root).map((image) => image.basis),
      ["vision", "vision", "vision"],
    );
  });

  it("images the model never looked at stay on the file-name basis even for a vision model", async () => {
    const root = sceneRoot(2, [SITE, COUNTER]);
    await writeTodo(root, [
      { pageId: "p1", title: "封面", materials: [SITE.id] },
      { pageId: "p2", title: "柜台", materials: [COUNTER.id] },
    ]);
    await writePage(root, pageArgs("p1", { src: SITE.src }));
    await writePage(root, pageArgs("p2", { src: COUNTER.src }));
    viewMaterialResult(root, CTX, { materialId: SITE.id });
    await composeScene(root);
    assert.deepEqual(
      provenanceImages(root).map((image) => image.basis),
      ["vision", "filename"],
    );
  });

  it("a deck without image materials keeps the old receipt and an empty images list", async () => {
    const root = sceneRoot(1, []);
    await writeTodo(root, [{ pageId: "p1", title: "封面" }]);
    await writePage(root, pageArgs("p1"));
    const composed = await composeScene(root);
    assert.equal("warnings" in payloadOf(composed), false);
    assert.deepEqual(provenanceImages(root), []);
  });

  it("the unused-image hint also reaches a compose that has no write_todo materialUse at all", async () => {
    const root = sceneRoot(1, [SITE, SCENERY]);
    await writeTodo(root, [{ pageId: "p1", title: "封面" }]);
    await writePage(root, pageArgs("p1", { src: SITE.src }));
    const composed = await composeScene(root);
    const warnings = payloadOf(composed).warnings as string[];
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /^图片『风景\.jpg』没有用在任何页面，也没有说明原因/);
    const images = provenanceImages(root);
    assert.deepEqual(
      images.map(({ materialId, placed, use }) => ({ materialId, placed, use })),
      [
        { materialId: SITE.id, placed: ["p1"], use: "placed" },
        { materialId: SCENERY.id, placed: [], use: "unused" },
      ],
      "an image placed on a page without being planned is still reported as placed",
    );
  });
});
