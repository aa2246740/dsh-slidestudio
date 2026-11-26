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
import { fakeJpeg, imageFixture, writeMaterialFixture } from "./material-testkit.js";
import { ensureRunLedger, readRunLedger } from "./run-ledger.js";

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

function addDocument(root: string): void {
  writeMaterialFixture(root, {
    id: "doc-report",
    name: "月报.pdf",
    kind: "document",
    parser: "pdf-unpdf-v4",
    originalBytes: Buffer.from("%PDF-1.4 fixture"),
    derivative: { document: { pageCount: 1, pages: [] } },
  });
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
const todoFacts = (root: string) => readRunLedger(root)?.facts.filter((fact) => fact.type === "todo.committed") ?? [];

describe("write_todo image plan", () => {
  it("persists per-page materials and the declared materialUse, and echoes the image plan", async () => {
    const root = sceneRoot(3);
    const result = await writeTodo(
      root,
      [
        { pageId: "p1", title: "封面", materials: [SITE.id] },
        { pageId: "p2", title: "柜台", materials: [`material:${COUNTER.id}`, ATM.id] },
        { pageId: "p3", title: "总结" },
      ],
      [
        { materialId: SITE.id, use: "background" },
        { materialId: SCENERY.id, use: "excluded", reason: "与网点检查主题无关" },
      ],
    );
    assert.equal(result.ok, true, result.detail);

    const fact = todoFacts(root).at(-1);
    assert.ok(fact && fact.type === "todo.committed");
    assert.deepEqual(
      fact.pagePlan?.map((page) => (page as { materials?: string[] }).materials),
      [[SITE.id], [COUNTER.id, ATM.id], undefined],
    );
    const declared = readRunLedger(root)?.facts.filter((entry) => entry.type === "material.use-declared");
    assert.equal(declared?.length, 1);
    assert.deepEqual((declared?.[0] as { entries: readonly unknown[] } | undefined)?.entries, [
      { materialId: SITE.id, use: "background" },
      { materialId: SCENERY.id, use: "excluded", reason: "与网点检查主题无关" },
    ]);

    const plan = payloadOf(result).materialPlan as Record<string, unknown>[];
    assert.deepEqual(
      plan.map(({ materialId, name, pages, use, reason }) => ({
        materialId,
        name,
        pages,
        use,
        reason,
      })),
      [
        { materialId: SITE.id, name: SITE.name, pages: [1], use: "background", reason: undefined },
        {
          materialId: COUNTER.id,
          name: COUNTER.name,
          pages: [2],
          use: undefined,
          reason: undefined,
        },
        { materialId: ATM.id, name: ATM.name, pages: [2], use: undefined, reason: undefined },
        {
          materialId: SCENERY.id,
          name: SCENERY.name,
          pages: [],
          use: "excluded",
          reason: "与网点检查主题无关",
        },
      ],
    );
  });

  it("refuses unknown and non-image ids in materialUse with Chinese errors naming the id", async () => {
    const root = sceneRoot(1);
    addDocument(root);
    const before = todoFacts(root).length;

    const unknown = await writeTodo(
      root,
      [{ pageId: "p1", title: "封面" }],
      [{ materialId: "img-ghost", use: "placed" }],
    );
    assert.equal(unknown.ok, false);
    assert.match(unknown.detail, /img-ghost/);
    assert.match(unknown.detail, /不存在/);

    const notImage = await writeTodo(
      root,
      [{ pageId: "p1", title: "封面" }],
      [{ materialId: "doc-report", use: "placed" }],
    );
    assert.equal(notImage.ok, false);
    assert.match(notImage.detail, /doc-report/);
    assert.match(notImage.detail, /不是图片/);

    assert.equal(todoFacts(root).length, before, "a refused call leaves the plan unchanged");
    assert.equal(
      readRunLedger(root)?.facts.some((fact) => fact.type === "material.use-declared"),
      false,
    );
  });

  it("refuses bad use values, a missing exclusion reason, duplicates and excluded-but-planned images", async () => {
    const root = sceneRoot(1);
    const page = [{ pageId: "p1", title: "封面" }];
    const refusals: Array<[unknown, RegExp]> = [
      ["img-site", /materialUse 必须是数组/],
      [[SITE.id], /materialUse\[0\] 必须是对象/],
      [[{ use: "placed" }], /materialUse\[0\] 缺少 materialId/],
      [[{ materialId: SITE.id, use: "banner" }], /use 无效：「banner」.*placed.*excluded/],
      [[{ materialId: SITE.id, use: "excluded" }], /网点外观\.jpg.*excluded.*reason/],
      [
        [
          { materialId: SITE.id, use: "placed" },
          { materialId: SITE.id, use: "logo" },
        ],
        /网点外观\.jpg.*重复/,
      ],
    ];
    for (const [materialUse, pattern] of refusals) {
      const result = await writeTodo(root, page, materialUse);
      assert.equal(result.ok, false, JSON.stringify(materialUse));
      assert.match(result.detail, pattern, JSON.stringify(materialUse));
    }
    const conflict = await writeTodo(
      root,
      [{ pageId: "p1", title: "封面", materials: [SITE.id] }],
      [{ materialId: SITE.id, use: "excluded", reason: "太模糊" }],
    );
    assert.equal(conflict.ok, false);
    assert.match(conflict.detail, /网点外观\.jpg.*excluded.*第 1 页/);
    assert.equal(todoFacts(root).length, 0);
  });

  it("refuses unknown or non-image ids in items[].materials", async () => {
    const root = sceneRoot(1);
    addDocument(root);
    const unknown = await writeTodo(root, [{ pageId: "p1", title: "封面", materials: ["img-ghost"] }]);
    assert.equal(unknown.ok, false);
    assert.match(unknown.detail, /第 1 页.*img-ghost.*不存在/);
    const notImage = await writeTodo(root, [{ pageId: "p1", title: "封面", materials: ["doc-report"] }]);
    assert.equal(notImage.ok, false);
    assert.match(notImage.detail, /第 1 页.*doc-report.*不是图片/);
    assert.equal(todoFacts(root).length, 0);
  });

  it("omitting materialUse keeps the earlier declaration; an explicit empty list clears it", async () => {
    const root = sceneRoot(1);
    const page = [{ pageId: "p1", title: "封面" }];
    await writeTodo(root, page, [{ materialId: SCENERY.id, use: "excluded", reason: "无关" }]);
    const kept = await writeTodo(root, page);
    assert.equal(kept.ok, true, kept.detail);
    assert.deepEqual(
      (payloadOf(kept).materialPlan as Array<{ materialId: string; use?: string }>).map(({ materialId, use }) => ({
        materialId,
        use,
      })),
      [{ materialId: SCENERY.id, use: "excluded" }],
    );
    const cleared = await writeTodo(root, page, []);
    assert.equal(cleared.ok, true, cleared.detail);
    assert.deepEqual(payloadOf(cleared).materialPlan, []);
    const again = await writeTodo(root, page);
    assert.deepEqual(payloadOf(again).materialPlan, [], "the cleared declaration stays cleared");
  });

  it("hints at images that have neither a page nor an exclusion, without blocking", async () => {
    const root = sceneRoot(2);
    const result = await writeTodo(
      root,
      [
        { pageId: "p1", title: "封面", materials: [SITE.id] },
        { pageId: "p2", title: "总结" },
      ],
      [{ materialId: CHART.id, use: "style-reference" }],
    );
    assert.equal(result.ok, true, result.detail);
    const hints = payloadOf(result).hints as string[];
    const hint = hints.find((line) => line.includes("没有安排页面"));
    assert.ok(hint, JSON.stringify(hints));
    assert.match(hint, /还有 4 张图片没有安排页面，也没有说明不用的原因/);
    for (const image of [COUNTER, ATM, TRAIN, SCENERY]) assert.ok(hint.includes(`『${image.name}』`));
    for (const image of [SITE, CHART]) assert.equal(hint.includes(image.name), false);
    assert.match(hint, /这条提示不阻止保存计划/);
  });

  it("keeps the old plan result shape when no images are involved", async () => {
    const root = sceneRoot(1, []);
    const result = await writeTodo(root, [{ pageId: "p1", title: "封面" }]);
    assert.equal(result.ok, true, result.detail);
    assert.equal("materialPlan" in payloadOf(result), false);
    assert.deepEqual(payloadOf(result).hints, []);
  });
});

describe("review_pages image plan hint", () => {
  it("hints at a page that planned an image but does not show it, without failing the review", async () => {
    const root = sceneRoot(2);
    await writeTodo(root, [
      { pageId: "p1", title: "封面", materials: [SITE.id] },
      { pageId: "p2", title: "柜台", materials: [COUNTER.id] },
    ]);
    await writePage(root, pageArgs("p1", { src: SITE.src }));
    await writePage(root, pageArgs("p2"));

    const review = await runDomainHand("review_pages", { __openSlideStudio: CTX }, root);
    assert.equal(review.ok, true, review.detail);
    const hints = payloadOf(review).hints as string[];
    assert.equal(hints.length, 1, JSON.stringify(hints));
    assert.match(hints[0] ?? "", /^第 2 页（柜台）计划放入图片『柜台\.jpg』，但页面里还没有这张图片/);
    assert.match(hints[0] ?? "", /这条提示不阻止检查通过/);
    assert.ok(review.detail.includes(hints[0] ?? ""), "the same hint is readable in the detail");

    await writePage(root, pageArgs("p2", { src: COUNTER.src }));
    const fixed = await runDomainHand("review_pages", { __openSlideStudio: CTX }, root);
    assert.equal(fixed.ok, true, fixed.detail);
    assert.equal("hints" in payloadOf(fixed), false, "no hint once the planned image is on its page");
  });

  it("counts a page background as showing the planned image", async () => {
    const root = sceneRoot(1);
    await writeTodo(root, [{ pageId: "p1", title: "封面", materials: [SITE.id] }]);
    await writePage(root, pageArgs("p1", { background: SITE.src }));
    const review = await runDomainHand("review_pages", { __openSlideStudio: CTX }, root);
    assert.equal(review.ok, true, review.detail);
    assert.equal("hints" in payloadOf(review), false);
  });
});
