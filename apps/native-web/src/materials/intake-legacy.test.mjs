/**
 * The legacy branch end to end through `ingestAttachment` and the real
 * attachment store: the unavailable-converter rejections stay byte-identical
 * to round 1, a conversion lands as an ownerless record with its converted
 * package, and the stored record is verified, reused and retired like any other.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { makeScratch } from "../testlib/fake-soffice.mjs";
import { classifyLegacyOffice } from "./cfb.mjs";
import { SUPPORTED_TYPES_ZH } from "./detect.mjs";
import { ingestAttachment } from "./intake.mjs";
import { createLegacyConverter } from "./legacy-convert.mjs";
import { loadSharp } from "./optional-decoder.mjs";
import { ParsePool } from "./parse-pool.mjs";
import {
  COPY,
  PRECHECKS,
  fakeConverter,
  legacy,
  sha,
  spied,
  success,
  throwingPool,
} from "./test-fixtures/legacy-intake-harness.mjs";
import { CONVERTED, noiseBytes } from "./test-fixtures/legacy-packages.mjs";
import { expectedRecord, goldenBytes, loadGolden, normalizeUpload } from "./test-fixtures/legacy-rejection-golden.mjs";

/** @typedef {import("./legacy-intake.mjs").LegacyConverterLike} LegacyConverterLike */

const golden = loadGolden();

const WPS_REFUSALS = {
  "legacy.dps": "这是 WPS 演示文件（.dps），暂不支持；请在 WPS 中“另存为” .pptx 后再上传",
  "legacy.et": "这是 WPS 表格文件（.et），暂不支持；请在 WPS 中“另存为” .xlsx 后再上传",
  "legacy.wps": "这是 WPS 文字文件（.wps），暂不支持；请在 WPS 中“另存为” .docx 后再上传",
};

/** @type {string} */
let scratch;
/** @type {ParsePool} */
let pool;
let storeSequence = 0;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-intake-legacy-"));
  pool = new ParsePool();
});

after(async () => {
  await pool?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

const freshStore = () => new AttachmentStore(path.join(scratch, `store-${storeSequence++}`));

/** @param {AttachmentStore} store @param {string} suffix */
const filesOf = (store, suffix) =>
  fs.existsSync(store.root) ? fs.readdirSync(store.root).filter((f) => f.endsWith(suffix)) : [];

/**
 * The upload as the route makes it, then the public record the browser gets.
 * @param {AttachmentStore} store @param {LegacyConverterLike} converter
 * @param {string} name @param {Uint8Array} bytes @param {{parse?: unknown}} [options]
 */
async function upload(store, converter, name, bytes, { parse } = {}) {
  const parsePool = /** @type {ParsePool} */ (parse ?? pool);
  const result = await ingestAttachment({ store, pool: parsePool, legacyConverter: converter }, { name, bytes });
  const view = attachmentPublic(result.record, {
    duplicateOf: result.duplicateOf,
    ...(result.uploadWarnings ? { warnings: result.uploadWarnings } : {}),
  });
  return { ...result, public: /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(view))) };
}

/**
 * The three ways a real converter ends up unavailable; none of them spawns anything.
 * @param {import("node:test").TestContext} t
 */
function unavailableConverters(t) {
  const dirs = makeScratch();
  t.after(dirs.cleanup);
  const base = {
    platform: "darwin",
    dataDir: dirs.dataDir,
    jobRoot: dirs.jobRoot,
    kill: () => undefined,
    log: () => undefined,
  };
  return {
    "no soffice": createLegacyConverter({ ...base, env: {}, candidates: ["/nonexistent/soffice"] }),
    "SLIDESTUDIO_LEGACY_CONVERT=off": createLegacyConverter({
      ...base,
      env: { SLIDESTUDIO_LEGACY_CONVERT: "off" },
    }),
    "Linux without network isolation (fail-closed)": createLegacyConverter({
      ...base,
      platform: "linux",
      env: {},
      sofficePath: dirs.soffice,
      runProbe: async () => false,
    }),
  };
}

describe("converter unavailable: today's rejection, byte for byte", () => {
  test("each unavailable case stores the golden record for non-security samples and refuses the encrypted ones", async (t) => {
    // The committed legacy.doc bytes carry the Word FIB fEncrypted bit, so the
    // classifier reads them as encrypted and they take the security refusal.
    const securityRefused = new Set(["legacy.doc", "legacy-as.docx"]);
    for (const name of securityRefused) {
      const verdict = classifyLegacyOffice(goldenBytes(golden, name), path.extname(name));
      assert.equal(verdict.encrypted, true, `${name}: the committed bytes carry fEncrypted`);
    }
    for (const [label, converter] of Object.entries(unavailableConverters(t))) {
      assert.equal((await converter.ready()).available, false, label);
      const probe = spied(converter);
      const store = freshStore();
      for (const sample of golden.samples) {
        const bytes = goldenBytes(golden, sample.name);
        const result = await upload(store, probe, sample.name, bytes, { parse: throwingPool });
        if (securityRefused.has(sample.name)) {
          const { status, errorCode, message } = result.public;
          assert.deepEqual([status, errorCode, message], ["unsupported", "encrypted", COPY.encrypted]);
          continue;
        }
        const actual = normalizeUpload(store, {
          name: sample.name,
          bytes,
          id: result.record.meta.id,
          publicRecord: result.public,
        });
        assert.deepEqual(actual, expectedRecord(sample), `${label}: ${sample.name}`);
        assert.equal(actual.derivative, sample.derivative, `${label}: ${sample.name} bytes`);
      }
      assert.equal(probe.calls.length, 0, `${label}: the converter is never asked`);
    }
  });

  test("WPS files get the WPS-named copy, security refusals still hold, and damaged files keep the legacy fallback", async (t) => {
    for (const [label, converter] of Object.entries(unavailableConverters(t))) {
      const probe = spied(converter);
      await probe.ready();
      const store = freshStore();
      for (const [name, message] of Object.entries(WPS_REFUSALS)) {
        const { public: record } = await upload(store, probe, name, legacy(name), {
          parse: throwingPool,
        });
        assert.deepEqual(
          [record.status, record.errorCode, record.message],
          ["unsupported", "legacy-office-format", message],
          `${label}: ${name}`,
        );
      }
      for (const [key, name, code, message] of PRECHECKS) {
        const { public: record } = await upload(store, probe, name, legacy(key), {
          parse: throwingPool,
        });
        const expected =
          key === "legacy-truncated.ppt" ? ["unsupported", "legacy-office-format"] : ["unsupported", code, message];
        assert.deepEqual(
          [record.status, record.errorCode, record.message].slice(0, expected.length),
          expected,
          `${label}: ${key}`,
        );
      }
      assert.equal(probe.calls.length, 0, `${label}: the converter is never asked`);
    }
  });

  test("the unsupported-type sentence names the legacy formats only with an available converter", async () => {
    const off = fakeConverter(new Map(), { available: false });
    const plain = await upload(freshStore(), off, "random.bin", noiseBytes(), { parse: throwingPool });
    assert.equal(plain.public.errorCode, "unsupported-type");
    assert.equal(plain.public.message, `暂不支持该文件类型；${SUPPORTED_TYPES_ZH}`);
    const on = await upload(freshStore(), fakeConverter(new Map()), "random.bin", noiseBytes(), {
      parse: throwingPool,
    });
    assert.ok(on.public.message.includes(SUPPORTED_TYPES_ZH), "the default sentence stays whole");
    for (const word of [".ppt", ".doc", ".xls", ".dps", ".et", ".wps"]) {
      assert.ok(on.public.message.includes(word), word);
    }
  });
});

describe("a conversion becomes an ownerless stored record", () => {
  test("the record keeps the upload as its original and the converted package beside it", async () => {
    const input = legacy("legacy-plain.ppt");
    const output = CONVERTED.ppt();
    const converter = fakeConverter(new Map([[sha(input), success(output, "pptx")]]));
    const store = freshStore();
    const { record, public: view } = await upload(store, converter, "deck.ppt", input);
    assert.equal(view.status, "parsed", JSON.stringify(view));
    assert.equal(view.kind, "deck-template");
    assert.ok(String(view.summary?.zh).startsWith("（由 .ppt 转换）"));
    assert.equal(view.size, input.length, "the record is about the uploaded file");
    const { meta } = record;
    assert.equal(meta.originalSha256, sha(input));
    assert.equal(meta.convertedSha256, sha(output));
    const raw = JSON.parse(fs.readFileSync(store.paths(meta.id).metadata, "utf8"));
    assert.equal("ownerId" in raw, false, "no owner is written");
    const files = store.paths(meta.id);
    assert.deepEqual(fs.readFileSync(files.original), input, "the original is the upload");
    assert.deepEqual(fs.readFileSync(files.converted), output, "the converted package is kept");
  });

  test("read() verifies the original and the converted package; delete removes both", async () => {
    const input = legacy("legacy-plain.doc");
    const converter = fakeConverter(new Map([[sha(input), success(CONVERTED.doc(), "docx")]]));
    const store = freshStore();
    const { record } = await upload(store, converter, "memo.doc", input);
    const { id } = record.meta;
    assert.equal(store.read(id)?.meta.id, id);
    const files = store.paths(id);
    const converted = fs.readFileSync(files.converted);
    fs.writeFileSync(files.converted, Buffer.concat([converted, Buffer.from([0])]));
    assert.throws(() => store.read(id), /转换|变化/);
    fs.writeFileSync(files.converted, converted);
    assert.equal(store.read(id)?.meta.id, id, "restored bytes verify");
    const original = fs.readFileSync(files.original);
    fs.writeFileSync(files.original, Buffer.concat([original, Buffer.from([0])]));
    assert.throws(() => store.read(id), /原文件已变化/);
    fs.writeFileSync(files.original, original);
    assert.equal(filesOf(store, ".converted").length, 1);
    assert.equal(store.delete(id), true);
    assert.deepEqual(fs.readdirSync(store.root), []);
  });

  test("a stalled warm-up stores a retryable timeout, and the next upload after warm-up converts", async () => {
    let warmedUp = false;
    const input = legacy("legacy-plain.ppt");
    const converter = fakeConverter(new Map([[sha(input), success(CONVERTED.ppt(), "pptx")]]), {
      waitReady: async () => warmedUp,
    });
    const store = freshStore();
    const stalled = await upload(store, converter, "slow.ppt", input);
    assert.deepEqual(
      [stalled.public.status, stalled.public.errorCode, stalled.public.message],
      ["failed", "timeout", COPY.timeout],
    );
    assert.deepEqual(filesOf(store, ".converted"), []);
    warmedUp = true;
    const converted = await upload(store, converter, "slow.ppt", input);
    assert.equal(converted.public.status, "parsed", JSON.stringify(converted.public));
    assert.equal(converted.duplicateOf, undefined, "a timeout is never reused");
    assert.equal(converter.calls.length, 1);
  });

  test("the template logo is taken from the converted package, not from the OLE original", async (t) => {
    // Logo verification decodes the picture; without the optional decoder the
    // store's own logo path is out of scope here (see the store's tests).
    if (!(await loadSharp())) return t.skip("the optional image decoder (sharp) is not installed");
    const { buildPptx } = await import("../testlib/pptx-fixture.mjs");
    const input = legacy("legacy-plain.ppt");
    const converter = fakeConverter(new Map([[sha(input), success(buildPptx({ withMedia: true }), "pptx")]]));
    const store = freshStore();
    const { record } = await upload(store, converter, "brand.ppt", input);
    assert.equal(record.derivative.status, "ok");
    const deck = /** @type {{media?: {logoCandidate?: boolean, sha256?: string}[]}} */ (
      record.derivative["deck-template"]
    );
    const media = deck?.media?.find((entry) => entry.logoCandidate);
    if (!media) {
      t.skip("this parser build marks no logo candidate (an image add-on may be missing)");
      return;
    }
    const logo = fs.readFileSync(store.paths(record.meta.id).logo);
    assert.equal(sha(logo), media.sha256, "the logo bytes come from the converted package");
  });
});
