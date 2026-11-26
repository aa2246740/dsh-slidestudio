import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildSystemDeliveryNote,
  cleanupScratchRoots,
  designSummary,
  projectCopy,
  provenanceFixture,
  writeMetadata,
} from "./delivery-note-test-fixture.mjs";

afterEach(cleanupScratchRoots);

describe("system delivery note: sealed summary and design sources", () => {
  it("attributes each adopted aspect to its own source filename", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          adoptedSourceIds: ["openkimi:material:synthetic-report", "material:synthetic-photo"],
          designAspects: [
            {
              source: "material:synthetic-report",
              aspects: ["palette", "fonts", "logo"],
            },
            { source: "material:synthetic-photo", aspects: ["photos"] },
            { source: "material:unselected", aspects: ["data"] },
          ],
        },
      }),
    );
    const note = buildSystemDeliveryNote({ projectRoot });
    assert.ok(note.lines.some((line) => line.includes("配色/字体/Logo 来自『合成参考资料』")));
    assert.ok(note.lines.some((line) => line.includes("照片 来自『合成图片.png』")));
    assert.equal(
      note.lines.some((line) => line.includes("数据 来自")),
      false,
    );
  });

  it("names the image and the PDF a palette came from and does not call a palette-only PDF unused", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        materials: [
          {
            id: "brand-image",
            name: "brand-redwhite.png",
            kind: "image",
            chunksRead: 0,
            chunkCount: null,
            pagesCovered: null,
            lowTextPages: [],
            use: ["design-source"],
          },
          {
            id: "brand-pdf",
            name: "品牌手册.pdf",
            kind: "document",
            chunksRead: 0,
            chunkCount: null,
            pagesCovered: null,
            lowTextPages: [],
            use: ["style-hint", "design-source"],
          },
        ],
        images: [
          {
            materialId: "brand-image",
            name: "brand-redwhite.png",
            placed: [],
            use: "style-reference",
            basis: "filename",
          },
        ],
        design: {
          stylePriority: "attachments",
          designSystemId: null,
          adoptedSourceIds: ["material:brand-image", "openkimi:material:brand-pdf"],
          designAspects: [
            { source: "material:brand-image", aspects: ["palette"] },
            { source: "material:brand-pdf", aspects: ["palette"] },
          ],
          userColors: [],
          components: [],
          styleHintsUsed: [],
        },
      }),
    );
    const lines = buildSystemDeliveryNote({ projectRoot }).lines;
    assert.ok(
      lines.includes("配色与字体：配色 来自『brand-redwhite.png』；配色 来自『品牌手册.pdf』。"),
      lines.join("\n"),
    );
    assert.ok(lines.some((line) => /^参考资料：品牌手册\.pdf — 只取了配色；/.test(line)));
    assert.equal(
      lines.some((line) => line.startsWith("参考资料：brand-redwhite.png")),
      false,
      "the image is already on its own line",
    );
    assert.ok(lines.some((line) => /^图片：brand-redwhite\.png — 只作风格参考，没有放进页面/.test(line)));
  });

  it("VAL-LEGACY-007: card lines name the legacy conversion origin of a converted material", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        materials: [
          {
            id: "legacy-deck",
            name: "旧版.ppt",
            kind: "deck-template",
            chunksRead: 2,
            chunkCount: null,
            pagesCovered: null,
            lowTextPages: [],
            use: [],
            convertedFrom: ".ppt",
          },
          {
            id: "legacy-wps",
            name: "旧版.dps",
            kind: "table",
            chunksRead: 0,
            chunkCount: null,
            pagesCovered: null,
            lowTextPages: [],
            use: [],
            convertedFrom: ".dps",
            convertedFromWps: true,
          },
        ],
      }),
    );
    const lines = buildSystemDeliveryNote({ projectRoot }).lines;
    assert.ok(
      lines.some((line) => line.startsWith("参考资料：旧版.ppt（由 .ppt 转换） —")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) => line.startsWith("参考资料：旧版.dps（由 WPS .dps 转换） —")),
      lines.join("\n"),
    );
    // A non-converted line stays without the mark.
    assert.ok(lines.every((line) => !line.startsWith("参考资料：合成数据.csv（由")));
  });

  it("never describes autonomous, built-in, or unmapped receipts as uploaded design sources", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "runtime.json", {});
    for (const sourceId of [
      "autonomous:self-directed",
      "self-directed",
      "openkimi:design/work/warm-jade-annual-report/design.md",
      "openkimi-preview:work/warm-jade-annual-report",
      "material:missing-upload",
    ]) {
      writeMetadata(projectRoot, "presentation-receipts.v1.json", {
        version: 1,
        receipts: [{ sourceId, state: "adopted", aspects: ["palette"] }],
      });
      assert.equal(
        designSummary(projectRoot),
        "设计：没有采用上传资料作为设计源，配色和版式由智能助手自行选择。",
        sourceId,
      );
    }
  });

  it("treats an explicit empty adoption selection as none even with a mapped old receipt", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "presentation-receipts.v1.json", {
      version: 1,
      receipts: [{ sourceId: "material:synthetic-report", state: "executed", aspects: ["palette"] }],
    });
    assert.equal(designSummary(projectRoot), "设计：没有采用上传资料作为设计源，配色和版式由智能助手自行选择。");
  });

  it("allows mapped adopted or executed material receipts when legacy runtime omits selection", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "runtime.json", {});
    for (const state of ["adopted", "executed", "consulted", "available"]) {
      writeMetadata(projectRoot, "presentation-receipts.v1.json", {
        version: 1,
        receipts: [{ sourceId: "material:synthetic-report", state, aspects: ["palette", "fonts"] }],
      });
      assert.equal(
        designSummary(projectRoot),
        ["adopted", "executed"].includes(state)
          ? "设计：已采用「合成参考资料」的配色、字体。"
          : "设计：没有采用上传资料作为设计源，配色和版式由智能助手自行选择。",
      );
    }
  });

  it("canonicalizes material aliases on both sides of the current effective selection", () => {
    const projectRoot = projectCopy("24-page");
    const sources = [
      "material:synthetic-report",
      "openkimi:material:synthetic-report",
      "openkimi-preview:material:synthetic-report",
    ];
    for (const sourceId of sources) {
      for (const selectedId of sources) {
        writeMetadata(projectRoot, "runtime.json", { adoptedSourceIds: [selectedId] });
        writeMetadata(projectRoot, "presentation-receipts.v1.json", {
          version: 1,
          receipts: [{ sourceId, state: "adopted", aspects: ["palette"] }],
        });
        assert.equal(
          designSummary(projectRoot),
          "设计：已采用「合成参考资料」的配色。",
          `${sourceId} selected as ${selectedId}`,
        );
      }
    }
  });

  it("excludes stale receipts and aspects from uploads outside the current selection", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "materials/manifest.json", {
      version: 1,
      materials: [
        { id: "synthetic-report", name: "合成参考资料" },
        { id: "old-upload", name: "旧合成资料" },
      ],
    });
    writeMetadata(projectRoot, "runtime.json", { adoptedSourceIds: ["material:synthetic-report"] });
    writeMetadata(projectRoot, "presentation-receipts.v1.json", {
      version: 1,
      receipts: [
        { sourceId: "material:synthetic-report", state: "executed", aspects: ["palette"] },
        { sourceId: "material:old-upload", state: "adopted", aspects: ["fonts"] },
        { sourceId: "autonomous:self-directed", state: "executed", aspects: ["layouts"] },
      ],
    });
    assert.equal(designSummary(projectRoot), "设计：已采用「合成参考资料」的配色。");
  });

  it("summarizes only sealed ledger, outline, receipt, and material facts", () => {
    const projectRoot = projectCopy("24-page");
    const issue = { code: "CONTEXT_BUDGET_EXCEEDED", detail: "not used in the note", sealed: true };
    const note = buildSystemDeliveryNote({ projectRoot, deliveryIssue: issue });

    assert.ok(note);
    assert.equal(note.title, "系统整理的交付摘要（根据生成记录自动整理，不是智能助手写的说明）");
    assert.ok(note.lines.includes("页数：24 页，全部写入；24 页通过页面检查。"));
    assert.ok(note.lines.some((line) => line.startsWith("封版：已合成封版，标题「")));
    assert.ok(note.lines.some((line) => line.startsWith("设计：没有采用上传资料作为设计源")));
    assert.ok(note.lines.includes("参考资料：「合成参考资料」已读取 3 段文字。"));
    const pageLine = note.lines.find((line) => line.startsWith("页面："));
    assert.ok(pageLine);
    assert.ok(pageLine.indexOf("页面 01") < pageLine.indexOf("页面 24"));
    assert.match(
      note.lines.at(-1) ?? "",
      /^说明：系统无法判断页面上的数字和结论来自资料还是智能助手编写.*请补写交付说明/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, "pages")), false);
    assert.equal(fs.existsSync(path.join(projectRoot, "_agent", "assistant-conversation.v1.json")), false);
  });

  it("caps long page-title lists at 32 and reports the total page count", () => {
    const projectRoot = projectCopy("40-page");
    const note = buildSystemDeliveryNote({
      projectRoot,
      deliveryIssue: { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: true },
    });
    const pageLine = note?.lines.find((line) => line.startsWith("页面："));

    assert.ok(pageLine);
    assert.ok(pageLine.includes("页面 32"));
    assert.ok(!pageLine.includes("页面 33"));
    assert.ok(pageLine.endsWith("等 40 页"));
    assert.ok(note.lines.includes("参考资料：「合成参考资料」已读取 3 段文字。"));
  });

  it("uses only explicit document chunk totals, never PDF pages or DOCX blocks", () => {
    const projectRoot = projectCopy("24-page");
    for (const total of [{ chunkCount: 3 }, { chunks: 3 }]) {
      writeMetadata(projectRoot, "materials/manifest.json", {
        version: 1,
        materials: [
          {
            id: "synthetic-report",
            name: "合成参考资料",
            kind: "document",
            parts: [{ part: "document", pages: 6, ...total }],
          },
        ],
      });
      const note = buildSystemDeliveryNote({ projectRoot, deliveryIssue: { sealed: true } });
      assert.ok(note.lines.includes("参考资料：「合成参考资料」已读取 3/3 段文字。"));
    }
  });

  it("preserves legacy text receipts and deduplicates chunks without counting non-text parts", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "materials/manifest.json", {
      version: 1,
      materials: [
        {
          id: "synthetic-report",
          name: "合成参考资料",
          parts: [
            { part: "text", chunks: 3 },
            { part: "preview", chunks: 9 },
          ],
        },
      ],
    });
    const ledger = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent", "run-ledger.v1.json"), "utf8"));
    for (const fact of ledger.facts) {
      if (fact.type === "material.chunk-returned") fact.part = "text";
    }
    const firstChunk = ledger.facts.find(
      (/** @type {{ type?: string }} */ fact) => fact.type === "material.chunk-returned",
    );
    ledger.facts.push(firstChunk, { ...firstChunk, part: "preview" });
    writeMetadata(projectRoot, "run-ledger.v1.json", ledger);

    const note = buildSystemDeliveryNote({ projectRoot, deliveryIssue: { sealed: true } });
    assert.ok(note.lines.includes("参考资料：「合成参考资料」已读取 3/3 段文字。"));
  });

  it("DECISIONS #63: uses recorded PDF/DOCX chunkCount with production-shaped manifests, keeping table rows", () => {
    const projectRoot = projectCopy("24-page");
    const ledger = JSON.parse(fs.readFileSync(path.join(projectRoot, "_agent/run-ledger.v1.json"), "utf8"));
    ledger.facts = ledger.facts.filter(
      (/** @type {{ type?: string }} */ fact) => fact.type !== "material.chunk-returned",
    );
    const materials = [
      {
        id: "pdf",
        name: "离线报告.pdf",
        kind: "document",
        parts: [{ part: "document", pages: 29, chars: 14000 }],
      },
      {
        id: "docx",
        name: "离线报告.docx",
        kind: "document",
        parts: [{ part: "document", blocks: 50, chars: 14000 }],
      },
      { id: "csv", name: "离线数据.csv", kind: "table", parts: [{ part: "rows", rows: 4 }] },
    ];
    for (const materialId of ["pdf", "docx"]) {
      for (const chunkIndex of [0, 1, 2, 0]) {
        ledger.facts.push({
          type: "material.chunk-returned",
          materialId,
          part: "document",
          chunkIndex,
          chunkCount: 3,
          chunkSha256: String(chunkIndex).repeat(64),
        });
      }
    }
    for (const [rowStart, rowEnd] of [
      [1, 3],
      [2, 4],
      [1, 3],
    ]) {
      ledger.facts.push({
        type: "material.chunk-returned",
        materialId: "csv",
        part: "rows",
        chunkIndex: 0,
        chunkCount: 1,
        rowStart,
        rowEnd,
        rowTotal: 4,
      });
    }
    writeMetadata(projectRoot, "materials/manifest.json", { version: 1, materials });
    writeMetadata(projectRoot, "run-ledger.v1.json", ledger);
    const note = buildSystemDeliveryNote({ projectRoot, deliveryIssue: { sealed: true } });
    assert.ok(note.lines.includes("参考资料：「离线报告.pdf」已读取 3/3 段文字。"));
    assert.ok(note.lines.includes("参考资料：「离线报告.docx」已读取 3/3 段文字。"));
    assert.ok(note.lines.includes("参考资料：「离线数据.csv」已读取 4/4 行。"));
    for (const fact of ledger.facts) delete fact.chunkCount;
    writeMetadata(projectRoot, "run-ledger.v1.json", ledger);
    const legacy = buildSystemDeliveryNote({ projectRoot, deliveryIssue: { sealed: true } });
    assert.ok(legacy.lines.includes("参考资料：「离线报告.pdf」已读取 3 段文字。"));
    assert.ok(legacy.lines.includes("参考资料：「离线报告.docx」已读取 3 段文字。"));
  });

  it("does not build or persist a note for an unsealed delivery issue", () => {
    const projectRoot = projectCopy("24-page");
    const conversationPath = path.join(projectRoot, "_agent", "assistant-conversation.v1.json");
    const before = Buffer.from('{"version":1,"messages":[]}\n');
    fs.writeFileSync(conversationPath, before);

    const note = buildSystemDeliveryNote({
      projectRoot,
      deliveryIssue: { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: false },
    });

    assert.equal(note, undefined);
    assert.deepEqual(fs.readFileSync(conversationPath), before);
  });

  it("does not write the generated note into the assistant conversation", () => {
    const projectRoot = projectCopy("24-page");
    const conversationPath = path.join(projectRoot, "_agent", "assistant-conversation.v1.json");
    const before = Buffer.from('{"version":1,"messages":[{"role":"assistant","text":"synthetic"}]}\n');
    fs.writeFileSync(conversationPath, before);

    buildSystemDeliveryNote({
      projectRoot,
      deliveryIssue: { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: true },
    });

    assert.deepEqual(fs.readFileSync(conversationPath), before);
  });

  it("words measured low-text pages as image, blank, or still unmeasured", () => {
    const projectRoot = projectCopy("24-page");
    const base = provenanceFixture();
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        materials: [
          {
            ...base.materials[0],
            lowTextPages: [2, 3, 4],
            imagePages: [2],
            blankPages: [3],
          },
        ],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.equal(
      note?.lines[0],
      "参考资料：合成参考资料 — 已读完全部 3 段（第 1–29 页的文字；第 2 页主要是图片，未识别其中的文字；第 3 页几乎没有文字；第 4 页几乎没有文字，可能是整页图片）；提供风格线索。",
    );
    assert.doesNotMatch(note?.lines.join("\n") ?? "", /扫描图片/);
  });

  it("always shows the provenance usage card under a delivered final reply", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "delivery-provenance.v1.json", provenanceFixture());

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.equal(note?.title, "资料使用情况（系统根据生成记录整理）");
    assert.deepEqual(note?.lines, [
      "参考资料：合成参考资料 — 已读完全部 3 段（第 1–29 页的文字；第 3、26 页几乎没有文字，可能是整页图片）；提供风格线索。",
      "参考资料：合成数据.csv — 已读取 2 个行区间。",
      "参考资料：合成图片.png — 未使用。",
      "配色与字体：未采用 PPT 设计源；配色由智能助手选择。",
      "与资料数字完全一致的页：第 3 页（4 个数字，资料期间 2026年1-2月，本页写的是 2026年9月，来自资料第 12 页）。",
      "标为示意数据的页：第 2 页。",
      "没有说明来源，也未检测到资料数字的页：第 1、4 页。",
    ]);
    assert.equal(
      note?.lines.some((line) => line.includes("总结说明没有生成")),
      false,
    );
    assert.equal(
      note?.lines.some((line) => line.includes("请补写交付说明")),
      false,
    );
    // Refresh-stable: the card rebuilds identically from the file.
    assert.deepEqual(buildSystemDeliveryNote({ projectRoot }), note);
  });
});
