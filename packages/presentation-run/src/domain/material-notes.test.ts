import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSlideFont } from "@open-slidestudio/pptd-v2";
import {
  FONT_CLASS_FONTS,
  MATERIAL_NOTE_USES,
  readMaterialNotes,
  recordMaterialNotesResult,
} from "./material-notes.js";
import {
  fakeJpeg,
  fixtureSha256,
  imageFixture,
  pngHeader,
  tempProject,
  writeMaterialFixture,
} from "./material-testkit.js";
import type { MaterialNotesFact } from "./material-view-facts.js";
import { ensureRunLedger, readRunLedger } from "./run-ledger.js";

const CONTEXT = { commandId: "notes-call", contextEpochId: "epoch-notes" };

function project() {
  const root = tempProject();
  writeMaterialFixture(root, imageFixture("img-a", "网点外观.jpg", 1200, 800));
  writeMaterialFixture(root, {
    id: "csv-a",
    name: "数据.csv",
    kind: "table",
    parser: "csv-v1",
    originalBytes: Buffer.from("a,b\n1,2"),
  });
  const page = fakeJpeg("pdf-page-2");
  writeMaterialFixture(root, {
    id: "pdf-a",
    name: "报告.pdf",
    kind: "document",
    parser: "pdf-unpdf-v4",
    originalBytes: Buffer.from("%PDF"),
    derivative: {
      document: {
        pageCount: 4,
        pages: [],
        renderedPages: [
          {
            index: 2,
            file: "page-2.jpg",
            sha256: fixtureSha256(page),
            px: { width: 960, height: 1360 },
          },
        ],
      },
    },
    pageImages: { pages: [2] },
    files: { "page-2.jpg": page },
  });
  const photo = pngHeader(800, 600);
  writeMaterialFixture(root, {
    id: "tpl-a",
    name: "模板.pptx",
    kind: "deck-template",
    parser: "pptx-ooxml-v2",
    originalBytes: Buffer.from("pptx"),
    derivative: { "deck-template": {} },
    media: [
      {
        mediaId: "template-tpl-a-0",
        role: "template-photo",
        variant: "original",
        file: "photos/p0.png",
        sha256: fixtureSha256(photo),
        mediaSrc: "media/template-tpl-a-0.png",
      },
    ],
    files: { "photos/p0.png": photo },
    projectFiles: { "media/template-tpl-a-0.png": photo },
  });
  ensureRunLedger(root, {
    manifestSha256: "e".repeat(64),
    requirementsId: "notes-test",
    requirements: [],
  });
  return root;
}

const NOTES = {
  caption: "柜台前的客户经理正在接待客户，画面明亮",
  suggestedUse: "page",
};

function notesFacts(root: string): MaterialNotesFact[] {
  return (readRunLedger(root)?.facts ?? []).filter(
    (fact): fact is MaterialNotesFact => fact.type === "material.notes-recorded",
  );
}

describe("VAL-IMG-005: record_material_notes", () => {
  it("records the caption, writes one ledger fact and returns the digest", () => {
    const root = project();
    const result = recordMaterialNotesResult(root, CONTEXT, {
      materialId: "img-a",
      ...NOTES,
      focus: [0.3, 0.4],
      layoutNotes: "主体居中，左右留白",
      mood: "明亮、专业",
      fontClass: "sans",
      readValues: [{ label: "排队人数", value: 12, unit: "人", period: "2026-10" }],
      reason: "适合放在现场检查页",
    });
    assert.equal(result.ok, true);
    const [fact] = notesFacts(root);
    assert.equal(notesFacts(root).length, 1);
    assert.equal(fact!.materialId, "img-a");
    assert.match(fact!.notesSha256, /^[a-f0-9]{64}$/);
    assert.equal(fact!.contextEpochId, CONTEXT.contextEpochId);
    assert.equal("mediaId" in fact! && fact!.mediaId !== undefined, false);
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.notesSha256, fact!.notesSha256);
    assert.deepEqual(payload.suggestedFonts, { ea: ["微软雅黑"], latin: ["Arial"] });
    const stored = readMaterialNotes(root);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.notes.caption, NOTES.caption);
    assert.deepEqual(stored[0]!.notes.readValues, [{ label: "排队人数", value: "12", unit: "人", period: "2026-10" }]);
  });

  it("replaces the stored notes for the same target and de-duplicates identical facts", () => {
    const root = project();
    const first = recordMaterialNotesResult(root, CONTEXT, { materialId: "img-a", ...NOTES });
    recordMaterialNotesResult(root, CONTEXT, { materialId: "img-a", ...NOTES });
    assert.equal(notesFacts(root).length, 1);
    const changed = recordMaterialNotesResult(root, CONTEXT, {
      materialId: "img-a",
      caption: "改成背景图使用",
      suggestedUse: "background",
    });
    assert.notEqual(
      (changed.payload as Record<string, unknown>).notesSha256,
      (first.payload as Record<string, unknown>).notesSha256,
    );
    assert.equal(notesFacts(root).length, 2);
    const stored = readMaterialNotes(root);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.notes.suggestedUse, "background");
  });

  it("records notes for a PDF page and a template photo with their own identity", () => {
    const root = project();
    recordMaterialNotesResult(root, CONTEXT, { materialId: "pdf-a", page: 2, ...NOTES });
    recordMaterialNotesResult(root, CONTEXT, {
      materialId: "tpl-a",
      mediaId: "template-tpl-a-0",
      caption: "模板里的办公室照片",
      suggestedUse: "style-reference",
    });
    const facts = notesFacts(root);
    assert.deepEqual(
      facts.map((fact) => [fact.materialId, fact.page, fact.mediaId]),
      [
        ["pdf-a", 2, undefined],
        ["tpl-a", undefined, "template-tpl-a-0"],
      ],
    );
    assert.equal(readMaterialNotes(root).length, 2);
  });

  it("rejects an invalid suggestedUse, a missing caption and an unknown fontClass in Chinese", () => {
    const root = project();
    assert.throws(
      () =>
        recordMaterialNotesResult(root, CONTEXT, {
          materialId: "img-a",
          caption: "x",
          suggestedUse: "banner",
        }),
      /suggestedUse 无效.*page.*background.*logo.*style-reference.*skip/,
    );
    assert.throws(
      () => recordMaterialNotesResult(root, CONTEXT, { materialId: "img-a", suggestedUse: "page" }),
      /caption/,
    );
    assert.throws(
      () =>
        recordMaterialNotesResult(root, CONTEXT, {
          materialId: "img-a",
          ...NOTES,
          fontClass: "宋体",
        }),
      /fontClass 无效.*sans.*serif.*kai.*mono/,
    );
    assert.throws(
      () =>
        recordMaterialNotesResult(root, CONTEXT, {
          materialId: "img-a",
          ...NOTES,
          focus: [2, 0.1],
        }),
      /focus/,
    );
    assert.equal(notesFacts(root).length, 0, "a rejected call records nothing");
  });

  it("rejects unknown materials and targets that cannot be viewed", () => {
    const root = project();
    assert.throws(() => recordMaterialNotesResult(root, CONTEXT, { materialId: "missing", ...NOTES }), /资料不存在/);
    assert.throws(
      () => recordMaterialNotesResult(root, CONTEXT, { materialId: "csv-a", ...NOTES }),
      /不是图片|无法记录/,
    );
    assert.throws(() => recordMaterialNotesResult(root, CONTEXT, { materialId: "pdf-a", ...NOTES }), /page/);
    assert.throws(
      () => recordMaterialNotesResult(root, CONTEXT, { materialId: "pdf-a", page: 3, ...NOTES }),
      /第 3 页没有页面图片/,
    );
    assert.throws(
      () =>
        recordMaterialNotesResult(root, CONTEXT, {
          materialId: "tpl-a",
          mediaId: "nope",
          ...NOTES,
        }),
      /模板照片不存在/,
    );
    assert.throws(() => recordMaterialNotesResult(root, CONTEXT, { materialId: "all-images", ...NOTES }), /逐张/);
    assert.equal(notesFacts(root).length, 0);
  });

  it("maps fontClass through the fixed table onto the slide font whitelist", () => {
    assert.deepEqual(Object.keys(FONT_CLASS_FONTS).sort(), ["kai", "mono", "sans", "serif"]);
    assert.deepEqual(FONT_CLASS_FONTS.sans, { ea: ["微软雅黑"], latin: ["Arial"] });
    assert.deepEqual(FONT_CLASS_FONTS.serif, {
      ea: ["宋体"],
      latin: ["Times New Roman", "Georgia"],
    });
    assert.deepEqual(FONT_CLASS_FONTS.kai, { ea: ["楷体"], latin: [] });
    assert.deepEqual(FONT_CLASS_FONTS.mono, { ea: [], latin: ["Courier New"] });
    for (const mapping of Object.values(FONT_CLASS_FONTS)) {
      for (const face of [...mapping.ea, ...mapping.latin]) {
        assert.equal(isSlideFont(face), true, `${face} must be a whitelisted slide font`);
      }
    }
    assert.deepEqual([...MATERIAL_NOTE_USES], ["page", "background", "logo", "style-reference", "skip"]);
  });
});
