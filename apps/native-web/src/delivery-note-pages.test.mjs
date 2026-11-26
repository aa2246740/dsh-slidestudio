import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildSystemDeliveryNote,
  cleanupScratchRoots,
  projectCopy,
  provenanceFixture,
  writeMetadata,
} from "./delivery-note-test-fixture.mjs";

afterEach(cleanupScratchRoots);

describe("system delivery note: design and page sources", () => {
  it("names adopted design sources and hub style packs from the provenance design section", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          stylePriority: "attachments",
          designSystemId: null,
          adoptedSourceIds: ["openkimi:material:synthetic-report"],
          designAspects: ["palette", "fonts"],
          userColors: [],
          components: [],
          styleHintsUsed: [],
        },
        pages: [],
      }),
    );
    assert.ok(buildSystemDeliveryNote({ projectRoot })?.lines.includes("配色与字体：配色/字体 来自『合成参考资料』。"));

    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          stylePriority: "hub-pack",
          designSystemId: "warm-jade",
          adoptedSourceIds: ["material:synthetic-report"],
          designAspects: ["content"],
          userColors: [],
          components: [],
          styleHintsUsed: [],
        },
        pages: [],
      }),
    );
    assert.ok(
      buildSystemDeliveryNote({ projectRoot })?.lines.includes(
        "配色与字体：以风格包「warm-jade」为准；内容 来自『合成参考资料』。",
      ),
    );
  });

  it("keeps naming adopted design sources when the agent also declared a self-directed plan", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          stylePriority: "attachments",
          designSystemId: null,
          adoptedSourceIds: [
            "material:synthetic-report",
            "openkimi:material:missing-upload",
            "material:missing-upload",
            "agent-self-directed-plan",
          ],
          designAspects: ["palette"],
          userColors: [],
          components: [],
          styleHintsUsed: [],
        },
        pages: [],
      }),
    );
    assert.equal(
      buildSystemDeliveryNote({ projectRoot })?.lines.find((line) => line.startsWith("配色与字体：")),
      "配色与字体：配色 来自『合成参考资料』；设计由智能助手自主确定。",
    );
  });

  it("does not claim uploaded materials for an agent-self-directed plan", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          stylePriority: "attachments",
          designSystemId: null,
          adoptedSourceIds: ["agent-self-directed-plan"],
          designAspects: ["palette", "layouts"],
          userColors: [],
          components: [],
          styleHintsUsed: [],
        },
        pages: [],
      }),
    );
    const note = buildSystemDeliveryNote({ projectRoot });
    const line = note?.lines.find((entry) => entry.startsWith("配色与字体："));
    assert.equal(line, "配色与字体：设计由智能助手自主确定。");
    assert.equal(line?.includes("项资料"), false);

    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          stylePriority: "hub-pack",
          designSystemId: "warm-jade",
          adoptedSourceIds: ["agent-self-directed-plan"],
          designAspects: [],
          userColors: [],
          components: [],
          styleHintsUsed: [],
        },
        pages: [],
      }),
    );
    assert.equal(
      buildSystemDeliveryNote({ projectRoot })?.lines.find((line) => line.startsWith("配色与字体：")),
      "配色与字体：以风格包「warm-jade」为准；设计由智能助手自主确定。",
    );
  });

  it("names built-in references distinctly without claiming attachments", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          stylePriority: "attachments",
          designSystemId: null,
          adoptedSourceIds: ["openkimi:design/work/warm-jade-annual-report/design.md", "SKILL.md"],
          designAspects: ["palette"],
          userColors: [],
          components: [],
          styleHintsUsed: [],
        },
        pages: [],
      }),
    );
    const note = buildSystemDeliveryNote({ projectRoot });
    const line = note?.lines.find((entry) => entry.startsWith("配色与字体："));
    assert.equal(line, "配色与字体：参考了 2 个内置设计参考。");
    assert.equal(line?.includes("项资料"), false);
    assert.equal(line?.includes("已采用"), false);

    // Unmapped material ids neither count as uploads nor as built-in references.
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        design: {
          stylePriority: "attachments",
          designSystemId: null,
          adoptedSourceIds: ["material:missing-upload"],
          designAspects: ["palette"],
          userColors: [],
          components: [],
          styleHintsUsed: [],
        },
        pages: [],
      }),
    );
    assert.equal(
      buildSystemDeliveryNote({ projectRoot })?.lines.find((line) => line.startsWith("配色与字体：")),
      "配色与字体：未采用 PPT 设计源；配色由智能助手选择。",
    );
  });

  it("compacts unexplained page ranges", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: Array.from({ length: 24 }, (_, index) => ({
          pageId: `p${String(index + 1).padStart(2, "0")}`,
          title: `页面 ${String(index + 1).padStart(2, "0")}`,
          declared: null,
          detected: null,
          visionValues: [],
          queries: [],
        })),
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(note?.lines.includes("没有说明来源，也未检测到资料数字的页：第 1–24 页。"));
  });

  it("discloses a mixed declaration together with its detected quotes", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          {
            pageId: "01_mixed",
            title: "混合",
            declared: { basis: "mixed" },
            detected: { quotedCount: 2, sourcePages: [12], periodMismatch: null },
            visionValues: [],
            queries: [],
          },
        ],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(note?.lines.includes("与资料数字完全一致的页：第 1 页（2 个数字，来自资料第 12 页）。"));
    assert.ok(note?.lines.includes("标为部分示意的页：第 1 页。"));
    assert.equal(
      note?.lines.some((line) => line.includes("没有说明来源")),
      false,
    );
  });

  it("discloses a mixed declaration even when nothing was detected", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          {
            pageId: "01_mixed",
            title: "混合",
            declared: { basis: "mixed" },
            detected: null,
            visionValues: [],
            queries: [],
          },
        ],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(note?.lines.includes("标为部分示意的页：第 1 页。"));
    assert.equal(
      note?.lines.some((line) => line.includes("没有说明来源")),
      false,
    );
  });

  it("keeps the mock disclosure when a mock page coincidentally matches material figures", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          {
            pageId: "01_mock",
            title: "示意",
            declared: { basis: "mock" },
            detected: { quotedCount: 1, sourcePages: [3], periodMismatch: null },
            visionValues: [],
            queries: [],
          },
        ],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(note?.lines.includes("与资料数字完全一致的页：第 1 页（1 个数字，来自资料第 3 页）。"));
    assert.ok(note?.lines.includes("标为示意数据的页：第 1 页。"));

    // The sealed delivery summary builds on the same provenance lines.
    const sealed = buildSystemDeliveryNote({
      projectRoot,
      deliveryIssue: { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: true },
    });
    assert.ok(sealed?.lines.includes("标为示意数据的页：第 1 页。"));
  });

  it("lists material pages with detections without inventing a mock line", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          {
            pageId: "01_material",
            title: "数据",
            declared: { basis: "material" },
            detected: {
              quotedCount: 4,
              sourcePages: [12],
              periodMismatch: { page: "2026年9月", source: ["2026年1-2月"] },
            },
            visionValues: [],
            queries: [],
          },
        ],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(
      note?.lines.includes(
        "与资料数字完全一致的页：第 1 页（4 个数字，资料期间 2026年1-2月，本页写的是 2026年9月，来自资料第 12 页）。",
      ),
    );
    assert.equal(
      note?.lines.some((line) => line.startsWith("标为示意数据的页")),
      false,
    );
    assert.equal(
      note?.lines.some((line) => line.startsWith("标为部分示意的页")),
      false,
    );
    assert.equal(
      note?.lines.some((line) => line.includes("没有说明来源")),
      false,
    );
  });

  it("renders the corrected distinct quoted count with every real source page", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(
      projectRoot,
      "delivery-provenance.v1.json",
      provenanceFixture({
        pages: [
          {
            pageId: "03_data",
            title: "数据",
            declared: { basis: "material" },
            detected: { quotedCount: 1, sourcePages: [12, 15], periodMismatch: null },
            visionValues: [],
            queries: [],
          },
        ],
      }),
    );

    const note = buildSystemDeliveryNote({ projectRoot });

    assert.ok(note?.lines.includes("与资料数字完全一致的页：第 1 页（1 个数字，来自资料第 12、15 页）。"));
  });

  it("turns the same card into the delivery summary when the delivery message is missing", () => {
    const projectRoot = projectCopy("24-page");
    writeMetadata(projectRoot, "delivery-provenance.v1.json", provenanceFixture());

    const note = buildSystemDeliveryNote({
      projectRoot,
      deliveryIssue: { code: "CONTEXT_BUDGET_EXCEEDED", detail: "ignored", sealed: true },
    });

    assert.equal(note?.title, "系统整理的交付摘要（根据生成记录自动整理，不是智能助手写的说明）");
    assert.equal(note?.lines[0], "总结说明没有生成");
    assert.ok(note?.lines.includes("页数：24 页，全部写入；24 页通过页面检查。"));
    assert.ok(note?.lines.some((line) => line.startsWith("封版：已合成封版，标题「")));
    assert.ok(note?.lines.some((line) => line.startsWith("页面：")));
    // The provenance section replaces the ledger design/material guesswork.
    assert.equal(
      note?.lines.some((line) => line.startsWith("设计：")),
      false,
    );
    assert.equal(
      note?.lines.some((line) => line.startsWith("参考资料：「合成参考资料」已读取")),
      false,
    );
    assert.ok(
      note?.lines.includes(
        "与资料数字完全一致的页：第 3 页（4 个数字，资料期间 2026年1-2月，本页写的是 2026年9月，来自资料第 12 页）。",
      ),
    );
    assert.equal(note?.lines.filter((line) => line.startsWith("参考资料：")).length, 3);
    assert.match(note?.lines.at(-1) ?? "", /可以在下方输入「请补写交付说明」/);
  });
});
