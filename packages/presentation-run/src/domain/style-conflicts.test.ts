/**
 * Style conflicts (CAP-21, VAL-DATA-010): a Hub style pack against an attached template, and several
 * palette sources in 自由风格. Deterministic over the saved design choice; no brief wording is read,
 * and recording a conflict never turns a commit into a refusal.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createEmptyProject } from "@open-slidestudio/pptd-v2";
import { styleConflictLines, styleConflicts } from "./delivery-conflicts.js";
import { buildDeliveryProvenance } from "./delivery-provenance.js";
import { runDomainHand, writeDomainRuntime } from "./domain-hands.js";
import { imageFixture, writeMaterialFixture } from "./material-testkit.js";
import { ensureRunLedger, type DeckComposedFact } from "./run-ledger.js";

const CONTEXT = { commandId: "style-conflicts", contextEpochId: "style-epoch" };
const PACK = "consulting/red-black-growth";

function template(root: string, id: string, name: string): void {
  writeMaterialFixture(root, {
    id,
    name,
    kind: "deck-template",
    parser: "pptx-template-v2",
    originalBytes: Buffer.from(`template-${id}`),
  });
}

function project(t: { after(fn: () => void): void }, runtime: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "style-conflicts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createEmptyProject(root, { title: "风格冲突" });
  writeDomainRuntime(root, { brief: "制作 3 页测试。", ...runtime });
  ensureRunLedger(root, {
    manifestSha256: "fixture",
    requirementsId: "fixture",
    requirements: [],
    executionPolicy: { currentRenderedLayoutRequired: false, structuralReviewRequired: true },
  });
  return root;
}

const choice = (
  designSystemId: string | null,
  adoptedSourceIds: string[],
  designAspects: { source: string; aspects: string[] }[] = [],
) => ({ designSystemId, adoptedSourceIds, designAspects });

/** What `commit_design` saves for an adopted template that declared no aspects of its own. */
const defaults = (...ids: string[]) =>
  ids.map((id) => ({ source: `material:${id}`, aspects: ["palette", "fonts", "logo"] }));

const sealed = (): DeckComposedFact => ({
  type: "deck.composed",
  factId: "style-seal",
  at: "2026-01-01T00:00:00.000Z",
  contextEpochId: CONTEXT.contextEpochId,
  title: "风格冲突",
  deckSha256: "a".repeat(64),
  pageRevisions: {},
});

describe("VAL-DATA-010: style pack against an attached template", () => {
  it("records the pack as the winner and what the attachment is still used for", (t) => {
    const root = project(t);
    template(root, "tpl-a", "品牌模板.pptx");
    const found = styleConflicts(
      root,
      choice(PACK, ["material:tpl-a"], [{ source: "material:tpl-a", aspects: ["logo", "content", "data"] }]),
    );
    assert.deepEqual(found, [
      {
        kind: "style",
        basis: "style-pack",
        detail: "首页选了风格「红黑增长」，附件「品牌模板.pptx」的配色没有采用",
        winner: "红黑增长",
        attachment: "品牌模板.pptx",
        uses: ["Logo", "内容", "数据"],
      },
    ]);
    assert.deepEqual(styleConflictLines(found[0]!), [
      "配色以风格『红黑增长』为准；附件『品牌模板.pptx』用于 Logo / 内容 / 数据",
    ]);
  });

  it("covers a template whose palette was never requested: it may still supply Logo, photos, content and data", (t) => {
    const root = project(t);
    template(root, "tpl-a", "品牌模板.pptx");
    const found = styleConflicts(root, choice(PACK, []));
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.uses, []);
    assert.deepEqual(styleConflictLines(found[0]!), [
      "配色以风格『红黑增长』为准；附件『品牌模板.pptx』可用于 Logo / 照片 / 内容 / 数据",
    ]);
  });

  it("lists layouts as reference only and keeps one entry per template", (t) => {
    const root = project(t);
    template(root, "tpl-a", "甲模板.pptx");
    template(root, "tpl-b", "乙模板.pptx");
    const found = styleConflicts(
      root,
      choice(PACK, [], [{ source: "material:tpl-b", aspects: ["layouts", "photos"] }]),
    );
    assert.deepEqual(
      found.map((entry) => [entry.attachment, entry.uses]),
      [
        ["甲模板.pptx", []],
        ["乙模板.pptx", ["照片", "版式（仅参考）"]],
      ],
    );
  });

  it("records nothing without a template attached or without a pack", (t) => {
    const root = project(t);
    writeMaterialFixture(root, {
      id: "xlsx",
      name: "季度经营.xlsx",
      kind: "table",
      parser: "xlsx-ooxml-v1",
      originalBytes: Buffer.from("workbook"),
    });
    assert.deepEqual(styleConflicts(root, choice(PACK, [])), []);
    template(root, "tpl-a", "品牌模板.pptx");
    assert.deepEqual(styleConflicts(root, choice(null, [])), []);
  });
});

describe("VAL-DATA-010: two palette sources in 自由风格", () => {
  it("names both templates and makes the first adopted the winner", (t) => {
    const root = project(t);
    template(root, "tpl-a", "甲模板.pptx");
    template(root, "tpl-b", "乙模板.pptx");
    const adopted = defaults("tpl-a", "tpl-b");
    const found = styleConflicts(root, choice(null, ["material:tpl-a", "material:tpl-b"], adopted));
    assert.deepEqual(found, [
      {
        kind: "style",
        basis: "first-adopted",
        detail: "配色来源有 2 个：甲模板.pptx、乙模板.pptx；以最先采用的「甲模板.pptx」为准",
        winner: "甲模板.pptx",
        others: ["乙模板.pptx"],
      },
    ]);
    assert.deepEqual(styleConflictLines(found[0]!), [
      "配色以『甲模板.pptx』为准",
      "『乙模板.pptx』也提供了配色，没有采用",
    ]);
    // Adoption order decides, not manifest order.
    const reversed = styleConflicts(root, choice(null, ["material:tpl-b", "material:tpl-a"], adopted));
    assert.equal(reversed[0]!.winner, "乙模板.pptx");
  });

  it("covers a template and an image whose palette was declared", (t) => {
    const root = project(t);
    template(root, "tpl-a", "甲模板.pptx");
    const image = imageFixture("img-a", "品牌色.png", 800, 600);
    writeMaterialFixture(root, image);
    const aspects = [...defaults("tpl-a"), { source: "material:img-a", aspects: ["palette"] }];
    const found = styleConflicts(root, choice(null, ["material:img-a", "material:tpl-a"], aspects));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.winner, "品牌色.png");
    assert.deepEqual(found[0]!.others, ["甲模板.pptx"]);
  });

  it("is not a conflict when only one adopted source supplies a palette", (t) => {
    const root = project(t);
    template(root, "tpl-a", "甲模板.pptx");
    template(root, "tpl-b", "乙模板.pptx");
    const contentOnly = [...defaults("tpl-a"), { source: "material:tpl-b", aspects: ["content", "data"] }];
    assert.deepEqual(styleConflicts(root, choice(null, ["material:tpl-a", "material:tpl-b"], contentOnly)), []);
    assert.deepEqual(styleConflicts(root, choice(null, ["material:tpl-a"], defaults("tpl-a"))), []);
    // An image supplies a palette only when it declares one.
    writeMaterialFixture(root, imageFixture("img-a", "品牌色.png", 800, 600));
    assert.deepEqual(styleConflicts(root, choice(null, ["material:tpl-a", "material:img-a"], defaults("tpl-a"))), []);
  });

  it("understands the openkimi alias of a material source id", (t) => {
    const root = project(t);
    template(root, "tpl-a", "甲模板.pptx");
    template(root, "tpl-b", "乙模板.pptx");
    const found = styleConflicts(
      root,
      choice(null, ["openkimi:material:tpl-a", "material:tpl-b"], defaults("tpl-a", "tpl-b")),
    );
    assert.equal(found[0]?.winner, "甲模板.pptx");
  });
});

describe("VAL-DATA-010: the delivery provenance", () => {
  it("writes the pack conflict into conflicts[] and the receipt summary, and no other entry", async (t) => {
    const root = project(t, {
      designSystemId: PACK,
      adoptedSourceIds: ["material:tpl-a"],
      designAspects: [{ source: "material:tpl-a", aspects: ["logo", "content"] }],
    });
    template(root, "tpl-a", "品牌模板.pptx");
    writeMaterialFixture(root, {
      id: "xlsx",
      name: "季度经营.xlsx",
      kind: "table",
      parser: "xlsx-ooxml-v1",
      originalBytes: Buffer.from("workbook"),
      derivative: {
        table: {
          sheetCount: 1,
          rowCount: 1,
          sheets: [
            {
              name: "表1",
              hidden: false,
              rowCount: 1,
              colCount: 2,
              headerRow: ["季度", "营收"],
              headerRowIndex: 1,
              columns: [],
              rows: [["Q1", 1234.5]],
            },
          ],
        },
      },
      parts: [{ part: "sheet:表1", label: "工作表「表1」", rows: 1, cols: 2 }],
    });
    const read = await runDomainHand("read_material", { materialId: "xlsx", __openSlideStudio: CONTEXT }, root);
    assert.equal(read.ok, true, read.detail);
    const built = buildDeliveryProvenance(root, sealed());
    assert.deepEqual(
      built.file.conflicts.map((entry) => entry.kind),
      ["style"],
    );
    assert.match(built.summary, /配色以风格『红黑增长』为准；附件『品牌模板\.pptx』用于 Logo \/ 内容/);
  });

  it("writes no conflict when the saved choice has none, and treats the freestyle marker as no pack", (t) => {
    const root = project(t, { designSystemId: "freestyle" });
    template(root, "tpl-a", "甲模板.pptx");
    const built = buildDeliveryProvenance(root, sealed());
    assert.deepEqual(built.file.conflicts, []);
  });
});
