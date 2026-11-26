/**
 * The synthetic legacy Office/WPS fixtures classify as each one declares, and
 * the round-1 golden samples still get the copy round 1 stored. Everything is
 * built in memory; no sample generator or external tool is needed.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { classifyLegacyOffice } from "./cfb.mjs";
import { detectType } from "./detect.mjs";
import { LEGACY_FIXTURES } from "./test-fixtures/legacy-office-fixtures.mjs";
import { goldenBytes, loadGolden } from "./test-fixtures/legacy-rejection-golden.mjs";

const REQUIRED = [
  "legacy-encrypted.doc",
  "legacy-filepass.xls",
  "legacy-encrypted.ppt",
  "wps-secure.dps",
  "wps-secure.doc",
  "wps-secure.xls",
  "legacy-macro.doc",
  "legacy-vba.xls",
  "legacy-xlm.xls",
  "legacy-macro.ppt",
  "legacy-truncated.ppt",
  "legacy.dps",
  "legacy.et",
  "legacy.wps",
];

/** @param {string} name */
const extensionOf = (name) => path.extname(name).toLowerCase();

describe("the synthetic legacy fixtures", () => {
  test("every required fixture exists, declares its property and builds the same bytes twice", () => {
    for (const name of REQUIRED) {
      const fixture = LEGACY_FIXTURES[/** @type {keyof typeof LEGACY_FIXTURES} */ (name)];
      assert.ok(fixture, `${name} is defined`);
      assert.ok(fixture.declares.length > 0, `${name} declares its property`);
      assert.deepEqual(fixture.build(), fixture.build(), `${name} is deterministic`);
    }
  });

  test("each fixture classifies as it declares, in under 100 ms", () => {
    for (const [name, fixture] of Object.entries(LEGACY_FIXTURES)) {
      const bytes = fixture.build();
      const started = performance.now();
      const result = classifyLegacyOffice(bytes, extensionOf(name));
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 100, `${name} took ${elapsed.toFixed(2)} ms`);
      for (const [key, value] of Object.entries(fixture.expect)) {
        assert.equal(/** @type {Record<string, unknown>} */ (result)[key], value, `${name} ${key}`);
      }
    }
  });

  test("a damaged fixture is refused without a crash and still reads as a legacy file", () => {
    const bytes = LEGACY_FIXTURES["legacy-truncated.ppt"].build();
    const result = classifyLegacyOffice(bytes, ".ppt");
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
    const refused = detectType({ name: "legacy-truncated.ppt", bytes });
    assert.equal(refused.ok, false);
    assert.equal(/** @type {{code: string}} */ (refused).code, "legacy-office-format");
  });

  test("the round-1 legacy.doc, .xls, .ppt and legacy-as.docx give the copy round 1 stored", () => {
    const golden = loadGolden();
    for (const sample of golden.samples) {
      const refused = detectType({ name: sample.name, bytes: goldenBytes(golden, sample.name) });
      assert.equal(refused.ok, false, sample.name);
      assert.equal(/** @type {{message: string}} */ (refused).message, sample.publicRecord.message, sample.name);
    }
  });
});
