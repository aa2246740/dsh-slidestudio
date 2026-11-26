import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildDeliveryProvenance,
  detectMaterialFigures,
  ensureRunLedger,
  recordMaterialFiguresFact,
  recordPageRevision,
  recordTemplateComponentUsed,
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

describe("system delivery note: layouts, components and reads", () => {
  it("adds one 版式 line naming each layout the pages use, and none when there are no layouts", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        layouts: [
          {
            scope: "layout",
            id: "body",
            name: "正文",
            pages: ["p02", "p03", "p04", "p05"],
            componentRefs: [],
            media: ["media/logo-a.png"],
          },
          {
            scope: "layout",
            id: "cover",
            name: "封面",
            pages: ["p01"],
            componentRefs: [],
            media: [],
          },
        ],
      }),
    );
    const lines = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];
    assert.deepEqual(
      lines.filter((line) => line.startsWith("版式：")),
      ["版式：『正文』用于 4 页（含 1 张图片）；『封面』用于 1 页"],
    );

    writeMetadata(projectRoot, "delivery-provenance.v1.json", provenanceFixture());
    const plain = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];
    assert.equal(
      plain.some((line) => line.startsWith("版式：")),
      false,
    );
  });

  it("lists the template components reused on pages and in layouts, and only those (VAL-KIT-008)", () => {
    const projectRoot = projectCopy("24-page");
    const base = provenanceFixture();
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          ...base.design,
          components: [
            { ref: "material:tpl#cover.arc-1", pages: ["01_cover"] },
            { ref: "material:tpl#cover.photo-1", pages: ["01_cover"] },
            { ref: "material:tpl#body.mark-1", pages: ["02_overview", "03_data"] },
            { ref: "material:tpl#body.header", pages: [], layoutId: "body" },
            { ref: "material:tpl#body.logo-1", pages: [], layoutId: "body" },
          ],
        },
        layouts: [
          {
            scope: "layout",
            id: "body",
            name: "正文",
            pages: ["02_overview", "03_data"],
            componentRefs: ["material:tpl#body.header", "material:tpl#body.logo-1"],
            media: [],
          },
        ],
      }),
    );
    const expected = [
      "沿用了模板组件的页：第 1 页（cover.arc-1、cover.photo-1）；第 2–3 页（body.mark-1）。",
      "沿用了模板组件的版式：『正文』（body.header、body.logo-1）。",
    ];
    const usage = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];
    assert.deepEqual(
      usage.filter((line) => line.startsWith("沿用了模板组件")),
      expected,
    );
    // The component lines sit between the 版式 line and the page-source lines.
    const layoutAt = usage.findIndex((line) => line.startsWith("版式："));
    assert.equal(usage[layoutAt + 1], expected[0]);
    assert.equal(usage[layoutAt + 2], expected[1]);
    // A component the Agent only read in the kit, or one that is not in the provenance, never shows.
    assert.equal(usage.join("\n").includes("cover.deco-1"), false);
    // The sealed delivery summary shares the same provenance lines.
    const summary = buildSystemDeliveryNote({ projectRoot, deliveryIssue: { sealed: true } })?.lines ?? [];
    assert.deepEqual(
      summary.filter((line) => line.startsWith("沿用了模板组件")),
      expected,
    );
    // Refresh-stable: the card rebuilds identically from the file.
    assert.deepEqual(buildSystemDeliveryNote({ projectRoot })?.lines, usage);
  });

  it("shows no component line for a deck without reused components, a legacy file or malformed entries", () => {
    const projectRoot = projectCopy("24-page");
    const base = provenanceFixture();
    for (const components of [
      [],
      undefined,
      ["material:tpl#cover.arc-1"],
      [null, 7, {}, { ref: "" }, { ref: "material:tpl#", pages: ["01_cover"] }],
      [{ ref: "material:tpl#cover.arc-1", pages: ["not-in-the-deck"] }],
    ]) {
      writeMetadata(
        projectRoot,
        "delivery-provenance.v1.json",
        provenanceFixture({ design: { ...base.design, components } }),
      );
      const lines = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];
      assert.equal(
        lines.some((line) => line.startsWith("沿用了模板组件")),
        false,
        JSON.stringify(components),
      );
    }
  });

  it("names the template of a component only when two templates are reused", () => {
    const projectRoot = projectCopy("24-page");
    const base = provenanceFixture();
    /** @param {string} id @param {string} name */
    const template = (id, name) => ({
      id,
      name,
      kind: "deck-template",
      chunksRead: 1,
      chunkCount: 1,
      pagesCovered: null,
      lowTextPages: [],
      use: ["design-source"],
    });
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        materials: [...base.materials, template("tpl-a", "模板甲.pptx"), template("tpl-b", "模板乙.pptx")],
        design: {
          ...base.design,
          components: [
            { ref: "material:tpl-a#cover.arc-1", pages: ["01_cover"] },
            { ref: "openkimi:material:tpl-b#cover.arc-1", pages: ["01_cover"] },
          ],
        },
      }),
    );
    const lines = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];
    assert.ok(
      lines.includes("沿用了模板组件的页：第 1 页（『模板甲.pptx』cover.arc-1、『模板乙.pptx』cover.arc-1）。"),
      JSON.stringify(lines),
    );
  });

  it("builds the component lines from the real provenance builder output", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-note-components-"));
    scratchRoots.push(projectRoot);
    const context = { commandId: "synthetic-components", contextEpochId: "components-epoch" };
    fs.mkdirSync(path.join(projectRoot, "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "deck.pptd"),
      `${JSON.stringify({
        version: "v2",
        title: "模板复用",
        size: [960, 540],
        theme: {},
        pages: ["pages/p1.page", "pages/p2.page"],
      })}\n`,
    );
    /** @param {string} id @param {string} label */
    const text = (id, label) => ({
      elementId: id,
      elementType: "text",
      bounds: [80, 80, 800, 60],
      content: { text: label, fontSize: 24 },
    });
    for (const [id, label] of [
      ["p1", "封面"],
      ["p2", "正文"],
    ]) {
      fs.writeFileSync(
        path.join(projectRoot, "pages", `${id}.page`),
        `${JSON.stringify({ pageType: "content", elements: [text(`${id}-t`, label)] })}\n`,
      );
    }
    fs.mkdirSync(path.join(projectRoot, "_agent", "materials"), { recursive: true });
    writeMetadata(projectRoot, "materials/manifest.json", { version: 1, materials: [] });
    ensureRunLedger(projectRoot, {
      manifestSha256: "synthetic",
      requirementsId: "synthetic",
      requirements: [],
    });
    recordTodo(projectRoot, context, [
      { pageId: "p1", title: "封面", layoutFamily: "content", exhibits: [] },
      { pageId: "p2", title: "正文", layoutFamily: "content", exhibits: [] },
    ]);
    const first = recordPageRevision(projectRoot, context, "p1", { id: "p1", elements: [] });
    const second = recordPageRevision(projectRoot, context, "p2", { id: "p2", elements: [] });
    /** @param {string} ref @param {string} pageId @param {number} revision */
    const use = (ref, pageId, revision) =>
      recordTemplateComponentUsed(projectRoot, {
        contextEpochId: context.contextEpochId,
        ref,
        kitSha256: "c".repeat(64),
        pageId,
        revision,
      });
    use("material:tpl#cover.arc-1", "p1", first.revision);
    use("material:tpl#body.mark-1", "p2", second.revision);
    // A use recorded for a revision the page no longer has is history, not what the deck shows.
    use("material:tpl#body.old-1", "p2", second.revision + 1);
    const built = buildDeliveryProvenance(projectRoot, {
      type: "deck.composed",
      factId: "synthetic-seal",
      at: "2031-01-01T00:00:00.000Z",
      contextEpochId: context.contextEpochId,
      title: "模板复用",
      deckSha256: "d".repeat(64),
      pageRevisions: { p1: first.pageSha256, p2: second.pageSha256 },
    });
    assert.deepEqual(built.file.design.components, [
      { ref: "material:tpl#cover.arc-1", pages: ["p1"] },
      { ref: "material:tpl#body.mark-1", pages: ["p2"] },
    ]);
    writeMetadata(projectRoot, "delivery-provenance.v1.json", built.file);

    const lines = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];

    assert.deepEqual(
      lines.filter((line) => line.startsWith("沿用了模板组件")),
      ["沿用了模板组件的页：第 1 页（cover.arc-1）；第 2 页（body.mark-1）。"],
    );
  });

  it("names source template pages and discloses an exact radar-to-bar substitution", () => {
    const projectRoot = projectCopy("24-page");
    const pages = provenanceFixture().pages;
    const dataPage = pages[2];
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          ...pages.slice(0, 2),
          {
            ...dataPage,
            detected: {
              ...dataPage.detected,
              sourcePages: [16],
              chartSubstitutions: [{ sourcePage: 16, sourceType: "radar", targetType: "bar" }],
            },
          },
          ...pages.slice(3),
        ],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(
      note?.lines.includes(
        "与资料数字完全一致的页：第 3 页（4 个数字，资料期间 2026年1-2月，本页写的是 2026年9月，来自资料第 16 页）。",
      ),
    );
    assert.ok(note?.lines.includes("图表类型替换说明：第 3 页：模板第 16 页的雷达图暂以柱状图代替。"));
  });

  it("discloses a radar-to-bar substitution detected at displayed precision", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-note-precision-"));
    scratchRoots.push(projectRoot);
    const context = { commandId: "synthetic-precision", contextEpochId: "precision-epoch" };
    ensureRunLedger(projectRoot, {
      manifestSha256: "synthetic",
      requirementsId: "synthetic",
      requirements: [],
    });
    recordTodo(projectRoot, context, [{ pageId: "p1", title: "合成指标", layoutFamily: "chart", exhibits: [] }]);
    const revision = recordPageRevision(projectRoot, context, "p1", { id: "p1", elements: [] });
    const categories = ["甲", "乙", "丙", "丁", "戊"];
    const report = detectMaterialFigures({
      pageText: "",
      pageCharts: [
        {
          title: "合成指标",
          cols: ["类别", "基准", "实测"],
          rows: [
            ["甲", 1.23, 6.79],
            ["乙", 2.35, 7.89],
            ["丙", 3.46, 8.9],
            ["丁", 4.57, 9.01],
            ["戊", 5.68, 1.12],
          ],
          series: ["基准", "实测"].map((name) => ({ type: "bar", encode: { x: "类别", y: name } })),
        },
      ],
      readings: [
        {
          materialId: "synthetic-template",
          materialName: "synthetic.pptx",
          pages: [],
          templateCharts: [
            {
              sourcePage: 7,
              chartId: "synthetic-radar",
              title: "合成指标",
              type: "radar",
              categories,
              series: [
                {
                  name: "基准",
                  categories,
                  values: [1.2345678901234, 2.3456789012345, 3.4567890123456, 4.5678901234567, 5.6789012345678],
                  numFmt: "0.00",
                },
                {
                  name: "实测",
                  categories,
                  values: [6.7890123456789, 7.8901234567891, 8.9012345678912, 9.0123456789123, 1.1234567891234],
                  numFmt: "0.00",
                },
              ],
              sourcePeriods: [],
            },
          ],
        },
      ],
    });
    assert.equal(report.matches.length, 10);
    assert.ok(report.matches.every((match) => match.chart?.valueMatch === "displayed"));
    recordMaterialFiguresFact(projectRoot, context, {
      pageId: "p1",
      revision: revision.revision,
      ...report,
      visionValues: [],
    });
    const built = buildDeliveryProvenance(projectRoot, {
      type: "deck.composed",
      factId: "synthetic-seal",
      at: "2031-01-01T00:00:00.000Z",
      contextEpochId: context.contextEpochId,
      title: "合成指标",
      deckSha256: "c".repeat(64),
      pageRevisions: { p1: revision.pageSha256 },
    });
    writeMetadata(projectRoot, "delivery-provenance.v1.json", built.file);
    const note = buildSystemDeliveryNote({ projectRoot });
    assert.ok(note?.lines.includes("图表类型替换说明：第 1 页：模板第 7 页的雷达图暂以柱状图代替。"));
    assert.deepEqual(buildSystemDeliveryNote({ projectRoot }), note);
  });

  it("reports partial and uncounted reads without inventing totals", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        materials: [
          {
            id: "a",
            name: "部分读取.pdf",
            kind: "document",
            chunksRead: 2,
            chunkCount: 3,
            pagesCovered: "1–11",
            lowTextPages: [],
            use: ["content"],
          },
          {
            id: "b",
            name: "未计数.docx",
            kind: "document",
            chunksRead: 4,
            chunkCount: null,
            pagesCovered: null,
            lowTextPages: [],
            use: [],
          },
          {
            id: "c",
            name: "未读取.csv",
            kind: "table",
            chunksRead: 0,
            chunkCount: null,
            pagesCovered: null,
            lowTextPages: [],
            use: [],
          },
        ],
        pages: [],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(note?.lines.includes("参考资料：部分读取.pdf — 已读取 2/3 段（第 1–11 页的文字）。"));
    assert.ok(note?.lines.includes("参考资料：未计数.docx — 已读取 4 段。"));
    assert.ok(note?.lines.includes("参考资料：未读取.csv — 未使用。"));
  });

  it("does not call a table 未使用 when its numbers were computed from it", () => {
    const projectRoot = projectCopy("24-page");
    /** @param {string} id @param {string} name @param {number} chunksRead @param {string[]} use */
    const table = (id, name, chunksRead, use) => ({
      id,
      name,
      kind: "table",
      chunksRead,
      chunkCount: null,
      pagesCovered: null,
      lowTextPages: [],
      use,
    });
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        materials: [table("q", "只查询.xlsx", 0, ["computed"]), table("r", "读后查询.csv", 2, ["content", "computed"])],
        pages: [],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(note?.lines.includes("参考资料：只查询.xlsx — 已用于计算。"));
    assert.ok(note?.lines.includes("参考资料：读后查询.csv — 已读取 2 个行区间；用于计算。"));
  });

  it("caps long low-text page lists like the upload notices", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        materials: [
          {
            id: "scan",
            name: "扫描件.pdf",
            kind: "document",
            chunksRead: 1,
            chunkCount: 2,
            pagesCovered: "1–14",
            lowTextPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            use: ["content"],
          },
        ],
        pages: [],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(
      note?.lines.includes(
        "参考资料：扫描件.pdf — 已读取 1/2 段（第 1–14 页的文字；第 1、2、3、4、5、6、7、8、9、10 等 12 页几乎没有文字，可能是整页图片）。",
      ),
    );
  });
});
