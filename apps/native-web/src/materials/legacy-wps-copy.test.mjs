import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { detectType } from "./detect.mjs";
import { ingestAttachment } from "./intake.mjs";
import { wpsLegacyRefusal } from "./legacy-copy.mjs";
import { LEGACY_FIXTURES } from "./test-fixtures/legacy-office-fixtures.mjs";

const WPS_DOC = "这是 WPS 文字文件（.wps），暂不支持；请在 WPS 中“另存为” .docx 后再上传";
const WPS_SHEET = "这是 WPS 表格文件（.et），暂不支持；请在 WPS 中“另存为” .xlsx 后再上传";
const WPS_DECK = "这是 WPS 演示文件（.dps），暂不支持；请在 WPS 中“另存为” .pptx 后再上传";
const MS_WORD = "这是旧版 Word 文件（.doc），暂不支持；请在 Word 中“另存为” .docx 后再上传";
const MS_EXCEL = "这是旧版 Excel 文件（.xls），暂不支持；请在 Excel 中“另存为” .xlsx 后再上传";
const MS_PPT = "这是旧版 PPT 文件（.ppt），暂不支持；请在 PPT 中“另存为” .pptx 后再上传";
const MS_GENERIC = "这是旧版 Office 文件，暂不支持；请用对应软件“另存为”新格式（.docx / .xlsx / .pptx）后再上传";

/** @param {string} name */
const fixture = (name) => {
  const entry = LEGACY_FIXTURES[/** @type {keyof typeof LEGACY_FIXTURES} */ (name)];
  if (!entry) throw new Error(`no legacy fixture named ${name}`);
  return entry.build();
};

/** An OLE file whose directory cannot be read: only the signature survives. */
const signatureOnly = () => {
  const bytes = Buffer.alloc(2048);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes);
  return bytes;
};

/** @param {string} name @param {Uint8Array} bytes */
const refusal = (name, bytes) => {
  const result = detectType({ name, bytes });
  assert.equal(result.ok, false, name);
  return /** @type {{ok: false, code: string, message: string}} */ (result);
};

describe("the refusal copy names WPS files and keeps the save-as hint", () => {
  test("a WPS file is named by its WPS family, whatever it is uploaded as", () => {
    const cases = [
      ["legacy.wps", "legacy.wps", WPS_DOC],
      ["legacy.et", "legacy.et", WPS_SHEET],
      ["legacy.dps", "legacy.dps", WPS_DECK],
      // a private stream decides when the extension is wrong or missing
      ["legacy.wps", "legacy-as.docx", WPS_DOC],
      ["legacy.et", "report", WPS_SHEET],
      ["legacy.et", "budget.xlsx", WPS_SHEET],
      // the extension decides when the file has no private stream
      ["legacy.dps", "deck.dps", WPS_DECK],
    ];
    for (const [fixtureName, uploadName, message] of cases) {
      const result = refusal(String(uploadName), fixture(String(fixtureName)));
      assert.equal(result.code, "legacy-office-format", `${fixtureName} as ${uploadName}`);
      assert.equal(result.message, message, `${fixtureName} as ${uploadName}`);
    }
  });

  test("a WPS file saved under a Microsoft extension keeps that extension in the copy", () => {
    assert.equal(
      refusal("report.doc", fixture("legacy.wps")).message,
      "这是 WPS 文字文件（.doc），暂不支持；请在 WPS 中“另存为” .docx 后再上传",
    );
    assert.equal(
      refusal("budget.xls", fixture("legacy.et")).message,
      "这是 WPS 表格文件（.xls），暂不支持；请在 WPS 中“另存为” .xlsx 后再上传",
    );
    assert.equal(
      refusal("secure.doc", fixture("wps-secure.doc")).message,
      "这是 WPS 文字文件（.doc），暂不支持；请在 WPS 中“另存为” .docx 后再上传",
    );
    assert.equal(refusal("secure.xls", fixture("wps-secure.xls")).code, "legacy-office-format");
    assert.match(refusal("secure.xls", fixture("wps-secure.xls")).message, /^这是 WPS 表格文件/);
  });

  test("each WPS copy carries a save-as hint toward the open format", () => {
    for (const message of [WPS_DOC, WPS_SHEET, WPS_DECK]) {
      assert.match(message, /“另存为” \.(docx|xlsx|pptx) 后再上传$/);
    }
  });

  test("Microsoft legacy files keep the round-1 sentence", () => {
    assert.equal(refusal("legacy.doc", fixture("legacy-plain.doc")).message, MS_WORD);
    assert.equal(refusal("legacy.xls", fixture("legacy-plain.xls")).message, MS_EXCEL);
    assert.equal(refusal("legacy.ppt", fixture("legacy-plain.ppt")).message, MS_PPT);
    // encrypted and macro Office files are still legacy files until the intake gate reads them
    assert.equal(refusal("locked.doc", fixture("legacy-encrypted.doc")).message, MS_WORD);
    assert.equal(refusal("macro.xls", fixture("legacy-vba.xls")).message, MS_EXCEL);
    assert.equal(refusal("macro.ppt", fixture("legacy-macro.ppt")).message, MS_PPT);
    // a stream-less deck is Microsoft's unless its name says WPS
    assert.equal(refusal("deck.ppt", fixture("legacy.dps")).message, MS_PPT);
    assert.equal(refusal("deck.pptx", fixture("legacy.dps")).message, MS_PPT);
  });

  test("an OLE file with no readable directory is named by its extension alone", () => {
    assert.equal(refusal("slides.dps", signatureOnly()).message, WPS_DECK);
    assert.equal(refusal("sheet.et", signatureOnly()).message, WPS_SHEET);
    assert.equal(refusal("letter.wps", signatureOnly()).message, WPS_DOC);
    assert.equal(refusal("slides.ppt", signatureOnly()).message, MS_GENERIC);
    assert.equal(refusal("slides", signatureOnly()).message, MS_GENERIC);
  });

  test("a truncated WPS file is still a WPS refusal, not a crash", () => {
    const bytes = fixture("legacy.dps");
    const result = refusal("slides.dps", bytes.subarray(0, Math.floor(bytes.length / 2)));
    assert.equal(result.message, WPS_DECK);
  });

  test("an encrypted OOXML package stays encrypted whatever its extension", () => {
    const bytes = Buffer.alloc(4096);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes);
    Buffer.from("EncryptedPackage", "utf16le").copy(bytes, 1024);
    const result = refusal("locked.dps", bytes);
    assert.equal(result.code, "encrypted");
  });

  test("wpsLegacyRefusal is null for a Microsoft file and for anything unreadable that is not named WPS", () => {
    assert.equal(wpsLegacyRefusal(fixture("legacy-plain.doc"), ".doc"), null);
    assert.equal(wpsLegacyRefusal(fixture("legacy-plain.xls"), ".xls"), null);
    assert.equal(wpsLegacyRefusal(fixture("legacy-plain.ppt"), ".ppt"), null);
    assert.equal(wpsLegacyRefusal(signatureOnly(), ".doc"), null);
    assert.equal(wpsLegacyRefusal(signatureOnly(), ""), null);
  });

  test("an empty file named .dps is still the empty-file refusal, never a WPS one", () => {
    const result = refusal("slides.dps", new Uint8Array(0));
    assert.equal(result.code, "empty");
  });
});

/** @type {string} */
let scratch;
/** A refused legacy upload never reaches the parse pool. */
const pool = {
  /** @returns {Promise<never>} */
  run() {
    throw new Error("a legacy rejection must not reach the parse pool");
  },
};

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-legacy-wps-copy-"));
});

after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the stored record carries the WPS copy", () => {
  test("a WPS upload is an unsupported record with the legacy code, no kind and no summary", async () => {
    const store = new AttachmentStore(path.join(scratch, "ingest"));
    for (const [name, source, message] of [
      ["legacy.wps", "legacy.wps", WPS_DOC],
      ["legacy.et", "legacy.et", WPS_SHEET],
      ["legacy.dps", "legacy.dps", WPS_DECK],
      ["renamed.docx", "legacy.wps", WPS_DOC],
    ]) {
      const bytes = fixture(String(source));
      const { record, duplicateOf, uploadWarnings } = await ingestAttachment(
        { store, pool },
        { name: String(name), bytes },
      );
      const publicRecord = attachmentPublic(record, {
        duplicateOf,
        ...(uploadWarnings ? { warnings: uploadWarnings } : {}),
      });
      assert.equal(publicRecord.status, "unsupported", name);
      assert.equal(publicRecord.errorCode, "legacy-office-format", name);
      assert.equal(publicRecord.message, message, name);
      assert.equal(publicRecord.kind, null, name);
      assert.equal(publicRecord.summary, null, name);
      const stored = JSON.parse(fs.readFileSync(store.paths(record.meta.id).derivative, "utf8"));
      assert.equal(stored.kind, null, name);
    }
  });

  test("uploading the same WPS bytes again re-evaluates and answers the same copy", async () => {
    const store = new AttachmentStore(path.join(scratch, "repeat"));
    const bytes = fixture("legacy.et");
    const messages = [];
    const ids = [];
    for (let round = 0; round < 3; round += 1) {
      const { record } = await ingestAttachment({ store, pool }, { name: "legacy.et", bytes });
      messages.push(attachmentPublic(record, {}).message);
      ids.push(record.meta.id);
    }
    assert.deepEqual(messages, [WPS_SHEET, WPS_SHEET, WPS_SHEET]);
    assert.equal(new Set(ids).size, ids.length, "each refused upload keeps its own failure record");
  });
});
