import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SUPPORTED_TYPES_ZH } from "./detect.mjs";
import { conversionMark, legacyOfficeOutcome, withLegacyFormatsSentence } from "./legacy-intake.mjs";
import { ParsePool } from "./parse-pool.mjs";
import {
  COPY,
  MemoryStore,
  PRECHECKS,
  asIntakeStore,
  fakeConverter,
  legacy,
  sha,
  success,
  throwingPool,
} from "./test-fixtures/legacy-intake-harness.mjs";
import {
  CONVERTED,
  entryBomb,
  macroPackage,
  noiseBytes,
  ratioBomb,
  withSlideText,
  workbook,
} from "./test-fixtures/legacy-packages.mjs";
import { docxWithBody, textParagraph } from "./test-fixtures/docx-media.mjs";

/**
 * @typedef {import("./legacy-intake.mjs").LegacyConverterLike} LegacyConverterLike
 * @typedef {import("./legacy-intake.mjs").LegacyIntakePool} LegacyIntakePool
 * @typedef {import("./legacy-intake.mjs").LegacyIntakeResult} LegacyIntakeResult
 */

/** @type {ParsePool} */
let pool;
before(() => {
  pool = new ParsePool();
});
after(() => pool.close());

/**
 * One legacy upload through the branch, as intake calls it.
 * @param {MemoryStore} store @param {LegacyConverterLike} converter
 * @param {string} name @param {Uint8Array} bytes @param {{parse?: LegacyIntakePool}} [options]
 */
function outcomeOf(store, converter, name, bytes, { parse } = {}) {
  return legacyOfficeOutcome(
    { store: asIntakeStore(store), pool: parse ?? pool, legacyConverter: converter },
    { name, bytes, materialId: store.nextId(name) },
  );
}

/** @param {LegacyIntakeResult|null} result */
function stored(result) {
  assert.ok(result, "the branch stored a record");
  return result.record.derivative;
}

/** @param {LegacyIntakeResult|null} result */
const verdictOf = (result) => {
  const derivative = stored(result);
  return [derivative.status, derivative.errorCode, derivative.message];
};

/** @param {"doc"|"xls"|"ppt"} family @param {Uint8Array} output */
function oneConversion(family, output) {
  const input = legacy(`legacy-plain.${family}`);
  const to = { doc: "docx", xls: "xlsx", ppt: "pptx" }[family];
  const converter = fakeConverter(new Map([[sha(input), success(output, to)]]));
  return { input, converter, store: new MemoryStore() };
}

describe("security findings are refused before readiness and never converted", () => {
  test("encrypted, macro and malformed files are refused with the design copy whatever the availability", async () => {
    for (const available of [true, false]) {
      const converter = fakeConverter(new Map(), { available });
      const store = new MemoryStore();
      for (const [key, name, code, message] of PRECHECKS) {
        const result = await outcomeOf(store, converter, name, legacy(key), {
          parse: throwingPool,
        });
        if (key === "legacy-truncated.ppt" && !available) {
          // Damaged, not a security finding: the unavailable fallback stays the caller's.
          assert.equal(result, null, key);
          continue;
        }
        assert.deepEqual(verdictOf(result), ["unsupported", code, message], key);
      }
      assert.equal(converter.calls.length, 0, "run was called for a refused file");
      assert.deepEqual(store.convertedPackages(), []);
      for (const input of store.recordInputs) assert.equal("ownerId" in input, false);
    }
  });

  test("an encrypted file is refused even when warm-up never settles", async () => {
    let readinessCalls = 0;
    const converter = {
      available: true,
      ready: () => new Promise(() => {}),
      waitReady: () => {
        readinessCalls += 1;
        return new Promise(() => {});
      },
      info: () => ({}),
      run: async () => {
        throw new Error("a security refusal must not reach the converter");
      },
    };
    const result = await outcomeOf(
      new MemoryStore(),
      /** @type {LegacyConverterLike} */ (converter),
      "legacy-encrypted.doc",
      legacy("legacy-encrypted.doc"),
      { parse: throwingPool },
    );
    assert.deepEqual(verdictOf(result), ["unsupported", "encrypted", COPY.encrypted]);
    assert.equal(readinessCalls, 0, "a security finding never waits for warm-up");
  });
});

describe("readiness and availability", () => {
  test("a stalled warm-up is a retryable timeout, and a later warm-up success converts", async () => {
    let warmedUp = false;
    const input = legacy("legacy-plain.ppt");
    const converter = fakeConverter(new Map([[sha(input), success(CONVERTED.ppt(), "pptx")]]), {
      waitReady: async () => warmedUp,
    });
    const store = new MemoryStore();
    const stalled = await outcomeOf(store, converter, "slow.ppt", input);
    assert.deepEqual(verdictOf(stalled), ["failed", "timeout", COPY.timeout]);
    assert.equal(converter.calls.length, 0, "nothing was converted while warm-up waited");
    warmedUp = true;
    assert.equal(stored(await outcomeOf(store, converter, "slow.ppt", input)).status, "ok");
    assert.equal(converter.calls.length, 1);
  });

  test("without an available converter an ordinary legacy file is left to the caller", async () => {
    const converter = fakeConverter(new Map(), { available: false });
    const store = new MemoryStore();
    for (const key of ["legacy-plain.doc", "legacy-plain.xls", "legacy-plain.ppt", "legacy.dps"]) {
      assert.equal(await outcomeOf(store, converter, key, legacy(key)), null, key);
    }
    assert.equal(store.records.length, 0, "nothing is stored by the branch");
    assert.equal(converter.calls.length, 0);
  });

  test("an available converter is never offered a container it cannot read safely", async () => {
    const converter = fakeConverter(new Map());
    const signatureOnly = Buffer.alloc(2048);
    signatureOnly.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const result = await outcomeOf(new MemoryStore(), converter, "deck.ppt", signatureOnly, {
      parse: throwingPool,
    });
    assert.deepEqual(verdictOf(result), ["unsupported", "corrupt", COPY.corrupt]);
    assert.equal(converter.calls.length, 0);
  });

  test("a legacy upload is sent to the converter with its family and vendor", async () => {
    const dps = legacy("legacy.dps");
    const converter = fakeConverter(new Map([[sha(dps), success(CONVERTED.ppt(), "pptx")]]));
    assert.equal(stored(await outcomeOf(new MemoryStore(), converter, "legacy.dps", dps)).status, "ok");
    assert.deepEqual(converter.calls, [{ family: "ppt", vendor: "wps", sha256: sha(dps) }]);
  });
});

describe("clean conversion", () => {
  const FAMILIES = /** @type {const} */ ([
    ["legacy-plain.doc", "legacy.doc", "doc", "docx", "document", "docx-ooxml-v1", ".doc", "（由 .doc 转换）"],
    ["legacy-plain.xls", "legacy.xls", "xls", "xlsx", "table", "xlsx-ooxml-v1", ".xls", "（由 .xls 转换）"],
    ["legacy-plain.ppt", "legacy.ppt", "ppt", "pptx", "deck-template", "pptx-ooxml-v2", ".ppt", "（由 .ppt 转换）"],
    ["legacy.dps", "legacy.dps", "ppt", "pptx", "deck-template", "pptx-ooxml-v2", ".dps", "（由 WPS .dps 转换）"],
  ]);
  for (const [key, name, family, to, kind, parserId, from, prefix] of FAMILIES) {
    test(`${key} uploaded as ${name} becomes a parsed ${kind} material with the conversion block`, async () => {
      const input = legacy(key);
      const output = CONVERTED[family]();
      const converter = fakeConverter(new Map([[sha(input), success(output, to)]]));
      const store = new MemoryStore();
      const derivative = stored(await outcomeOf(store, converter, name, input));
      assert.equal(derivative.status, "ok", JSON.stringify(derivative));
      assert.equal(derivative.kind, kind);
      assert.equal(derivative.parser.id, parserId);
      assert.ok(derivative.summary?.zh.startsWith(prefix), derivative.summary?.zh);
      const warning = derivative.warnings.find((entry) => entry.code === "converted-from-legacy");
      assert.match(warning?.message ?? "", /自动转换成 \.(docx|xlsx|pptx) 后读取.*可能与原文件不同/);
      assert.deepEqual(
        { ...derivative.conversion, durationMs: typeof derivative.conversion?.durationMs },
        {
          from,
          to: `.${to}`,
          engine: "libreoffice",
          engineVersion: "26.2.3.2",
          rule: "legacy-convert-v1",
          durationMs: "number",
          convertedSha256: sha(output),
          convertedBytes: output.length,
          isolation: "sandbox-exec",
        },
      );
      assert.equal(derivative.source.sha256, sha(input), "source is the user's upload");
      assert.equal(derivative.source.name, name);
      assert.equal(derivative.errorCode, undefined);
      const [record] = store.records;
      assert.deepEqual(record?.converted, output, "the converted package is kept");
      assert.equal(record?.meta.originalSha256, sha(input));
      assert.equal(JSON.stringify(derivative).includes("<a:"), false, "no raw OOXML");
      assert.equal("ownerId" in (store.recordInputs[0] ?? {}), false);
    });
  }

  test("a legacy file with a foreign extension is told so, and the mark names the real format", async () => {
    const { input, converter, store } = oneConversion("doc", CONVERTED.doc());
    const derivative = stored(await outcomeOf(store, converter, "legacy-as.docx", input));
    const mismatch = derivative.warnings.find((entry) => entry.code === "extension-mismatch");
    assert.match(mismatch?.message ?? "", /扩展名为 \.docx/);
    assert.equal(derivative.warnings[0]?.code, "extension-mismatch", "the mismatch comes first");
    assert.ok(derivative.summary?.zh.startsWith("（由 .doc 转换）"));
    assert.equal(derivative.source.extensionMismatch, true);
    assert.equal(derivative.source.detectedMime, "application/msword");
  });

  test("a converted workbook with readable headers and a logo is not an encrypted decoy", async () => {
    const output = workbook({ rows: [["项目", "金额"]], withPicture: true });
    const { input, converter, store } = oneConversion("xls", output);
    const derivative = stored(await outcomeOf(store, converter, "report.xls", input));
    assert.equal(derivative.status, "ok", JSON.stringify(derivative));
    assert.equal(derivative.kind, "table");
  });

  test("the conversion mark names WPS files as WPS", () => {
    assert.deepEqual(conversionMark("xls", "wps"), { from: ".et", prefix: "（由 WPS .et 转换）" });
    assert.deepEqual(conversionMark("doc", "ms"), { from: ".doc", prefix: "（由 .doc 转换）" });
  });
});

describe("converted output is re-validated like a new upload", () => {
  /** label, family, output builder, expected code, expected message or RegExp */
  const REJECTED = /** @type {[string, "doc"|"xls"|"ppt", () => Uint8Array, string, string|RegExp][]} */ ([
    ["vbaProject.bin in a pptx", "ppt", () => macroPackage("pptm"), "macro-enabled", COPY.macro],
    ["a macroEnabled docx", "doc", () => macroPackage("docm"), "macro-enabled", COPY.macro],
    ["a hidden vbaProject.bin in an xlsx", "xls", () => macroPackage("sneaky-xlsx"), "macro-enabled", COPY.macro],
    ["a zip bomb by entry count", "doc", entryBomb, "archive-limit", /安全限制/],
    ["a zip bomb by compression ratio", "xls", ratioBomb, "archive-limit", /安全限制/],
    ["a docx where a deck is required", "ppt", CONVERTED.doc, "corrupt", COPY.corrupt],
    ["an xlsx where a document is required", "doc", CONVERTED.xls, "corrupt", COPY.corrupt],
    ["a pptx where a table is required", "xls", CONVERTED.ppt, "corrupt", COPY.corrupt],
    ["bytes that are not a package", "ppt", noiseBytes, "corrupt", COPY.corrupt],
    [
      "a WPS secure-document decoy in a docx",
      "doc",
      () => docxWithBody(textParagraph("此文件为私密文档"), []),
      "encrypted",
      COPY.wpsSecure,
    ],
    [
      "the other WPS decoy sentence in a pptx",
      "ppt",
      () => withSlideText(CONVERTED.ppt(), { "ppt/slides/slide1.xml": "此文件仅WPS能打开" }),
      "encrypted",
      COPY.wpsSecure,
    ],
    [
      "an xlsx with no cells and only a picture",
      "xls",
      () => workbook({ withPicture: true }),
      "encrypted",
      COPY.wpsSecure,
    ],
    ["an output above 50 MiB", "ppt", () => Buffer.alloc(50 * 1024 * 1024 + 1, 1), "too-large", COPY.tooLarge],
  ]);
  for (const [label, family, output, code, message] of REJECTED) {
    test(`${label} is refused with its own code and keeps no converted package`, async () => {
      const { input, converter, store } = oneConversion(family, output());
      const derivative = stored(await outcomeOf(store, converter, `case.${family}`, input));
      assert.equal(derivative.status, "unsupported", `${label}: ${JSON.stringify(derivative)}`);
      assert.equal(derivative.errorCode, code, label);
      if (message instanceof RegExp) assert.match(derivative.message ?? "", message);
      else assert.equal(derivative.message, message, label);
      assert.equal(derivative.kind, null);
      assert.equal(derivative.conversion, undefined, "a refusal carries no conversion block");
      assert.deepEqual(store.convertedPackages(), [], label);
      assert.equal(converter.calls.length, 1);
    });
  }

  test("converter failures keep their retry semantics and the design copy", async () => {
    for (const [code, status, message] of /** @type {const} */ ([
      ["timeout", "failed", COPY.timeout],
      ["out-of-memory", "failed", COPY.oom],
      ["convert-busy", "failed", COPY.busy],
      ["convert-failed", "failed", COPY.failed],
      ["corrupt", "unsupported", COPY.corrupt],
      ["too-large", "unsupported", COPY.tooLarge],
    ])) {
      const input = legacy("legacy-plain.ppt");
      const converter = fakeConverter(new Map([[sha(input), { ok: false, code, message: "converter-side wording" }]]));
      const result = await outcomeOf(new MemoryStore(), converter, "slow.ppt", input);
      assert.deepEqual(verdictOf(result), [status, code, message]);
    }
  });

  test("a re-validation parse timeout, out-of-memory or thrown error keeps the pool's own answer", async () => {
    for (const [code, message] of [
      ["timeout", "文件解析时间过长，已停止；请拆分或简化文件后重试"],
      ["out-of-memory", "文件解析占用内存过大，无法完成；请拆分或压缩后重试"],
    ]) {
      const { input, converter, store } = oneConversion("ppt", CONVERTED.ppt());
      const slowPool = { run: async () => ({ ok: /** @type {const} */ (false), code, message }) };
      const result = await outcomeOf(store, converter, "slow.ppt", input, { parse: slowPool });
      assert.deepEqual(verdictOf(result), ["failed", code, message], code);
    }
    const { input, converter, store } = oneConversion("ppt", CONVERTED.ppt());
    const crashing = {
      run: async () => {
        throw new Error("worker exited");
      },
    };
    const result = await outcomeOf(store, converter, "crash.ppt", input, { parse: crashing });
    assert.deepEqual(verdictOf(result), ["unsupported", "corrupt", COPY.corrupt]);
  });
});

describe("dedupe without owners", () => {
  test("the same bytes again reuse the stored conversion, and simultaneous uploads convert once", async () => {
    const { input, converter, store } = oneConversion("ppt", CONVERTED.ppt());
    const [a, b] = await Promise.all([
      outcomeOf(store, converter, "a.ppt", input),
      outcomeOf(store, converter, "b.ppt", input),
    ]);
    assert.equal(converter.calls.length, 1);
    assert.equal([a?.duplicateOf, b?.duplicateOf].filter(Boolean).length, 1);
    const again = await outcomeOf(store, converter, "copy.ppt", input);
    assert.equal(again?.duplicateOf, store.records[0]?.meta.id);
    assert.equal(converter.calls.length, 1, "no second conversion");
    assert.equal(store.convertedPackages().length, 1, "one stored package");
  });

  test("a refused upload is evaluated again rather than reused", async () => {
    const input = legacy("legacy-plain.doc");
    const converter = fakeConverter(new Map());
    const store = new MemoryStore();
    for (let round = 0; round < 2; round += 1) {
      assert.equal(stored(await outcomeOf(store, converter, "memo.doc", input)).errorCode, "convert-failed");
    }
    assert.equal(converter.calls.length, 2);
    assert.equal(store.records.length, 2, "each refused upload keeps its own failure record");
  });
});

describe("the supported-types sentence follows the converter", () => {
  const base = `暂不支持该文件类型；${SUPPORTED_TYPES_ZH}`;

  test("an available converter adds the legacy formats; otherwise the sentence is unchanged", async () => {
    const extended = await withLegacyFormatsSentence(fakeConverter(new Map()), base);
    assert.ok(extended.includes(SUPPORTED_TYPES_ZH), "the default sentence stays whole");
    for (const word of [".ppt", ".doc", ".xls", ".dps", ".et", ".wps"]) {
      assert.ok(extended.includes(word), word);
    }
    const off = fakeConverter(new Map(), { available: false });
    assert.equal(await withLegacyFormatsSentence(off, base), base);
    const stalled = fakeConverter(new Map(), { waitReady: async () => false });
    assert.equal(await withLegacyFormatsSentence(() => stalled, base), base);
    assert.equal(await withLegacyFormatsSentence(fakeConverter(new Map()), "其他"), "其他");
  });
});
