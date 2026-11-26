import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  LEGACY_FIXTURES,
  SHEET_TYPE,
  container,
  excelItems,
  pptItems,
  seededBytes,
  wordItems,
} from "./test-fixtures/legacy-office-fixtures.mjs";
import { classifyLegacyOffice, legacyVendorOf, openCfb } from "./cfb.mjs";
import { sha256, timed, extensionOf, fixture, shape, build } from "./test-fixtures/cfb-test-kit.mjs";

/** @typedef {import("./cfb.mjs").CfbStream} CfbStream */
/** @typedef {import("./test-fixtures/legacy-office-fixtures.mjs").PowerPointOptions} PowerPointOptions */

describe("the CFB reader on the test writer's output", () => {
  test("streams of every size around the mini-stream cutoff read back byte for byte", () => {
    const items = [1, 63, 64, 4095, 4096, 4097, 70_000].map((size) => ({
      path: `S${size}`,
      data: seededBytes(size, size),
    }));
    const cfb = timed("roundtrip", () => openCfb(build(items).bytes));
    for (const { path, data } of items) {
      const stream = /** @type {CfbStream} */ (cfb.stream(path));
      assert.equal(stream.size, data.length, path);
      assert.ok(Buffer.from(stream.read(0, data.length)).equals(data), `${path} whole`);
      const middle = Math.floor(data.length / 2);
      const tail = Math.min(37, data.length - middle);
      assert.ok(Buffer.from(stream.read(middle, tail)).equals(data.subarray(middle, middle + tail)), `${path} slice`);
    }
  });

  test("4096-byte sectors (version 4) read back the same way", () => {
    const items = [
      { path: "Small", data: seededBytes(300, 1) },
      { path: "Large", data: seededBytes(20_000, 2) },
    ];
    const bytes = build(items, 4).bytes;
    assert.equal(bytes.length % 4096, 0);
    const cfb = openCfb(bytes);
    for (const { path, data } of items) {
      assert.ok(Buffer.from(/** @type {CfbStream} */ (cfb.stream(path)).read(0, data.length)).equals(data), path);
    }
  });

  test("storages nest, names compare without case, and every path is listed", () => {
    const cfb = openCfb(
      build([
        { path: "Macros" },
        { path: "Macros/VBA" },
        { path: "Macros/VBA/_VBA_PROJECT", data: seededBytes(10, 3) },
        { path: "WordDocument", data: seededBytes(100, 4) },
      ]).bytes,
    );
    assert.deepEqual(cfb.entries.map((entry) => entry.path).sort(), [
      "Macros",
      "Macros/VBA",
      "Macros/VBA/_VBA_PROJECT",
      "WordDocument",
    ]);
    assert.ok(cfb.has("macros/vba/_vba_project"));
    assert.ok(cfb.has("WORDDOCUMENT"));
    assert.equal(cfb.has("Macros/WordDocument"), false);
    assert.equal(cfb.stream("Macros"), undefined, "a storage is not a stream");
  });

  test("a file that needs DIFAT sectors reads back (more than 109 FAT sectors)", () => {
    const data = seededBytes(8 * 1024 * 1024, 9);
    const { bytes, layout } = build([{ path: "Big", data }]);
    assert.ok(layout.difatSectors.length > 0, "the writer produced a DIFAT chain");
    const cfb = timed("DIFAT file", () => openCfb(bytes));
    assert.equal(sha256(/** @type {CfbStream} */ (cfb.stream("Big")).read(0, data.length)), sha256(data));
  });

  test("a read outside a stream throws a CfbError instead of returning short data", () => {
    const stream = /** @type {CfbStream} */ (
      openCfb(build([{ path: "S", data: seededBytes(100, 5) }]).bytes).stream("S")
    );
    assert.throws(() => stream.read(90, 20), { name: "CfbError", code: "bad-stream" });
    assert.throws(() => stream.read(-1, 4), { name: "CfbError", code: "bad-stream" });
  });

  test("openCfb throws a CfbError with a code, never a bare RangeError", () => {
    assert.throws(() => openCfb(Buffer.alloc(10)), { name: "CfbError", code: "not-cfb" });
  });
});

describe("classification of the synthetic legacy fixtures", () => {
  for (const [name, { build: make, expect, declares }] of Object.entries(LEGACY_FIXTURES)) {
    test(`${name}: ${declares}`, () => {
      const bytes = make();
      const result = timed(name, () => classifyLegacyOffice(bytes, extensionOf(name)));
      assert.deepEqual(shape(result), expect);
      assert.equal(result.ok ? result.reason : typeof result.reason, result.ok ? null : "string");
    });
  }

  test("the fixture builds are byte-identical on every run", () => {
    for (const [name, { build: make }] of Object.entries(LEGACY_FIXTURES)) {
      assert.ok(make().equals(make()), name);
    }
  });

  test("an encrypted FIB stays encrypted when the file also has a Macros storage", () => {
    const bytes = container(wordItems({ encrypted: true, macros: true }));
    assert.deepEqual(shape(timed("enc+macro", () => classifyLegacyOffice(bytes, ".doc"))), {
      ...fixture("legacy-encrypted.doc").expect,
      macro: true,
    });
  });

  test("an Excel 5 'Book' stream with FILEPASS is encrypted", () => {
    const bytes = container(excelItems({ book: true, filepass: true }));
    assert.deepEqual(shape(classifyLegacyOffice(bytes, ".xls")), fixture("legacy-filepass.xls").expect);
  });

  test("XLM and VBA-module sheets are macros, a chart sheet is not", () => {
    const macro = (/** @type {number[]} */ types) =>
      classifyLegacyOffice(container(excelItems({ sheets: types })), ".xls").macro;
    assert.equal(macro([SHEET_TYPE.worksheet, SHEET_TYPE.macro]), true);
    assert.equal(macro([SHEET_TYPE.worksheet, SHEET_TYPE.vba]), true);
    assert.equal(macro([SHEET_TYPE.worksheet, SHEET_TYPE.chart]), false);
    assert.equal(macro([SHEET_TYPE.worksheet, SHEET_TYPE.worksheet]), false);
  });

  test("a PowerPoint VbaInfo without macros is not a macro, with fHasMacros=1 it is", () => {
    const ppt = (
      /** @type {import("./test-fixtures/legacy-office-fixtures.mjs").PowerPointOptions | undefined} */ options,
    ) => classifyLegacyOffice(container(pptItems(options)), ".ppt");
    assert.equal(ppt({ vba: "empty" }).macro, false);
    assert.equal(ppt({ vba: "macros" }).macro, true);
    assert.equal(ppt({ vba: "macros", userEditLength: 0x20 }).macro, false, "an encrypted deck is never walked");
    assert.equal(ppt({ vba: "macros", userEditLength: 0x20 }).encrypted, true);
  });

  test("guard: a VbaInfo placed directly under the document (no DocInfoList) is still a macro", () => {
    // MS-PPT §2.4.4 nests VbaInfo inside the RT_List DocInfoListContainer; the
    // reader also accepts the direct placement so a wrong writer cannot hide
    // macros from the precheck.
    const ppt = (
      /** @type {import("./test-fixtures/legacy-office-fixtures.mjs").PowerPointOptions | undefined} */ options,
    ) => timed("direct vba", () => classifyLegacyOffice(container(pptItems(options)), ".ppt"));
    assert.equal(ppt({ vba: "macros", vbaPlacement: "document" }).macro, true);
    assert.equal(ppt({ vba: "empty", vbaPlacement: "document" }).macro, false);
  });

  test("the document container is found through an older edit session", () => {
    const ppt = (/** @type {PowerPointOptions["vba"]} */ vba) =>
      classifyLegacyOffice(container(pptItems({ vba, incremental: true })), ".ppt");
    assert.deepEqual(shape(ppt("macros")), fixture("legacy-macro.ppt").expect);
    assert.deepEqual(shape(ppt("none")), fixture("legacy-plain.ppt").expect);
  });

  test("the Current User token of an encrypted file marks the deck encrypted", () => {
    const result = classifyLegacyOffice(container(pptItems({ token: "encrypted" })), ".ppt");
    assert.equal(result.ok, true);
    assert.equal(result.encrypted, true);
  });

  test("an OOXML encryption container (EncryptedPackage) is encrypted with no Office family", () => {
    const bytes = container([
      { path: "EncryptionInfo", data: seededBytes(64, 7) },
      { path: "EncryptedPackage", data: seededBytes(5000, 8) },
    ]);
    assert.deepEqual(shape(classifyLegacyOffice(bytes, ".docx")), {
      ok: true,
      family: null,
      vendor: "ms",
      encrypted: true,
      macro: false,
      wpsSecure: false,
    });
  });
});

describe("WPS vendor and secure documents", () => {
  const word = container(wordItems());
  const sheet = container(excelItems());
  const deck = container(pptItems());

  test("the WPS extensions decide the vendor, a Microsoft extension does not", () => {
    assert.equal(classifyLegacyOffice(word, ".wps").vendor, "wps");
    assert.equal(classifyLegacyOffice(sheet, ".et").vendor, "wps");
    assert.equal(classifyLegacyOffice(deck, ".dps").vendor, "wps");
    assert.equal(classifyLegacyOffice(word, ".doc").vendor, "ms");
    assert.equal(classifyLegacyOffice(word).vendor, "ms");
    assert.equal(classifyLegacyOffice(word, ".docx").vendor, "ms");
  });

  test("WpsCustomData and ETExtData make the vendor WPS under any extension", () => {
    assert.equal(classifyLegacyOffice(container(wordItems({ wpsMarker: true })), ".doc").vendor, "wps");
    assert.equal(classifyLegacyOffice(container(excelItems({ wpsMarker: true })), ".xls").vendor, "wps");
    assert.equal(classifyLegacyOffice(container(wordItems({ wpsMarker: true })), "").vendor, "wps");
  });

  test("the secure-document notice in either script marks a WPS document secure and encrypted", () => {
    for (const script of /** @type {const} */ (["simplified", "traditional"])) {
      const bytes = container(wordItems({ wpsMarker: true, decoy: script }));
      const result = timed(script, () => classifyLegacyOffice(bytes, ".doc"));
      assert.equal(result.wpsSecure, true, script);
      assert.equal(result.encrypted, true, script);
      assert.equal(result.family, "doc", script);
    }
  });

  test("the notice text without a WPS private stream is only text, not an encrypted document", () => {
    const result = classifyLegacyOffice(container(wordItems({ decoy: "simplified" })), ".doc");
    assert.deepEqual(shape(result), fixture("legacy-plain.doc").expect);
  });

  test("a WPS document with ordinary text and no encryption is not secure", () => {
    const result = classifyLegacyOffice(container(wordItems({ wpsMarker: true })), ".doc");
    assert.equal(result.wpsSecure, false);
    assert.equal(result.encrypted, false);
  });

  test("WPS encryption on a workbook or a deck makes it secure, a Microsoft extension does not", () => {
    assert.equal(
      classifyLegacyOffice(container(excelItems({ wpsMarker: true, filepass: true })), ".xls").wpsSecure,
      true,
    );
    assert.equal(classifyLegacyOffice(container(pptItems({ userEditLength: 0x20 })), ".dps").wpsSecure, true);
    assert.equal(classifyLegacyOffice(container(pptItems({ userEditLength: 0x20 })), ".ppt").wpsSecure, false);
  });

  test("legacyVendorOf gives the vendor and family from the directory alone", () => {
    assert.deepEqual(legacyVendorOf(word, ".wps"), { vendor: "wps", family: "doc" });
    assert.deepEqual(legacyVendorOf(sheet, ".et"), { vendor: "wps", family: "xls" });
    assert.deepEqual(legacyVendorOf(deck, ".dps"), { vendor: "wps", family: "ppt" });
    assert.deepEqual(legacyVendorOf(word, ".doc"), { vendor: "ms", family: "doc" });
    assert.deepEqual(legacyVendorOf(container(excelItems({ wpsMarker: true })), ".xlsx"), {
      vendor: "wps",
      family: "xls",
    });
  });

  test("legacyVendorOf falls back to the extension when the container cannot be read", () => {
    const garbage = seededBytes(2048, 77);
    assert.deepEqual(legacyVendorOf(garbage, ".dps"), { vendor: "wps", family: "ppt" });
    assert.deepEqual(legacyVendorOf(garbage, ".et"), { vendor: "wps", family: "xls" });
    assert.deepEqual(legacyVendorOf(garbage, ".wps"), { vendor: "wps", family: "doc" });
    assert.deepEqual(legacyVendorOf(garbage, ".doc"), { vendor: "ms", family: null });
  });
});
