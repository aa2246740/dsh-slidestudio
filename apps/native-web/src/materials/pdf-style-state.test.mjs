import assert from "node:assert/strict";
import { test } from "node:test";
import * as parseWorker from "./parse-worker.mjs";
import { buildPdf } from "./pdf-fixture-pdfs.mjs";
import * as styleHints from "./pdf-style-hints.mjs";

/** Loosely typed views: the tests hand in partial pdf.js stand-ins. */
/** @type {(input: any) => Promise<any>} */
const extractPdfStyleProfile = styleHints.extractPdfStyleProfile;
/** @type {(job: any) => Promise<any>} */
const runParseJob = parseWorker.runParseJob;

/** Operator-list builder keeping fnArray/argsArray index-aligned. */
function operatorScript() {
  /** @type {any[]} */ const fnArray = [];
  /** @type {any[]} */ const argsArray = [];
  const add = (/** @type {any} */ fn, /** @type {any} */ args = []) => {
    fnArray.push(fn);
    argsArray.push(args);
  };
  return {
    add,
    async getOperatorList() {
      return { fnArray, argsArray };
    },
  };
}

test("colours painted inside q…Q stay inside the saved graphics state", async () => {
  const OPS = { setFillRGBColor: 1, constructPath: 2, fill: 3, save: 4, restore: 5 };
  const script = operatorScript();
  script.add(OPS.setFillRGBColor, ["#0000FF"]);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  script.add(OPS.save);
  script.add(OPS.setFillRGBColor, ["#FF0000"]);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  script.add(OPS.restore);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  const profile = await extractPdfStyleProfile({
    unpdf: {
      getResolvedPDFJS: async () => ({ OPS }),
      getMeta: async () => ({ info: {} }),
    },
    proxy: {
      getPage: async () => ({
        commonObjs: { get: () => undefined },
        cleanup() {},
        getOperatorList: script.getOperatorList,
      }),
    },
    pageCount: 1,
  });
  assert.deepEqual(profile.accentColors, [
    { hex: "#0000FF", share: 0.6667, roles: ["fill"] },
    { hex: "#FF0000", share: 0.3333, roles: ["fill"] },
  ]);
});

test("nested q…Q restore their own graphics state level", async () => {
  const OPS = {
    setFillRGBColor: 1,
    constructPath: 2,
    fill: 3,
    save: 4,
    restore: 5,
  };
  const script = operatorScript();
  script.add(OPS.setFillRGBColor, ["#0000FF"]);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  script.add(OPS.save);
  script.add(OPS.setFillRGBColor, ["#FF0000"]);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  script.add(OPS.save);
  script.add(OPS.setFillRGBColor, ["#00FF00"]);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  script.add(OPS.restore);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  script.add(OPS.restore);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  const profile = await extractPdfStyleProfile({
    unpdf: {
      getResolvedPDFJS: async () => ({ OPS }),
      getMeta: async () => ({ info: {} }),
    },
    proxy: {
      getPage: async () => ({
        commonObjs: { get: () => undefined },
        cleanup() {},
        getOperatorList: script.getOperatorList,
      }),
    },
    pageCount: 1,
  });
  assert.deepEqual(profile.accentColors, [
    { hex: "#0000FF", share: 0.4, roles: ["fill"] },
    { hex: "#FF0000", share: 0.4, roles: ["fill"] },
    { hex: "#00FF00", share: 0.2, roles: ["fill"] },
  ]);
});

test("q…Q restore stroke color independently from fill color", async () => {
  const OPS = {
    setStrokeRGBColor: 1,
    constructPath: 2,
    stroke: 3,
    save: 4,
    restore: 5,
  };
  const script = operatorScript();
  script.add(OPS.setStrokeRGBColor, ["#0000FF"]);
  script.add(OPS.constructPath, [OPS.stroke, [], {}]);
  script.add(OPS.stroke);
  script.add(OPS.save);
  script.add(OPS.setStrokeRGBColor, ["#FF0000"]);
  script.add(OPS.constructPath, [OPS.stroke, [], {}]);
  script.add(OPS.stroke);
  script.add(OPS.restore);
  script.add(OPS.constructPath, [OPS.stroke, [], {}]);
  script.add(OPS.stroke);
  const profile = await extractPdfStyleProfile({
    unpdf: {
      getResolvedPDFJS: async () => ({ OPS }),
      getMeta: async () => ({ info: {} }),
    },
    proxy: {
      getPage: async () => ({
        commonObjs: { get: () => undefined },
        cleanup() {},
        getOperatorList: script.getOperatorList,
      }),
    },
    pageCount: 1,
  });
  assert.deepEqual(profile.accentColors, [
    { hex: "#0000FF", share: 0.6667, roles: ["stroke"] },
    { hex: "#FF0000", share: 0.3333, roles: ["stroke"] },
  ]);
});

test("an unbalanced restore never throws and keeps the current graphics state", async () => {
  const OPS = { setFillRGBColor: 1, constructPath: 2, fill: 3, restore: 4 };
  const script = operatorScript();
  script.add(OPS.restore);
  script.add(OPS.setFillRGBColor, ["#C00000"]);
  script.add(OPS.constructPath, [OPS.fill, [], {}]);
  script.add(OPS.fill);
  const profile = await extractPdfStyleProfile({
    unpdf: {
      getResolvedPDFJS: async () => ({ OPS }),
      getMeta: async () => ({ info: {} }),
    },
    proxy: {
      getPage: async () => ({
        commonObjs: { get: () => undefined },
        cleanup() {},
        getOperatorList: script.getOperatorList,
      }),
    },
    pageCount: 1,
  });
  assert.deepEqual(profile.accentColors, [{ hex: "#C00000", share: 1, roles: ["fill"] }]);
});

test("text state set inside q…Q is restored after Q", async () => {
  const OPS = { setFont: 1, showText: 2, save: 3, restore: 4 };
  const script = operatorScript();
  script.add(OPS.setFont, ["F-A"]);
  script.add(OPS.showText, [[["A"]]]);
  script.add(OPS.save);
  script.add(OPS.setFont, ["F-B"]);
  script.add(OPS.showText, [[["B"]]]);
  script.add(OPS.restore);
  script.add(OPS.showText, [[["A2"]]]);
  const profile = await extractPdfStyleProfile({
    unpdf: {
      getResolvedPDFJS: async () => ({ OPS }),
      getMeta: async () => ({ info: {} }),
    },
    proxy: {
      getPage: async () => ({
        commonObjs: {
          get: (/** @type {any} */ id) => ({ name: id === "F-B" ? "HYZhongHeiKW" : "HYQiHei-EES" }),
        },
        cleanup() {},
        getOperatorList: script.getOperatorList,
      }),
    },
    pageCount: 1,
  });
  assert.deepEqual(
    profile.fonts.map((/** @type {any} */ font) => [font.source, font.share]),
    [
      ["HYQiHei-EES", 0.6667],
      ["HYZhongHeiKW", 0.3333],
    ],
  );
});

test("a generated PDF keeps q…Q colours inside their state through the real parser", async () => {
  // runParseJob is the exact body the intake pool executes in its worker, so
  // this exercises the production detect → parse → style-profile chain.
  const derivative = await runParseJob({
    materialId: "graphics-state.pdf",
    name: "graphics-state.pdf",
    bytes: graphicsStatePdf(),
  });
  assert.equal(derivative.parser.id, "pdf-unpdf-v4");
  assert.equal(derivative.document.pageCount, 1);
  const profile = derivative.document.styleProfile;
  assert.equal(profile.source, "pdf-vector-ops");
  const shares = Object.fromEntries(profile.accentColors.map((/** @type {any} */ entry) => [entry.hex, entry.share]));
  // The final rectangle is painted after Q, so it must return to the outer
  // blue instead of leaking the red saved state away.
  assert.ok(Math.abs(shares["#0000FF"] - 2 / 3) < 0.001, `blue share ${shares["#0000FF"]}`);
  assert.ok(Math.abs(shares["#FF0000"] - 1 / 3) < 0.001, `red share ${shares["#FF0000"]}`);
  assert.ok(profile.accentColors.every((/** @type {any} */ entry) => entry.roles.includes("fill")));
});

/**
 * Deterministic one-page vector PDF: blue rectangle, then a red one painted
 * inside q…Q, then another rectangle AFTER Q that must be blue again.
 */
function graphicsStatePdf() {
  return buildPdf({
    pages: [
      {
        vectorContent: "0 0 1 rg 50 700 200 100 re f\n" + "q 1 0 0 rg 50 500 200 100 re f Q\n" + "50 300 200 100 re f",
      },
    ],
  });
}
