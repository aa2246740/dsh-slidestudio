import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { test } from "node:test";
import {
  DEFAULT_FILE_BYTES,
  LARGE_DOCUMENT_BYTES,
  MAX_UPLOAD_BYTES,
  TOO_LARGE_FOR_TYPE_MESSAGE,
  UPLOAD_CAP_MESSAGE,
  uploadSizeVerdict,
} from "./size-limits.mjs";

const MIB = 1024 * 1024;
const OOXML_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>';

/**
 * A structurally valid PPTX whose stored filler pushes it past `bytes`.
 * @param {number} bytes
 */
function pptxOfSize(bytes, contentTypes = OOXML_TYPES) {
  const filler = new Uint8Array(bytes);
  return Buffer.from(
    zipSync(
      {
        "[Content_Types].xml": strToU8(contentTypes),
        "ppt/presentation.xml": strToU8("<p:presentation/>"),
        "ppt/media/filler.bin": [filler, { level: 0 }],
      },
      { mtime: new Date(Date.UTC(2026, 0, 1)) },
    ),
  );
}

/**
 * @param {number} bytes
 */
function pdfOfSize(bytes) {
  const out = Buffer.alloc(bytes, 0x20);
  out.write("%PDF-1.4\n");
  return out;
}

test("the limits are 20 MiB for everything, 50 MiB for decks and PDFs, and the body cap is 50 MiB", () => {
  assert.equal(DEFAULT_FILE_BYTES, 20 * MIB);
  assert.equal(LARGE_DOCUMENT_BYTES, 50 * MIB);
  assert.equal(MAX_UPLOAD_BYTES, 50 * MIB);
  assert.match(UPLOAD_CAP_MESSAGE, /文件超过 50MB 上限/);
  assert.match(TOO_LARGE_FOR_TYPE_MESSAGE, /图片等文件不能超过 20MB/);
  assert.match(TOO_LARGE_FOR_TYPE_MESSAGE, /PPT 和 PDF 不能超过 50MB/);
});

test("a file up to 20 MiB is never inspected for its type", () => {
  const verdict = uploadSizeVerdict("any.bin", Buffer.alloc(20 * MIB));
  assert.deepEqual(verdict, { ok: true });
});

test("nothing above 50 MiB passes, whatever it is", () => {
  const verdict = uploadSizeVerdict("deck.pptx", pdfOfSize(50 * MIB + 1));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.message, UPLOAD_CAP_MESSAGE);
});

test("a PPTX or PDF between 20 and 50 MiB passes", () => {
  assert.deepEqual(uploadSizeVerdict("deck.pptx", pptxOfSize(25 * MIB)), { ok: true });
  assert.deepEqual(uploadSizeVerdict("report.pdf", pdfOfSize(30 * MIB)), { ok: true });
  assert.deepEqual(uploadSizeVerdict("deck.pptx", pptxOfSize(49 * MIB)), { ok: true });
});

test("a .potx template shares the 50 MiB deck limit", () => {
  const potx = pptxOfSize(22 * MIB, OOXML_TYPES.replace("presentation.main+xml", "template.main+xml"));
  assert.deepEqual(uploadSizeVerdict("tpl.potx", potx), { ok: true });
});

test("content decides the limit: a PDF renamed .png gets the PDF limit", () => {
  assert.deepEqual(uploadSizeVerdict("renamed.png", pdfOfSize(25 * MIB)), { ok: true });
});

test("a valid image above 20 MiB gets the two-limit message", () => {
  const png = Buffer.alloc(21 * MIB);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  const verdict = uploadSizeVerdict("over-20m.png", png);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.message, TOO_LARGE_FOR_TYPE_MESSAGE);
});

test("unknown bytes above 20 MiB are refused with the two-limit message", () => {
  const verdict = uploadSizeVerdict("over-limit.bin", Buffer.alloc(20 * MIB + 1));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.message, TOO_LARGE_FOR_TYPE_MESSAGE);
});

test("legacy Office files keep the 20 MiB limit", () => {
  const ole = Buffer.alloc(21 * MIB);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole);
  const verdict = uploadSizeVerdict("legacy.ppt", ole);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.message, TOO_LARGE_FOR_TYPE_MESSAGE);
});

test("a DOCX or XLSX above 20 MiB is refused", () => {
  const docx = Buffer.from(
    zipSync(
      {
        "[Content_Types].xml": strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        "word/document.xml": strToU8("<w:document/>"),
        "word/media/filler.bin": [new Uint8Array(21 * MIB), { level: 0 }],
      },
      { mtime: new Date(Date.UTC(2026, 0, 1)) },
    ),
  );
  const verdict = uploadSizeVerdict("big.docx", docx);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.message, TOO_LARGE_FOR_TYPE_MESSAGE);
});
