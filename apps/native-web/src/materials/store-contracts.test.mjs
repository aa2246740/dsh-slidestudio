import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { attachmentsStoreDir, verifySessionMaterials, writeSessionMaterials } from "@open-slidestudio/slides-tools";
import { verifyMaterial } from "@open-slidestudio/presentation-run";
import {
  MATERIAL_MAX_LOGO_BYTES,
  MATERIAL_MAX_ORIGINAL_BYTES,
} from "@open-slidestudio/presentation-run/material-limits";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { MATERIAL_MAX_LOGO_BYTES as LOGO_CAP_USED } from "./logo-bytes.mjs";
import { DERIVATIVE_SCHEMA } from "./derivative.mjs";
import { contentWithPdf } from "./attachment-routes.mjs";
import { buildPptx } from "../testlib/pptx-fixture.mjs";
import { docxWithBody, textParagraph } from "./test-fixtures/docx-media.mjs";
import { buildXlsx } from "./test-fixtures/xlsx-build.mjs";
import { editorAttachmentOf, hostAcceptsTextReceipt, ingest, tempStore } from "./test-fixtures/material-harness.mjs";

const sha = (/** @type {import("node:crypto").BinaryLike} */ value) =>
  crypto.createHash("sha256").update(value).digest("hex");

test("(a)+(d) the store root is DATA_ROOT/output/attachments and the limits come from presentation-run", (t) => {
  const { dataRoot, store } = tempStore(t);
  assert.equal(store.root, attachmentsStoreDir(dataRoot));
  assert.equal(store.storeId, sha(attachmentsStoreDir(dataRoot)));
  assert.equal(LOGO_CAP_USED, MATERIAL_MAX_LOGO_BYTES);
  assert.ok(MATERIAL_MAX_ORIGINAL_BYTES > MATERIAL_MAX_LOGO_BYTES);
});

test("(b) a UTF-8 text upload through intake reads back as the host's utf8-full-v1 receipt", async (t) => {
  const { store } = tempStore(t);
  const text = "# 品牌语气\n标题必须是完整断言句\n😀 结尾\n";
  const { record } = await ingest(store, "brand.md", Buffer.from(text));
  const read = store.read(record.meta.id);
  assert.ok(read);
  const body = JSON.parse(JSON.stringify(contentWithPdf(store, read, undefined)));
  assert.equal(hostAcceptsTextReceipt(record.meta.id, body, sha), true, JSON.stringify(body));
  assert.equal(body.text, text);
  assert.equal(body.storeId, sha(store.root));
  assert.equal(body.materialParser, "text-utf8-v1");
  assert.equal("ownerId" in body, false);
  const meta = JSON.parse(fs.readFileSync(store.paths(record.meta.id).metadata, "utf8"));
  assert.equal(meta.ownerId, undefined);
  assert.equal(meta.parser, "utf8-full-v1");
});

test("(b) the synchronous store() keeps its record shape and also carries a derivative", (t) => {
  const { store } = tempStore(t);
  const stored = store.store("rows.csv", Buffer.from("地区,金额\n华东,12\n"));
  assert.equal(stored.parser, "utf8-full-v1");
  assert.equal(stored.complete, true);
  // store() always sets the record id alongside its text receipt.
  const storedId = /** @type {string} */ (stored.id);
  assert.equal(stored.meta.derivativeSha256, sha(fs.readFileSync(store.paths(storedId).derivative)));
  assert.equal(stored.derivative.schema, DERIVATIVE_SCHEMA);
  const publicRecord = attachmentPublic(stored);
  assert.equal(publicRecord.parsed, true);
  assert.equal(publicRecord.chars, stored.chars);
  assert.equal("text" in publicRecord, false);
  assert.equal(hostAcceptsTextReceipt(storedId, JSON.parse(JSON.stringify(store.read(storedId))), sha), true);
});

test("(b) a record written before derivatives existed still reads as its text receipt", (t) => {
  const { store } = tempStore(t);
  const id = `${crypto.randomUUID()}-old.txt`;
  const bytes = Buffer.from("旧版资料");
  fs.mkdirSync(store.root, { recursive: true });
  fs.writeFileSync(store.paths(id).original, bytes);
  const meta = { id, name: "old.txt", bytes: bytes.length, storeId: store.storeId, parsed: true, complete: true };
  const receipt = { parser: "utf8-full-v1", chars: 4, originalSha256: sha(bytes), textSha256: sha("旧版资料") };
  fs.writeFileSync(store.paths(id).metadata, JSON.stringify({ ...meta, ...receipt }));
  const read = store.read(id);
  assert.equal(read?.text, "旧版资料");
  assert.equal(read?.derivative.kind, "text");
  assert.equal(
    hostAcceptsTextReceipt(id, JSON.parse(JSON.stringify(contentWithPdf(store, read, undefined))), sha),
    true,
  );
});

/** @type {[string, () => Buffer, string, string][]} */
const BINARY = [
  ["deck.pptx", () => buildPptx(), "deck-template", "pptx-ooxml-v2"],
  [
    "report.docx",
    () => docxWithBody(textParagraph("季度复盘正文") + textParagraph("第二段"), []),
    "document",
    "docx-ooxml-v1",
  ],
  [
    "book.xlsx",
    () =>
      buildXlsx([
        {
          name: "Sheet1",
          rows: [
            [
              { ref: "A1", text: "地区" },
              { ref: "B1", text: "金额" },
            ],
            [
              { ref: "A2", text: "华东" },
              { ref: "B2", v: "12" },
            ],
          ],
        },
      ]),
    "table",
    "xlsx-ooxml-v1",
  ],
];

for (const [name, build, kind, parser] of BINARY) {
  test(`(c) ${name} intake → verifySessionMaterials → project materialization verifies`, async (t) => {
    const { dataRoot, store } = tempStore(t);
    const { record } = await ingest(store, name, build());
    assert.equal(record.derivative.status, "ok", record.derivative.message);
    assert.equal(record.derivative.kind, kind);
    assert.equal(record.meta.parserId, parser);
    assert.equal(record.meta.parser, undefined, "binary materials carry no text receipt");
    const attachment = editorAttachmentOf(record);
    const [prepared] = verifySessionMaterials(dataRoot, [attachment]);
    assert.ok(prepared);
    assert.equal(prepared.attachment.id, record.meta.id);
    const project = path.join(dataRoot, "project");
    const [materialized] = writeSessionMaterials(project, [prepared]);
    assert.equal(materialized?.id, record.meta.id);
    assert.equal(verifyMaterial(project, record.meta.id).parser, parser);
  });
}

test("(c) a tampered derivative or original fails the materials receipt check", async (t) => {
  const { dataRoot, store } = tempStore(t);
  const { record } = await ingest(store, "deck.pptx", buildPptx());
  const attachment = editorAttachmentOf(record);
  const files = store.paths(record.meta.id);
  const derivative = fs.readFileSync(files.derivative);
  fs.writeFileSync(files.derivative, Buffer.concat([derivative, Buffer.from(" ")]));
  assert.throws(() => verifySessionMaterials(dataRoot, [attachment]), /解析结果已变化/);
  assert.throws(() => store.read(record.meta.id), /解析结果已变化/);
  fs.writeFileSync(files.derivative, derivative);
  fs.appendFileSync(files.original, "x");
  assert.throws(() => verifySessionMaterials(dataRoot, [attachment]), /原文件已变化/);
});

test("identical bytes dedupe to one record and survive a store restart", async (t) => {
  const { store } = tempStore(t);
  const bytes = buildPptx();
  const first = await ingest(store, "a.pptx", bytes);
  const second = await ingest(store, "b.pptx", bytes);
  assert.equal(second.duplicateOf, first.record.meta.id);
  const reopened = new AttachmentStore(store.root);
  const third = await ingest(reopened, "c.pptx", bytes);
  assert.equal(third.record.meta.id, first.record.meta.id);
  const receipts = fs.readdirSync(store.root).filter((entry) => entry.endsWith(".meta.json"));
  assert.deepEqual(receipts, [`${first.record.meta.id}.meta.json`]);
});

test("rejected outcomes are stored as records with a Chinese reason and delete removes every sidecar", async (t) => {
  const { store } = tempStore(t);
  const { record } = await ingest(store, "notes.exe", Buffer.from([0x4d, 0x5a, 0, 1, 2, 3]));
  const publicRecord = attachmentPublic(record);
  assert.equal(publicRecord.status, "unsupported");
  assert.equal(publicRecord.errorCode, "unsupported-type");
  assert.match(String(publicRecord.message), /暂不支持/);
  assert.equal(store.delete(record.meta.id), true);
  assert.deepEqual(fs.readdirSync(store.root), []);
  assert.equal(store.read(record.meta.id), undefined);
});

test("a record carrying an owner or a foreign store id fails closed", async (t) => {
  const { store } = tempStore(t);
  const { record } = await ingest(store, "deck.pptx", buildPptx());
  const file = store.paths(record.meta.id).metadata;
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...meta, ownerId: "browser-a" }));
  assert.throws(() => store.read(record.meta.id), /owner/);
  fs.writeFileSync(file, JSON.stringify({ ...meta, storeId: "0".repeat(64) }));
  assert.throws(() => store.read(record.meta.id), /不属于当前上传存储/);
});
