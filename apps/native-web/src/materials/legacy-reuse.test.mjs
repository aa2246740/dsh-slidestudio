/**
 * Reuse, reconversion and network silence of converted legacy materials in
 * the real attachment store. The store is single-user local: identical bytes
 * are one material, whatever name they are uploaded under.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { AttachmentStore, attachmentPublic } from "../attachments.mjs";
import { createFakeSpawn, defaultHandler, makeScratch } from "../testlib/fake-soffice.mjs";
import { ingestAttachment } from "./intake.mjs";
import { createLegacyConverter } from "./legacy-convert.mjs";
import { ParsePool } from "./parse-pool.mjs";
import { fakeConverter, legacy, sha, success } from "./test-fixtures/legacy-intake-harness.mjs";
import { CONVERTED } from "./test-fixtures/legacy-packages.mjs";

/** @typedef {import("./legacy-intake.mjs").LegacyConverterLike} LegacyConverterLike */

/** @type {string} */
let scratch;
/** @type {ParsePool} */
let pool;
let storeSequence = 0;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-legacy-reuse-"));
  pool = new ParsePool();
});

after(async () => {
  await pool?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

const freshStore = () => new AttachmentStore(path.join(scratch, `store-${storeSequence++}`));

/** @param {AttachmentStore} store */
const convertedFiles = (store) => fs.readdirSync(store.root).filter((f) => f.endsWith(".converted"));

/**
 * @param {AttachmentStore} store @param {LegacyConverterLike} converter
 * @param {string} name @param {Uint8Array} bytes
 */
async function upload(store, converter, name, bytes) {
  const result = await ingestAttachment({ store, pool, legacyConverter: converter }, { name, bytes });
  return { ...result, public: attachmentPublic(result.record, { duplicateOf: result.duplicateOf }) };
}

/**
 * The real converter on a fake soffice that writes a valid package; every run is logged.
 * @param {import("node:test").TestContext} t
 */
function convertingStack(t) {
  const dirs = makeScratch();
  t.after(dirs.cleanup);
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  const fake = createFakeSpawn((call) => {
    if (!call.isRun) return defaultHandler(call);
    call.writeOutput(call.input.endsWith(".doc") ? CONVERTED.doc() : CONVERTED.ppt());
    call.exit(0);
  });
  const converter = createLegacyConverter({
    env: {},
    platform: "darwin",
    isolation: "none",
    sofficePath: dirs.soffice,
    dataDir: dirs.dataDir,
    jobRoot: dirs.jobRoot,
    spawn: /** @type {never} */ (fake.spawn),
    kill: () => undefined,
    sampleRssMb: async () => 0,
    log: (entry) => logs.push(entry),
  });
  const events = () => logs.filter((entry) => entry.event === "material.legacy-convert");
  return { converter, events, logs };
}

describe("dedupe and reconversion", () => {
  test("uploading legacy.doc twice gives duplicateOf and exactly one content-free conversion event", async (t) => {
    const { converter, events, logs } = convertingStack(t);
    await converter.ready();
    const store = freshStore();
    const bytes = legacy("legacy-plain.doc");
    const first = await upload(store, converter, "legacy.doc", bytes);
    assert.equal(first.public.status, "parsed", JSON.stringify(first.public));
    assert.equal(events().length, 1);
    const second = await upload(store, converter, "copy.doc", bytes);
    assert.equal(second.duplicateOf, first.record.meta.id);
    assert.equal(second.public.duplicateOf, first.record.meta.id);
    assert.equal(events().length, 1, "no second conversion");
    assert.equal(convertedFiles(store).length, 1, "one stored package");
    const text = JSON.stringify(logs);
    for (const secret of ["legacy.doc", "copy.doc", first.record.meta.id, "oss-lo-", scratch]) {
      assert.equal(text.includes(secret), false, `the log leaks ${secret}`);
    }
  });

  test("two simultaneous uploads of one file convert once", async () => {
    const bytes = legacy("legacy-plain.ppt");
    const converter = fakeConverter(new Map([[sha(bytes), success(CONVERTED.ppt(), "pptx")]]));
    const store = freshStore();
    const [a, b] = await Promise.all([
      upload(store, converter, "a.ppt", bytes),
      upload(store, converter, "b.ppt", bytes),
    ]);
    assert.equal(converter.calls.length, 1);
    assert.equal([a.duplicateOf, b.duplicateOf].filter(Boolean).length, 1);
  });

  test("a stored conversion is reused after the engine version changes, and redone only when the rule changes", async () => {
    const bytes = legacy("legacy-plain.ppt");
    const output = CONVERTED.ppt();
    const first = fakeConverter(new Map([[sha(bytes), success(output, "pptx", { engineVersion: "1.0.0" })]]));
    const store = freshStore();
    const stored = await upload(store, first, "deck.ppt", bytes);
    assert.equal(stored.record.derivative.conversion?.engineVersion, "1.0.0");

    const newer = fakeConverter(new Map([[sha(bytes), success(output, "pptx", { engineVersion: "9.9.9" })]]));
    const again = await upload(store, newer, "deck.ppt", bytes);
    assert.equal(again.duplicateOf, stored.record.meta.id, "an engine version is no reason to convert");
    assert.equal(newer.calls.length, 0);

    // The same bytes under a conversion rule this build no longer trusts.
    const { derivative } = stored.record;
    const converted = fs.readFileSync(store.paths(stored.record.meta.id).converted);
    assert.equal(store.delete(stored.record.meta.id), true);
    const conversion = /** @type {NonNullable<typeof derivative.conversion>} */ (derivative.conversion);
    const old = await store.record({
      name: "deck.ppt",
      bytes,
      converted,
      derivative: { ...derivative, conversion: { ...conversion, rule: "legacy-convert-v0" } },
    });
    const redone = await upload(store, newer, "deck.ppt", bytes);
    assert.equal(redone.duplicateOf, undefined, "a different rule is converted again");
    assert.notEqual(redone.record.meta.id, old.meta.id);
    assert.equal(newer.calls.length, 1);
    assert.equal(redone.record.derivative.conversion?.rule, "legacy-convert-v1");
    assert.equal(convertedFiles(store).length, 1, "the retired record's package is gone");
    assert.equal(store.read(old.meta.id), undefined);
  });
});

describe("external relationships in converted output are never fetched", () => {
  /** @type {http.Server} */
  let probe;
  let requests = 0;
  let port = 0;

  before(async () => {
    probe = http.createServer((_req, res) => {
      requests += 1;
      res.end("x");
    });
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(undefined)));
    port = /** @type {import("node:net").AddressInfo} */ (probe.address()).port;
  });
  after(() => new Promise((resolve) => probe.close(() => resolve(undefined))));

  /** @param {string} part */
  const external = (part) =>
    `<Relationship Id="rIdExt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://127.0.0.1:${port}/${part}.png" TargetMode="External"/>`;

  /** @param {Uint8Array} bytes @param {string} relsPart @param {string} xmlPart @param {string} tag */
  function withExternalImage(bytes, relsPart, xmlPart, tag) {
    const entries = unzipSync(new Uint8Array(bytes));
    const rels = Buffer.from(entries[relsPart] ?? strToU8("")).toString("utf8");
    entries[relsPart] = strToU8(
      rels.includes("</Relationships>")
        ? rels.replace("</Relationships>", `${external(tag)}</Relationships>`)
        : `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${external(tag)}</Relationships>`,
    );
    const xml = Buffer.from(entries[xmlPart] ?? strToU8("")).toString("utf8");
    entries[xmlPart] = strToU8(
      xml.replace(
        /<\/(w:body|p:spTree)>/,
        `<a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:link="rIdExt1"/></$1>`,
      ),
    );
    return Buffer.from(zipSync(entries));
  }

  test("a docx and a pptx whose output points at a local server parse without a single request", async (t) => {
    const fetchSpy = mock.method(globalThis, "fetch");
    t.after(() => fetchSpy.mock.restore());
    const cases = /** @type {const} */ ([
      ["legacy-plain.doc", "doc", "docx", "word/_rels/document.xml.rels", "word/document.xml"],
      ["legacy-plain.ppt", "ppt", "pptx", "ppt/slides/_rels/slide1.xml.rels", "ppt/slides/slide1.xml"],
    ]);
    for (const [key, family, to, relsPart, xmlPart] of cases) {
      const input = legacy(key);
      const output = withExternalImage(CONVERTED[family](), relsPart, xmlPart, family);
      const converter = fakeConverter(new Map([[sha(input), success(output, to)]]));
      const { public: record } = await upload(freshStore(), converter, `ext.${family}`, input);
      assert.equal(record.status, "parsed", JSON.stringify(record));
    }
    assert.equal(requests, 0, "the probe server saw a request");
    assert.equal(fetchSpy.mock.callCount(), 0, "fetch was called");
  });
});
