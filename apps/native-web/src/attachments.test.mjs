import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AttachmentStore,
  ATTACHMENT_TEXT_LIMIT,
  parseAttachmentBuffer,
  decodeAttachmentUpload,
} from "./attachments.mjs";

const sha = (/** @type {Buffer<ArrayBufferLike> | crypto.BinaryLike} */ bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * A record written or read through the text-receipt route: these tests only
 * store complete UTF-8 text, so the receipt fields are always present.
 * @typedef {import("./attachments.mjs").ReadRecord & import("./materials/text-receipt.mjs").TextReceiptRecord} TextRecord
 */

/** @param {AttachmentStore} store @param {string} name @param {Uint8Array} bytes */
const storeText = (store, name, bytes) => /** @type {TextRecord} */ (store.store(name, bytes));
/** @param {AttachmentStore} store @param {string} id */
const readText = (store, id) => /** @type {TextRecord} */ (store.read(id));

/** @param {import("node:test").TestContext} t */
function setup(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oss-attachments-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { temporary, store: new AttachmentStore(path.join(temporary, "uploads")) };
}

test("real project documentation retains complete bytes and verified provenance across store restarts", (t) => {
  const { store } = setup(t);
  const original = fs.readFileSync(new URL("../../../CONTEXT.md", import.meta.url));
  const decoded = decodeAttachmentUpload(`data:text/markdown;base64,${original.toString("base64")}`);
  assert.deepEqual(decoded, original);
  const record = storeText(store, "CONTEXT.md", decoded);
  const reread = readText(new AttachmentStore(store.root), record.id);
  assert.equal(reread.originalSha256, sha(original));
  assert.equal(reread.text, new TextDecoder().decode(original));
  assert.equal(reread.textSha256, sha(reread.text));
  assert.equal(reread.complete, true);
  assert.equal(reread.storeId, store.storeId);
});

test("regression: CSV rows and blank lines after the former 30-row boundary are not dropped", () => {
  const text = `${Array.from({ length: 64 }, (_, index) => `row-${index},${index}`).join("\r\n")}\r\n\r\nlast,retained\r\n`;
  const parsed = /** @type {import("./materials/text-receipt.mjs").TextReceipt} */ (
    parseAttachmentBuffer("boundary.csv", Buffer.from(text))
  );
  assert.equal(parsed.text, text);
  assert.equal(parsed.originalSha256, sha(Buffer.from(text)));
});

test("regression: unsupported, invalid UTF-8 and over-limit inputs leave no accepted files", (t) => {
  const { store } = setup(t);
  for (const [name, bytes] of /** @type {[string, Buffer][]} */ ([
    ["too-long.md", Buffer.from("x".repeat(ATTACHMENT_TEXT_LIMIT + 1))],
    ["bad.txt", Buffer.from([0xc3, 0x28])],
    ["unparsed.pdf", Buffer.from("not a parsed PDF")],
    ["empty.md", Buffer.from(" \n")],
  ]))
    assert.throws(() => store.store(name, bytes));
  assert.equal(fs.existsSync(store.root), false);
});

test("changed original bytes cannot reuse an earlier parsing receipt", (t) => {
  const { store } = setup(t);
  const record = storeText(store, "input.txt", Buffer.from("accepted input"));
  fs.writeFileSync(store.paths(record.id).original, "changed input");
  assert.throws(() => store.read(record.id), /原文件已变化/);
});

test("foreign ownership and invalid completion receipts fail closed", (t) => {
  const { store } = setup(t);
  for (const patch of [{ storeId: "foreign" }, { ownerId: "unverified" }, { complete: false }]) {
    const record = storeText(store, "input.txt", Buffer.from("reference"));
    const files = store.paths(record.id);
    const metadata = JSON.parse(fs.readFileSync(files.metadata, "utf8"));
    fs.writeFileSync(files.metadata, JSON.stringify({ ...metadata, ...patch }));
    assert.throws(() => store.read(record.id));
  }
});

test("paths, missing IDs and symlinks cannot stand in for uploaded regular files", (t) => {
  const { temporary, store } = setup(t);
  for (const id of ["../outside", "..\\outside", "arbitrary-path", ""]) assert.throws(() => store.read(id));
  const record = storeText(store, "input.txt", Buffer.from("reference"));
  const original = store.paths(record.id).original;
  const outside = path.join(temporary, "outside.txt");
  fs.writeFileSync(outside, "reference");
  fs.unlinkSync(original);
  fs.symlinkSync(outside, original);
  assert.throws(() => store.read(record.id), /符号链接/);
});

test("malformed base64 is rejected instead of silently losing upload bytes", () => {
  for (const data of ["Y!Q==", "YR==", "data:text/plain,YQ==", "YQ=", "YQ==trailing"]) {
    assert.throws(() => decodeAttachmentUpload(data));
  }
});

test("long Chinese filenames preserve the displayed name without exceeding filesystem byte limits", (t) => {
  const { store } = setup(t);
  const name = `${"资料".repeat(36)}.md`;
  const record = storeText(store, name, Buffer.from("完整正文"));
  assert.ok(Buffer.byteLength(`${record.id}.meta.json`) < 255);
  assert.equal(readText(store, record.id).name, name);
  assert.equal(readText(store, record.id).text, "完整正文");
});
