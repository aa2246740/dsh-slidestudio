import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildDeliveryProvenance,
  ensureRunLedger,
  recordPageRevision,
  recordTodo,
} from "@open-slidestudio/presentation-run";
import {
  buildSystemDeliveryNote,
  cleanupScratchRoots,
  projectCopy,
  provenanceFixture,
  scratchRoots,
  writeMetadata,
} from "./delivery-note-test-fixture.mjs";

afterEach(cleanupScratchRoots);

describe("system delivery note: images and vision values", () => {
  it("lists one line per image with its page or reason and does not repeat it as a reference", () => {
    const projectRoot = projectCopy("24-page");
    const base = provenanceFixture();
    /** @param {string} id @param {string} name */
    const image = (id, name) => ({
      id,
      name,
      kind: "image",
      chunksRead: 0,
      chunkCount: null,
      pagesCovered: null,
      lowTextPages: [],
      use: [],
    });
    /** @param {string} materialId @param {string} name @param {string[]} placed @param {string} use @param {Record<string, unknown>} [extra] */
    const entry = (materialId, name, placed, use, extra = {}) => ({
      materialId,
      name,
      placed,
      use,
      basis: "filename",
      ...extra,
    });
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        materials: [
          ...base.materials.slice(0, 2),
          image("img-a", "网点外观.jpg"),
          image("img-b", "柜台.jpg"),
          image("img-c", "数据截图.png"),
          image("img-d", "风景.jpg"),
          image("img-e", "品牌色卡.png"),
          image("img-f", "公司标识.png"),
        ],
        images: [
          entry("img-a", "网点外观.jpg", ["01_cover"], "placed"),
          entry("img-b", "柜台.jpg", ["02_overview", "03_data", "04_plan"], "background", {
            basis: "vision",
          }),
          entry("img-c", "数据截图.png", [], "excluded", { reason: "与本次检查无关" }),
          entry("img-d", "风景.jpg", [], "unused"),
          entry("img-e", "品牌色卡.png", [], "style-reference", { basis: "vision" }),
          entry("img-f", "公司标识.png", ["03_data"], "logo"),
        ],
      }),
    );

    const lines = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];

    assert.deepEqual(
      lines.filter((line) => line.startsWith("图片：")),
      [
        "图片：网点外观.jpg — 放在第 1 页；按文件名和你的描述分配，未看画面。",
        "图片：柜台.jpg — 作为第 2–4 页的背景。",
        "图片：数据截图.png — 不使用：与本次检查无关；按文件名和你的描述分配，未看画面。",
        "图片：风景.jpg — 没有用在任何页面，也没有说明原因。",
        "图片：品牌色卡.png — 只作风格参考，没有放进页面。",
        "图片：公司标识.png — 作为 Logo 放在第 3 页；按文件名和你的描述分配，未看画面。",
      ],
    );
    assert.equal(lines.filter((line) => line.startsWith("参考资料：")).length, 2);
    // Refresh-stable: the card rebuilds identically from the file.
    assert.deepEqual(buildSystemDeliveryNote({ projectRoot })?.lines, lines);
  });

  it("builds the image lines from the real provenance builder output", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-note-images-"));
    scratchRoots.push(projectRoot);
    const context = { commandId: "synthetic-images", contextEpochId: "images-epoch" };
    const media = { site: "media/material-site.jpg", scenery: "media/material-scenery.jpg" };
    fs.mkdirSync(path.join(projectRoot, "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "deck.pptd"),
      `${JSON.stringify({
        version: "v2",
        title: "网点检查",
        size: [960, 540],
        theme: {},
        pages: ["pages/p1.page", "pages/p2.page"],
      })}\n`,
    );
    /** @param {unknown[]} elements */
    const page = (elements) => ({ pageType: "content", elements });
    /** @param {string} id */
    const text = (id) => ({
      elementId: id,
      elementType: "text",
      bounds: [80, 80, 800, 60],
      content: { text: "检查情况", fontSize: 24 },
    });
    fs.writeFileSync(path.join(projectRoot, "pages", "p1.page"), `${JSON.stringify(page([text("t1")]))}\n`);
    fs.writeFileSync(
      path.join(projectRoot, "pages", "p2.page"),
      `${JSON.stringify(
        page([
          text("t2"),
          {
            elementId: "photo",
            elementType: "image",
            bounds: [80, 200, 300, 200],
            src: media.site,
          },
        ]),
      )}\n`,
    );
    fs.mkdirSync(path.join(projectRoot, "_agent", "materials"), { recursive: true });
    writeMetadata(projectRoot, "materials/manifest.json", {
      version: 1,
      materials: [
        ["img-site", "网点外观.jpg", media.site],
        ["img-scenery", "风景.jpg", media.scenery],
      ].map(([id, name, mediaSrc]) => ({
        id,
        name,
        kind: "image",
        summaryZh: `${name} 摘要`,
        mediaSrc,
        needsVision: true,
        parser: "image-sharp-v1",
        sha256: "e".repeat(64),
        parts: [],
      })),
    });
    ensureRunLedger(projectRoot, {
      manifestSha256: "synthetic",
      requirementsId: "synthetic",
      requirements: [],
    });
    recordTodo(projectRoot, context, [
      { pageId: "p1", title: "封面", layoutFamily: "content", exhibits: [] },
      { pageId: "p2", title: "现场", layoutFamily: "content", exhibits: [] },
    ]);
    const first = recordPageRevision(projectRoot, context, "p1", { id: "p1", elements: [] });
    const second = recordPageRevision(projectRoot, context, "p2", { id: "p2", elements: [] });
    const built = buildDeliveryProvenance(projectRoot, {
      type: "deck.composed",
      factId: "synthetic-seal",
      at: "2031-01-01T00:00:00.000Z",
      contextEpochId: context.contextEpochId,
      title: "网点检查",
      deckSha256: "d".repeat(64),
      pageRevisions: { p1: first.pageSha256, p2: second.pageSha256 },
    });
    assert.equal(built.warnings.length, 1);
    assert.match(built.warnings[0], /^图片『风景\.jpg』没有用在任何页面，也没有说明原因/);
    writeMetadata(projectRoot, "delivery-provenance.v1.json", built.file);

    const lines = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];

    assert.deepEqual(
      lines.filter((line) => line.startsWith("图片：")),
      [
        "图片：网点外观.jpg — 放在第 2 页；按文件名和你的描述分配，未看画面。",
        "图片：风景.jpg — 没有用在任何页面，也没有说明原因。",
      ],
    );
  });

  it("marks each vision-read number 请核对 on its page, numbered by deck position (VAL-IMG-012)", () => {
    const projectRoot = projectCopy("24-page");
    /** @param {string} value */
    const visionValue = (value) => ({ value, materialId: "synthetic-photo", basis: "vision-read" });
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          {
            pageId: "01_cover",
            title: "封面",
            declared: null,
            detected: null,
            visionValues: [],
            queries: [],
          },
          {
            pageId: "02_overview",
            title: "概览",
            declared: { basis: "mock" },
            detected: null,
            visionValues: [],
            queries: [],
          },
          {
            pageId: "03_data",
            title: "数据",
            declared: { basis: "material" },
            detected: null,
            visionValues: [visionValue("89.64%"), visionValue("2300")],
            queries: [],
          },
          {
            pageId: "04_plan",
            title: "计划",
            declared: null,
            detected: null,
            visionValues: [{ value: "1500", materialId: "synthetic-photo", basis: "file-match" }],
            queries: [],
          },
        ],
      }),
    );
    const lines = buildSystemDeliveryNote({ projectRoot }).lines;
    assert.ok(lines.includes("第 3 页的 89.64% 是看图识别的，未经文件校验，请核对。"), lines.join("\n"));
    assert.ok(lines.includes("第 3 页的 2300 是看图识别的，未经文件校验，请核对。"), lines.join("\n"));
    assert.equal(
      lines.filter((line) => line.includes("请核对")).length,
      2,
      "only vision-read values carry the marking",
    );
    assert.equal(
      lines.some((line) => line.includes("1500")),
      false,
    );
  });

  it("shows a signed vision-read value with its sign on the 请核对 line (VAL-IMG-012)", () => {
    const projectRoot = projectCopy("24-page");
    /** @param {string} value */
    const visionValue = (value) => ({ value, materialId: "synthetic-photo", basis: "vision-read" });
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          {
            pageId: "01_cover",
            title: "封面",
            declared: null,
            detected: null,
            visionValues: [],
            queries: [],
          },
          {
            pageId: "02_complaints",
            title: "投诉与同比",
            declared: { basis: "material" },
            detected: null,
            visionValues: [visionValue("42"), visionValue("-12.34%")],
            queries: [],
          },
        ],
      }),
    );
    const lines = buildSystemDeliveryNote({ projectRoot }).lines;
    assert.ok(lines.includes("第 2 页的 42 是看图识别的，未经文件校验，请核对。"), lines.join("\n"));
    assert.ok(lines.includes("第 2 页的 -12.34% 是看图识别的，未经文件校验，请核对。"), lines.join("\n"));
  });

  it("names unit-carried 5% and 0% and a trailing-zero 89.60% as recorded on the 请核对 line (VAL-IMG-012)", () => {
    const projectRoot = projectCopy("24-page");
    /** @param {string} value */
    const visionValue = (value) => ({ value, materialId: "synthetic-photo", basis: "vision-read" });
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          {
            pageId: "01_cover",
            title: "封面",
            declared: null,
            detected: null,
            visionValues: [],
            queries: [],
          },
          {
            pageId: "02_growth",
            title: "增长与达标",
            declared: { basis: "material" },
            detected: null,
            visionValues: [visionValue("5%"), visionValue("89.60%"), visionValue("0%")],
            queries: [],
          },
        ],
      }),
    );
    const lines = buildSystemDeliveryNote({ projectRoot }).lines;
    assert.ok(lines.includes("第 2 页的 5% 是看图识别的，未经文件校验，请核对。"), lines.join("\n"));
    assert.ok(lines.includes("第 2 页的 89.60% 是看图识别的，未经文件校验，请核对。"), lines.join("\n"));
    assert.ok(lines.includes("第 2 页的 0% 是看图识别的，未经文件校验，请核对。"), lines.join("\n"));
  });

  it("falls back to the ledger-only summary when provenance is absent or malformed", () => {
    const projectRoot = projectCopy("24-page");
    const sealed = { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: true };
    const legacy = buildSystemDeliveryNote({ projectRoot, deliveryIssue: sealed });
    assert.equal(legacy?.title, "系统整理的交付摘要（根据生成记录自动整理，不是智能助手写的说明）");
    assert.ok(legacy?.lines.some((line) => line.startsWith("设计：")));

    writeMetadata(projectRoot, "delivery-provenance.v1.json", { schema: "delivery-provenance/v2" });
    assert.deepEqual(buildSystemDeliveryNote({ projectRoot, deliveryIssue: sealed }), legacy);
    assert.equal(buildSystemDeliveryNote({ projectRoot }), undefined);
  });
});
