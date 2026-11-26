import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildDeliveryProvenance,
  ensureRunLedger,
  numberConflictLine,
  recordPageConflictsFact,
  recordPageRevision,
  recordTodo,
  styleConflictLines,
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

describe("monthly update lines (CAP-17, VAL-DATA-008)", () => {
  const MAP = { from: "2026年8月", to: "2026年9月" };
  const MISSING = "第 7 页『专题汇报』：未提供本期数据";

  /** @param {unknown} data @param {unknown} [deliveryIssue] */
  function noteWith(data, deliveryIssue) {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "delivery-provenance.v1.json", provenanceFixture({ data }));
    return buildSystemDeliveryNote({ projectRoot, ...(deliveryIssue ? { deliveryIssue } : {}) });
  }

  it("shows the period line and one line naming the items without new data", () => {
    const note = noteWith({ periodMap: MAP, missingItems: [MISSING] });
    assert.equal(note?.title, "资料使用情况（系统根据生成记录整理）");
    assert.ok(note?.lines.includes("期间：2026年8月 → 2026年9月"), note?.lines.join("\n"));
    assert.ok(note?.lines.includes("没有本期数据的项目：第 7 页『专题汇报』"), note?.lines.join("\n"));
    const period = note.lines.indexOf("期间：2026年8月 → 2026年9月");
    assert.equal(note.lines[period + 1], "没有本期数据的项目：第 7 页『专题汇报』");
  });

  it("joins several items and bounds a long list", () => {
    /** @param {number} page */
    const entry = (page) => `第 ${page} 页『图表${page}』：未提供本期数据`;
    const few = noteWith({ periodMap: MAP, missingItems: [entry(3), entry(5)] });
    assert.ok(few?.lines.includes("没有本期数据的项目：第 3 页『图表3』、第 5 页『图表5』"), few?.lines.join("\n"));
    /** @param {number} count */
    const listed = (count) =>
      noteWith({
        periodMap: MAP,
        missingItems: Array.from({ length: count }, (_, index) => entry(index + 1)),
      })?.lines.find((item) => item.startsWith("没有本期数据的项目："));
    // A 12-page update of a 52-chart deck can lack data for a few dozen items; every one is named.
    const all = listed(21);
    assert.ok(all?.endsWith("第 20 页『图表20』、第 21 页『图表21』"), all);
    assert.ok(!all?.includes("等 21 项"));
    const bounded = listed(65);
    assert.ok(bounded?.endsWith("第 60 页『图表60』等 65 项"), bounded);
    assert.ok(!bounded?.includes("第 61 页"));
  });

  it("writes no 没有本期数据 line for an empty list, and nothing for a plain project", () => {
    const empty = noteWith({ periodMap: MAP, missingItems: [] });
    assert.ok(empty?.lines.includes("期间：2026年8月 → 2026年9月"));
    assert.ok(!empty?.lines.some((line) => line.includes("没有本期数据")), empty?.lines.join("\n"));
    const plain = noteWith({});
    assert.ok(!plain?.lines.some((line) => line.startsWith("期间：") || line.includes("没有本期数据")));
    const legacy = noteWith(undefined);
    assert.ok(!legacy?.lines.some((line) => line.startsWith("期间：")));
  });

  it("carries both lines into the delivery summary the card becomes without an Agent message", () => {
    const issue = { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: true };
    const note = noteWith({ periodMap: MAP, missingItems: [MISSING] }, issue);
    assert.equal(note?.title, "系统整理的交付摘要（根据生成记录自动整理，不是智能助手写的说明）");
    assert.equal(note?.lines[0], "总结说明没有生成");
    assert.equal(note?.lines.filter((line) => line.startsWith("期间：")).length, 1);
    assert.ok(note?.lines.includes("期间：2026年8月 → 2026年9月"));
    assert.ok(note?.lines.includes("没有本期数据的项目：第 7 页『专题汇报』"));
    const withoutItems = noteWith({ periodMap: MAP, missingItems: [] }, issue);
    assert.ok(!withoutItems?.lines.some((line) => line.includes("没有本期数据")));
  });
});

describe("conflict lines (CAP-21, VAL-DATA-009/010)", () => {
  /** @typedef {Parameters<typeof numberConflictLine>[0] & { pages: number[] }} NumberConflict */
  /** @typedef {Parameters<typeof styleConflictLines>[0]} StyleConflict */
  /** @param {Partial<NumberConflict>} [overrides] @returns {NumberConflict} */
  const number = (overrides = {}) => ({
    kind: "number",
    label: "Q3 营收",
    values: [
      { source: "季度经营.xlsx", value: "1502.25", unit: "万" },
      { source: "运营简报.pdf", value: "1500", unit: "万" },
    ],
    used: { source: "季度经营.xlsx", value: "1502.25", unit: "万" },
    reason: "表格数据优先于文档文字",
    pages: [1],
    ...overrides,
  });
  /** @type {NumberConflict} */
  const brief = {
    kind: "brief",
    label: "Q3 营收",
    values: [
      { source: "你的要求", value: "1500", unit: "万" },
      { source: "季度经营.xlsx", value: "1502.25", unit: "万" },
    ],
    used: { source: "你的要求", value: "1500", unit: "万" },
    reason: "按你的要求写入，资料里的数不同",
    pages: [1],
  };
  /** @type {StyleConflict} */
  const pack = {
    kind: "style",
    basis: "style-pack",
    detail: "首页选了风格「红黑增长」，附件「品牌模板.pptx」的配色没有采用",
    winner: "红黑增长",
    attachment: "品牌模板.pptx",
    uses: ["Logo", "内容", "数据"],
  };
  /** @type {StyleConflict} */
  const palette = {
    kind: "style",
    basis: "first-adopted",
    detail: "配色来源有 2 个：甲模板.pptx、乙模板.pptx；以最先采用的「甲模板.pptx」为准",
    winner: "甲模板.pptx",
    others: ["乙模板.pptx"],
  };

  /** @param {unknown[] | undefined} conflicts @param {unknown} [deliveryIssue] */
  function noteWith(conflicts, deliveryIssue) {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "delivery-provenance.v1.json", provenanceFixture({ conflicts }));
    return buildSystemDeliveryNote({ projectRoot, ...(deliveryIssue ? { deliveryIssue } : {}) });
  }

  it("states both sources, both values and the winner of a number conflict in Chinese", () => {
    const note = noteWith([number()]);
    assert.equal(note?.title, "资料使用情况（系统根据生成记录整理）");
    assert.ok(
      note?.lines.includes(
        "数字不一致：『Q3 营收』季度经营.xlsx 为 1502.25 万，运营简报.pdf 为 1500 万；本稿采用 1502.25 万（来自 季度经营.xlsx）。表格数据优先于文档文字",
      ),
      note?.lines.join("\n"),
    );
    const bare = noteWith([
      number({
        values: [
          { source: "季度经营.xlsx", value: "1502.25" },
          { source: "报告.docx", value: "1500" },
        ],
        used: { source: "季度经营.xlsx", value: "1502.25" },
      }),
    ]);
    const line = bare?.lines.find((item) => item.startsWith("数字不一致："));
    assert.ok(
      line?.startsWith(
        "数字不一致：『Q3 营收』季度经营.xlsx 为 1502.25，报告.docx 为 1500；本稿采用 1502.25（来自 季度经营.xlsx）",
      ),
      line,
    );
  });

  it("names the brief as a source when the conflict is against the user's own words", () => {
    const note = noteWith([brief]);
    assert.ok(
      note?.lines.includes(
        "数字不一致：『Q3 营收』你的要求 为 1500 万，季度经营.xlsx 为 1502.25 万；本稿采用 1500 万（来自 你的要求）。按你的要求写入，资料里的数不同",
      ),
      note?.lines.join("\n"),
    );
  });

  it("keeps two same-named materials apart by the place their names carry", () => {
    const first = "季度经营.xlsx（同名第 1 份）";
    const same = number({
      values: [
        { source: first, value: "1502.25", unit: "万" },
        { source: "季度经营.xlsx（同名第 2 份）", value: "1500", unit: "万" },
      ],
      used: { source: first, value: "1502.25", unit: "万" },
      reason: "几份资料类型相同，系统无法判断哪个更准，请核对",
    });
    const lines = noteWith([same])?.lines ?? [];
    assert.ok(
      lines.includes(
        "数字不一致：『Q3 营收』季度经营.xlsx（同名第 1 份） 为 1502.25 万，季度经营.xlsx（同名第 2 份） 为 1500 万；本稿采用 1502.25 万（来自 季度经营.xlsx（同名第 1 份））。几份资料类型相同，系统无法判断哪个更准，请核对",
      ),
      lines.join("\n"),
    );
    assert.ok(lines.includes(numberConflictLine(same)));
  });

  it("states the style pack as the winner and what the attachment still supplies", () => {
    const note = noteWith([pack]);
    assert.ok(
      note?.lines.includes("配色以风格『红黑增长』为准；附件『品牌模板.pptx』用于 Logo / 内容 / 数据"),
      note?.lines.join("\n"),
    );
    const unspecified = noteWith([{ ...pack, uses: [] }]);
    assert.ok(
      unspecified?.lines.includes("配色以风格『红黑增长』为准；附件『品牌模板.pptx』可用于 Logo / 照片 / 内容 / 数据"),
    );
  });

  it("states the first adopted palette source as the winner and who lost", () => {
    const note = noteWith([palette]);
    const winner = note?.lines.indexOf("配色以『甲模板.pptx』为准") ?? -1;
    assert.ok(winner >= 0, note?.lines.join("\n"));
    assert.equal(note?.lines[winner + 1], "『乙模板.pptx』也提供了配色，没有采用");
  });

  it("writes no conflict line without a conflict, for old projects, or for unusable entries", () => {
    /** @param {string} line */
    const isConflict = (line) => line.startsWith("数字不一致") || line.startsWith("配色以");
    assert.ok(!noteWith([])?.lines.some(isConflict));
    assert.ok(!noteWith(undefined)?.lines.some(isConflict));
    // Earlier builds wrote plain strings; the card ignores them rather than printing a guess.
    assert.ok(!noteWith(["首页选了风格「红黑增长」"])?.lines.some(isConflict));
    assert.ok(
      !noteWith([
        number({ values: [] }),
        number({ used: /** @type {NumberConflict["used"]} */ ({}) }),
        { kind: "style" },
      ])?.lines.some(isConflict),
    );
    assert.ok(!noteWith([{ ...pack, basis: "other" }])?.lines.some(isConflict));
  });

  it("is non-blocking: the card still shows the rest of the usage lines", () => {
    const note = noteWith([number(), pack]);
    assert.ok(
      note?.lines.some((line) => line.startsWith("配色与字体：")),
      note?.lines.join("\n"),
    );
    assert.ok(note?.lines.some((line) => line.includes("合成参考资料")));
  });

  it("carries the lines into the delivery summary the card becomes without an Agent message", () => {
    const issue = { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: true };
    const note = noteWith([number(), palette], issue);
    assert.equal(note?.title, "系统整理的交付摘要（根据生成记录自动整理，不是智能助手写的说明）");
    assert.equal(note?.lines[0], "总结说明没有生成");
    assert.equal(note?.lines.filter((line) => line.startsWith("数字不一致")).length, 1);
    assert.ok(note?.lines.includes("配色以『甲模板.pptx』为准"));
  });

  it("bounds a long list of number conflicts", () => {
    const many = Array.from({ length: 8 }, (_, index) => number({ label: `指标${index + 1}` }));
    const note = noteWith(many);
    assert.equal(note?.lines.filter((line) => line.startsWith("数字不一致")).length, 6);
    assert.ok(note?.lines.includes("另有 2 处数字不一致，没有逐条列出"));
  });

  it("prints the same text the compose receipt summary uses", () => {
    const lines = noteWith([number(), brief, pack, palette])?.lines ?? [];
    for (const conflict of [number(), brief]) assert.ok(lines.includes(numberConflictLine(conflict)));
    for (const conflict of [pack, palette]) {
      for (const line of styleConflictLines(conflict)) assert.ok(lines.includes(line), line);
    }
  });

  it("builds the lines from the real provenance builder output", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-note-conflicts-"));
    scratchRoots.push(projectRoot);
    const context = { commandId: "synthetic-conflicts", contextEpochId: "conflicts-epoch" };
    fs.mkdirSync(path.join(projectRoot, "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "deck.pptd"),
      `${JSON.stringify({
        version: "v2",
        title: "数字冲突",
        size: [960, 540],
        theme: {},
        pages: ["pages/p1.page"],
      })}\n`,
    );
    fs.writeFileSync(
      path.join(projectRoot, "pages", "p1.page"),
      `${JSON.stringify({ pageType: "content", elements: [] })}\n`,
    );
    fs.mkdirSync(path.join(projectRoot, "_agent", "materials"), { recursive: true });
    writeMetadata(projectRoot, "materials/manifest.json", { version: 1, materials: [] });
    ensureRunLedger(projectRoot, {
      manifestSha256: "synthetic",
      requirementsId: "synthetic",
      requirements: [],
    });
    recordTodo(projectRoot, context, [{ pageId: "p1", title: "营收", layoutFamily: "content", exhibits: [] }]);
    const revision = recordPageRevision(projectRoot, context, "p1", { id: "p1", elements: [] });
    /** @param {number} revisionNumber */
    const fact = (revisionNumber) =>
      recordPageConflictsFact(projectRoot, context, {
        pageId: "p1",
        revision: revisionNumber,
        conflicts: [
          {
            kind: /** @type {const} */ ("number"),
            label: number().label,
            values: number().values,
            used: number().used,
            reason: number().reason,
          },
        ],
      });
    // A fact recorded for a revision the page no longer has is history, not what the deck shows.
    fact(revision.revision + 1);
    const none = buildDeliveryProvenance(projectRoot, {
      type: "deck.composed",
      factId: "synthetic-seal-0",
      at: "2031-01-01T00:00:00.000Z",
      contextEpochId: context.contextEpochId,
      title: "数字冲突",
      deckSha256: "d".repeat(64),
      pageRevisions: { p1: revision.pageSha256 },
    });
    assert.deepEqual(none.file.conflicts, []);
    fact(revision.revision);
    const built = buildDeliveryProvenance(projectRoot, {
      type: "deck.composed",
      factId: "synthetic-seal",
      at: "2031-01-01T00:00:01.000Z",
      contextEpochId: context.contextEpochId,
      title: "数字冲突",
      deckSha256: "d".repeat(64),
      pageRevisions: { p1: revision.pageSha256 },
    });
    assert.equal(built.file.conflicts.length, 1);
    assert.deepEqual(/** @type {{ pages?: number[] }} */ (built.file.conflicts[0]).pages, [1]);
    writeMetadata(projectRoot, "delivery-provenance.v1.json", built.file);

    const lines = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];

    assert.ok(
      lines.includes(
        "数字不一致：『Q3 营收』季度经营.xlsx 为 1502.25 万，运营简报.pdf 为 1500 万；本稿采用 1502.25 万（来自 季度经营.xlsx）。表格数据优先于文档文字",
      ),
      lines.join("\n"),
    );
  });
});

describe("user colour line (CAP-18, VAL-DATA-011)", () => {
  const blue = { hex: "#1F4E9A", reason: "用户要求主色换成蓝色" };
  const orange = { hex: "#AA5500", reason: "用户要求强调色用橙棕" };
  /** @param {string} line */
  const isColourLine = (line) => line.startsWith("配色：");

  /** @param {unknown[] | undefined} userColors @param {unknown} [deliveryIssue] */
  function noteWith(userColors, deliveryIssue) {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          stylePriority: "agent",
          designSystemId: null,
          adoptedSourceIds: [],
          designAspects: [],
          ...(userColors === undefined ? {} : { userColors }),
          components: [],
          styleHintsUsed: [],
        },
      }),
    );
    return buildSystemDeliveryNote({ projectRoot, ...(deliveryIssue ? { deliveryIssue } : {}) });
  }

  it("states the colour and the request it answers, right after the 配色与字体 line", () => {
    const lines = noteWith([blue])?.lines ?? [];
    const index = lines.indexOf("配色：按你的要求使用 #1F4E9A（用户要求主色换成蓝色）");
    assert.ok(index > 0, lines.join("\n"));
    assert.ok(lines[index - 1]?.startsWith("配色与字体："), lines[index - 1]);
  });

  it("names every colour on one line, in the order the Agent declared them", () => {
    const lines = noteWith([blue, orange])?.lines ?? [];
    assert.equal(lines.filter(isColourLine).length, 1);
    assert.ok(lines.includes("配色：按你的要求使用 #1F4E9A（用户要求主色换成蓝色）、#AA5500（用户要求强调色用橙棕）"));
  });

  it("writes no line without user colours, for old projects, or for unusable entries", () => {
    assert.ok(!noteWith([])?.lines.some(isColourLine));
    assert.ok(!noteWith(undefined)?.lines.some(isColourLine));
    // Earlier builds wrote an empty list only; plain strings and malformed hexes are ignored.
    assert.ok(!noteWith(["#1F4E9A"])?.lines.some(isColourLine));
    assert.ok(!noteWith([{ hex: "blue", reason: "x" }, { reason: "y" }])?.lines.some(isColourLine));
  });

  it("carries the line into the delivery summary the card becomes without an Agent message", () => {
    const issue = { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: true };
    const note = noteWith([blue], issue);
    assert.equal(note?.lines[0], "总结说明没有生成");
    assert.ok(note?.lines.includes("配色：按你的要求使用 #1F4E9A（用户要求主色换成蓝色）"));
  });

  it("builds the line from the real provenance builder output and the saved runtime.json", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-note-user-colors-"));
    scratchRoots.push(projectRoot);
    const context = { commandId: "synthetic-colours", contextEpochId: "colours-epoch" };
    fs.mkdirSync(path.join(projectRoot, "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "deck.pptd"),
      `${JSON.stringify({
        version: "v2",
        title: "指定配色",
        size: [960, 540],
        theme: {},
        pages: ["pages/p1.page"],
      })}\n`,
    );
    fs.writeFileSync(
      path.join(projectRoot, "pages", "p1.page"),
      `${JSON.stringify({ pageType: "content", elements: [] })}\n`,
    );
    fs.mkdirSync(path.join(projectRoot, "_agent", "materials"), { recursive: true });
    writeMetadata(projectRoot, "materials/manifest.json", { version: 1, materials: [] });
    // What commit_design saves when the Agent declares a colour the user named.
    writeMetadata(projectRoot, "runtime.json", {
      brief: "主色换成蓝色 #1F4E9A",
      adoptedSourceIds: [],
      designAspects: [],
      userColors: [blue],
    });
    ensureRunLedger(projectRoot, {
      manifestSha256: "synthetic",
      requirementsId: "synthetic",
      requirements: [],
    });
    recordTodo(projectRoot, context, [{ pageId: "p1", title: "概览", layoutFamily: "content", exhibits: [] }]);
    const revision = recordPageRevision(projectRoot, context, "p1", { id: "p1", elements: [] });
    const built = buildDeliveryProvenance(projectRoot, {
      type: "deck.composed",
      factId: "synthetic-colours-seal",
      at: "2031-01-01T00:00:00.000Z",
      contextEpochId: context.contextEpochId,
      title: "指定配色",
      deckSha256: "e".repeat(64),
      pageRevisions: { p1: revision.pageSha256 },
    });
    assert.deepEqual(built.file.design.userColors, [blue]);
    writeMetadata(projectRoot, "delivery-provenance.v1.json", built.file);

    const lines = buildSystemDeliveryNote({ projectRoot })?.lines ?? [];

    assert.ok(lines.includes("配色：按你的要求使用 #1F4E9A（用户要求主色换成蓝色）"), lines.join("\n"));
  });
});
