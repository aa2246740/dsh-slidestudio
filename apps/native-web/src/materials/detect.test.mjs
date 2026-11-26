import assert from "node:assert/strict";
import { zipSync, strToU8, deflateSync } from "fflate";
import { test } from "node:test";
import { detectType, looksBinary } from "./detect.mjs";

const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Minimal OOXML-ish zip with an explicit [Content_Types].xml.
 * @param {{parts: Record<string, Uint8Array>, contentTypes: string, extraParts?: Record<string, Uint8Array>}} input
 */
function ooxmlZip({ parts, contentTypes, extraParts = {} }) {
  const ct = `[Content_Types].xml`;
  const files = { [ct]: strToU8(contentTypes), ...parts, ...extraParts };
  return zipSync(files);
}

const docxContentTypes =
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

test("image and PDF signatures win over extensions", () => {
  const detect = (/** @type {string} */ name, /** @type {Buffer<ArrayBuffer>} */ bytes) =>
    detectType({ name, bytes, declaredMime: undefined });
  assert.equal(detect("photo.pdf", pngMagic).ok, true);
  const pdf = detect("notes-pdf.txt", Buffer.from("%PDF-1.4 fake text"));
  assert.equal(pdf.ok, true);
  if (pdf.ok) assert.equal(pdf.kind, "document");
});

test("a PNG renamed .pdf detects as image with a Chinese mismatch warning", () => {
  const result = detectType({ name: "photo.pdf", bytes: pngMagic, declaredMime: undefined });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "image");
    assert.equal(result.extensionMismatch, true);
    assert.match(result.warnings[0]?.message ?? "", /扩展名.*实际内容/);
  }
});

test("a PNG with a lying text/plain MIME is still an image", () => {
  const result = detectType({
    name: "sample.png",
    bytes: pngMagic,
    declaredMime: "text/plain",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.kind, "image");
});

test("xlsx content is detected through [Content_Types].xml regardless of name", () => {
  const workbook = ooxmlZip({
    parts: { "xl/workbook.xml": strToU8("<workbook/>") },
    contentTypes:
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  });
  const result = detectType({ name: "report-xlsx.docx", bytes: workbook, declaredMime: undefined });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "table");
    assert.equal(result.parserId, "xlsx-ooxml-v1");
    assert.equal(result.extensionMismatch, true);
  }
});

test("vbaProject.bin inside a .xlsx is macro-enabled", () => {
  const sneaky = zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ),
    "xl/workbook.xml": strToU8("<workbook/>"),
    "xl/vbaProject.bin": Buffer.from([0x01, 0x02]),
  });
  const result = detectType({ name: "sneaky.xlsx", bytes: sneaky, declaredMime: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "macro-enabled");
});

test("macroEnabled content type is rejected without inflating parts", () => {
  const macro = ooxmlZip({
    parts: { "word/document.xml": strToU8("<doc/>") },
    contentTypes:
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>` +
      `</Types>`,
  });
  const result = detectType({ name: "macro.docm", bytes: macro, declaredMime: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "macro-enabled");
});

test("OLE2 unencrypted bytes are legacy-office-format with a save-as hint", () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  const wordDocEntry = Buffer.from("W\0o\0r\0d\0D\0o\0c\0u\0m\0e\0n\0t\0\0", "utf8");
  ole.set(wordDocEntry, 200);
  const result = detectType({ name: "legacy.docx", bytes: ole, declaredMime: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "legacy-office-format");
    assert.match(result.message, /另存为.*\.docx/);
    assert.match(result.message, /旧版 Word/);
  }
});

test("OLE2 with EncryptedPackage is encrypted, not legacy", () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  ole.set(Buffer.from("E\0n\0c\0r\0y\0p\0t\0e\0d\0P\0a\0c\0k\0a\0g\0e\0\0", "utf8"), 200);
  const result = detectType({ name: "secret.xlsx", bytes: ole, declaredMime: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "encrypted");
    assert.doesNotMatch(result.message ?? "", /旧版/);
  }
});

test("plain zip and random bytes are unsupported-type", () => {
  /** @type {[string, Uint8Array][]} */
  const cases = [
    ["archive.zip", zipSync({ "a.txt": strToU8("hi") })],
    ["random.bin", Buffer.from([0x01, 0x02, 0x03, 0xfe, 0xff, 0x00])],
  ];
  for (const [name, bytes] of cases) {
    const result = detectType({ name, bytes, declaredMime: undefined });
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.equal(result.code, "unsupported-type", name);
      assert.match(result.message ?? "", /暂不支持/);
    }
  }
});

test("an SVG body under a .txt name is never treated as text", () => {
  const result = detectType({
    name: "looks-like.txt",
    bytes: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>`),
    declaredMime: undefined,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "image");
    assert.equal(result.parserId, "svg-raster-v1");
  }
});

test("empty files are rejected as empty", () => {
  const result = detectType({
    name: "empty.txt",
    bytes: new Uint8Array(0),
    declaredMime: undefined,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "empty");
});

test("text kinds dispatch by extension: csv/tsv → csv-v1, others → text-utf8-v1", () => {
  for (const [name, parserId, kind] of [
    ["a.csv", "csv-v1", "table"],
    ["a.tsv", "csv-v1", "table"],
    ["a.txt", "text-utf8-v1", "text"],
    ["a.md", "text-utf8-v1", "text"],
    ["a.json", "text-utf8-v1", "text"],
  ]) {
    const result = detectType({ name, bytes: Buffer.from("内容,数据"), declaredMime: undefined });
    assert.equal(result.ok, true, name);
    if (result.ok) {
      assert.equal(result.parserId, parserId, name);
      assert.equal(result.kind, kind, name);
    }
  }
});

test("looksBinary: NUL and control-heavy content are not text", () => {
  assert.equal(looksBinary(Buffer.from([0x68, 0x00, 0x69])), true);
  assert.equal(looksBinary(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1])), true);
  assert.equal(looksBinary(Buffer.from("正常的文本内容，没有二进制字节")), false);
});

test("corrupt zip (truncated) reports corrupt, not a crash", () => {
  const archive = zipSync({
    "word/document.xml": strToU8("<doc/>"),
    "[Content_Types].xml": strToU8(docxContentTypes),
  });
  const result = detectType({
    name: "truncated.pptx",
    bytes: archive.subarray(0, Math.floor(archive.length / 2)),
    declaredMime: undefined,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "corrupt");
});

test("a zip bomb declared in the central directory is archive-limit", () => {
  // Declared 1 GB entry, compressed tiny.
  const name = Buffer.from("sheet.xml");
  const payload = deflateSync(Buffer.alloc(2048));
  const local = Buffer.alloc(30 + name.length + payload.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(1024 * 1024 * 1024, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  local.set(payload, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(1024 * 1024 * 1024, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  const result = detectType({
    name: "bomb-ratio.xlsx",
    bytes: Buffer.concat([local, central, eocd]),
    declaredMime: undefined,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "archive-limit");
});

test("a [Content_Types].xml that under-declares its size is archive-limit", () => {
  // The detection thread reads this entry before the parse worker exists, so
  // its inflate output must stay bounded even when the directory lies. The
  // regression measure is arrayBuffers/external/RSS: heapUsed never counted
  // the fflate output buffer, which is why the bug stayed green before.
  const contentTypes = deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x61));
  const archive = lyingEntryZip({
    name: "[Content_Types].xml",
    declaredUncompressed: 32,
    declaredCompressed: contentTypes.length,
    payload: contentTypes,
  });
  const before = process.memoryUsage();
  const result = detectType({ name: "lying.xlsx", bytes: archive, declaredMime: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "archive-limit");
  const after = process.memoryUsage();
  const budget = 4 * 1024 * 1024;
  assert.ok(
    after.arrayBuffers - before.arrayBuffers < budget,
    `arrayBuffers grew by ${after.arrayBuffers - before.arrayBuffers} bytes`,
  );
  assert.ok(after.external - before.external < budget, `external grew by ${after.external - before.external} bytes`);
  assert.ok(after.rss - before.rss < budget, `rss grew by ${after.rss - before.rss} bytes`);
});

/**
 * Hand-write a single-entry zip whose headers declare arbitrary sizes.
 * @param {{name: string, declaredUncompressed: number, declaredCompressed: number, payload: Uint8Array}} entry
 */
function lyingEntryZip({ name, declaredUncompressed, declaredCompressed, payload }) {
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30 + nameBytes.length + payload.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(declaredCompressed, 18);
  local.writeUInt32LE(declaredUncompressed, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  local.set(payload, 30 + nameBytes.length);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(declaredCompressed, 20);
  central.writeUInt32LE(declaredUncompressed, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}
