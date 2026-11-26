import assert from "node:assert/strict";
import { before, test } from "node:test";
import { detectType } from "./detect.mjs";
import { registeredParserIds, runParseJob } from "./parse-worker.mjs";
import { PARSER_IDS } from "./derivative.mjs";
import { generateSamples, readSample, SAMPLES_SKIP } from "./sample-fixtures.mjs";

let dir;
before(async () => {
  dir = SAMPLES_SKIP ? "" : await generateSamples();
});

test("every parser id detection can emit is registered — the placeholder path is gone", () => {
  const registered = registeredParserIds();
  for (const id of Object.values(PARSER_IDS)) {
    assert.ok(registered.includes(id), `parser ${id} must be registered`);
  }
});

test("detection never returns a parser id outside the registered set", async () => {
  const registered = new Set(registeredParserIds());
  /** @type {[string, Buffer][]} */
  const probes = [
    ["a.txt", Buffer.from("hello")],
    ["a.csv", Buffer.from("a,b\n1,2\n")],
    ["a.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)])],
    ["a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
  ];
  for (const [name, bytes] of probes) {
    const detected = detectType({ name, bytes });
    if (detected.ok) assert.ok(registered.has(detected.parserId), name);
  }
});
